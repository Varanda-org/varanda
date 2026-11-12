// Per-screen snapshots: the last first page of a few screens, kept so the
// next cold start can paint them at once while the node starts and the live
// read answers (the same idea as A Rua's ./feedSnapshot.js). Pure: no React,
// no react-native, no Node built-ins; the per-platform text store lives in
// ./screenSnapshotStore.*.js and uses createScreenSnapshotStore below.
//
// Why it is safe to keep: every kind holds only what this device already
// holds unencrypted for the member (the own diary and profile, followed
// diaries, the own group and community list with public names). Never
// stored: anything of a non-followed author, the Espiadinha, Avisos, DM rows,
// previews, peers or counts, the name of a private group, unread state.
// Snapshots are written and read only while acting as the member: a page
// actor never writes one and never reads the member's.
//
// Envelope (version 1): { v, kind, origin, association, owner, savedAt, body }
// - 'diario': { rows: [{ seq, record }], oldest, atEnd, originals }: the own
//   diary's first log.read page, only its post and repost records; `oldest`
//   the seq of the oldest entry of that page (the next `before`); originals:
//   ref -> post item of the own or a followed author.
// - 'perfil': { name, username, bio, avatar }: the own profile.read entry.
// - 'membro': { authors: { [author]: { openedAt, header, items, before,
//   atEnd, originals } } }: at most MEMBER_MAX_AUTHORS followed authors,
//   the least recently opened out first, each entry at most
//   MEMBER_ENTRY_MAX_BYTES; header { name, username, bio, avatar }.
// - 'conversasGrupos': { rows: [{ community, group, role, general, name }] }
//   as Conversas lists groups; name only for a public group.
// - 'comunidades': { rows: [{ community, name, join, state, role, general }] }
//   as Comunidades lists them, one row per community; name only if public.

import rpc from '@varanda/rpc'
import { avatarOf } from './media/avatar.js'
import { validDescriptor, validVideoDescriptor } from './media/fetch.js'
import { MAX_MEDIA_PER_POST, videoPair } from './media/plan.js'
import { cacheGeneration, registerLocalCache } from './localCaches.js'

const { MAX_NAME, MAX_BIO, MAX_TEXT, MAX_CARD_TITLE, MAX_CARD_DESC, MAX_CARD_IMAGE_BYTES, cardTextLength, cardUrlHost, utf8ByteLength } = rpc

export const SCREEN_SNAPSHOT_VERSION = 1
export const SCREEN_SNAPSHOT_KINDS = Object.freeze(['diario', 'perfil', 'membro', 'conversasGrupos', 'comunidades'])
// UTF-8 bytes of the JSON text of one kind: a synchronous read at start must
// stay cheap.
export const SCREEN_SNAPSHOT_MAX_BYTES = 262144
export const SCREEN_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const MEMBER_MAX_AUTHORS = 8
export const MEMBER_ENTRY_MAX_BYTES = 65536
// A clock moved back a little must not throw away a good snapshot.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

// log.read answers at most 32 entries per page.
const MAX_ROWS = 32
const MAX_ITEMS = 32
// Per row at most a repost target or a quote or a reply parent, and one
// level further.
const MAX_ORIGINALS = 2 * MAX_ROWS
// COMMUNITY_LIST_MAX communities, MAX_GROUPS_PER_COMMUNITY groups each.
const MAX_COMMUNITIES = 64
const MAX_GROUP_ROWS = 64 * 32
const MAX_ORIGIN = 2048
const MAX_AT = 32
// Caps in UTF-16 units: a character is at most two.
const MAX_NAME_UNITS = MAX_NAME * 2
const MAX_BIO_UNITS = MAX_BIO * 2
const MAX_TEXT_UNITS = MAX_TEXT * 2

