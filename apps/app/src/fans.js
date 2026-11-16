// Fãs and Melhores amigos: the pure view model. Nothing here is trusted from
// the network. The seeder only gives pointers and a claimed count; the app
// re-reads every pointer with diary.peek and judges the records itself, with
// the rules of the core fold (packages/core/lib/records.js, kept in step by
// hand: this file is ESM for the app and imports nothing from the core). No
// React, no platform module, no request: the caller does the reads this model
// plans.
//
// What one peek cannot prove: a fan or follow-back pointer names the latest
// record to the seeder, and a superseded one looks the same as the latest, so
// "still on" stays a seeder claim, like the follower lists (pessoas.js). The
// fan count is a seeder claim shown with the follower-count honesty wording.
//
// Peer text never reaches this module: rows carry keys, seqs and dates only.

import rpc from '@varanda/rpc'
import { COUNTS_INCOMPLETE_NOTE } from './pessoas.js'

const HEX64 = /^[0-9a-f]{64}$/

// Same value as PEEK_SEQS_MAX in @varanda/rpc (docs/rpc.md 5.27).
export const PEEK_BATCH_MAX = 29

// One /index/fans page: must equal FOLLOWS_MAX in indexClient.js (the follower
// lists' page). A list longer than that is not a page, so the rest is never
// planned or judged.
export const FANS_PAGE_MAX = 20

export { COUNTS_INCOMPLETE_NOTE }

