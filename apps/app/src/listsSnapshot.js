// The 'listas' snapshot codec: the first page of six lists (Seguindo,
// Salvos, the Feira, Assuntos do momento, Curtidas and the own
// Depoimentos), kept so a reopen paints them at once while the live read
// answers. Each list is one entry that expires 14 days after its own save,
// so saving one list never renews another. Registered in the DELEGATED
// table of ./screenSnapshot.js, which checks the binding, the actor (never a
// page), the envelope age and the byte size and wipes it with the other
// kinds. Pure: no React, no react-native, no Node built-ins.
//
// Body: { lists: { [name]: { savedAt, scope, rows, total? } } }. `scope` is
// what the screen compares before using an entry ('' for a list with one
// scope). An unknown list, entry or row key fails the whole parse. No cursor
// or offset is stored. Rows per list:
// - 'seguindo': at most 100 hex64 keys of the follow.list first page, plus
//   `total` (follow.list's total).
// - 'salvos': at most 30 { ref, post }, post a FeedItem of itemOf.
// - 'feira': at most 30 rows as loadFeiraPage returns them (./feiraScreen.js).
// - 'assuntos': at most 30 { tag, label, meta } of trendRows (./topicTrend.js).
// - 'curtidas': scope the post ref, at most 30 rows of confirmEngagers
//   (./engagers.js), plus `total` (a count or null). Only the likes tab.
// - 'depoimentos': scope '', at most 30 shown rows of rowsFrom
//   (./testimonials.js), only the owner's own: pending, kept and sent ones
//   are never stored.

import rpc from '@varanda/rpc'
import { validDescriptor } from './media/fetch.js'
import { MAX_TEXT_UNITS, avatarField, exactKeys, hasOwn, isAt, isHex64, isName, isPlain, isSeq, isUsername, itemOf } from './snapshotParts.js'

const { utf8ByteLength, feira, MAX_TESTIMONIAL } = rpc

const DAY = 24 * 60 * 60 * 1000
export const KIND = 'listas'
export const LISTS_SNAPSHOT_MAX_BYTES = 262144
export const LISTS_SNAPSHOT_MAX_AGE_MS = 14 * DAY
// A clock moved back a little must not throw away a good entry (the same
// slack as ./screenSnapshot.js).
const FUTURE_SLACK_MS = DAY
export const LIST_ENTRY_MAX_BYTES = 40960
export const LIST_SCOPE_MAX = 256
export const LIST_NAMES = Object.freeze(['seguindo', 'salvos', 'feira', 'assuntos', 'curtidas', 'depoimentos'])
export const SEGUINDO_MAX_ROWS = 100
export const LIST_MAX_ROWS = 30

const WITH_TOTAL = ['seguindo', 'curtidas']
const ENTRY_KEYS = ['savedAt', 'scope', 'rows']
const ENTRY_TOTAL_KEYS = ['savedAt', 'scope', 'rows', 'total']
const SAVED_KEYS = ['ref', 'post']
const TOPIC_KEYS = ['tag', 'label', 'meta']
const ENGAGER_KEYS = ['author', 'seq', 'name', 'username', 'avatar']
const TESTIMONIAL_KEYS = ['from', 'seq', 'text', 'at', 'ref', 'name', 'username', 'avatar']
const FEIRA_REQUIRED = ['ref', 'author', 'seq', 'editSeq', 'edited', 'kind', 'kindLabel', 'title', 'text', 'price', 'unit', 'priceLabel', 'cat', 'catLabel', 'place', 'media', 'status', 'statusLabel', 'at', 'editedAt']
const FEIRA_OPTIONAL = ['stale', 'name', 'username', 'certDate', 'page']
const PLACE_KEYS = ['uf', 'city', 'bairro', 'label']
const REF = /^([0-9a-f]{64}):([1-9][0-9]{0,15})$/
const TAG = /^[a-z0-9]{2,32}$/
// Labels the app builds (prices, categories, places, counts): short.
const MAX_LABEL_UNITS = 256
const MAX_TESTIMONIAL_UNITS = MAX_TESTIMONIAL * 2

