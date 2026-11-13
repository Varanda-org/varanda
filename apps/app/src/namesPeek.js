// On-demand name read for a key profile.read finds no name for (#436). The
// browser node syncs a diary newest first, so a profile record that sits in
// the middle of a diary not downloaded yet reads "sem nome" until the history
// arrives. The seeder index (GET /index/member/<key>) says where the profile
// and @nome blocks are, and diary.peek (docs/rpc.md 5.27) reads and verifies
// them. Pure: no React, so the rules load in tests (./names.js wires it).
//
// One key at a time, each key tried once per scope (a passing failure is
// asked again only when profile.read lists the key anew, at most 3 times),
// and nothing is asked of a node that answers USAGE 'leitura sob demanda só
// na versão web' (the core node) after the first answer.

import rpc from '@varanda/rpc'
import { applySeed, authoritative } from './namesCache.js'

const { USAGE } = rpc
const WEB_ONLY = 'leitura sob demanda só na versão web'
const MAX_ATTEMPTS = 3
// Index failures worth another turn; not-found and malformed are answers.
const PASSING = new Set(['network', 'timeout', 'rate-limited', 'status'])

const validSeq = (n) => Number.isSafeInteger(n) && n >= 1

// A cache entry with nothing to show: a missing profile (null) or one with
// neither a name nor an @nome.
export function unnamed (entry) {
  return entry === null || entry === undefined || (entry.name === null && entry.username === null)
}

// The diary.peek params that read the profile (and @nome) blocks the index
// names, or null when it names none.
export function peekParams (author, hints) {
  const profileSeq = hints && validSeq(hints.profileSeq) ? hints.profileSeq : null
  const usernameSeq = hints && validSeq(hints.usernameSeq) ? hints.usernameSeq : null
  if (profileSeq === null && usernameSeq === null) return null
  const seqs = [...new Set([profileSeq, usernameSeq].filter((seq) => seq !== null))].sort((a, b) => a - b)
  const params = { author, seqs }
  if (profileSeq !== null) params.profileSeq = profileSeq
  if (usernameSeq !== null) params.usernameSeq = usernameSeq
  return params
}

// { name, username, bio, avatar } from a diary.peek answer (the node verified
// both blocks), or null when it brings neither a name nor an @nome.
export function peekFields (res) {
  if (!res || typeof res !== 'object') return null
  const p = res.profile && typeof res.profile === 'object' ? res.profile : null
  const name = p && typeof p.name === 'string' && p.name !== '' ? p.name : null
  const username = typeof res.username === 'string' && res.username !== '' ? res.username : null
  if (name === null && username === null) return null
  const fields = { name, username }
  if (p) {
    fields.bio = p.bio
    fields.avatar = p.avatar
  }
  return fields
}

// An entry with a name or an @nome still empty, the case a peek can fill.
export function partial (entry) {
  return entry === null || entry === undefined || entry.name === null || entry.username === null
}

// Whether `entry` still says what `base` said, for the fields of one group.
// profile.read cannot tell "block not downloaded yet" from "field removed"
// (docs/rpc.md 5.21), so a peeked value is reapplied only while the local
// copy has not moved since the peek: once a group changes, profile.read is
// authoritative for it again.
const sameGroup = (entry, base, fields) => fields.every((field) => {
  const a = entry === null || entry === undefined ? null : entry[field]
  const b = base === null || base === undefined ? null : base[field]
  if (field === 'avatar') return JSON.stringify(a || null) === JSON.stringify(b || null)
  return (a ?? null) === (b ?? null)
})

// The entry once the peeked fields fill what profile.read left empty: a
// field profile.read already brought is never replaced, so a name never
// drops out while an older block downloads. It counts as loaded: the node was
// asked and the answer stands until the diary grows (the freshness path marks
// it stale again). With `base` (the entry the peek filled), the profile group
// (name, bio, avatar) and the @nome are each filled only while they still
// read as they did then.
export function withPeek (entry, fields, base) {
  const known = entry || null
  const gap = (field) => known === null || known[field] === null || known[field] === undefined
  const reapply = base !== undefined
  const seed = {}
  if (!reapply || sameGroup(known, base, ['name', 'bio', 'avatar'])) {
    for (const field of ['name', 'bio']) if (gap(field)) seed[field] = fields[field]
    if (known === null || !known.avatar) seed.avatar = fields.avatar
  }
  if ((!reapply || sameGroup(known, base, ['username'])) && gap('username')) seed.username = fields.username
  const merged = applySeed(known, seed)
  if (merged === null) return known === null ? null : { ...known, loaded: true }
  return { ...(known || {}), ...merged, loaded: true }
}

