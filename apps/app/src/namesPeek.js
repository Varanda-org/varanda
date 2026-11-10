// On-demand name read for a key profile.read finds no name for (#436). The
// browser node syncs a diary newest first, so a profile record that sits in
// the middle of a diary not downloaded yet reads "sem nome" until the history
// arrives. The seeder index (GET /index/member/<key>) says where the profile
// and @nome blocks are, and diary.peek (docs/rpc.md 5.27) reads and verifies
// them. Pure: no React, so the rules load in tests (./names.js wires it).
//
// One key at a time, each key tried once per scope (a failure is never
// repeated), and nothing is asked of a node that answers USAGE 'leitura sob
// demanda só na versão web' (the core node) after the first answer.

import rpc from '@varanda/rpc'
import { applySeed } from './namesCache.js'

const { USAGE } = rpc
const WEB_ONLY = 'leitura sob demanda só na versão web'

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

// The entry once the peeked fields fill what profile.read left empty: a
// field profile.read already brought is never replaced, so a name never
// drops out while an older block downloads. It counts as loaded: the node was
// asked and the answer stands until the diary grows (the freshness path marks
// it stale again).
export function withPeek (entry, fields) {
  const known = entry || null
  const gap = (field) => known === null || known[field] === null || known[field] === undefined
  const seed = {}
  for (const field of ['name', 'username', 'bio']) if (gap(field)) seed[field] = fields[field]
  if (known === null || !known.avatar) seed.avatar = fields.avatar
  const merged = applySeed(known, seed)
  if (merged === null) return known === null ? null : { ...known, loaded: true }
  return { ...(known || {}), ...merged, loaded: true }
}

// lookup(key) -> { ok, value: { profileSeq, usernameSeq, ... } } (fetchMember);
// peek(params) -> the diary.peek answer, or throws.
export function createNamePeeker ({ enabled, lookup, peek }) {
  const queue = new Set()
  const tried = new Set()
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
    // What the last successful read of `key` said, or null.
    foundFor (key) {
      return found.get(key) || null
    },
    // Reads the next queued key. -> { key, fields } (fields null when the
    // index or the node had nothing) or null with an empty queue.
    async next () {
      if (off || queue.size === 0) return null
      const key = queue.values().next().value
      queue.delete(key)
      tried.add(key)
      let fields = null
      try {
        const member = await lookup(key)
        const params = member && member.ok ? peekParams(key, member.value) : null
        if (params !== null) fields = peekFields(await peek(params))
      } catch (err) {
        if (err && err.code === USAGE && err.message === WEB_ONLY) {
          off = true
          queue.clear()
        }
        fields = null
      }
      if (fields !== null) found.set(key, fields)
      return { key, fields }
    }
  }
}
