// Per-screen snapshots: the last first page of a few screens, kept so the
// next cold start can paint them at once while the node starts and the live
// read answers (the same idea as A Rua's ./feedSnapshot.js). Pure: no React,
// no react-native, no Node built-ins; the per-platform text store lives in
// ./screenSnapshotStore.*.js and uses createScreenSnapshotStore below.
//
// What is kept: the own diary and profile, followed diaries, the own group
// and community list with public names, the own and followed live momentos
// without any blob reference, and one kind with posts of people the member
// does NOT follow: 'espiadinha', the last Espiadinha page (./peekSnapshot.js),
// at most 30 rows, 192 KiB and 7 days, without its cursor. Never stored:
// Avisos, DM rows, previews, peers or counts, the name of a private group,
// unread state, media keys or nonces. Every kind is bound to origin,
// association and owner, removed by every wipe of ./localCaches.js
// (lock, sign-out, reset, owner change) and rewritten by a block or a follow
// change. Snapshots are written and read only while acting as the member: a
// page actor never writes one and never reads the member's.
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
// - 'momentos': { authors: [{ author, items }], own: [items], names: [{ author,
//   name, username, avatar }] }: the strip as useMoments holds it (momentsOf
//   of ./momentSeen.js), at most MOMENT_MAX_AUTHORS followed authors with
//   MOMENT_MAX_ITEMS items each and MOMENT_MAX_OWN own items, at most
//   KIND_MAX_BYTES.momentos in all (authors cut from the end). An item is
//   exactly { seq, ref, text, at, media, music? }, media null or { mime, w,
//   h, ms }: never the blob id, key, nonce, chunks, bytes or sha256 (the
//   screen reads the bytes by author and seq). An item past its 24 hours is
//   dropped at parse, and an author left with none.
// - a delegated kind (DELEGATED below): the body its codec builds and
//   parses; the envelope, binding, actor, age and byte checks stay here.
//   'espiadinha': { rows, meta: { diaries, skipped, incomplete } }, see
//   ./peekSnapshot.js.

import rpc from '@varanda/rpc'
import { MAX_MEDIA_DIMENSION, MAX_MOMENT_VIDEO_MS, MAX_VIDEO_DIMENSION, MAX_VIDEO_PIXELS, MEDIA_MIMES, VIDEO_MIME } from './media/plan.js'
import { cacheGeneration, registerLocalCache } from './localCaches.js'
import { MOMENT_MS } from './moments.js'
import { peekCodec } from './peekSnapshot.js'
import { MAX_NAME_UNITS, MAX_TEXT_UNITS, PROFILE_KEYS, avatarField, cardOf, exactKeys, hasOwn, isAt, isHex64, isName, isPlain, isSeq, isUsername, itemOf, mediaOf, profileOf, targetOf } from './snapshotParts.js'

const { isMomentMusic, utf8ByteLength } = rpc

export const SCREEN_SNAPSHOT_VERSION = 1
// Kinds whose body a codec module validates (the codec interface is
// described above buildScreenSnapshot). Imported statically so the store's
// wipe reaches every kind on lock, sign-out, reset and owner change even when
// its screen never mounted.
const DELEGATED = Object.freeze({ espiadinha: peekCodec })
export const SCREEN_SNAPSHOT_KINDS = Object.freeze(['diario', 'perfil', 'membro', 'conversasGrupos', 'comunidades', 'momentos'].concat(Object.keys(DELEGATED)))
// UTF-8 bytes of the whole stored JSON text of one kind, envelope included:
// a synchronous read at start must stay cheap.
export const SCREEN_SNAPSHOT_MAX_BYTES = 262144
// A tighter cap for a kind read on every cold start of A Rua.
export const KIND_MAX_BYTES = Object.freeze({ momentos: 65536 })
export const SCREEN_SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const MEMBER_MAX_AUTHORS = 8
export const MEMBER_ENTRY_MAX_BYTES = 65536
// As moments.read answers (docs/rpc.md 5.113).
export const MOMENT_MAX_AUTHORS = 32
export const MOMENT_MAX_ITEMS = 4
export const MOMENT_MAX_OWN = 4
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
const MAX_MOMENT_TEXT = 200
// packages/core/lib/moments.js MOMENT_SKEW_MS: the live reader hides a momento
// dated further ahead than this.
const MOMENT_SKEW_MS = 10 * 60 * 1000