export const NOTICES = Object.freeze({
  pending: 'esperando seguir de volta',
  blockedPick: 'Você bloqueou esta pessoa.',
  full: 'Você já escolheu o máximo de melhores amigos.',
  self: 'Você não pode escolher a si mesmo.',
  duplicate: 'Esta pessoa já está nos seus melhores amigos.',
  invalid: 'Não deu para escolher esta pessoa.',
  blocked: 'Você bloqueou esta pessoa. Desbloqueie para ver os melhores amigos dela.',
  unreadable: 'Não deu para ler os melhores amigos agora. Nada é mostrado por enquanto.',
  indexing: 'O semeador ainda está montando esta lista. Podem faltar pessoas por enquanto.',
  incomplete: 'A leitura ficou incompleta. Podem faltar pessoas nesta lista.',
  pendingOwner: 'Só aparece para os outros quando a pessoa seguir você de volta.'
})

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isHex64 = (s) => typeof s === 'string' && HEX64.test(s)
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isCount = (n) => Number.isSafeInteger(n) && n >= 0
const keysAre = (obj, keys) => {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

function isCanonicalIso (s) {
  if (typeof s !== 'string') return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString() === s
}

// The limit lives in the contract package; read it there at call time. When
// the contract does not carry it the limit is 0, so nothing is shown or added
// (fail closed), never a copy of the number kept here.
export function maxTopFriends () {
  const n = rpc.MAX_TOP_FRIENDS
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

// ---- reading peeks --------------------------------------------------------

function peeksOf (peeks, key) {
  let v
  if (peeks instanceof Map) v = peeks.get(key)
  else if (isObject(peeks) && Object.prototype.hasOwnProperty.call(peeks, key)) v = peeks[key]
  if (v === undefined || v === null) return []
  return (Array.isArray(v) ? v : [v]).filter((p) => isObject(p) && p.key === key)
}

// One diary's reads: live records by seq and the seqs the node judged invalid.
// A peek whose `key` is another diary's never counts.
function readOf (peeks, key) {
  const live = new Map()
  const invalid = new Set()
  for (const p of peeksOf(peeks, key)) {
    for (const e of Array.isArray(p.entries) ? p.entries : []) {
      if (isObject(e) && isSeq(e.seq) && isObject(e.record) && !live.has(e.seq)) live.set(e.seq, e.record)
    }
    for (const s of Array.isArray(p.invalid) ? p.invalid : []) if (isSeq(s)) invalid.add(s)
  }
  return { live, invalid }
}

// Strictly ascending diary.peek params of at most PEEK_BATCH_MAX seqs.
export function peekBatches (author, seqs) {
  const sorted = [...new Set(seqs.filter(isSeq))].sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < sorted.length; i += PEEK_BATCH_MAX) out.push({ author, seqs: sorted.slice(i, i + PEEK_BATCH_MAX) })
  return out
}

// ---- records --------------------------------------------------------------

const fanOf = (r) => isObject(r) && r.type === 'fan' && keysAre(r, ['type', 'key', 'on', 'at']) && isHex64(r.key) && typeof r.on === 'boolean' && isCanonicalIso(r.at) ? r : null
const followOf = (r) => isObject(r) && r.type === 'follow' && keysAre(r, ['type', 'key', 'on', 'at']) && isHex64(r.key) && typeof r.on === 'boolean' && isCanonicalIso(r.at) ? r : null

// A top-friends record as the node would accept it, or null: 0..max distinct
// keys, never the writer's own.
function topOf (record, owner) {
  if (!isObject(record) || record.type !== 'top-friends' || !keysAre(record, ['type', 'keys', 'at'])) return null
  if (!isCanonicalIso(record.at) || !Array.isArray(record.keys) || record.keys.length > maxTopFriends()) return null
  const seen = new Set()
  for (const k of record.keys) {
    if (!isHex64(k) || k === owner || seen.has(k)) return null
    seen.add(k)
  }
  return record
}

// ---- the fan count --------------------------------------------------------

export function fansLabel (n) {
  if (!isCount(n)) return ''
  return n === 1 ? '1 fã' : n + ' fãs'
}

// `fans` is the { count, indexing } of /index/profile/<author> (null while
// the seeder has not finished that diary) and `complete` its flag. Same rule
// as the follower counts (useFollowCounts): the number is shown, and it may
// be short while the seeder is indexing or the read is not complete.
export function fansCountView ({ fans, complete } = {}) {
  if (!isObject(fans) || !isCount(fans.count) || typeof fans.indexing !== 'boolean') return { count: null, text: '', incomplete: false, note: null }
  const incomplete = fans.indexing === true || complete !== true
  return { count: fans.count, text: fansLabel(fans.count), incomplete, note: incomplete ? COUNTS_INCOMPLETE_NOTE : null }
}

// ---- the fan list ---------------------------------------------------------

const refOf = (item) => isObject(item) && isHex64(item.key) && isSeq(item.seq) && typeof item.at === 'string' ? item.key + ':' + item.seq : null

// Round one for the fan list: { author, seqs } peek params, one batch per fan
// diary (each pointer lives in the fan's own diary). Malformed pointers, the
// author itself and the reader's blocked fans are left out. Only the first
// FANS_PAGE_MAX items are planned: the list is untrusted and of any length.
export function planFanPeeks ({ author, items, isBlocked } = {}) {
  if (!isHex64(author) || !Array.isArray(items)) return []
  const blocked = typeof isBlocked === 'function' ? (k) => isBlocked(k) === true : () => false
  const byFan = new Map()
  for (const item of items.slice(0, FANS_PAGE_MAX)) {
    if (refOf(item) === null || item.key === author || blocked(item.key)) continue
    if (!byFan.has(item.key)) byFan.set(item.key, [])
    byFan.get(item.key).push(item.seq)
  }
  let out = []
  for (const [key, seqs] of byFan) out = out.concat(peekBatches(key, seqs))
  return out
}

// A row exists only when the fan's own diary returned a signed `fan` record,
// on, naming the author, at the pointer's seq and date. Newest first by the
// verified date, then key; no ranking. `unavailable` counts pointers that
// proved nothing (forged, off, unread, malformed) so the screen can say so;
// a blocked fan is dropped silently, as the reader chose it.
export function confirmFans ({ author, items, peeks, isBlocked } = {}) {
  const ok = isHex64(author)
  const blocked = typeof isBlocked === 'function' ? (k) => isBlocked(k) === true : () => false
  const reads = new Map()
  const proven = new Map()
  const missing = new Set()
  let malformed = 0
  for (const item of Array.isArray(items) ? items.slice(0, FANS_PAGE_MAX) : []) {
    if (refOf(item) === null) { malformed++; continue }
    if (!ok || item.key === author) { missing.add(item.key); continue }
    if (blocked(item.key)) continue
    if (!reads.has(item.key)) reads.set(item.key, readOf(peeks, item.key))
    const raw = reads.get(item.key).live.get(item.seq)
    const rec = raw === undefined ? null : fanOf(raw)
    if (rec === null || rec.on !== true || rec.key !== author || rec.at !== item.at) { missing.add(item.key); continue }
    const t = Date.parse(rec.at)
    const prev = proven.get(item.key)
    if (prev === undefined || t > prev.t || (t === prev.t && item.seq > prev.seq)) proven.set(item.key, { key: item.key, seq: item.seq, at: rec.at, t })
  }
  for (const key of proven.keys()) missing.delete(key)
  const rows = [...proven.values()]
    .sort((a, b) => b.t - a.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ t, ...row }) => row)
  return { rows, unavailable: malformed + missing.size }
}