const HEX64 = /^[0-9a-f]{64}$/
const REF = /^[0-9a-f]{64}:[1-9][0-9]{0,15}$/
const USERNAME = /^[a-z][a-z0-9_]{2,19}$/
const ROLE = /^[a-z]{1,16}$/
const TOP_KEYS = ['v', 'kind', 'origin', 'association', 'owner', 'savedAt', 'body']
const POST_KEYS = ['kind', 'author', 'name', 'username', 'seq', 'at', 'text', 'replyTo', 'quote', 'media', 'preview']
const REPOST_KEYS = ['kind', 'author', 'name', 'username', 'seq', 'at', 'to', 'text', 'replyTo', 'quote', 'media', 'preview']
const CARD_KEYS = ['url', 'host', 'title', 'desc', 'image']
const TARGET_KEYS = ['author', 'seq']
const POST_RECORD_KEYS = ['type', 'text', 'at', 'replyTo']
const POST_RECORD_EXTRA = ['quote', 'media', 'card']
const REPOST_RECORD_KEYS = ['type', 'to', 'on', 'at']
const PROFILE_KEYS = ['name', 'username', 'bio', 'avatar']
const MEMBER_KEYS = ['openedAt', 'header', 'items', 'before', 'atEnd', 'originals']
const GROUP_ROW_KEYS = ['community', 'group', 'role', 'general', 'name']
const COMMUNITY_ROW_KEYS = ['community', 'name', 'join', 'state', 'role', 'general']
const BODY_KEYS = {
  diario: ['rows', 'oldest', 'atEnd', 'originals'],
  perfil: PROFILE_KEYS,
  membro: ['authors'],
  conversasGrupos: ['rows'],
  comunidades: ['rows']
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isHex64 = (v) => typeof v === 'string' && HEX64.test(v)
const isSeq = (v) => Number.isSafeInteger(v) && v >= 1
const isRef = (v) => typeof v === 'string' && REF.test(v) && isSeq(Number(v.slice(65)))
const authorOfRef = (ref) => ref.slice(0, 64)
const seqOfRef = (ref) => Number(ref.slice(65))
const isAt = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_AT
const isName = (v) => v === null || (typeof v === 'string' && v.length <= MAX_NAME_UNITS)
const isUsername = (v) => v === null || (typeof v === 'string' && USERNAME.test(v))
const isBio = (v) => v === null || (typeof v === 'string' && v.length <= MAX_BIO_UNITS)
const validOrigin = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_ORIGIN
const isKind = (v) => typeof v === 'string' && SCREEN_SNAPSHOT_KINDS.includes(v)
const bytesOf = (v) => utf8ByteLength(JSON.stringify(v))

function isPlain (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function exactKeys (o, keys) {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => hasOwn(o, k))
}

function keysWithin (o, keys) {
  return Object.keys(o).every((k) => keys.includes(k))
}

// Only the member acting as the member: a page (actingAs.js) never writes
// nor reads a snapshot, and an unknown actor is treated as a page.
export function actingAsMember (acting) {
  return acting !== null && typeof acting === 'object' && acting.kind === 'me'
}

function keySet (src) {
  const set = new Set()
  if (src === null || typeof src !== 'object' || typeof src[Symbol.iterator] !== 'function') return set
  for (const k of src) if (typeof k === 'string') set.add(k.toLowerCase())
  return set
}

// A followed test over a Set, a list or a function.
function followTest (src) {
  if (typeof src === 'function') return (k) => src(k) === true
  const set = keySet(src)
  return (k) => set.has(k)
}

function getter (src) {
  if (src instanceof Map) return (k) => src.get(k)
  if (isPlain(src)) return (k) => (hasOwn(src, k) ? src[k] : undefined)
  return () => undefined
}

function refOfTarget (t) {
  return t && isHex64(t.author) && isSeq(t.seq) ? t.author + ':' + t.seq : null
}

function targetOf (v, strict) {
  if (!isPlain(v) || !isHex64(v.author) || !isSeq(v.seq)) return null
  if (strict && !exactKeys(v, TARGET_KEYS)) return null
  return { author: v.author, seq: v.seq }
}

function mediaOf (v, strict) {
  if (v === null || v === undefined) return v === null || !strict ? { ok: true, value: null } : { ok: false }
  if (!Array.isArray(v) || v.length > MAX_MEDIA_PER_POST) return { ok: false }
  if (v.length === 0) return strict ? { ok: false } : { ok: true, value: null }
  if (!v.every(validDescriptor) && !validPair(v)) return { ok: false }
  return { ok: true, value: v.map((d) => ({ ...d })) }
}

// A video post's media, as records.js validPostMedia: [JPEG poster, video].
function validPair (v) {
  const pair = videoPair(v)
  return pair !== null && validDescriptor(pair.poster) && validVideoDescriptor(pair.video)
}

function cardOf (v) {
  if (v === null) return { ok: true, value: null }
  if (!isPlain(v) || !exactKeys(v, CARD_KEYS)) return { ok: false }
  const host = cardUrlHost(v.url)
  if (host === null || v.host !== host) return { ok: false }
  const title = cardTextLength(v.title)
  const desc = cardTextLength(v.desc)
  if (title < 0 || title > MAX_CARD_TITLE || desc < 0 || desc > MAX_CARD_DESC) return { ok: false }
  let image = null
  if (v.image !== null) {
    if (!validDescriptor(v.image) || v.image.mime !== 'image/jpeg' || v.image.bytes > MAX_CARD_IMAGE_BYTES) return { ok: false }
    image = { ...v.image }
  }
  return { ok: true, value: { url: v.url, host: v.host, title: v.title, desc: v.desc, image } }
}

function avatarField (v, strict) {
  if (v === null || v === undefined) return v === null || !strict ? { ok: true, value: null } : { ok: false }
  const avatar = avatarOf(v)
  if (avatar === null) return strict ? { ok: false } : { ok: true, value: null }
  return { ok: true, value: avatar }
}

// A FeedItem (post or repost, as A Rua and Membro hold them) as a fresh
// canonical copy, or null. `strict` (parsing): exactly the shape. Otherwise
// extra keys are ignored and a missing optional field reads as null.
function itemOf (v, strict) {
  if (!isPlain(v)) return null
  const repost = v.kind === 'repost'
  if (!repost && v.kind !== 'post') return null
  if (strict && !exactKeys(v, repost ? REPOST_KEYS : POST_KEYS)) return null
  const loose = (x) => (x === undefined && !strict ? null : x)
  const name = loose(v.name)
  const username = loose(v.username)
  if (!isHex64(v.author) || !isSeq(v.seq) || !isAt(v.at) || !isName(name) || !isUsername(username)) return null
  const out = { kind: v.kind, author: v.author, name, username, seq: v.seq, at: v.at }
  if (repost) {
    const to = targetOf(v.to, strict)
    if (to === null) return null
    if (strict && (v.text !== null || v.replyTo !== null || v.quote !== null || v.media !== null || v.preview !== null)) return null
    return Object.assign(out, { to, text: null, replyTo: null, quote: null, media: null, preview: null })
  }
  if (typeof v.text !== 'string' || v.text.length > MAX_TEXT_UNITS) return null
  const rawReply = loose(v.replyTo)
  const replyTo = rawReply === null ? null : targetOf(rawReply, strict)
  const rawQuote = loose(v.quote)
  const quote = rawQuote === null ? null : targetOf(rawQuote, strict)
  if ((rawReply !== null && replyTo === null) || (rawQuote !== null && quote === null) || (replyTo !== null && quote !== null)) return null
  const media = mediaOf(v.media, strict)
  const preview = cardOf(loose(v.preview))
  if (!media.ok || !preview.ok) return null
  return Object.assign(out, { text: v.text, replyTo, quote, media: media.value, preview: preview.value })
}

// A resolved original stored under `ref`: a post of that very author and seq.
function originalOf (v, ref, strict) {
  const item = itemOf(v, strict)
  if (item === null || item.kind !== 'post' || item.author !== authorOfRef(ref) || item.seq !== seqOfRef(ref)) return null
  return item
}

// The own diary's post or repost record (protocol section 2), or null.
function recordOf (v, strict) {
  if (!isPlain(v) || !isAt(v.at)) return null
  if (v.type === 'repost') {
    if (strict ? !exactKeys(v, REPOST_RECORD_KEYS) : !keysWithin(v, REPOST_RECORD_KEYS)) return null
    const to = targetOf(v.to, true)
    if (to === null || typeof v.on !== 'boolean') return null
    return { type: 'repost', to, on: v.on, at: v.at }
  }
  if (v.type !== 'post') return null
  if (!POST_RECORD_KEYS.every((k) => hasOwn(v, k)) || !keysWithin(v, POST_RECORD_KEYS.concat(POST_RECORD_EXTRA))) return null
  if (typeof v.text !== 'string' || v.text.length > MAX_TEXT_UNITS) return null
  const replyTo = v.replyTo === null ? null : targetOf(v.replyTo, true)
  if (v.replyTo !== null && replyTo === null) return null
  const out = { type: 'post', text: v.text, at: v.at, replyTo }
  if (hasOwn(v, 'quote')) {
    const quote = v.quote === null ? null : targetOf(v.quote, true)
    if (v.quote !== null && quote === null) return null
    out.quote = quote
  }
  if (hasOwn(v, 'media')) {
    const media = mediaOf(v.media, true)
    if (!media.ok) return null
    out.media = media.value
  }
  if (hasOwn(v, 'card')) {
    const card = cardOf(v.card)
    if (!card.ok) return null
    out.card = card.value
  }
  return out
}

function profileOf (v, strict) {
  if (!isPlain(v)) return null
  if (strict && !exactKeys(v, PROFILE_KEYS)) return null
  const loose = (x) => (x === undefined && !strict ? null : x)
  const name = loose(v.name)
  const username = loose(v.username)
  const bio = loose(v.bio)
  if (!isName(name) || !isUsername(username) || !isBio(bio)) return null
  const avatar = avatarField(v.avatar, strict)
  if (!avatar.ok) return null
  return { name, username, bio, avatar: avatar.value }
}

function mapOf (v, max, validKey, entry) {
  if (!isPlain(v)) return null
  const keys = Object.keys(v)
  if (keys.length > max) return null
  const out = {}
  for (const k of keys) {
    if (!validKey(k)) return null
    const e = entry(v[k], k)
    if (e === null) return null
    out[k] = e
  }
  return out
}

// The refs a list of rows points at (reposted, quoted, replied to) and one
// level further, kept from `originalAt` only for authors `ok` allows.
function originalsFor (targets, ok, originalAt) {
  const out = {}
  const take = (ref) => {
    if (ref === null || hasOwn(out, ref) || !ok(authorOfRef(ref)) || Object.keys(out).length >= MAX_ORIGINALS) return
    const item = originalAt(ref)
    if (item) out[ref] = item
  }
  for (const ref of targets) take(ref)
  for (const ref of targets) {
    const o = ref !== null && hasOwn(out, ref) ? out[ref] : null
    if (o) {
      take(refOfTarget(o.quote))
      take(refOfTarget(o.replyTo))
    }
  }
  return out
}

function recordTargets (rows) {
  const refs = []
  for (const { record } of rows) {
    if (record.type === 'repost') refs.push(refOfTarget(record.to))
    else refs.push(refOfTarget(record.quote), refOfTarget(record.replyTo))
  }
  return refs
}

function itemTargets (items) {
  const refs = []
  for (const item of items) {
    if (item.kind === 'repost') refs.push(refOfTarget(item.to))
    else refs.push(refOfTarget(item.quote), refOfTarget(item.replyTo))
  }
  return refs
}

function envelope (kind, { origin, association, owner, now }, body) {
  return { v: SCREEN_SNAPSHOT_VERSION, kind, origin, association, owner, savedAt: now, body }
}

// The longest prefix of `list` whose envelope fits `max` bytes, or null.
function fitPrefix (list, make, max) {
  for (let n = list.length; n >= 0; n--) {
    const out = make(list.slice(0, n))
    if (out !== null && bytesOf(out) <= max) return out
  }
  return null
}

function buildDiario (id, { log, originals, followed, blocked }) {
  if (!isPlain(log) || !Array.isArray(log.entries) || (log.key !== undefined && log.key !== id.owner)) return null
  const block = keySet(blocked)
  const known = followTest(followed)
  const ok = (a) => !block.has(a) && (a === id.owner || known(a))
  let oldest = null
  const rows = []
  let truncated = false
  const all = log.entries.concat(Array.isArray(log.invalid) ? log.invalid : [])
  for (const e of all) {
    if (isPlain(e) && isSeq(e.seq) && (oldest === null || e.seq < oldest)) oldest = e.seq
  }
  for (const e of log.entries.slice().sort((a, b) => (b && b.seq) - (a && a.seq))) {
    if (!isPlain(e) || !isSeq(e.seq)) continue
    // Likes, follows, group joins, keys and the rest are never kept.
    const record = recordOf(e.record, false)
    if (record === null) continue
    if (rows.length < MAX_ROWS) rows.push({ seq: e.seq, record })
    else truncated = true
  }
  const atEnd = log.entriesTruncated === 0
  const at = getter(originals)
  const originalAt = (ref) => originalOf(at(ref), ref, false)
  return fitPrefix(rows, (kept) => {
    // A cut page is no longer the whole page: the next `before` is the
    // oldest row kept (rows past MAX_ROWS count as cut too).
    const cut = truncated || kept.length < rows.length
    const bound = cut ? (kept.length > 0 ? kept[kept.length - 1].seq : null) : oldest
    if (bound === null) return null
    return envelope('diario', id, { rows: kept, oldest: bound, atEnd: cut ? false : atEnd, originals: originalsFor(recordTargets(kept), ok, originalAt) })
  }, SCREEN_SNAPSHOT_MAX_BYTES)
}

function buildPerfil (id, { profile }) {
  if (!isPlain(profile) || (profile.author !== undefined && String(profile.author).toLowerCase() !== id.owner)) return null
  const body = profileOf(profile, false)
  return body === null ? null : envelope('perfil', id, body)
}

// One author's entry: their own rows only, originals of the own or followed
// authors, cut to fit MEMBER_ENTRY_MAX_BYTES.
function memberEntry (author, { header, items, before, atEnd, originals }, ok, now) {
  const h = profileOf(header, false)
  if (h === null || !Array.isArray(items)) return null
  const rows = []
  for (const raw of items.slice(0, MAX_ITEMS)) {
    const item = itemOf(raw, false)
    if (item === null || item.author !== author) continue
    if (item.kind === 'repost' && !ok(item.to.author)) continue
    rows.push(item)
  }
  // Items past MAX_ITEMS are cut too: the next page must start below the
  // oldest item kept, not at the live page's bound.
  const truncated = items.length > MAX_ITEMS
  // Nothing kept of a cut page leaves no bound to continue from: no entry.
  if (truncated && rows.length === 0) return null
  const at = getter(originals)
  const originalAt = (ref) => originalOf(at(ref), ref, false)
  const whole = isSeq(before) || before === null
  return fitPrefix(rows, (kept) => {
    const cut = truncated || kept.length < rows.length
    const bound = cut ? (kept.length > 0 ? kept[kept.length - 1].seq : null) : (whole ? before : null)
    return { openedAt: now, header: h, items: kept, before: bound, atEnd: cut ? false : atEnd === true, originals: originalsFor(itemTargets(kept), ok, originalAt) }
  }, MEMBER_ENTRY_MAX_BYTES)
}

function buildMembro (id, { previous, author, header, items, before, atEnd, originals, followed, blocked }) {
  const key = typeof author === 'string' ? author.toLowerCase() : ''
  const block = keySet(blocked)
  const known = followTest(followed)
  // Only a followed author: a diary the member only visits is not kept.
  if (!isHex64(key) || key === id.owner || block.has(key) || !known(key)) return null
  const ok = (a) => !block.has(a) && (a === id.owner || known(a))
  const entry = memberEntry(key, { header, items, before, atEnd, originals }, ok, id.now)
  if (entry === null) return null
  const same = previous && previous.kind === 'membro' && previous.origin === id.origin &&
    previous.association === id.association && previous.owner === id.owner && isPlain(previous.body) && isPlain(previous.body.authors)
  // Each author's entry ages on its own: refreshing one never extends
  // another past SCREEN_SNAPSHOT_MAX_AGE_MS.
  const others = same
    ? Object.entries(previous.body.authors).filter(([a, e]) => a !== key && !block.has(a) && known(a) && fresh(e, id.now))
    : []
  // Most recently opened first; the oldest go when over the limits.
  others.sort((a, b) => b[1].openedAt - a[1].openedAt)
  const list = [[key, entry]].concat(others).slice(0, MEMBER_MAX_AUTHORS)
  return fitPrefix(list, (kept) => kept.length === 0 ? null : envelope('membro', id, { authors: Object.fromEntries(kept) }), SCREEN_SNAPSHOT_MAX_BYTES)
}

function groupRowOf (v) {
  if (!isPlain(v) || !isHex64(v.community) || !isHex64(v.group) || typeof v.role !== 'string' || !ROLE.test(v.role)) return null
  // Geral is titled by its community, as Conversas shows it.
  const label = typeof v.title === 'string' && v.title !== '' ? v.title : v.name
  const name = v.visibility === 'public' && typeof label === 'string' && label.length <= MAX_NAME_UNITS ? label : null
  return { community: v.community, group: v.group, role: v.role, general: v.general === true, name }
}

function buildConversasGrupos (id, { rows }) {
  if (!Array.isArray(rows)) return null
  const out = []
  const seen = new Set()
  for (const raw of rows) {
    const row = groupRowOf(raw)
    if (row === null || seen.has(row.group)) continue
    seen.add(row.group)
    out.push(row)
  }
  return fitPrefix(out.slice(0, MAX_GROUP_ROWS), (kept) => envelope('conversasGrupos', id, { rows: kept }), SCREEN_SNAPSHOT_MAX_BYTES)
}

function communityRowOf (v) {
  if (!isPlain(v) || !isHex64(v.community) || typeof v.role !== 'string' || !ROLE.test(v.role)) return null
  if (v.state !== 'ready' && v.state !== 'pending') return null
  // A community is public (protocol, communities); a row that says
  // otherwise keeps no name.
  const pub = v.visibility === undefined || v.visibility === 'public'
  const name = pub && typeof v.name === 'string' && v.name.length <= MAX_NAME_UNITS ? v.name : null
  const join = v.join === 'open' || v.join === 'approval' ? v.join : null
  const general = isHex64(v.general) ? v.general : null
  return { community: v.community, name, join, state: v.state, role: v.role, general }
}

function buildComunidades (id, { rows }) {
  if (!Array.isArray(rows) || rows.length > MAX_COMMUNITIES) return null
  const out = []
  const seen = new Set()
  for (const raw of rows) {
    const row = communityRowOf(raw)
    if (row === null) return null
    // One row per community, as the list keys them.
    if (seen.has(row.community)) return null
    seen.add(row.community)
    out.push(row)
  }
  return fitPrefix(out, (kept) => envelope('comunidades', id, { rows: kept }), SCREEN_SNAPSHOT_MAX_BYTES)
}

const BUILDERS = {
  diario: buildDiario,
  perfil: buildPerfil,
  membro: buildMembro,
  conversasGrupos: buildConversasGrupos,
  comunidades: buildComunidades
}

// -> the envelope to store, or null (unknown kind, bad identity, a page
// actor, nothing to keep, or over the size cap). `input` per kind:
// - diario: { log (a log.read answer of the own diary), originals (Map or
//   object ref -> post item), followed (Set, list or function), blocked }
// - perfil: { profile (the own profile.read entry) }
// - membro: { previous (the parsed 'membro' snapshot or null), author,
//   header, items, before, atEnd, originals, followed, blocked }; refused
//   for an author not in `followed`.
// - conversasGrupos: { rows (Conversas group rows, with `visibility`) }
// - comunidades: { rows (community.list rows) }; duplicate keys refused.
export function buildScreenSnapshot (kind, { origin, association, owner, acting, now = Date.now(), ...input } = {}) {
  try {
    if (!isKind(kind) || !actingAsMember(acting)) return null
    if (!validOrigin(origin) || !isHex64(association) || !isHex64(owner) || !Number.isSafeInteger(now) || now < 0) return null
    return BUILDERS[kind]({ origin, association, owner, now }, input)
  } catch {
    return null
  }
}

function parseDiario (b) {
  if (!Array.isArray(b.rows) || b.rows.length > MAX_ROWS || !isSeq(b.oldest) || typeof b.atEnd !== 'boolean') return null
  const rows = []
  let last = Infinity
  for (const r of b.rows) {
    if (!isPlain(r) || !exactKeys(r, ['seq', 'record']) || !isSeq(r.seq) || r.seq >= last || r.seq < b.oldest) return null
    last = r.seq
    const record = recordOf(r.record, true)
    if (record === null) return null
    rows.push({ seq: r.seq, record })
  }
  const originals = mapOf(b.originals, MAX_ORIGINALS, isRef, (e, ref) => originalOf(e, ref, true))
  if (originals === null) return null
  return { rows, oldest: b.oldest, atEnd: b.atEnd, originals }
}

function parseMemberEntry (e, author, owner) {
  if (!isPlain(e) || !exactKeys(e, MEMBER_KEYS) || !Number.isSafeInteger(e.openedAt) || e.openedAt < 0) return null
  if (!(e.before === null || isSeq(e.before)) || typeof e.atEnd !== 'boolean') return null
  if (bytesOf(e) > MEMBER_ENTRY_MAX_BYTES) return null
  const header = profileOf(e.header, true)
  if (header === null || !Array.isArray(e.items) || e.items.length > MAX_ITEMS) return null
  const items = e.items.map((i) => itemOf(i, true))
  if (items.some((i) => i === null || i.author !== author)) return null
  const originals = mapOf(e.originals, MAX_ORIGINALS, isRef, (o, ref) => originalOf(o, ref, true))
  if (originals === null) return null
  return { openedAt: e.openedAt, header, items, before: e.before, atEnd: e.atEnd, originals }
}

function parseMembro (b, owner) {
  const authors = mapOf(b.authors, MEMBER_MAX_AUTHORS, (k) => isHex64(k) && k !== owner, (e, k) => parseMemberEntry(e, k, owner))
  return authors === null ? null : { authors }
}

function parseRows (list, max, keys, rowOf, key) {
  if (!Array.isArray(list) || list.length > max) return null
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (!isPlain(raw) || !exactKeys(raw, keys)) return null
    const row = rowOf(raw)
    if (row === null || seen.has(row[key])) return null
    // The canonical form is what a build writes: anything else was not.
    if (keys.some((k) => row[k] !== raw[k])) return null
    seen.add(row[key])
    out.push(row)
  }
  return out
}

