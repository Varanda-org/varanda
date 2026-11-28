// The 'espiadinha' snapshot codec: the last first page of the Espiadinha,
// kept so a reopen paints it at once while peek.read answers. It holds posts
// of people the member does NOT follow, so it is tighter than the other
// kinds: 30 rows, 192 KiB of stored text (envelope included), 7 days, and an
// unknown key anywhere fails the whole parse. The cursor (`next`) is never
// stored: the node's copy of the list dies in 5 minutes (docs/design.md), so
// a stored cursor could only ever be refused. Registered in the DELEGATED
// table of ./screenSnapshot.js, which checks the binding, the actor, the age
// and the byte size and wipes it with the other kinds. Pure: no React, no
// react-native, no Node built-ins.
//
// Body: { rows, meta: { diaries, skipped, incomplete } }. A row is a
// peek.read PeekItem (docs/rpc.md 5.22): the FeedItem fields itemOf keeps,
// then `avatar` (the item's own descriptor or null) and `round`, and
// `thumbs` and `alt` only when the read gave a valid list. A poll post is not kept.
//
// Optional `originals` ('author:seq' -> a post item, with its `avatar`): the
// reposted, quoted and replied-to posts the rows draw, and what those quote
// or answer (two levels, as A Rua), so a reopen draws them without a read.
// Only what a stored row needs, at most PEEK_MAX_ORIGINALS, never a blocked
// author's; the key is left out when there is none (the older two-key body
// still parses).

import { PEEK_MAX_ORIGINALS, peekOriginalsOf } from './peek.js'
import { POST_KEYS, REPOST_KEYS, avatarField, exactKeys, hasOwn, isPlain, itemOf, postKeysFor } from './snapshotParts.js'

export const KIND = 'espiadinha'
export const PEEK_SNAPSHOT_MAX_BYTES = 196608
export const PEEK_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const PEEK_SNAPSHOT_MAX_ROWS = 30
// docs/rpc.md 5.22: a PeekItem's round is at most 100000.
const MAX_ROUND = 100000

const BODY_KEYS = ['rows', 'meta']
const BODY_KEYS_ORIGINALS = ['rows', 'meta', 'originals']
const META_KEYS = ['diaries', 'skipped', 'incomplete']
const PEEK_EXTRA = ['avatar', 'round']
const POST_ROW_KEYS = POST_KEYS.concat(PEEK_EXTRA)
const REPOST_ROW_KEYS = REPOST_KEYS.concat(PEEK_EXTRA)
const ORIGINAL_KEYS = POST_KEYS.concat(['avatar'])

const iterable = (v) => v !== null && typeof v === 'object' && typeof v[Symbol.iterator] === 'function'
const isCount = (v) => Number.isSafeInteger(v) && v >= 0
const isRound = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_ROUND
const rowKey = (row) => row.author + ':' + row.seq

function keySet (src) {
  const set = new Set()
  if (src === null || typeof src !== 'object' || typeof src[Symbol.iterator] !== 'function') return set
  for (const k of src) if (typeof k === 'string') set.add(k.toLowerCase())
  return set
}

// Every author a row shows or names: the poster (the reposter for a repost),
// the reposted original's author and the quoted or replied-to author.
function rowAuthors (row) {
  const out = [row.author]
  if (row.to) out.push(row.to.author)
  if (row.quote) out.push(row.quote.author)
  if (row.replyTo) out.push(row.replyTo.author)
  return out
}

// One row as a fresh canonical copy, or null. `strict` (parsing): exactly the
// keys of a stored row.
function rowOf (v, strict) {
  if (!isPlain(v)) return null
  if (strict && !exactKeys(v, v.kind === 'repost' ? REPOST_ROW_KEYS : postKeysFor(v, POST_ROW_KEYS))) return null
  if (!isRound(v.round)) return null
  const avatar = avatarField(v.avatar, strict)
  if (!avatar.ok) return null
  const { avatar: _avatar, round: _round, ...rest } = v
  const item = itemOf(strict ? rest : v, strict)
  if (item === null) return null
  return Object.assign(item, { avatar: avatar.value, round: v.round })
}