// ---- melhores amigos: the reader's view -------------------------------------

// `top` is the { seq, back } of /index/profile/<owner>: seq the owner's latest
// top-friends block and back { friendKey: followSeq | null } the friend's
// latest follow block. A shape that is not that is no pointer at all.
function pointersOf (top) {
  if (!isObject(top) || !isSeq(top.seq)) return null
  const back = new Map()
  if (isObject(top.back)) {
    for (const key of Object.keys(top.back)) {
      if (isHex64(key) && isSeq(top.back[key])) back.set(key, top.back[key])
    }
  }
  return { seq: top.seq, back }
}

// Round one, a single round: the owner's top-friends block and each pointed
// follow-back block in the friend's own diary. At most the limit of friends
// are planned, so a seeder that lists more cannot make the app read more.
// The owner's record is not known yet in this round, so the cap counts the
// seeder's pointers in its order. A seeder that lists keys outside the record
// first can push a real friend past the cap: that friend then has no peek,
// reads as unread, and the view is 'incomplete' (fail closed, never shown on
// the seeder's word). The client already refuses a `back` over the limit
// (indexClient.js TOP_MAX), so this only bounds a caller that skipped it.
export function planTopPeeks ({ owner, top, isBlocked } = {}) {
  if (!isHex64(owner)) return []
  const p = pointersOf(top)
  if (p === null) return []
  const blocked = typeof isBlocked === 'function' ? (k) => isBlocked(k) === true : () => false
  let out = peekBatches(owner, [p.seq])
  let n = 0
  for (const [key, seq] of p.back) {
    if (key === owner || blocked(key)) continue
    if (++n > maxTopFriends()) break
    out = out.concat(peekBatches(key, [seq]))
  }
  return out
}

// Does the friend's follow block at the pointer prove "follows the owner"?
// true / false, or null when the block was not read at all.
// A newer follow of the owner by that friend, already known from the same
// peek, overrides a pointer at an older one: a dishonest seeder cannot keep
// showing a friend whose later 'off' is in front of us.
function backVerdict (read, seq, owner) {
  if (seq === undefined) return false
  let newest = null
  for (const [s, raw] of read.live) {
    if (s <= seq) continue
    const f = followOf(raw)
    if (f !== null && f.key === owner && (newest === null || s > newest.seq)) newest = { seq: s, on: f.on }
  }
  if (newest !== null && newest.on === false) return false
  if (read.live.has(seq)) {
    const f = followOf(read.live.get(seq))
    return f !== null && f.on === true && f.key === owner
  }
  return read.invalid.has(seq) ? false : null
}

// assembleTop({ owner, self, top, peeks, isBlocked, complete }) -> view
//   owner     the page owner's key
//   self      the reader's own key (null when there is no identity)
//   top       the `top` of the /index/profile/<owner> answer
//   peeks     Map or object: key -> one diary.peek result or a list of them
//   isBlocked (key) => boolean, the reader's own block list
//   complete  the `complete` flag of that answer: false says the list may be
//             short ('indexing') when nothing worse is to be said
// view: { owner, mine, rows, pending, incomplete, notice }. Rows keep the
// owner's order and are { key, slot, status, label }: slot the 0-based place
// in the owner's record, status 'confirmed', or, on the owner's own page only,
// 'pending' (the friend does not follow back, or it was not proven) and
// 'blocked'. Another reader gets confirmed rows only: a pointer that is
// forged, off, to another person, unread or in another diary proves nothing,
// so the friend stays out. The record itself unread or invalid fails closed:
// no rows at all.
export function assembleTop ({ owner, self = null, top, peeks, isBlocked, complete } = {}) {
  const base = { owner: isHex64(owner) ? owner : null, mine: false, rows: [], pending: 0, incomplete: false, notice: null }
  if (!isHex64(owner)) return { ...base, incomplete: true, notice: NOTICES.unreadable }
  const blocked = typeof isBlocked === 'function' ? (k) => isBlocked(k) === true : () => false
  const mine = isHex64(self) && self === owner
  if (!mine && blocked(owner)) return { ...base, notice: NOTICES.blocked }
  const view = { ...base, mine }
  if (top === null || top === undefined) return view
  const p = pointersOf(top)
  if (p === null) return { ...view, incomplete: true, notice: NOTICES.unreadable }
  const ownerRead = readOf(peeks, owner)
  const raw = ownerRead.live.get(p.seq)
  const rec = raw === undefined ? null : topOf(raw, owner)
  if (rec === null) return { ...view, incomplete: true, notice: NOTICES.unreadable }

  const rows = []
  let pending = 0
  let unread = 0
  rec.keys.forEach((key, slot) => {
    if (blocked(key)) {
      if (mine) rows.push({ key, slot, status: 'blocked', label: NOTICES.blockedPick })
      return
    }
    const seq = p.back.get(key)
    const verdict = seq === undefined ? false : backVerdict(readOf(peeks, key), seq, owner)
    if (verdict === null) unread++
    if (verdict === true) {
      rows.push({ key, slot, status: 'confirmed', label: null })
    } else if (mine) {
      pending++
      rows.push({ key, slot, status: 'pending', label: NOTICES.pending })
    }
  })
  const incomplete = unread > 0
  const notice = incomplete ? NOTICES.incomplete : complete === false ? NOTICES.indexing : null
  return { ...view, rows, pending, incomplete, notice }
}