const iterable = (v) => v !== null && typeof v === 'object' && typeof v[Symbol.iterator] === 'function'
const bytesOf = (v) => utf8ByteLength(JSON.stringify(v))
const isLabel = (v) => typeof v === 'string' && v.length <= MAX_LABEL_UNITS
const isCount = (v) => Number.isSafeInteger(v) && v >= 0
const isList = (name) => typeof name === 'string' && LIST_NAMES.includes(name)
const maxRows = (name) => (name === 'seguindo' ? SEGUINDO_MAX_ROWS : LIST_MAX_ROWS)

function isIso (v) {
  if (typeof v !== 'string' || v.length > 32) return false
  const d = new Date(v)
  return !Number.isNaN(d.getTime()) && d.toISOString() === v
}

function keySet (src) {
  const set = new Set()
  if (!iterable(src)) return set
  for (const k of src) if (typeof k === 'string') set.add(k.toLowerCase())
  return set
}

// -> { author, seq } of 'hex64:seq', or null.
function refParts (v) {
  const m = typeof v === 'string' ? REF.exec(v) : null
  if (m === null) return null
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) ? { author: m[1], seq } : null
}

// Exactly the required keys plus any of the optional ones.
function shapeOk (o, required, optional) {
  return required.every((k) => hasOwn(o, k)) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k))
}

// Building takes a peer name or username as the screen holds it: one this
// copy cannot keep reads as unknown instead of dropping the row.
function nameField (v, strict) {
  if (isName(v)) return { ok: true, value: v }
  return strict ? { ok: false } : { ok: true, value: null }
}

function usernameField (v, strict) {
  if (isUsername(v)) return { ok: true, value: v }
  return strict ? { ok: false } : { ok: true, value: null }
}

// An entry is kept for LISTS_SNAPSHOT_MAX_AGE_MS from its own savedAt. A
// time ahead of the clock past the slack is not fresh: it would otherwise
// outlive every later save.
function fresh (savedAt, now) {
  return Number.isSafeInteger(savedAt) && savedAt >= 0 && Number.isSafeInteger(now) &&
    now - savedAt <= LISTS_SNAPSHOT_MAX_AGE_MS && savedAt - now <= FUTURE_SLACK_MS
}

// ---- rows, one validator per list: (v, strict, ctx) -> a fresh copy or null

function followRow (v) {
  return isHex64(v) ? v : null
}

function savedRow (v, strict) {
  if (!isPlain(v) || (strict && !exactKeys(v, SAVED_KEYS))) return null
  const post = itemOf(v.post, strict)
  if (post === null || v.ref !== post.author + ':' + post.seq) return null
  return { ref: v.ref, post }
}

function placeOf (v, strict) {
  if (!isPlain(v) || (strict && !exactKeys(v, PLACE_KEYS))) return null
  if (!(v.uf === '' || feira.isUf(v.uf)) || !isLabel(v.city) || !(v.bairro === null || isLabel(v.bairro)) || !isLabel(v.label)) return null
  return { uf: v.uf, city: v.city, bairro: v.bairro, label: v.label }
}

function listingMedia (v) {
  if (!Array.isArray(v) || v.length > feira.MAX_LISTING_MEDIA || !v.every(validDescriptor)) return null
  return v.map((d) => ({ ...d }))
}