const REF = /^[0-9a-f]{64}:[1-9][0-9]{0,15}$/
const ROLE = /^[a-z]{1,16}$/
const TOP_KEYS = ['v', 'kind', 'origin', 'association', 'owner', 'savedAt', 'body']
const POST_RECORD_KEYS = ['type', 'text', 'at', 'replyTo']
const POST_RECORD_EXTRA = ['quote', 'media', 'preview']
const REPOST_RECORD_KEYS = ['type', 'to', 'on', 'at']
const MEMBER_KEYS = ['openedAt', 'header', 'items', 'before', 'atEnd', 'originals']
const GROUP_ROW_KEYS = ['community', 'group', 'role', 'general', 'name']
const COMMUNITY_ROW_KEYS = ['community', 'name', 'join', 'state', 'role', 'general']
const MOMENT_ITEM_KEYS = ['seq', 'ref', 'text', 'at', 'media']
const MOMENT_MEDIA_KEYS = ['mime', 'w', 'h', 'ms']
const MOMENT_MUSIC_KEYS = ['id', 'start']
const MOMENT_AUTHOR_KEYS = ['author', 'items']
const MOMENT_NAME_KEYS = ['author', 'name', 'username', 'avatar']
const BODY_KEYS = {
  diario: ['rows', 'oldest', 'atEnd', 'originals'],
  perfil: PROFILE_KEYS,
  membro: ['authors'],
  conversasGrupos: ['rows'],
  comunidades: ['rows'],
  momentos: ['authors', 'own', 'names']
}

