'use strict'

// Signup invite card: the signed greeting a member attaches to a signup
// invite link. The card travels in the URL fragment (never sent to a server)
// and a short public query '?c=N' names the design for the messenger preview.
// This module only builds and parses; it never verifies a signature.

const { utf8Encode, utf8Decode, isDisplayUnsafe } = require('./text')

const INVITE_CARD_MAX_URL = 400
const FRAGMENT_MARK = '#c1.'
const NAME_MAX = 40
const MESSAGE_MAX_BYTES = 200
// design, expires, name length, message length, member, signature
const FIXED_BYTES = 1 + 4 + 1 + 1 + 32 + 64

// Append-only: a card stores the index, so an id never moves or goes away.
const DESIGNS = Object.freeze([
  'marajoara', 'aguas', 'vitoria',
  'cordel', 'bandeirinhas', 'chita',
  'ipe', 'pantanal',
  'azulejo', 'copacabana', 'minas',
  'araucaria', 'chimarrao'
])

const REGIONS = Object.freeze([
  Object.freeze({ id: 'norte', designs: Object.freeze(['marajoara', 'aguas', 'vitoria']) }),
  Object.freeze({ id: 'nordeste', designs: Object.freeze(['cordel', 'bandeirinhas', 'chita']) }),
  Object.freeze({ id: 'centro-oeste', designs: Object.freeze(['ipe', 'pantanal']) }),
  Object.freeze({ id: 'sudeste', designs: Object.freeze(['azulejo', 'copacabana', 'minas']) }),
  Object.freeze({ id: 'sul', designs: Object.freeze(['araucaria', 'chimarrao']) })
])

// Same origin rule as apps/app/src/signupInvite.js.
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1(:[0-9]{1,5})?$/
const CODE_RE = /^[A-Za-z0-9_-]{43}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const URL_RE = /^(?:https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?|http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?|varanda:\/\/)\/convite\/([A-Za-z0-9_-]{43})\/?(?:\?c=(0|[1-9][0-9]{0,2}))?#c1\.([A-Za-z0-9_-]*)$/

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i
  return t
})()

function designIndex (id) {
  return typeof id === 'string' ? DESIGNS.indexOf(id) : -1
}

function designAt (index) {
  return Number.isInteger(index) && index >= 0 && index < DESIGNS.length ? DESIGNS[index] : null
}

function isInviteCode (s) {
  return typeof s === 'string' && CODE_RE.test(s)
}

function isInviteCardExpires (n) {
  return Number.isSafeInteger(n) && n > 0 && n < 2 ** 32
}

function isOrigin (origin) {
  return typeof origin === 'string' && (HTTPS_ORIGIN.test(origin) || LOOPBACK_ORIGIN.test(origin))
}

// Trimmed NFC text of 1..maxCodePoints code points with nothing from the
// displayText unsafe set (LF only when multiline), or null.
function canonicalInviteCardText (value, maxCodePoints, opts) {
  if (typeof value !== 'string') return null
  const multiline = opts !== null && typeof opts === 'object' && opts.multiline === true
  // Checked before normalize so a lone surrogate never reaches it.
  for (const ch of value) {
    if (isDisplayUnsafe(ch.codePointAt(0), multiline)) return null
  }
  const out = value.trim().normalize('NFC')
  let count = 0
  for (const ch of out) {
    if (isDisplayUnsafe(ch.codePointAt(0), multiline)) return null
    count++
  }
  return count >= 1 && count <= maxCodePoints ? out : null
}

function base64urlEncode (bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64[n >> 18] + B64[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63]
  }
  return out
}