// The original stored under `ref` as a fresh canonical copy: a post of that
// very author and seq, or null. `strict` (parsing): exactly the stored keys.
function originalOf (v, ref, strict) {
  if (!isPlain(v) || v.kind !== 'post') return null
  if (strict && !exactKeys(v, postKeysFor(v, ORIGINAL_KEYS))) return null
  const avatar = avatarField(v.avatar, strict)
  if (!avatar.ok) return null
  const { avatar: _avatar, ...rest } = v
  const item = itemOf(strict ? rest : v, strict)
  if (item === null || item.author + ':' + item.seq !== ref) return null
  return Object.assign(item, { avatar: avatar.value })
}

// The body over `rows`, with the originals they need read through at(ref).
function bodyOf (rows, meta, at) {
  const originals = peekOriginalsOf(rows, at)
  return Object.keys(originals).length > 0 ? { rows, meta, originals } : { rows, meta }
}

// The body over `rows` with what they still need of `originals`, among the
// ones `ok(author)` allows: an original no row needs any more goes too.
function rebody (rows, meta, originals, ok) {
  if (!isPlain(originals)) return { rows, meta }
  return bodyOf(rows, meta, (ref) => {
    const o = hasOwn(originals, ref) ? originals[ref] : null
    return o !== null && typeof o === 'object' && ok(o.author) ? o : null
  })
}

function metaOf (v, strict) {
  if (!isPlain(v) || (strict && !exactKeys(v, META_KEYS))) return null
  if (!isCount(v.diaries) || !isCount(v.skipped) || typeof v.incomplete !== 'boolean') return null
  return { diaries: v.diaries, skipped: v.skipped, incomplete: v.incomplete }
}

// input: { rows (the shown peek.read items, in order), meta ({ diaries,
// skipped, incomplete }), blocked, followed (lists or Sets of keys) }.
// Both lists are required (an empty one is the explicit "none"): without
// them a stranger's row could not be checked, so nothing is built. A row
// naming a blocked author, or posted by a followed one (other than the
// owner), is left out; a row that fails validation is skipped. `originals`
// (optional, ref -> post item, peekOriginalsOf of ./peek.js): an invalid or
// blocked author's original is left out, its row stays. Rows are cut from
// the end, each with the originals only it needed, until fits(body).
// -> the body or null.
export function build (input, { fits, owner } = {}) {
  if (!isPlain(input) || !Array.isArray(input.rows) || typeof fits !== 'function') return null
  if (!iterable(input.blocked) || !iterable(input.followed)) return null
  const meta = metaOf(input.meta, false)
  if (meta === null) return null
  const blocked = keySet(input.blocked)
  const followed = keySet(input.followed)
  const rows = []
  const seen = new Set()
  for (const raw of input.rows) {
    if (rows.length >= PEEK_SNAPSHOT_MAX_ROWS) break
    const row = rowOf(raw, false)
    if (row === null || seen.has(rowKey(row))) continue
    if (rowAuthors(row).some((a) => blocked.has(a))) continue
    if (row.author !== owner && followed.has(row.author)) continue
    seen.add(rowKey(row))
    rows.push(row)
  }
  const src = isPlain(input.originals) ? input.originals : {}
  const checked = new Map()
  const at = (ref) => {
    if (!checked.has(ref)) {
      const o = hasOwn(src, ref) ? originalOf(src[ref], ref, false) : null
      checked.set(ref, o !== null && !blocked.has(o.author) ? o : null)
    }
    return checked.get(ref)
  }
  for (let n = rows.length; n >= 0; n--) {
    const body = bodyOf(rows.slice(0, n), meta, at)
    if (fits(body) === true) return body
  }
  return null
}

// -> the canonical body, or null for anything not exactly what build writes
// (an original no row needs, or an empty `originals`, included).
export function parse (body) {
  if (!isPlain(body)) return null
  const withOriginals = exactKeys(body, BODY_KEYS_ORIGINALS)
  if (!withOriginals && !exactKeys(body, BODY_KEYS)) return null
  if (!Array.isArray(body.rows) || body.rows.length > PEEK_SNAPSHOT_MAX_ROWS) return null
  const meta = metaOf(body.meta, true)
  if (meta === null) return null
  const rows = []
  const seen = new Set()
  for (const raw of body.rows) {
    const row = rowOf(raw, true)
    if (row === null || seen.has(rowKey(row))) return null
    seen.add(rowKey(row))
    rows.push(row)
  }
  if (!withOriginals) return { rows, meta }
  if (!isPlain(body.originals)) return null
  const refs = Object.keys(body.originals)
  if (refs.length === 0 || refs.length > PEEK_MAX_ORIGINALS) return null
  const stored = {}
  for (const ref of refs) {
    const o = originalOf(body.originals[ref], ref, true)
    if (o === null) return null
    stored[ref] = o
  }
  const out = bodyOf(rows, meta, (ref) => (hasOwn(stored, ref) ? stored[ref] : null))
  if (!out.originals || Object.keys(out.originals).length !== refs.length) return null
  return out
}

