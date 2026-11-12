// A Rua's last first page, kept so the next cold start can paint it at once
// while the node starts and feed.read answers. Pure: no React, no
// react-native, no Node built-ins; the per-platform text store lives in
// ./feedSnapshotStore.*.js.
//
// Why it is safe to keep: only rows of the own diary and of followed diaries
// are stored, with the names, counts, own like/repost state and resolved
// originals (reposted, quoted and reply-parent posts) of those same
// authors. Those blocks already sit unencrypted in this device's replicas
// (the node downloads every followed diary), so the snapshot holds nothing
// the device did not already hold. A reposted original, quote, reply parent
// or name of an author who is neither own nor followed is never stored:
// that row then renders as it does while its original is unresolved.
// Nothing of the Espiadinha, DMs, groups or notices is ever stored here.
//
// Shape (version 1): { v, origin, association, owner, savedAt, cursor,
// items, names, counts, liked, reposted, originals }
// - items: FeedItems newest first (as A Rua holds them), at most
//   FEED_LIMIT_DEFAULT; cursor: the feed.read cursor of the oldest one.
// - names: author -> { name, username, avatar?, page?, closed?, moved? }
//   (the names cache view without the bio; no avatar key = not known).
// - counts: ref -> { replies, likes, reposts, quotes }; liked, reposted:
//   lists of refs; originals: ref -> post item.
// Refs are 'author:seq' with a lowercase author, as A Rua keys them.

import rpc from '@varanda/rpc'
import { avatarOf } from './media/avatar.js'
import { validDescriptor, validVideoDescriptor } from './media/fetch.js'
import { MAX_MEDIA_PER_POST, videoPair } from './media/plan.js'

const { FEED_LIMIT_DEFAULT, MAX_NAME, MAX_TEXT, MAX_CARD_TITLE, MAX_CARD_DESC, MAX_CARD_IMAGE_BYTES, cardTextLength, cardUrlHost, utf8ByteLength } = rpc

export const SNAPSHOT_VERSION = 1
// UTF-8 bytes of the JSON text: a synchronous read at start must stay cheap.
export const SNAPSHOT_MAX_BYTES = 524288
export const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
// A clock moved back a little must not throw away a good snapshot.
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000

// Per row at most: its own ref, a repost target or a quote or a reply
// parent, and one level further (what that original quotes or replies to).
const MAX_ENTRIES = 4 * FEED_LIMIT_DEFAULT
const MAX_ORIGIN = 2048
const MAX_AT = 32
// Caps in UTF-16 units: a character is at most two.
const MAX_NAME_UNITS = MAX_NAME * 2
const MAX_TEXT_UNITS = MAX_TEXT * 2

const HEX64 = /^[0-9a-f]{64}$/
const REF = /^[0-9a-f]{64}:[1-9][0-9]{0,15}$/
const USERNAME = /^[a-z][a-z0-9_]{2,19}$/
const TOP_KEYS = ['v', 'origin', 'association', 'owner', 'savedAt', 'cursor', 'items', 'names', 'counts', 'liked', 'reposted', 'originals']
const POST_KEYS = ['kind', 'author', 'name', 'username', 'seq', 'at', 'text', 'replyTo', 'quote', 'media', 'preview']
const REPOST_KEYS = ['kind', 'author', 'name', 'username', 'seq', 'at', 'to', 'text', 'replyTo', 'quote', 'media', 'preview']
const NAME_KEYS = ['name', 'username', 'avatar', 'page', 'closed', 'moved']
const COUNT_KEYS = ['replies', 'likes', 'reposts', 'quotes']
const CARD_KEYS = ['url', 'host', 'title', 'desc', 'image']
const CURSOR_KEYS = ['at', 'author', 'seq']
const TARGET_KEYS = ['author', 'seq']

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
const isHex64 = (v) => typeof v === 'string' && HEX64.test(v)
const isSeq = (v) => Number.isSafeInteger(v) && v >= 1
const isRef = (v) => typeof v === 'string' && REF.test(v) && isSeq(Number(v.slice(65)))
const authorOfRef = (ref) => ref.slice(0, 64)
const seqOfRef = (ref) => Number(ref.slice(65))
const isAt = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_AT
const isName = (v) => v === null || (typeof v === 'string' && v.length <= MAX_NAME_UNITS)
const isUsername = (v) => v === null || (typeof v === 'string' && USERNAME.test(v))
const validOrigin = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_ORIGIN

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