// ---- melhores amigos: the owner's editor ------------------------------------

// The editor holds the picks in order and the saved list they started from.
// Every operation returns a new state; one that cannot apply returns the same
// state with an `error` notice (never throws).
export function editorState (keys) {
  const seen = new Set()
  const list = []
  for (const k of Array.isArray(keys) ? keys : []) {
    if (!isHex64(k) || seen.has(k) || list.length >= maxTopFriends()) continue
    seen.add(k)
    list.push(k)
  }
  return { saved: list.slice(), keys: list, error: null }
}

const refuse = (state, error) => ({ ...state, error })

export function addPick (state, key, { self = null, isBlocked } = {}) {
  // Without the writer's own key "never self" cannot be checked: refuse.
  if (!isHex64(self)) return refuse(state, NOTICES.invalid)
  if (!isHex64(key)) return refuse(state, NOTICES.invalid)
  if (key === self) return refuse(state, NOTICES.self)
  if (state.keys.includes(key)) return refuse(state, NOTICES.duplicate)
  if (typeof isBlocked === 'function' && isBlocked(key) === true) return refuse(state, NOTICES.blockedPick)
  if (state.keys.length >= maxTopFriends()) return refuse(state, NOTICES.full)
  return { ...state, keys: state.keys.concat([key]), error: null }
}

export function removePick (state, key) {
  const i = state.keys.indexOf(key)
  if (i === -1) return state
  return { ...state, keys: state.keys.filter((k) => k !== key), error: null }
}

function swap (state, from, to) {
  const keys = state.keys.slice()
  const tmp = keys[from]
  keys[from] = keys[to]
  keys[to] = tmp
  return { ...state, keys, error: null }
}

export const canMoveUp = (state, key) => state.keys.indexOf(key) > 0
export const canMoveDown = (state, key) => {
  const i = state.keys.indexOf(key)
  return i !== -1 && i < state.keys.length - 1
}

export function moveUp (state, key) {
  return canMoveUp(state, key) ? swap(state, state.keys.indexOf(key), state.keys.indexOf(key) - 1) : state
}

export function moveDown (state, key) {
  return canMoveDown(state, key) ? swap(state, state.keys.indexOf(key), state.keys.indexOf(key) + 1) : state
}

// True when the order or the set differs from the saved list.
export function editorChanged (state) {
  return state.keys.length !== state.saved.length || state.keys.some((k, i) => k !== state.saved[i])
}

// The keys to publish, or null when nothing changed or a pick is no longer
// valid (self, a duplicate, over the limit): the caller never sends a record
// the node would refuse.
export function editorRecordKeys (state, self = null) {
  if (!isHex64(self)) return null
  if (!editorChanged(state)) return null
  const seen = new Set()
  if (state.keys.length > maxTopFriends()) return null
  for (const k of state.keys) {
    if (!isHex64(k) || k === self || seen.has(k)) return null
    seen.add(k)
  }
  return state.keys.slice()
}

// Rows for the editor: each pick with its place, the move controls and what
// the owner's own view says about it (pending picks wait for a follow back).
export function editorRows (state, view) {
  const status = new Map()
  for (const r of isObject(view) && Array.isArray(view.rows) ? view.rows : []) status.set(r.key, r.status)
  return state.keys.map((key, index) => ({
    key,
    index,
    canUp: index > 0,
    canDown: index < state.keys.length - 1,
    status: status.get(key) || null,
    pending: status.get(key) === 'pending',
    label: status.get(key) === 'pending' ? NOTICES.pending : null
  }))
}