function feiraRow (v, strict) {
  if (!isPlain(v) || (strict && !shapeOk(v, FEIRA_REQUIRED, FEIRA_OPTIONAL))) return null
  if (!FEIRA_REQUIRED.every((k) => hasOwn(v, k))) return null
  if (!isHex64(v.author) || !isSeq(v.seq) || v.ref !== v.author + ':' + v.seq) return null
  if (!(v.editSeq === null || isSeq(v.editSeq)) || typeof v.edited !== 'boolean') return null
  if (!feira.isKind(v.kind) || !feira.isCat(v.cat) || !feira.isPrice(v.price) || !(v.unit === null || feira.isUnit(v.unit))) return null
  if (!isLabel(v.kindLabel) || !isLabel(v.title) || typeof v.text !== 'string' || v.text.length > MAX_TEXT_UNITS) return null
  if (!isLabel(v.priceLabel) || !isLabel(v.catLabel) || !isAt(v.at) || !(v.editedAt === null || isAt(v.editedAt))) return null
  const stale = hasOwn(v, 'stale') ? v.stale : undefined
  if (stale !== undefined && typeof stale !== 'boolean') return null
  // Only a stale row has no status: its current status is unknown.
  if (stale === true ? (v.status !== null || v.statusLabel !== null) : (!feira.isStatus(v.status) || !isLabel(v.statusLabel))) return null
  const place = placeOf(v.place, strict)
  const media = listingMedia(v.media)
  if (place === null || media === null) return null
  const out = { ref: v.ref, author: v.author, seq: v.seq, editSeq: v.editSeq, edited: v.edited, kind: v.kind, kindLabel: v.kindLabel, title: v.title, text: v.text, price: v.price, unit: v.unit, priceLabel: v.priceLabel, cat: v.cat, catLabel: v.catLabel, place, media, status: v.status, statusLabel: v.statusLabel, at: v.at, editedAt: v.editedAt }
  if (stale !== undefined) out.stale = stale
  if (hasOwn(v, 'name')) {
    if (!isName(v.name)) return null
    out.name = v.name
  }
  if (hasOwn(v, 'username')) {
    if (!isUsername(v.username)) return null
    out.username = v.username
  }
  if (hasOwn(v, 'certDate')) {
    if (!(v.certDate === null || isIso(v.certDate))) return null
    out.certDate = v.certDate
  }
  if (hasOwn(v, 'page')) {
    if (typeof v.page !== 'boolean') return null
    out.page = v.page
  }
  return out
}

function topicRow (v, strict) {
  if (!isPlain(v) || (strict && !exactKeys(v, TOPIC_KEYS))) return null
  if (typeof v.tag !== 'string' || !TAG.test(v.tag) || v.label !== '#' + v.tag || !isLabel(v.meta)) return null
  return { tag: v.tag, label: v.label, meta: v.meta }
}

function engagerRow (v, strict) {
  if (!isPlain(v) || (strict && !exactKeys(v, ENGAGER_KEYS))) return null
  if (!isHex64(v.author) || !isSeq(v.seq)) return null
  const name = nameField(v.name, strict)
  const username = usernameField(v.username, strict)
  const avatar = avatarField(v.avatar, strict)
  if (!name.ok || !username.ok || !avatar.ok) return null
  return { author: v.author, seq: v.seq, name: name.value, username: username.value, avatar: avatar.value }
}

// ctx.owner: undefined when unknown (putList checks the shape only), else
// the owner the ref must name (null refuses every row).
function testimonialRow (v, strict, ctx) {
  if (!isPlain(v) || (strict && !exactKeys(v, TESTIMONIAL_KEYS))) return null
  if (!isHex64(v.from) || !isSeq(v.seq) || !isIso(v.at)) return null
  if (typeof v.text !== 'string' || v.text.length < 1 || v.text.length > MAX_TESTIMONIAL_UNITS) return null
  const ref = refParts(v.ref)
  if (ref === null || ref.seq !== v.seq || ref.author === v.from) return null
  if (ctx.owner !== undefined && ref.author !== ctx.owner) return null
  const name = nameField(v.name, strict)
  const username = usernameField(v.username, strict)
  const avatar = avatarField(v.avatar, strict)
  if (!name.ok || !username.ok || !avatar.ok) return null
  return { from: v.from, seq: v.seq, text: v.text, at: v.at, ref: v.ref, name: name.value, username: username.value, avatar: avatar.value }
}

// Every author a salvo shows or names, as ./peekSnapshot.js does.
function postAuthors (post) {
  const out = [post.author]
  if (post.to) out.push(post.to.author)
  if (post.quote) out.push(post.quote.author)
  if (post.replyTo) out.push(post.replyTo.author)
  return out
}