const isRef = (v) => typeof v === 'string' && REF.test(v) && isSeq(Number(v.slice(65)))
const authorOfRef = (ref) => ref.slice(0, 64)
const seqOfRef = (ref) => Number(ref.slice(65))
const validOrigin = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_ORIGIN
const isKind = (v) => typeof v === 'string' && SCREEN_SNAPSHOT_KINDS.includes(v)
const bytesOf = (v) => utf8ByteLength(JSON.stringify(v))
const codecOf = (kind) => (hasOwn(DELEGATED, kind) ? DELEGATED[kind] : null)
// A codec may tighten the size and age rules, never loosen them.
const capped = (v, max) => (Number.isSafeInteger(v) && v > 0 ? Math.min(v, max) : max)
const maxBytesOf = (kind) => {
  if (hasOwn(KIND_MAX_BYTES, kind)) return KIND_MAX_BYTES[kind]
  const codec = codecOf(kind)
  return codec === null ? SCREEN_SNAPSHOT_MAX_BYTES : capped(codec.maxBytes, SCREEN_SNAPSHOT_MAX_BYTES)
}
const maxAgeOf = (kind) => {
  const codec = codecOf(kind)
  return codec === null ? SCREEN_SNAPSHOT_MAX_AGE_MS : capped(codec.maxAgeMs, SCREEN_SNAPSHOT_MAX_AGE_MS)
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
  // Same for a poll post record: skipped, never a reason to refuse the page.
  if (hasOwn(v, 'poll') || hasOwn(v, 'event')) return null
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
  if (hasOwn(v, 'preview')) {
    const preview = cardOf(v.preview)
    if (!preview.ok) return null
    out.preview = preview.value
  }
  return out
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
  if (!isPlain(v) || !(v.community === null || isHex64(v.community)) || !isHex64(v.group) || typeof v.role !== 'string' || !ROLE.test(v.role)) return null
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

// A momento's media as the screen needs it to lay out and read it: one blob
// object, never a post descriptor, so validDescriptor does not apply. Only
// the four fields are copied; `strict` (parsing) also wants no other key.
// The bounds are records.js validMomentMedia's: a video within
// MAX_VIDEO_DIMENSION a side and MAX_VIDEO_PIXELS, an image within
// MAX_MEDIA_DIMENSION a side.
function momentMediaOf (v, strict) {
  if (v === null) return { ok: true, value: null }
  if (!isPlain(v) || (strict && !exactKeys(v, MOMENT_MEDIA_KEYS))) return { ok: false }
  const { mime, w, h, ms } = v
  const within = (n, max) => Number.isSafeInteger(n) && n >= 1 && n <= max
  if (mime === VIDEO_MIME) {
    if (!within(w, MAX_VIDEO_DIMENSION) || !within(h, MAX_VIDEO_DIMENSION) || w * h > MAX_VIDEO_PIXELS) return { ok: false }
    if (!within(ms, MAX_MOMENT_VIDEO_MS)) return { ok: false }
  } else if (!MEDIA_MIMES.includes(mime) || !within(w, MAX_MEDIA_DIMENSION) || !within(h, MAX_MEDIA_DIMENSION) || ms !== 0) {
    return { ok: false }
  }
  return { ok: true, value: { mime, w, h, ms } }
}

// momentsOf has already taken the provider out of a valid reference.
function momentMusicField (v) {
  if (!isPlain(v) || !exactKeys(v, MOMENT_MUSIC_KEYS)) return null
  return isMomentMusic({ p: 'audius', id: v.id, start: v.start }) ? { id: v.id, start: v.start } : null
}

const momentTextOk = (v) => typeof v === 'string' && v.length <= MAX_MOMENT_TEXT * 2 && Array.from(v).length <= MAX_MOMENT_TEXT
const momentAtOk = (v) => isAt(v) && Number.isFinite(Date.parse(v))
// Inside its 24 hours and, as the live reader wants, not dated more than
// MOMENT_SKEW_MS ahead of `now`.
const momentLive = (item, now) => {
  const t = Date.parse(item.at)
  return t + MOMENT_MS > now && t - now <= MOMENT_SKEW_MS
}

// One momento of `author` as useMoments holds it, as a fresh copy, or null.
// The same rules build and parse: any other key or a wrong type drops the
// item, and a music that fails drops only the music.
function momentItemOf (v, author, strict) {
  if (!isPlain(v) || !keysWithin(v, MOMENT_ITEM_KEYS.concat(['music'])) || !MOMENT_ITEM_KEYS.every((k) => hasOwn(v, k))) return null
  if (!isSeq(v.seq) || v.ref !== author + ':' + v.seq || !momentTextOk(v.text) || !momentAtOk(v.at)) return null
  const media = momentMediaOf(v.media, strict)
  if (!media.ok) return null
  const out = { seq: v.seq, ref: v.ref, text: v.text, at: v.at, media: media.value }
  // The app ignores music on a video (moments.js momentMusicOf).
  const music = hasOwn(v, 'music') && !(media.value !== null && media.value.mime === VIDEO_MIME) ? momentMusicField(v.music) : null
  if (music !== null) out.music = music
  return out
}

// Valid, live items of `author`, once per seq, at most `max`.
function momentItems (list, author, max, strict, now) {
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (out.length >= max) break
    const item = momentItemOf(raw, author, strict)
    if (item === null || seen.has(item.seq) || !momentLive(item, now)) continue
    seen.add(item.seq)
    out.push(item)
  }
  return out
}

function momentNameOf (v, author, strict) {
  if (!isPlain(v) || (strict && !exactKeys(v, MOMENT_NAME_KEYS))) return null
  const loose = (x) => (x === undefined && !strict ? null : x)
  const name = loose(v.name)
  const username = loose(v.username)
  if (!isName(name) || !isUsername(username)) return null
  const avatar = avatarField(v.avatar, strict)
  if (!avatar.ok) return null
  return { author, name, username, avatar: avatar.value }
}

// A names lookup over a list of { author, ... } entries, a Map, an object or
// a function (a names cache's profileOf).
function nameLookup (src) {
  if (typeof src === 'function') return (k) => src(k)
  if (Array.isArray(src)) {
    const map = new Map()
    for (const e of src) {
      if (isPlain(e) && typeof e.author === 'string') {
        const k = e.author.toLowerCase()
        if (!map.has(k)) map.set(k, e)
      }
    }
    return (k) => map.get(k)
  }
  return getter(src)
}