function parseConversasGrupos (b) {
  const rows = parseRows(b.rows, MAX_GROUP_ROWS, GROUP_ROW_KEYS, (r) => {
    if (typeof r.general !== 'boolean' || !isName(r.name)) return null
    const row = groupRowOf({ ...r, visibility: 'public' })
    return row === null ? null : { ...row, general: r.general, name: r.name }
  }, 'group')
  return rows === null ? null : { rows }
}

function parseComunidades (b) {
  const rows = parseRows(b.rows, MAX_COMMUNITIES, COMMUNITY_ROW_KEYS, (r) => {
    if (!isName(r.name) || !(r.join === null || r.join === 'open' || r.join === 'approval') || !(r.general === null || isHex64(r.general))) return null
    return communityRowOf({ ...r, visibility: undefined })
  }, 'community')
  return rows === null ? null : { rows }
}

function parseBody (kind, b, owner) {
  if (!isPlain(b) || !exactKeys(b, BODY_KEYS[kind])) return null
  if (kind === 'diario') return parseDiario(b)
  if (kind === 'perfil') return profileOf(b, true)
  if (kind === 'membro') return parseMembro(b, owner)
  if (kind === 'conversasGrupos') return parseConversasGrupos(b)
  return parseComunidades(b)
}

// -> the envelope, or null when the text is not exactly a `kind` snapshot of
// this origin, association and owner (owner omitted = not checked), when
// acting as a page, or when it is older than SCREEN_SNAPSHOT_MAX_AGE_MS or
// dated in the future. Never throws.
export function parseScreenSnapshot (text, kind, { origin, association, owner, acting, now = Date.now() } = {}) {
  try {
    if (!isKind(kind) || !actingAsMember(acting)) return null
    // A UTF-16 unit is at least one UTF-8 byte: the cheap check goes first.
    if (typeof text !== 'string' || text.length > SCREEN_SNAPSHOT_MAX_BYTES || utf8ByteLength(text) > SCREEN_SNAPSHOT_MAX_BYTES) return null
    const s = JSON.parse(text)
    if (!isPlain(s) || !exactKeys(s, TOP_KEYS) || s.v !== SCREEN_SNAPSHOT_VERSION || s.kind !== kind) return null
    if (!validOrigin(s.origin) || s.origin !== origin) return null
    if (!isHex64(s.association) || s.association !== association) return null
    if (!isHex64(s.owner) || (owner !== undefined && owner !== null && s.owner !== owner)) return null
    if (!Number.isSafeInteger(s.savedAt) || s.savedAt < 0 || !Number.isSafeInteger(now)) return null
    if (now - s.savedAt > SCREEN_SNAPSHOT_MAX_AGE_MS || s.savedAt - now > FUTURE_SLACK_MS) return null
    let body = parseBody(kind, s.body, s.owner)
    if (body === null) return null
    if (kind === 'membro') {
      body = { authors: Object.fromEntries(Object.entries(body.authors).filter(([, e]) => fresh(e, now))) }
    }
    return { v: s.v, kind, origin: s.origin, association: s.association, owner: s.owner, savedAt: s.savedAt, body }
  } catch {
    return null
  }
}

