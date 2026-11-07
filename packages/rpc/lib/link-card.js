'use strict'

// The pure rules of a link card (docs/protocol.md, "Link cards"), shared by
// every place that builds or checks one: core validates cards with them, and
// the account service and the app use them before fetching a page and when
// cutting its title and description, so a card they build always passes
// core. Zero dependencies, no Node built-ins. Never throws.

const MAX_CARD_URL = 300
const MAX_CARD_TITLE = 80
const MAX_CARD_DESC = 160
// A re-encoded JPEG thumbnail, one media block at most.
const MAX_CARD_IMAGE_BYTES = 32768
const MAX_HOST = 253

// Printable ASCII an href keeps unescaped (RFC 3986 unreserved, reserved
// and `%`). No space, quote, backslash, angle bracket, brace, pipe or
// control: a URL with any other character is not the canonical form the
// sender's device writes, and a backslash reads as a slash in browsers.
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
// The last label starts with a letter: no IPv4 literal, no bare number.
const TLD = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PORT = /^[1-9][0-9]{0,4}$/
const SPACES = /\s+/g
const SPACE = /\s/

// The post text character rule (core lib/records.js isForbiddenChar,
// security audit S5): C0 and C1 controls (LF allowed only when asked), the
// line and paragraph separators and the bidi embedding, override and
// isolate controls.
function isCardForbiddenChar (cp, allowLf) {
  if (cp < 0x20) return !(allowLf && cp === 0x0a)
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp === 0x2028 || cp === 0x2029) return true
  if (cp >= 0x202a && cp <= 0x202e) return true
  return cp >= 0x2066 && cp <= 0x2069
}

// Code points of a well-formed string with no forbidden character, or -1.
function cardTextLength (s) {
  if (typeof s !== 'string') return -1
  let n = 0
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
      if (d < 0xdc00 || d > 0xdfff) return -1
      cp = 0x10000 + ((cp - 0xd800) << 10) + (d - 0xdc00)
      i++
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      return -1
    }
    if (isCardForbiddenChar(cp, true)) return -1
    n++
  }
  return n
}

// What a producer puts in a card's title or desc from text it read (entities
// already decoded): forbidden characters that are not whitespace dropped, a
// lone surrogate as U+FFFD, whitespace collapsed to one space and trimmed,
// cut to `max` code points. Always passes cardTextLength within `max`; ''
// when nothing is left or `raw` is not a string.
function cardText (raw, max) {
  if (typeof raw !== 'string' || !Number.isSafeInteger(max) || max < 1) return ''
  let kept = ''
  for (const ch of raw) {
    const cp = ch.codePointAt(0)
    if (cp >= 0xd800 && cp <= 0xdfff) kept += '\ufffd'
    else if (!isCardForbiddenChar(cp, false) || SPACE.test(ch)) kept += ch
  }
  const points = Array.from(kept.replace(SPACES, ' ').trim())
  return points.length > max ? points.slice(0, max).join('').trim() : points.join('')
}

function validHostname (h) {
  if (typeof h !== 'string' || h.length < 1 || h.length > MAX_HOST) return false
  const labels = h.split('.')
  if (labels.length < 2) return false
  for (const l of labels) {
    if (!LABEL.test(l)) return false
  }
  return TLD.test(labels[labels.length - 1])
}

// The lowercase hostname of an https URL a card may carry, or null:
// `https://` then a hostname with an optional port, no credentials, no IP
// literal, at most MAX_CARD_URL printable ASCII characters. A fragment is
// kept as part of the URL. Never throws.
function cardUrlHost (url) {
  try {
    if (typeof url !== 'string' || url.length > MAX_CARD_URL || !URL_CHARS.test(url)) return null
    if (!url.startsWith('https://')) return null
    const rest = url.slice(8)
    const end = rest.search(/[/?#]/)
    const authority = end === -1 ? rest : rest.slice(0, end)
    // `@` is the credentials separator, `[` an IPv6 literal.
    if (authority.includes('@') || authority.includes('[') || authority.includes(']')) return null
    const colon = authority.indexOf(':')
    const host = colon === -1 ? authority : authority.slice(0, colon)
    if (colon !== -1) {
      const port = authority.slice(colon + 1)
      if (!PORT.test(port) || Number(port) > 65535) return null
    }
    return validHostname(host) ? host : null
  } catch {
    return null
  }
}

module.exports = {
  MAX_CARD_URL,
  MAX_CARD_TITLE,
  MAX_CARD_DESC,
  MAX_CARD_IMAGE_BYTES,
  isCardForbiddenChar,
  cardTextLength,
  cardText,
  cardUrlHost
}