function buildMomentos (id, { authors, own, names, followed, blocked }) {
  if (!Array.isArray(authors) || !Array.isArray(own)) return null
  const block = keySet(blocked)
  const known = followTest(followed)
  const ok = (a) => !block.has(a) && (a === id.owner || known(a))
  const list = []
  const seen = new Set()
  for (const a of authors) {
    if (list.length >= MOMENT_MAX_AUTHORS) break
    // The owner's moments go in `own`, never among the authors.
    if (!isPlain(a) || !isHex64(a.author) || a.author === id.owner || !Array.isArray(a.items) || seen.has(a.author) || !ok(a.author)) continue
    const items = momentItems(a.items, a.author, MOMENT_MAX_ITEMS, false, id.now)
    if (items.length === 0) continue
    seen.add(a.author)
    list.push({ author: a.author, items })
  }
  const ownItems = momentItems(own, id.owner, MOMENT_MAX_OWN, false, id.now)
  const nameAt = nameLookup(names)
  const nameFor = (author) => momentNameOf(nameAt(author), author, false)
  const ownName = nameFor(id.owner)
  const nameList = new Map(list.map(({ author }) => [author, nameFor(author)]))
  return fitPrefix(list, (kept) => {
    const kNames = ownName === null ? [] : [ownName]
    for (const { author } of kept) {
      const n = nameList.get(author)
      if (n !== null && author !== id.owner) kNames.push(n)
    }
    return envelope('momentos', id, { authors: kept, own: ownItems, names: kNames })
  }, maxBytesOf('momentos'))
}

const BUILDERS = {
  diario: buildDiario,
  perfil: buildPerfil,
  membro: buildMembro,
  conversasGrupos: buildConversasGrupos,
  comunidades: buildComunidades,
  momentos: buildMomentos
}

