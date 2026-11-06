'use strict'

// Link cards (docs/protocol.md, "Link cards"): what the sender's device read
// once from a page it linked, carried next to the text so readers never
// contact the site. `{ url, host, title, desc, image }`: `url` an https URL,
// `host` its lowercase hostname, `title` and `desc` short texts with the
// post text character rules, `image` a thumbnail descriptor or null. What
// kind of descriptor `image` is depends on where the card travels (a post,
// a DM, a public or a private group), so each caller passes its own image
// validator; every one bounds the thumbnail to MAX_CARD_IMAGE_BYTES.
//
// No imports from lib/records.js: records.js validates post previews with
// this module, and a require cycle would leave one side empty. The URL,
// host and text rules and the caps live in @varanda/rpc (lib/link-card.js),
// so the account service and the app build cards by the same rules; the
// character rule there is records.js isForbiddenChar spelled out again, and
// packages/core/test/link-card.test.js checks parity. Never throws.

const { MAX_CARD_URL, MAX_CARD_TITLE, MAX_CARD_DESC, MAX_CARD_IMAGE_BYTES, cardUrlHost, cardTextLength } = require('@varanda/rpc')

const CARD_KEYS = Object.freeze(['url', 'host', 'title', 'desc', 'image'])
const CARD_IMAGE_MIME = 'image/jpeg'

function isPlainObject (v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

function validCardText (s, max) {
  const n = cardTextLength(s)
  return n >= 0 && n <= max
}

// A card with exactly CARD_KEYS whose image is null or passes validImage
// (the caller's descriptor rule, which must bound the bytes). Never throws.
function validLinkCard (card, validImage) {
  try {
    if (!isPlainObject(card) || !hasExactKeys(card, CARD_KEYS)) return false
    const host = cardUrlHost(card.url)
    if (host === null || card.host !== host) return false
    if (!validCardText(card.title, MAX_CARD_TITLE) || !validCardText(card.desc, MAX_CARD_DESC)) return false
    return card.image === null || (typeof validImage === 'function' && validImage(card.image) === true)
  } catch {
    return false
  }
}

// The thumbnail bound every image validator applies to its own `bytes`.
function validCardImageBytes (bytes) {
  return Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= MAX_CARD_IMAGE_BYTES
}

// A copy with exactly the card keys, the image copied by copyImage
// (anything else is passed through for validation to reject).
function copyLinkCard (card, copyImage) {
  if (!isPlainObject(card)) return card
  const out = {}
  for (const k of CARD_KEYS) out[k] = card[k]
  if (isPlainObject(out.image) && typeof copyImage === 'function') out.image = copyImage(out.image)
  return out
}

module.exports = {
  CARD_KEYS,
  MAX_CARD_URL,
  MAX_CARD_TITLE,
  MAX_CARD_DESC,
  MAX_CARD_IMAGE_BYTES,
  CARD_IMAGE_MIME,
  cardUrlHost,
  cardTextLength,
  validLinkCard,
  validCardImageBytes,
  copyLinkCard
}