const ROWS = {
  seguindo: { rowOf: followRow, idOf: (k) => k, authorsOf: (k) => [k] },
  salvos: { rowOf: savedRow, idOf: (r) => r.ref, authorsOf: (r) => postAuthors(r.post) },
  feira: { rowOf: feiraRow, idOf: (r) => r.ref, authorsOf: (r) => [r.author] },
  assuntos: { rowOf: topicRow, idOf: (r) => r.tag, authorsOf: () => [] },
  curtidas: { rowOf: engagerRow, idOf: (r) => r.author, authorsOf: (r) => [r.author] },
  depoimentos: { rowOf: testimonialRow, idOf: (r) => r.from, authorsOf: (r) => [r.from] }
}

// ---- entries

function scopeOk (name, scope) {
  if (typeof scope !== 'string' || scope.length > LIST_SCOPE_MAX) return false
  if (name === 'curtidas') return refParts(scope) !== null
  if (name === 'depoimentos') return scope === ''
  return true
}

// Curtidas of a post by a dropped author go whole.
function entryDropped (name, scope, drop) {
  return name === 'curtidas' && drop.has(refParts(scope).author)
}

function totalOf (name, raw, strict) {
  if (name === 'seguindo') return isCount(raw.total) ? { ok: true, value: raw.total } : { ok: false }
  const total = raw.total === undefined && !strict ? null : raw.total
  return total === null || isCount(total) ? { ok: true, value: total } : { ok: false }
}

// One list entry as a fresh canonical copy, or null. `raw` is { scope, rows,
// total? }; ctx { drop (a Set of keys to leave out), owner }. Building skips
// a bad or dropped row and cuts rows from the end until the entry is within
// LIST_ENTRY_MAX_BYTES; parsing (`strict`) refuses instead.
function entryOf (name, raw, savedAt, strict, ctx) {
  if (!isList(name) || !isPlain(raw) || !scopeOk(name, raw.scope) || !Array.isArray(raw.rows)) return null
  if (strict && raw.rows.length > maxRows(name)) return null
  const withTotal = WITH_TOTAL.includes(name)
  if (strict && !exactKeys(raw, withTotal ? ENTRY_TOTAL_KEYS : ENTRY_KEYS)) return null
  const drop = ctx.drop || new Set()
  if (entryDropped(name, raw.scope, drop)) return null
  const total = withTotal ? totalOf(name, raw, strict) : null
  if (total !== null && !total.ok) return null
  const { rowOf, idOf, authorsOf } = ROWS[name]
  const rows = []
  const seen = new Set()
  for (const v of raw.rows) {
    if (rows.length >= maxRows(name)) break
    const row = rowOf(v, strict, ctx)
    if (row === null || seen.has(idOf(row))) {
      if (strict) return null
      continue
    }
    if (authorsOf(row).some((a) => drop.has(a))) continue
    seen.add(idOf(row))
    rows.push(row)
  }
  const make = (kept) => (withTotal ? { savedAt, scope: raw.scope, rows: kept, total: total.value } : { savedAt, scope: raw.scope, rows: kept })
  if (strict) {
    const entry = make(rows)
    return bytesOf(entry) <= LIST_ENTRY_MAX_BYTES ? entry : null
  }
  for (let n = rows.length; n >= 0; n--) {
    const entry = make(rows.slice(0, n))
    if (bytesOf(entry) <= LIST_ENTRY_MAX_BYTES) return entry
  }
  return null
}

// The stored entries still live, the newest saves first. -> [[name, entry]].
function liveEntries (lists, { now, skip, ctx }) {
  if (!isPlain(lists)) return []
  const out = []
  for (const [name, e] of Object.entries(lists)) {
    if (!isList(name) || skip(name) || !isPlain(e) || !fresh(e.savedAt, now)) continue
    const entry = entryOf(name, e, e.savedAt, false, ctx)
    if (entry !== null) out.push([name, entry])
  }
  out.sort((a, b) => b[1].savedAt - a[1].savedAt)
  return out
}

