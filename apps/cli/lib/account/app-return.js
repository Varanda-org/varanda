'use strict'

const nodeCrypto = require('node:crypto')

// The pure rules of the native app's account sign-in (RFC 8252 pattern), used
// by ./server.js and ./age-routes.js. The app's provider step runs in the
// system browser, which shares no cookie jar with the app, so the link cookie
// of the web flow is replaced by two proofs:
//
//   - V, a 32-byte secret the app keeps in memory; start carries only
//     appProof = base64url(sha256(V)) and every later step sends V itself
//     (header x-varanda-link);
//   - R, a one-time redeem code minted by the Google callback and handed to
//     the app only through the varanda:// redirect (header x-varanda-redeem).
//
// Neither secret is ever logged; the server keeps appProof and a hash of R.

const CLIENT_HEADER = 'x-varanda-client'
const CLIENT_APP = 'app'
const LINK_HEADER = 'x-varanda-link'
const REDEEM_HEADER = 'x-varanda-redeem'
// 32 bytes, base64url without padding (the store's randomToken shape).
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const OUTCOMES = Object.freeze(['ok', 'erro', 'cancelado', 'lista-de-espera', 'convite-invalido'])
const ACCOUNT_RETURN = 'varanda://conta'
const AGE_RETURN = 'varanda://idade?volta=1'

function isAppRequest (req) {
  return req.headers[CLIENT_HEADER] === CLIENT_APP
}

// Exactly the base64url (no padding) of 32 bytes. Non-canonical spellings
// (stray low bits in the last character) are refused, so one value has one
// spelling and the comparisons below compare like with like.
function isToken (value) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) return false
  const buf = Buffer.from(value, 'base64url')
  return buf.length === 32 && buf.toString('base64url') === value
}

function isAppProof (value) {
  return isToken(value)
}

function hashToken (value) {
  return nodeCrypto.createHash('sha256').update(value, 'utf8').digest('base64url')
}

// The appProof that V proves: base64url(sha256(the 32 bytes of V)), or null
// for anything that is not a well-formed V.
function proofOf (link) {
  if (!isToken(link)) return null
  return nodeCrypto.createHash('sha256').update(Buffer.from(link, 'base64url')).digest('base64url')
}

// Constant-time equality of two strings; false for anything else or when
// the lengths differ (the length of a hash is public).
function safeEqual (a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  if (x.length !== y.length) return false
  return nodeCrypto.timingSafeEqual(x, y)
}

// A fresh redeem code: { code, hash }. Only `hash` is kept server-side.
function mintRedeem () {
  const code = nodeCrypto.randomBytes(32).toString('base64url')
  return { code, hash: hashToken(code) }
}

// True when `code` is a well-formed redeem code whose hash is `hash`.
function redeemMatches (code, hash) {
  if (!isToken(code) || typeof hash !== 'string') return false
  return safeEqual(hashToken(code), hash)
}

// The fixed account return. Anything outside OUTCOMES reads as 'erro'; the
// code rides only on 'ok' and only in its exact shape.
function accountReturnUrl (outcome, code) {
  const known = OUTCOMES.includes(outcome) ? outcome : 'erro'
  let url = ACCOUNT_RETURN + '?conta=' + known
  if (known === 'ok' && isToken(code)) url += '&codigo=' + code
  return url
}

function ageReturnUrl () {
  return AGE_RETURN
}

function header (req, name) {
  const value = req.headers[name]
  return typeof value === 'string' ? value : null
}

module.exports = {
  CLIENT_HEADER,
  CLIENT_APP,
  LINK_HEADER,
  REDEEM_HEADER,
  OUTCOMES,
  isAppRequest,
  isAppProof,
  proofOf,
  safeEqual,
  mintRedeem,
  redeemMatches,
  accountReturnUrl,
  ageReturnUrl,
  header
}