// The entry once a peek of `fields` lands on `known`, or null when it must not
// land: the key has no entry (a `missing` answer stored null, or nothing was
// read yet) or it already shows a name or an @nome.
export function peekApply (known, fields) {
  if (!known || !unnamed(known)) return null
  return withPeek(known, fields)
}

// What one profile.read answer says, key -> entry (null for a key in
// `missing`: nothing to show, so a name the peek found earlier does not stay
// and the key leaves the peek queue), plus the keys left without a name or @nome that
// the peek may try. A key the peek already filled gets its fields back only
// while the local copy still reads as it did then (see withPeek).
export function foldRead (res, peeker) {
  const entries = new Map()
  const lonely = []
  for (const p of (res && res.profiles) || []) {
    if (!p || typeof p.author !== 'string') continue
    const key = p.author.toLowerCase()
    let entry = authoritative(p)
    const peeked = peeker ? peeker.foundFor(key) : null
    if (partial(entry) && peeked !== null && peeked.base !== null) entry = withPeek(entry, peeked.fields, peeked.base)
    if (unnamed(entry)) lonely.push(key)
    entries.set(key, entry)
  }
  for (const rawKey of (res && res.missing) || []) {
    if (typeof rawKey !== 'string') continue
    const key = rawKey.toLowerCase()
    if (peeker) peeker.drop(key)
    entries.set(key, null)
  }
  return { entries, lonely }
}

// lookup(key) -> { ok, value: { profileSeq, usernameSeq, ... } } (fetchMember);
// peek(params) -> the diary.peek answer, or throws.
export function createNamePeeker ({ enabled, lookup, peek }) {
  const queue = new Set()
  const tried = new Set()
  const attempts = new Map()
  const found = new Map()
  let off = enabled !== true

  return {
    get size () { return queue.size },
    get off () { return off },
    // The keys to ask about; -> how many are waiting. Keys already tried,
    // queued or found are ignored.
    enqueue (keys) {
      if (off) return 0
      for (const key of keys) {
        if (typeof key === 'string' && !tried.has(key) && !found.has(key)) queue.add(key)
      }
      return queue.size
    },
    // A key that is no longer worth asking about (profile.read says `missing`).
    drop (key) {
      queue.delete(key)
    },
    // What the last successful read of `key` said, { fields, base }, or null.
    // base is the entry the peek filled (see remember), null until then.
    foundFor (key) {
      return found.get(key) || null
    },
    // Records the entry `key` had when its peeked fields were applied.
    remember (key, base) {
      const hit = found.get(key)
      if (hit) hit.base = base
    },
    // Reads the next queued key. -> { key, fields } (fields null when the
    // index or the node had nothing) or null with an empty queue.
    async next () {
      if (off || queue.size === 0) return null
      const key = queue.values().next().value
      queue.delete(key)
      tried.add(key)
      let fields = null
      let transient = false
      try {
        const member = await lookup(key)
        const params = member && member.ok ? peekParams(key, member.value) : null
        if (params !== null) fields = peekFields(await peek(params))
        else transient = !member || (!member.ok && PASSING.has(member.reason))
      } catch (err) {
        if (err && err.code === USAGE && err.message === WEB_ONLY) {
          off = true
          queue.clear()
        } else {
          transient = true
        }
        fields = null
      }
      // A passing failure (index not ready, seeder down right at start) gets
      // another turn the next time profile.read lists the key, up to a cap.
      if (transient && !off) {
        const n = (attempts.get(key) || 0) + 1
        attempts.set(key, n)
        if (n < MAX_ATTEMPTS) tried.delete(key)
      }
      if (fields !== null) found.set(key, { fields, base: null })
      return { key, fields }
    }
  }
}