// `body` with list `name` saved now from { scope, rows, total }; only that
// entry is renewed and expired ones leave. -> a body or null.
export function putList (body, name, { scope, rows, total } = {}, now) {
  if (!isList(name) || !Number.isSafeInteger(now) || now < 0) return null
  const raw = { scope, rows }
  if (total !== undefined) raw.total = total
  const ctx = {}
  const entry = entryOf(name, raw, now, false, ctx)
  if (entry === null) return null
  const others = liveEntries(isPlain(body) ? body.lists : null, { now, skip: (k) => k === name, ctx })
  return { lists: Object.fromEntries([[name, entry]].concat(others)) }
}

export function removeList (body, name) {
  if (!isPlain(body) || !isPlain(body.lists)) return null
  return { lists: Object.fromEntries(Object.entries(body.lists).filter(([k]) => k !== name)) }
}

// input: { previous (the stored body or null), name, scope, rows and total
// (the list to save now, optional), blocked (a list or Set of keys,
// required) }. The entry saved longest ago leaves first when the whole text
// does not fit. -> the body or null.
export function build (input, { fits, now, owner } = {}) {
  if (!isPlain(input) || typeof fits !== 'function' || !iterable(input.blocked) || !Number.isSafeInteger(now)) return null
  const ctx = { drop: keySet(input.blocked), owner: isHex64(owner) ? owner : null }
  let base = isPlain(input.previous) ? input.previous : null
  if (input.name !== undefined) {
    // putList knows no owner: a row it would keep over a later valid one
    // (the same writer) must not reach it.
    const rows = isList(input.name) && Array.isArray(input.rows) ? input.rows.filter((v) => ROWS[input.name].rowOf(v, false, ctx) !== null) : input.rows
    base = putList(base, input.name, { scope: input.scope, rows, total: input.total }, now)
    if (base === null) return null
  }
  const list = liveEntries(base === null ? null : base.lists, { now, skip: () => false, ctx })
  for (let n = list.length; n >= 0; n--) {
    const body = { lists: Object.fromEntries(list.slice(0, n)) }
    if (fits(body) === true) return body
  }
  return null
}

// Strict: an unknown list, entry or row key, a list over its caps or a
// depoimento of another owner fails the whole body; an expired entry is
// dropped.
export function parse (body, { now, owner } = {}) {
  if (!isPlain(body) || !exactKeys(body, ['lists']) || !isPlain(body.lists)) return null
  const ctx = { owner: isHex64(owner) ? owner : null }
  const lists = {}
  for (const [name, e] of Object.entries(body.lists)) {
    if (!isList(name) || !isPlain(e) || !Number.isSafeInteger(e.savedAt) || e.savedAt < 0) return null
    const entry = entryOf(name, e, e.savedAt, true, ctx)
    if (entry === null) return null
    if (fresh(entry.savedAt, now)) lists[name] = entry
  }
  return { lists }
}

// Without anything of `keys` (a block): the key in 'seguindo', rows by
// author in 'salvos', 'feira' and 'curtidas', rows by `from` in
// 'depoimentos', and the whole 'curtidas' entry of a post by one of them.
export function withoutAuthors (body, keys, { now } = {}) {
  if (!isPlain(body) || !isPlain(body.lists)) return null
  const drop = keySet(keys)
  const lists = {}
  for (const [name, e] of Object.entries(body.lists)) {
    if (!isList(name) || !isPlain(e) || !Array.isArray(e.rows) || !fresh(e.savedAt, now)) continue
    if (name === 'curtidas' && (refParts(e.scope) === null || entryDropped(name, e.scope, drop))) continue
    const { authorsOf } = ROWS[name]
    lists[name] = { ...e, rows: e.rows.filter((r) => !authorsOf(r).some((a) => drop.has(a))) }
  }
  return { lists }
}

export const listsCodec = Object.freeze({
  KIND,
  maxBytes: LISTS_SNAPSHOT_MAX_BYTES,
  maxAgeMs: LISTS_SNAPSHOT_MAX_AGE_MS,
  build,
  parse,
  withoutAuthors
})