// A delegated kind's body comes from its codec, cut until the whole envelope
// fits, then read back through the codec's own parse so only what a load
// would accept is ever written.
function buildDelegated (kind, id, input) {
  const codec = codecOf(kind)
  const max = maxBytesOf(kind)
  const fits = (body) => bytesOf(envelope(kind, id, body)) <= max
  const built = codec.build(input, { fits, now: id.now, owner: id.owner })
  if (built === null || built === undefined) return null
  const body = codec.parse(JSON.parse(JSON.stringify(built)), { now: id.now, owner: id.owner })
  if (body === null || body === undefined || !fits(body)) return null
  return envelope(kind, id, body)
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
// - momentos: { authors, own (useMoments' lists, never `past`), names (a
//   list of { author, name, username, avatar }, a Map, an object or a
//   function), followed, blocked }; only the owner and followed, unblocked
//   authors, and a name only for one of them.
// - a delegated kind (DELEGATED): whatever its codec's build takes. A codec
//   is { KIND, maxBytes, maxAgeMs, build(input, { fits, now, owner }),
//   parse(body, { now, owner }), withoutAuthors(body, keys, { now, owner }),
//   keepOnlyAuthors?(body, allowed, { now, owner }) }, each returning a body
//   or null. fits(body) says whether the envelope with that body stays within
//   maxBytes UTF-8 bytes; build cuts until it does and returns null when even
//   its smallest body does not. maxBytes and maxAgeMs never exceed
//   SCREEN_SNAPSHOT_MAX_BYTES and SCREEN_SNAPSHOT_MAX_AGE_MS.
export function buildScreenSnapshot (kind, { origin, association, owner, acting, now = Date.now(), ...input } = {}) {
  try {
    if (!isKind(kind) || !actingAsMember(acting)) return null
    if (!validOrigin(origin) || !isHex64(association) || !isHex64(owner) || !Number.isSafeInteger(now) || now < 0) return null
    const id = { origin, association, owner, now }
    if (codecOf(kind) !== null) return buildDelegated(kind, id, input)
    return BUILDERS[kind](id, input)
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

// The shape is strict (caps, entry keys, one entry per author); an item
// that fails, or is past its 24 hours at `now`, is dropped, then an author
// left with none and that author's name.
function parseMomentos (b, owner, now) {
  if (!Array.isArray(b.authors) || b.authors.length > MOMENT_MAX_AUTHORS) return null
  if (!Array.isArray(b.own) || b.own.length > MOMENT_MAX_OWN) return null
  if (!Array.isArray(b.names) || b.names.length > MOMENT_MAX_AUTHORS + 1) return null
  const stored = new Set()
  const authors = []
  for (const a of b.authors) {
    if (!isPlain(a) || !exactKeys(a, MOMENT_AUTHOR_KEYS) || !isHex64(a.author) || stored.has(a.author)) return null
    if (!Array.isArray(a.items) || a.items.length > MOMENT_MAX_ITEMS) return null
    // The owner never shows among the authors (momentsOf): the entry goes.
    if (a.author === owner) continue
    stored.add(a.author)
    const items = momentItems(a.items, a.author, MOMENT_MAX_ITEMS, true, now)
    if (items.length > 0) authors.push({ author: a.author, items })
  }
  const own = momentItems(b.own, owner, MOMENT_MAX_OWN, true, now)
  const live = new Set(authors.map((a) => a.author))
  const named = new Set()
  const names = []
  for (const raw of b.names) {
    const author = isPlain(raw) ? raw.author : null
    if (!isHex64(author) || named.has(author) || (author !== owner && !stored.has(author))) return null
    const entry = momentNameOf(raw, author, true)
    if (entry === null) return null
    named.add(author)
    if (author === owner || live.has(author)) names.push(entry)
  }
  return { authors, own, names }
}

function parseBody (kind, b, owner, now) {
  if (!isPlain(b) || !exactKeys(b, BODY_KEYS[kind])) return null
  if (kind === 'diario') return parseDiario(b)
  if (kind === 'perfil') return profileOf(b, true)
  if (kind === 'membro') return parseMembro(b, owner)
  if (kind === 'conversasGrupos') return parseConversasGrupos(b)
  if (kind === 'momentos') return parseMomentos(b, owner, now)
  return parseComunidades(b)
}

// -> the envelope, or null when the text is not exactly a `kind` snapshot of
// this origin, association and owner (owner omitted = not checked), when
// acting as a page, or when it is older than SCREEN_SNAPSHOT_MAX_AGE_MS (a
// delegated kind: its codec's maxAgeMs) or dated in the future. Never throws.
export function parseScreenSnapshot (text, kind, { origin, association, owner, acting, now = Date.now() } = {}) {
  try {
    if (!isKind(kind) || !actingAsMember(acting)) return null
    // A UTF-16 unit is at least one UTF-8 byte: the cheap check goes first.
    const max = maxBytesOf(kind)
    if (typeof text !== 'string' || text.length > max || utf8ByteLength(text) > max) return null
    const s = JSON.parse(text)
    if (!isPlain(s) || !exactKeys(s, TOP_KEYS) || s.v !== SCREEN_SNAPSHOT_VERSION || s.kind !== kind) return null
    if (!validOrigin(s.origin) || s.origin !== origin) return null
    if (!isHex64(s.association) || s.association !== association) return null
    if (!isHex64(s.owner) || (owner !== undefined && owner !== null && s.owner !== owner)) return null
    if (!Number.isSafeInteger(s.savedAt) || s.savedAt < 0 || !Number.isSafeInteger(now)) return null
    if (now - s.savedAt > maxAgeOf(kind) || s.savedAt - now > FUTURE_SLACK_MS) return null
    const codec = codecOf(kind)
    let body = codec !== null
      ? (isPlain(s.body) ? codec.parse(s.body, { now, owner: s.owner }) : null)
      : parseBody(kind, s.body, s.owner, now)
    if (body === undefined) body = null
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

// Rewrites the author-bearing kinds ('membro', 'diario', 'momentos') so
// only authors `ok` allows stay; the other kinds hold no other author and
// stay as they are. -> a new snapshot, or null.
function prune (snapshot, ok) {
  const b = snapshot.body
  if (snapshot.kind === 'momentos') {
    const keep = (a) => a === snapshot.owner || ok(a)
    return withBody(snapshot, { authors: b.authors.filter((a) => keep(a.author)), own: b.own, names: b.names.filter((n) => keep(n.author)) })
  }
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

// A delegated kind's body rewritten by its codec. -> a new snapshot, or null.
function delegatedChange (snapshot, fn, keys) {
  if (typeof fn !== 'function') return snapshot
  const body = fn(snapshot.body, keys, { now: Date.now(), owner: snapshot.owner })
  return body === null || body === undefined ? null : withBody(snapshot, body)
}

// Without anything of `keys` (a Set or list of hex keys). -> a new snapshot,
// or null.
export function screenWithoutAuthors (snapshot, keys) {
  try {
    const codec = codecOf(snapshot.kind)
    // A codec without withoutAuthors cannot honour a block: nothing is kept.
    if (codec !== null) return typeof codec.withoutAuthors === 'function' ? delegatedChange(snapshot, codec.withoutAuthors, keys) : null
    const drop = keySet(keys)
    return prune(snapshot, (a) => !drop.has(a))
  } catch {
    return null
  }
}

// Only the own diary and `allowed` (a Set or list of hex keys, e.g. the
// follow list now). A delegated kind applies its codec's keepOnlyAuthors,
// whose meaning is its own ('espiadinha' removes the followed), or stays as
// it is without one. -> a new snapshot, or null.
export function screenKeepOnlyAuthors (snapshot, allowed) {
  try {
    const codec = codecOf(snapshot.kind)
    if (codec !== null) return delegatedChange(snapshot, codec.keepOnlyAuthors, allowed)
    const keep = keySet(allowed)
    return prune(snapshot, (a) => keep.has(a))
  } catch {
    return null
  }
}

const MEMBER = Object.freeze({ kind: 'me' })
const AUTHOR_KINDS = Object.freeze(['membro', 'diario', 'momentos'].concat(Object.keys(DELEGATED)))

// The per-platform store over a raw text store { load(kind), save(kind,
// text), clear(kind) } (each never throws). Registers once with
// ./localCaches.js: a wipe removes every kind; a block or an unfollow
// rewrites 'membro', 'diario', 'momentos' and the delegated kinds.
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

  // -> the text a save may write for `snapshot`, or null.
  function storable (kind, snapshot) {
    if (!isPlain(snapshot) || snapshot.kind !== kind || snapshot.v !== SCREEN_SNAPSHOT_VERSION) return null
    let text
    try { text = JSON.stringify(snapshot) } catch { return null }
    if (utf8ByteLength(text) > maxBytesOf(kind)) return null
    // A hand-built 'momentos' or delegated kind could carry what the strict
    // parser drops (a blob key or nonce): only its own canonical parse is
    // written.
    if (kind === 'momentos' || codecOf(kind) !== null) {
      const again = parseScreenSnapshot(text, kind, { origin: snapshot.origin, association: snapshot.association, owner: snapshot.owner, acting: MEMBER, now: snapshot.savedAt })
      if (again === null || JSON.stringify(again) !== text) return null
    }
    return text
  }

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
    // A delegated kind is re-checked for size and canonical form first.
    const out = codecOf(kind) !== null ? storable(kind, next) : JSON.stringify(next)
    if (out === text) return
    // Fail closed: the old text goes before the filtered copy is written, and
    // a copy that cannot be read back exactly goes too (the raw store swallows
    // its errors, so only a read proves the write).
    clear(kind)
    if (out === null) return
    saveText(kind, out)
    if (loadText(kind) !== out) clear(kind)
  }

  registerLocalCache({
    wipe: clearAll,
    dropAuthors: (keys) => {
      for (const kind of AUTHOR_KINDS) rewrite(kind, (s) => screenWithoutAuthors(s, keys))
    },
    keepOnlyAuthors: (allowed) => {
      for (const kind of AUTHOR_KINDS) rewrite(kind, (s) => screenKeepOnlyAuthors(s, allowed))
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
    const text = storable(kind, snapshot)
    if (text === null) return false
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
