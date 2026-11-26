// Row validators shared by the snapshot kinds of ./screenSnapshot.js and the
// codecs it delegates to (./peekSnapshot.js): a FeedItem and a profile entry
// as a fresh canonical copy. Pure: no React, no react-native, no Node
// built-ins.

import rpc from '@varanda/rpc'
import { avatarOf } from './media/avatar.js'
import { validDescriptor, validVideoDescriptor } from './media/fetch.js'
import { MAX_MEDIA_PER_POST, videoPair } from './media/plan.js'
import { validThumbs } from './media/variant.js'
import { validAlt } from './mediaAlt.js'

const { MAX_NAME, MAX_BIO, MAX_TEXT, MAX_CARD_TITLE, MAX_CARD_DESC, MAX_CARD_IMAGE_BYTES, cardTextLength, cardUrlHost } = rpc

export const MAX_AT = 32
// Caps in UTF-16 units: a character is at most two.
export const MAX_NAME_UNITS = MAX_NAME * 2
export const MAX_BIO_UNITS = MAX_BIO * 2
export const MAX_TEXT_UNITS = MAX_TEXT * 2

const HEX64 = /^[0-9a-f]{64}$/
const USERNAME = /^[a-z][a-z0-9_]{2,19}$/
export const POST_KEYS = Object.freeze(['kind', 'author', 'name', 'username', 'seq', 'at', 'text', 'replyTo', 'quote', 'media', 'preview'])
export const REPOST_KEYS = Object.freeze(['kind', 'author', 'name', 'username', 'seq', 'at', 'to', 'text', 'replyTo', 'quote', 'media', 'preview'])
const CARD_KEYS = ['url', 'host', 'title', 'desc', 'image']
const TARGET_KEYS = ['author', 'seq']
export const PROFILE_KEYS = Object.freeze(['name', 'username', 'bio', 'avatar'])
// A post item may also carry `thumbs` (docs/rpc.md 5.13), stored only when present.
// and `alt` (5.64, descriptions) likewise.
export function postKeysFor (v, base = POST_KEYS) {
  return base.concat(hasOwn(v, 'thumbs') ? ['thumbs'] : [], hasOwn(v, 'alt') ? ['alt'] : [])
}

export const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
export const isHex64 = (v) => typeof v === 'string' && HEX64.test(v)
export const isSeq = (v) => Number.isSafeInteger(v) && v >= 1
export const isAt = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_AT
export const isName = (v) => v === null || (typeof v === 'string' && v.length <= MAX_NAME_UNITS)
export const isUsername = (v) => v === null || (typeof v === 'string' && USERNAME.test(v))
export const isBio = (v) => v === null || (typeof v === 'string' && v.length <= MAX_BIO_UNITS)

export function isPlain (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export function exactKeys (o, keys) {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => hasOwn(o, k))
}

export function targetOf (v, strict) {
  if (!isPlain(v) || !isHex64(v.author) || !isSeq(v.seq)) return null
  if (strict && !exactKeys(v, TARGET_KEYS)) return null
  return { author: v.author, seq: v.seq }
}

export function mediaOf (v, strict) {
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

export function cardOf (v) {
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

export function avatarField (v, strict) {
  if (v === null || v === undefined) return v === null || !strict ? { ok: true, value: null } : { ok: false }
  const avatar = avatarOf(v)
  if (avatar === null) return strict ? { ok: false } : { ok: true, value: null }
  return { ok: true, value: avatar }
}

// A FeedItem (post or repost, as A Rua and Membro hold them) as a fresh
// canonical copy, or null. `strict` (parsing): exactly the shape. Otherwise
// extra keys are ignored and a missing optional field reads as null.
export function itemOf (v, strict) {
  if (!isPlain(v)) return null
  const repost = v.kind === 'repost'
  if (!repost && v.kind !== 'post') return null
  if (strict && !exactKeys(v, repost ? REPOST_KEYS : postKeysFor(v))) return null
  // A poll post is never kept: the snapshot has no poll, so it is left out and
  // fetched live (the callers skip a null row).
  if (hasOwn(v, 'poll') || hasOwn(v, 'event')) return null
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
  const thumbs = thumbsField(v, media.value, strict)
  if (!thumbs.ok) return null
  Object.assign(out, { text: v.text, replyTo, quote, media: media.value, preview: preview.value })
  if (thumbs.value !== null) out.thumbs = thumbs.value
  const alt = altField(v, media.value, strict)
  if (!alt.ok) return null
  if (alt.value !== null) out.alt = alt.value
  return out
}

// A post item's `thumbs` (validThumbs of ./media/variant.js: aligned with
// media, each null or a valid thumbnail descriptor). value null = not stored.
// Parsing (strict), a stored list that is not valid fails the item like a bad
// `media`; building, an invalid one is only left out (the row then shows the
// full size).
export function thumbsField (v, media, strict) {
  if (!hasOwn(v, 'thumbs') || (!strict && v.thumbs === undefined)) return { ok: true, value: null }
  if (validThumbs(v.thumbs, media)) return { ok: true, value: v.thumbs.map((d) => (d === null ? null : { ...d })) }
  return strict ? { ok: false } : { ok: true, value: null }
}

// A post item's `alt` (validAlt of ../mediaAlt.js), handled like thumbsField.
export function altField (v, media, strict) {
  if (!hasOwn(v, 'alt') || (!strict && v.alt === undefined)) return { ok: true, value: null }
  if (validAlt(v.alt, media)) return { ok: true, value: v.alt.slice() }
  return strict ? { ok: false } : { ok: true, value: null }
}

export function profileOf (v, strict) {
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