// A 'membro' entry is kept for SCREEN_SNAPSHOT_MAX_AGE_MS from its own
// openedAt, whatever the envelope's savedAt says.
function fresh (entry, now) {
  // A time ahead of the clock (past the envelope's slack) is not fresh: it
  // would otherwise outlive every later save.
  return Number.isSafeInteger(entry.openedAt) && now - entry.openedAt <= SCREEN_SNAPSHOT_MAX_AGE_MS &&
    entry.openedAt - now <= FUTURE_SLACK_MS
}

function withBody (snapshot, body) {
  return { v: snapshot.v, kind: snapshot.kind, origin: snapshot.origin, association: snapshot.association, owner: snapshot.owner, savedAt: snapshot.savedAt, body }
}

function filterOriginals (originals, ok) {
  const out = {}
  for (const [ref, item] of Object.entries(originals)) if (ok(authorOfRef(ref))) out[ref] = item
  return out
}

// Rewrites the author-bearing kinds ('membro', 'diario') so only authors
// `ok` allows stay; the other kinds hold no other author and stay as they
// are. -> a new snapshot, or null.
function prune (snapshot, ok) {
  const b = snapshot.body
  if (snapshot.kind === 'diario') {
    // An own repost of a dropped author goes with that author's originals.
    const rows = b.rows.filter((r) => r.record.type !== 'repost' || r.record.to.author === snapshot.owner || ok(r.record.to.author))
    return withBody(snapshot, { ...b, rows, originals: filterOriginals(b.originals, (a) => a === snapshot.owner || ok(a)) })
  }
  if (snapshot.kind !== 'membro') return snapshot
  const authors = {}
  for (const [author, e] of Object.entries(b.authors)) {
    if (!ok(author)) continue
    // As the node leaves out a dropped author's reposts.
    const items = e.items.filter((i) => i.kind !== 'repost' || i.to.author === snapshot.owner || ok(i.to.author))
    const cut = items.length < e.items.length
    authors[author] = { ...e, items, before: cut ? (items.length > 0 ? items[items.length - 1].seq : null) : e.before, atEnd: cut ? false : e.atEnd, originals: filterOriginals(e.originals, (a) => a === snapshot.owner || ok(a)) }
  }
  return withBody(snapshot, { authors })
}