// Without any row that shows or names an author of `keys` (a block), any
// original by one of them, and any original no row left needs.
export function withoutAuthors (body, keys) {
  if (!isPlain(body) || !Array.isArray(body.rows)) return null
  const drop = keySet(keys)
  const rows = body.rows.filter((row) => !rowAuthors(row).some((a) => drop.has(a)))
  return rebody(rows, body.meta, body.originals, (a) => !drop.has(a))
}

// Without any original by an author of `keys`; every row stays, and one
// that names such an original draws it as a read still on its way. -> the
// body, or null.
export function withoutOriginalsBy (body, keys) {
  if (!isPlain(body) || !Array.isArray(body.rows)) return null
  const drop = keySet(keys)
  return rebody(body.rows, body.meta, body.originals, (a) => !drop.has(a))
}

// Every own deletion, on any screen (App.js deletedPost): the stored copy,
// whether the Espiadinha is mounted or not, loses each original by its owner,
// so a deleted own post never paints again from it; the rows stay. Bound by
// the copy's own envelope, as a purge is. `store`: { loadText, load, save,
// clear } of ./screenSnapshotStore; `gen`: cacheGeneration() read after the
// deletion's bump. Fails closed: a copy that cannot be rewritten goes.
export function dropOwnOriginals (store, gen) {
  const text = store.loadText(KIND)
  if (text === null) return
  let bound = null
  try {
    const s = JSON.parse(text)
    if (isPlain(s)) bound = { origin: s.origin, association: s.association, owner: s.owner }
  } catch {}
  const snapshot = bound === null ? null : store.load(KIND, { ...bound, acting: { kind: 'me' } })
  const body = snapshot === null ? null : withoutOriginalsBy(snapshot.body, [snapshot.owner])
  if (body === null) {
    store.clear(KIND)
    return
  }
  const count = (b) => (isPlain(b.originals) ? Object.keys(b.originals).length : 0)
  if (count(body) === count(snapshot.body)) return
  if (store.save(KIND, { ...snapshot, body }, gen) !== true) {
    store.clear(KIND)
    return
  }
  // The raw store swallows a failed write and save still says true: only a
  // read back proves the own originals are gone.
  const after = store.load(KIND, { ...bound, acting: { kind: 'me' } })
  const left = after === null ? null : withoutOriginalsBy(after.body, [after.owner])
  if (after !== null && (left === null || count(left) !== count(after.body))) store.clear(KIND)
}

// Inverted for this kind: `allowed` is the follow list (plus the own key),
// and a followed author's rows belong in A Rua, not here. Removes the rows
// posted by an author in `allowed` other than `owner`, and the originals
// only they needed (a followed author's original a stranger's row draws
// stays).
export function keepOnlyAuthors (body, allowed, { owner } = {}) {
  if (!isPlain(body) || !Array.isArray(body.rows)) return null
  const followed = keySet(allowed)
  const rows = body.rows.filter((row) => row.author === owner || !followed.has(row.author))
  return rebody(rows, body.meta, body.originals, () => true)
}

// useSocial's seed from a parsed body, in the shape A Rua's socialSeed
// (./feedSnapshot.js) gives: the stored originals; no counts and no own like
// or repost state, which the live read fills. -> the seed, or null.
export function peekSeedOf (body) {
  if (!isPlain(body)) return null
  const originals = isPlain(body.originals) ? Object.entries(body.originals) : []
  return { originals: new Map(originals), counts: new Map(), liked: new Set(), reposted: new Set() }
}

export const peekCodec = Object.freeze({
  KIND,
  maxBytes: PEEK_SNAPSHOT_MAX_BYTES,
  maxAgeMs: PEEK_SNAPSHOT_MAX_AGE_MS,
  build,
  parse,
  withoutAuthors,
  keepOnlyAuthors
})