function refOfTarget (t) {
  return t && isHex64(t.author) && isSeq(t.seq) ? t.author + ':' + t.seq : null
}

// { author, seq } copy, or null. `strict`: exactly those keys.
function targetOf (v, strict) {
  if (!isPlain(v) || !isHex64(v.author) || !isSeq(v.seq)) return null
  if (strict && !exactKeys(v, TARGET_KEYS)) return null
  return { author: v.author, seq: v.seq }
}

function cursorOf (v) {
  if (!isPlain(v) || !exactKeys(v, CURSOR_KEYS) || !isAt(v.at) || !isHex64(v.author) || !isSeq(v.seq)) return null
  return { at: v.at, author: v.author, seq: v.seq }
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

function cardImageOf (v) {
  if (v === null) return { ok: true, value: null }
  if (!validDescriptor(v) || v.mime !== 'image/jpeg' || v.bytes > MAX_CARD_IMAGE_BYTES) return { ok: false }
  return { ok: true, value: { ...v } }
}

function previewOf (v) {
  if (v === null) return { ok: true, value: null }
  if (!isPlain(v) || !exactKeys(v, CARD_KEYS)) return { ok: false }
  const host = cardUrlHost(v.url)
  if (host === null || v.host !== host) return { ok: false }
  const title = cardTextLength(v.title)
  const desc = cardTextLength(v.desc)
  if (title < 0 || title > MAX_CARD_TITLE || desc < 0 || desc > MAX_CARD_DESC) return { ok: false }
  const image = cardImageOf(v.image)
  if (!image.ok) return { ok: false }
  return { ok: true, value: { url: v.url, host: v.host, title: v.title, desc: v.desc, image: image.value } }
}

// A FeedItem (or a resolved original, which may carry `avatar`) as a fresh
// canonical copy, or null. `strict` (parsing): no key beyond the shape, and
// every one present. Otherwise (building from screen state) extra keys are
// ignored and a missing name or username reads as null.
function itemOf (v, strict) {
  if (!isPlain(v)) return null
  const repost = v.kind === 'repost'
  if (!repost && v.kind !== 'post') return null
  if (strict) {
    const keys = repost ? REPOST_KEYS : POST_KEYS
    if (!keys.every((k) => hasOwn(v, k)) || !keysWithin(v, keys.concat(['avatar']))) return null
  }
  const name = v.name === undefined && !strict ? null : v.name
  const username = v.username === undefined && !strict ? null : v.username
  if (!isHex64(v.author) || !isSeq(v.seq) || !isAt(v.at) || !isName(name) || !isUsername(username)) return null
  const out = { kind: v.kind, author: v.author, name, username, seq: v.seq, at: v.at }
  if (repost) {
    const to = targetOf(v.to, strict)
    if (to === null) return null
    if (strict && (v.text !== null || v.replyTo !== null || v.quote !== null || v.media !== null || v.preview !== null)) return null
    Object.assign(out, { to, text: null, replyTo: null, quote: null, media: null, preview: null })
  } else {
    if (typeof v.text !== 'string' || v.text.length > MAX_TEXT_UNITS) return null
    const rawReply = v.replyTo === undefined && !strict ? null : v.replyTo
    const replyTo = rawReply === null ? null : targetOf(rawReply, strict)
    if (rawReply !== null && replyTo === null) return null
    const rawQuote = v.quote === undefined && !strict ? null : v.quote
    const quote = rawQuote === null ? null : targetOf(rawQuote, strict)
    if (rawQuote !== null && quote === null) return null
    if (replyTo !== null && quote !== null) return null
    const media = mediaOf(v.media, strict)
    if (!media.ok) return null
    const preview = previewOf(v.preview === undefined && !strict ? null : v.preview)
    if (!preview.ok) return null
    Object.assign(out, { text: v.text, replyTo, quote, media: media.value, preview: preview.value })
  }
  if (hasOwn(v, 'avatar') && v.avatar !== undefined) {
    if (v.avatar === null) out.avatar = null
    else {
      const avatar = avatarOf(v.avatar)
      if (avatar === null) {
        if (strict) return null
        out.avatar = null
      } else {
        out.avatar = avatar
      }
    }
  }
  return out
}

// A resolved original stored under `ref`: a post of that very author and seq.
function originalOf (v, ref, strict) {
  const item = itemOf(v, strict)
  if (item === null || item.kind !== 'post' || item.author !== authorOfRef(ref) || item.seq !== seqOfRef(ref)) return null
  return item
}

// The names cache view without the bio, or null. No avatar key = unknown
// (undefined in the cache), which is not "no photo" (null).
function nameEntryOf (v, strict) {
  if (!isPlain(v)) return null
  if (strict && (!hasOwn(v, 'name') || !hasOwn(v, 'username') || !keysWithin(v, NAME_KEYS))) return null
  const name = v.name === undefined && !strict ? null : v.name
  const username = v.username === undefined && !strict ? null : v.username
  if (!isName(name) || !isUsername(username)) return null
  const out = { name, username }
  if (v.avatar !== undefined) {
    if (v.avatar === null) out.avatar = null
    else {
      const avatar = avatarOf(v.avatar)
      if (avatar !== null) out.avatar = avatar
      else if (strict) return null
    }
  } else if (strict && hasOwn(v, 'avatar')) {
    return null
  }
  if (v.page === true) {
    out.page = true
    out.closed = v.closed === true
    out.moved = v.moved === true
  }
  if (strict) {
    if (hasOwn(v, 'page') && v.page !== true) return null
    for (const k of ['closed', 'moved']) {
      if (hasOwn(v, k) && (v.page !== true || typeof v[k] !== 'boolean')) return null
    }
    if (v.page === true && (!hasOwn(v, 'closed') || !hasOwn(v, 'moved'))) return null
  }
  if (out.name === null && out.username === null && out.avatar === undefined && out.page !== true) return null
  return out
}

function countsOf (v) {
  if (!isPlain(v) || !exactKeys(v, COUNT_KEYS)) return null
  if (!COUNT_KEYS.every((k) => Number.isSafeInteger(v[k]) && v[k] >= 0)) return null
  return { replies: v.replies, likes: v.likes, reposts: v.reposts, quotes: v.quotes }
}

// The ref a row's counts, hearts and actions use: a repost acts on its original.
function rowRef (row) {
  return row.kind === 'repost' ? refOfTarget(row.to) : row.author + ':' + row.seq
}

// Lookups over a Map, a plain object, a Set or an array, whichever the
// screen state holds.
function getter (src) {
  if (src instanceof Map) return (k) => src.get(k)
  if (isPlain(src)) return (k) => (hasOwn(src, k) ? src[k] : undefined)
  return () => undefined
}

function tester (src) {
  if (src instanceof Set) return (k) => src.has(k)
  if (Array.isArray(src)) {
    const set = new Set(src)
    return (k) => set.has(k)
  }
  return () => false
}

function keySet (src) {
  if (src instanceof Set) return src
  if (Array.isArray(src)) return new Set(src)
  return new Set()
}

// Everything that depends on `rows`, from the given sources, keeping only
// what `ok(author)` allows (names, originals) and only the rows' own refs
// (counts, liked, reposted).
function assemble (rows, ok, { nameOf, countOf, isLiked, isReposted, originalAt }) {
  const shown = []
  const first = []
  for (const row of rows) {
    const ref = rowRef(row)
    if (ref !== null) shown.push(ref)
    if (row.kind === 'repost') first.push(ref)
    else first.push(refOfTarget(row.quote), refOfTarget(row.replyTo))
  }
  const originals = {}
  const asked = []
  const take = (ref) => {
    if (ref === null || hasOwn(originals, ref)) return
    asked.push(ref)
    if (!ok(authorOfRef(ref))) return
    const item = originalAt(ref)
    if (item) originals[ref] = item
  }
  for (const ref of first) take(ref)
  for (const ref of first) {
    const o = ref !== null && hasOwn(originals, ref) ? originals[ref] : null
    if (o) {
      take(refOfTarget(o.quote))
      take(refOfTarget(o.replyTo))
    }
  }
  const names = {}
  const authors = rows.map((r) => r.author).concat(asked.map(authorOfRef))
  for (const author of authors) {
    if (hasOwn(names, author) || !ok(author)) continue
    const entry = nameOf(author)
    if (entry) names[author] = entry
  }
  const counts = {}
  const liked = []
  const reposted = []
  for (const ref of shown) {
    if (hasOwn(counts, ref)) continue
    const c = countOf(ref)
    if (c) counts[ref] = c
    if (isLiked(ref) && !liked.includes(ref)) liked.push(ref)
    if (isReposted(ref) && !reposted.includes(ref)) reposted.push(ref)
  }
  return { items: rows, names, counts, liked, reposted, originals }
}

function sourcesOf (snapshot) {
  return {
    nameOf: (a) => (hasOwn(snapshot.names, a) ? snapshot.names[a] : null),
    countOf: (r) => (hasOwn(snapshot.counts, r) ? snapshot.counts[r] : null),
    isLiked: tester(snapshot.liked),
    isReposted: tester(snapshot.reposted),
    originalAt: (r) => (hasOwn(snapshot.originals, r) ? snapshot.originals[r] : null)
  }
}

function snapshotBytes (snapshot) {
  return utf8ByteLength(JSON.stringify(snapshot))
}

// -> the snapshot to store, or null (bad identity, nothing to show, or not
// even one row fits SNAPSHOT_MAX_BYTES). `items` newest first; `isKnown`
// (author) -> true for followed authors; `blocked` a Set of hex keys.
export function buildSnapshot ({ origin, association, owner, items, cursor, profileOf, counts, liked, reposted, originals, isKnown, blocked, now = Date.now() } = {}) {
  try {
    if (!validOrigin(origin) || !isHex64(association) || !isHex64(owner) || !Array.isArray(items) || !Number.isSafeInteger(now)) return null
    const known = typeof isKnown === 'function' ? isKnown : () => false
    const block = keySet(blocked)
    const ok = (a) => !block.has(a) && (a === owner || known(a) === true)
    const head = items.slice(0, FEED_LIMIT_DEFAULT)
    const rows = []
    let whole = items.length <= FEED_LIMIT_DEFAULT
    for (const raw of head) {
      const row = itemOf(raw, false)
      // Rows stay a contiguous run from the top, so the cursor stays exact.
      if (row === null) {
        whole = false
        break
      }
      // The browser node drops a blocked author's posts and reposts of them.
      if (block.has(row.author) || (row.kind === 'repost' && block.has(row.to.author))) {
        whole = false
        continue
      }
      // Only the own diary and followed authors are kept.
      if (!ok(row.author)) {
        whole = false
        continue
      }
      rows.push(row)
    }
    const profile = typeof profileOf === 'function' ? profileOf : () => null
    const countAt = getter(counts)
    const originalSrc = getter(originals)
    const sources = {
      nameOf: (a) => nameEntryOf(profile(a), false),
      countOf: (r) => countsOf(countAt(r)),
      isLiked: tester(liked),
      isReposted: tester(reposted),
      originalAt: (r) => originalOf(originalSrc(r), r, false)
    }
    const given = cursorOf(cursor)
    for (let n = rows.length; n > 0; n--) {
      const kept = rows.slice(0, n)
      const last = kept[kept.length - 1]
      const bound = whole && n === rows.length && given !== null ? given : { at: last.at, author: last.author, seq: last.seq }
      const snapshot = { v: SNAPSHOT_VERSION, origin, association, owner, savedAt: now, cursor: bound, ...assemble(kept, ok, sources) }
      if (snapshotBytes(snapshot) <= SNAPSHOT_MAX_BYTES) return snapshot
    }
    return null
  } catch {
    return null
  }
}

function refList (v) {
  if (!Array.isArray(v) || v.length > FEED_LIMIT_DEFAULT) return null
  if (!v.every(isRef) || new Set(v).size !== v.length) return null
  return v.slice()
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

// -> the snapshot, or null when the text is not exactly a snapshot of this
// origin, association and owner (owner omitted = not checked), or when it
// is older than SNAPSHOT_MAX_AGE_MS or dated in the future. Never throws.
export function parseSnapshot (text, { origin, association, owner, now = Date.now() } = {}) {
  try {
    // A UTF-16 unit is at least one UTF-8 byte: the cheap check goes first.
    if (typeof text !== 'string' || text.length > SNAPSHOT_MAX_BYTES || utf8ByteLength(text) > SNAPSHOT_MAX_BYTES) return null
    const s = JSON.parse(text)
    if (!isPlain(s) || !exactKeys(s, TOP_KEYS) || s.v !== SNAPSHOT_VERSION) return null
    if (!validOrigin(s.origin) || s.origin !== origin) return null
    if (!isHex64(s.association) || s.association !== association) return null
    if (!isHex64(s.owner) || (owner !== undefined && owner !== null && s.owner !== owner)) return null
    if (!Number.isSafeInteger(s.savedAt) || s.savedAt < 0 || !Number.isSafeInteger(now)) return null
    if (now - s.savedAt > SNAPSHOT_MAX_AGE_MS || s.savedAt - now > FUTURE_SLACK_MS) return null
    const cursor = s.cursor === null ? null : cursorOf(s.cursor)
    if (s.cursor !== null && cursor === null) return null
    if (!Array.isArray(s.items) || s.items.length > FEED_LIMIT_DEFAULT) return null
    const items = s.items.map((i) => itemOf(i, true))
    if (items.includes(null)) return null
    const names = mapOf(s.names, MAX_ENTRIES, isHex64, (e) => nameEntryOf(e, true))
    const counts = mapOf(s.counts, FEED_LIMIT_DEFAULT, isRef, countsOf)
    const originals = mapOf(s.originals, MAX_ENTRIES, isRef, (e, ref) => originalOf(e, ref, true))
    const liked = refList(s.liked)
    const reposted = refList(s.reposted)
    if (names === null || counts === null || originals === null || liked === null || reposted === null) return null
    return { v: s.v, origin: s.origin, association: s.association, owner: s.owner, savedAt: s.savedAt, cursor, items, names, counts, liked, reposted, originals }
  } catch {
    return null
  }
}

function rebuild (snapshot, rows, allow) {
  const ok = (a) => a === snapshot.owner || allow(a)
  return {
    v: snapshot.v,
    origin: snapshot.origin,
    association: snapshot.association,
    owner: snapshot.owner,
    savedAt: snapshot.savedAt,
    // The rows removed sat between the kept ones and this cursor, and their
    // authors are left out of later pages too, so it stays the right bound.
    cursor: snapshot.cursor,
    ...assemble(rows, ok, sourcesOf(snapshot))
  }
}

// Without the rows of `keys` (a Set or list of hex keys), reposts of their
// posts included (as the node leaves out a blocked author's reposts), and
// without their names and originals. -> a new snapshot, or null.
export function withoutAuthors (snapshot, keys) {
  try {
    const drop = keySet(keys)
    const rows = snapshot.items.filter((r) => !drop.has(r.author) && !(r.kind === 'repost' && drop.has(r.to.author)))
    return rebuild(snapshot, rows, (a) => !drop.has(a))
  } catch {
    return null
  }
}

// Only the rows of the own diary and of `allowed` (a Set or list of hex
// keys, e.g. the follow list now). A repost by an allowed author of someone
// else's post stays; its original goes unless that author is allowed too.
// -> a new snapshot, or null.
export function keepOnlyAuthors (snapshot, allowed) {
  try {
    const keep = keySet(allowed)
    const rows = snapshot.items.filter((r) => r.author === snapshot.owner || keep.has(r.author))
    return rebuild(snapshot, rows, (a) => keep.has(a))
  } catch {
    return null
  }
}

// A Rua's feed state seed: loadedAt stays null, so the screen still treats
// the page as not loaded and reads feed.read as usual.
export function initialFeedState (snapshot) {
  return { items: snapshot.items.slice(), cursor: snapshot.cursor, loadedAt: null }
}

// The social state seed (Maps and Sets, as useSocial keeps them), with only
// the refs the snapshot's rows show.
export function socialSeed (snapshot) {
  const parts = assemble(snapshot.items, () => true, sourcesOf(snapshot))
  return {
    counts: new Map(Object.entries(parts.counts)),
    liked: new Set(parts.liked),
    reposted: new Set(parts.reposted),
    originals: new Map(Object.entries(parts.originals))
  }
}