// Without anything of `keys` (a Set or list of hex keys). -> a new snapshot,
// or null.
export function screenWithoutAuthors (snapshot, keys) {
  try {
    const drop = keySet(keys)
    return prune(snapshot, (a) => !drop.has(a))
  } catch {
    return null
  }
}

// Only the own diary and `allowed` (a Set or list of hex keys, e.g. the
// follow list now). -> a new snapshot, or null.
export function screenKeepOnlyAuthors (snapshot, allowed) {
  try {
    const keep = keySet(allowed)
    return prune(snapshot, (a) => keep.has(a))
  } catch {
    return null
  }
}

const MEMBER = Object.freeze({ kind: 'me' })

// The per-platform store over a raw text store { load(kind), save(kind,
// text), clear(kind) } (each never throws). Registers once with
// ./localCaches.js: a wipe removes every kind; a block or an unfollow
// rewrites 'membro' and 'diario'.
export function createScreenSnapshotStore (raw) {
  const clear = (kind) => { try { raw.clear(kind) } catch {} }
  const clearAll = () => { for (const kind of SCREEN_SNAPSHOT_KINDS) clear(kind) }
  const loadText = (kind) => {
    try {
      const text = raw.load(kind)
      return typeof text === 'string' ? text : null
    } catch {
      return null
    }
  }
  const saveText = (kind, text) => { try { raw.save(kind, text) } catch {} }

  // Checked against its own stored binding: a purge can run before the
  // screen mounts. A text that does not parse, or a failed change, goes.
  function rewrite (kind, change) {
    const text = loadText(kind)
    if (text === null) return
    let bound = null
    try {
      const s = JSON.parse(text)
      bound = { origin: s.origin, association: s.association }
    } catch {}
    const snapshot = bound === null ? null : parseScreenSnapshot(text, kind, { ...bound, acting: MEMBER })
    const next = snapshot === null ? null : change(snapshot)
    if (next === null) {
      clear(kind)
      return
    }
    const out = JSON.stringify(next)
    if (out !== text) saveText(kind, out)
  }

  registerLocalCache({
    wipe: clearAll,
    dropAuthors: (keys) => {
      for (const kind of ['membro', 'diario']) rewrite(kind, (s) => screenWithoutAuthors(s, keys))
    },
    keepOnlyAuthors: (allowed) => {
      for (const kind of ['membro', 'diario']) rewrite(kind, (s) => screenKeepOnlyAuthors(s, allowed))
    }
  })

  // -> the stored `kind` snapshot for `binding` ({ origin, association,
  // owner, acting, now? }), or null. A page actor reads nothing and removes
  // nothing; a text that does not parse for the member is removed.
  function load (kind, binding = {}) {
    if (!isKind(kind) || !actingAsMember(binding.acting)) return null
    const text = loadText(kind)
    if (text === null) return null
    const snapshot = parseScreenSnapshot(text, kind, binding)
    if (snapshot === null) clear(kind)
    return snapshot
  }

  // `gen`: cacheGeneration() read when the save was prepared (before a
  // debounce or a read). A wipe or prune since then discards it, so work in
  // flight never recreates what a purge removed. -> whether it was written.
  function save (kind, snapshot, gen) {
    if (!isKind(kind) || gen !== cacheGeneration()) return false
    if (!isPlain(snapshot) || snapshot.kind !== kind || snapshot.v !== SCREEN_SNAPSHOT_VERSION) return false
    let text
    try { text = JSON.stringify(snapshot) } catch { return false }
    if (utf8ByteLength(text) > SCREEN_SNAPSHOT_MAX_BYTES) return false
    saveText(kind, text)
    return true
  }

  return {
    loadScreenSnapshot: load,
    saveScreenSnapshot: save,
    clearScreenSnapshot: (kind) => { if (isKind(kind)) clear(kind) },
    clearScreenSnapshots: clearAll
  }
}
