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
// then `avatar` (the item's own descriptor or null) and `round`. A poll post
// is not kept.

import { POST_KEYS, REPOST_KEYS, avatarField, exactKeys, isPlain, itemOf } from './snapshotParts.js'

export const KIND = 'espiadinha'
export const PEEK_SNAPSHOT_MAX_BYTES = 196608
export const PEEK_SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const PEEK_SNAPSHOT_MAX_ROWS = 30
// docs/rpc.md 5.22: a PeekItem's round is at most 100000.
const MAX_ROUND = 100000

const BODY_KEYS = ['rows', 'meta']
const META_KEYS = ['diaries', 'skipped', 'incomplete']
const PEEK_EXTRA = ['avatar', 'round']
const POST_ROW_KEYS = POST_KEYS.concat(PEEK_EXTRA)
const REPOST_ROW_KEYS = REPOST_KEYS.concat(PEEK_EXTRA)

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
  if (strict && !exactKeys(v, v.kind === 'repost' ? REPOST_ROW_KEYS : POST_ROW_KEYS)) return null
  if (!isRound(v.round)) return null
  const avatar = avatarField(v.avatar, strict)
  if (!avatar.ok) return null
  const { avatar: _avatar, round: _round, ...rest } = v
  const item = itemOf(strict ? rest : v, strict)
  if (item === null) return null
  return Object.assign(item, { avatar: avatar.value, round: v.round })
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
// owner), is left out; a row that fails validation is skipped. Rows are cut
// from the end until fits(body). -> the body or null.
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
  for (let n = rows.length; n >= 0; n--) {
    const body = { rows: rows.slice(0, n), meta }
    if (fits(body) === true) return body
  }
  return null
}

// -> the canonical body, or null for anything not exactly what build writes.
export function parse (body) {
  if (!isPlain(body) || !exactKeys(body, BODY_KEYS)) return null
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
  return { rows, meta }
}

// Without any row that shows or names an author of `keys` (a block).
export function withoutAuthors (body, keys) {
  if (!isPlain(body) || !Array.isArray(body.rows)) return null
  const drop = keySet(keys)
  return { rows: body.rows.filter((row) => !rowAuthors(row).some((a) => drop.has(a))), meta: body.meta }
}

// Inverted for this kind: `allowed` is the follow list (plus the own key),
// and a followed author's rows belong in A Rua, not here. Removes the rows
// posted by an author in `allowed` other than `owner`.
export function keepOnlyAuthors (body, allowed, { owner } = {}) {
  if (!isPlain(body) || !Array.isArray(body.rows)) return null
  const followed = keySet(allowed)
  return { rows: body.rows.filter((row) => row.author === owner || !followed.has(row.author)), meta: body.meta }
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