// Bytes of an unpadded base64url string, or null. The caller rejects a
// non-canonical spelling by re-encoding.
function base64urlDecode (str) {
  if (str.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor(str.length * 3 / 4))
  let o = 0
  let acc = 0
  let bits = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    const v = c < 128 ? B64_INDEX[c] : -1
    if (v < 0) return null
    acc = ((acc << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out
}

function hexBytes (hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesHex (bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
  return out
}

function canonicalName (name) {
  const out = canonicalInviteCardText(name, NAME_MAX)
  return out !== null && out === name ? out : null
}

function canonicalMessage (message) {
  const out = canonicalInviteCardText(message, MESSAGE_MAX_BYTES, { multiline: true })
  return out !== null && out === message ? out : null
}

function urlPrefix (origin, code, index) {
  return origin + '/convite/' + code + '?c=' + index + FRAGMENT_MARK
}

// UTF-8 bytes still free for the message once origin, code, design, name and
// expires are fixed (0 when none, or when an input is invalid).
function messageRoom ({ origin, code, design, name, expires } = {}) {
  const index = designIndex(design)
  if (!isOrigin(origin) || !isInviteCode(code) || index < 0 || !isInviteCardExpires(expires)) return 0
  if (canonicalName(name) === null) return 0
  const chars = INVITE_CARD_MAX_URL - urlPrefix(origin, code, index).length
  if (chars <= 0) return 0
  // The longest body whose unpadded base64url fits `chars` characters.
  const bodyBytes = Math.floor(chars * 3 / 4)
  const room = bodyBytes - FIXED_BYTES - utf8Encode(name).length
  return Math.max(0, Math.min(room, MESSAGE_MAX_BYTES))
}

function buildInviteCardUrl ({ origin, code, design, name, message, expires, member, signature } = {}) {
  const index = designIndex(design)
  if (!isOrigin(origin) || !isInviteCode(code) || index < 0 || !isInviteCardExpires(expires)) return null
  if (typeof member !== 'string' || !HEX64.test(member)) return null
  if (typeof signature !== 'string' || !HEX128.test(signature)) return null
  if (canonicalName(name) === null || canonicalMessage(message) === null) return null
  const nameBytes = utf8Encode(name)
  const messageBytes = utf8Encode(message)
  if (messageBytes.length > MESSAGE_MAX_BYTES) return null
  const body = new Uint8Array(FIXED_BYTES + nameBytes.length + messageBytes.length)
  let o = 0
  body[o++] = index
  body[o++] = (expires >>> 24) & 0xff
  body[o++] = (expires >>> 16) & 0xff
  body[o++] = (expires >>> 8) & 0xff
  body[o++] = expires & 0xff
  body[o++] = nameBytes.length
  body.set(nameBytes, o)
  o += nameBytes.length
  body[o++] = messageBytes.length
  body.set(messageBytes, o)
  o += messageBytes.length
  body.set(hexBytes(member), o)
  o += 32
  body.set(hexBytes(signature), o)
  const url = urlPrefix(origin, code, index) + base64urlEncode(body)
  return url.length <= INVITE_CARD_MAX_URL ? url : null
}

// Same rule as clean in apps/app/src/linkReturn.js.
function cleanUrl (url) {
  if (typeof url !== 'string' || url.length > INVITE_CARD_MAX_URL || /[\s\\]/.test(url)) return false
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return false
  }
  return true
}

function decodeText (bytes) {
  try {
    return utf8Decode(bytes)
  } catch {
    return null
  }
}

function parseInviteCardUrl (url) {
  if (!cleanUrl(url)) return null
  const m = URL_RE.exec(url)
  if (m === null) return null
  const code = m[1]
  const query = m[2]
  const body = m[3]
  const bytes = base64urlDecode(body)
  if (bytes === null || base64urlEncode(bytes) !== body) return null
  if (bytes.length < FIXED_BYTES) return null
  let o = 0
  const design = designAt(bytes[o++])
  if (design === null) return null
  if (query !== undefined && Number(query) !== DESIGNS.indexOf(design)) return null
  const expires = ((bytes[o] << 24) >>> 0) + (bytes[o + 1] << 16) + (bytes[o + 2] << 8) + bytes[o + 3]
  o += 4
  if (!isInviteCardExpires(expires)) return null
  const nameLen = bytes[o++]
  if (o + nameLen + 1 > bytes.length) return null
  const name = decodeText(bytes.subarray(o, o + nameLen))
  o += nameLen
  const messageLen = bytes[o++]
  if (messageLen > MESSAGE_MAX_BYTES) return null
  if (o + messageLen + 96 !== bytes.length) return null
  const message = decodeText(bytes.subarray(o, o + messageLen))
  o += messageLen
  if (name === null || canonicalName(name) === null) return null
  if (message === null || canonicalMessage(message) === null) return null
  const member = bytesHex(bytes.subarray(o, o + 32))
  const signature = bytesHex(bytes.subarray(o + 32, o + 96))
  return { code, design, name, message, expires, member, signature }
}

module.exports = {
  INVITE_CARD_MAX_URL,
  FRAGMENT_MARK,
  NAME_MAX,
  MESSAGE_MAX_BYTES,
  DESIGNS,
  REGIONS,
  designIndex,
  designAt,
  isInviteCode,
  isInviteCardExpires,
  canonicalInviteCardText,
  buildInviteCardUrl,
  parseInviteCardUrl,
  messageRoom
}
