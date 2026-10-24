'use strict'

const crypto = require('node:crypto')

// Server-side Google sign-in for the account service: an authorization URL
// with PKCE (RFC 7636, S256), the code exchange at the token endpoint and the
// userinfo read. Only `sub` and a verified `email` leave this module; the
// access token and the raw id_token are dropped as soon as they are checked.
// Every failure collapses into { ok: false, reason: 'google-recusado' }: no
// token, e-mail, sub or provider body ever reaches an error or a log.
//
// No nonce: state + PKCE + the server cookie bind the transaction, and the code
// is exchanged only here, server to server. No access_type=offline: we never
// want a refresh token.

const DEFAULT_ENDPOINTS = Object.freeze({
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo'
})

const SCOPE = 'openid email'
const TIMEOUT_MS = 10000
const MAX_BODY = 65536
const MAX_ID_TOKEN = 8192
const MAX_EMAIL = 320
const SUB_RE = /^[\x21-\x7e]{1,255}$/
// Google documents both spellings of its issuer for ID tokens.
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com'])
const REFUSED = Object.freeze({ ok: false, reason: 'google-recusado' })

function base64url (buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function pkce () {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function isObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// Reads at most MAX_BODY bytes of a JSON response; anything else throws a bare
// Error (caught by exchange and turned into REFUSED, never surfaced).
async function readJson (res) {
  const type = String(res.headers.get('content-type') || '').toLowerCase()
  if (!type.startsWith('application/json')) throw new Error('not json')
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error('too large')
  const chunks = []
  let size = 0
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.byteLength
      if (size > MAX_BODY) throw new Error('too large')
      chunks.push(Buffer.from(chunk))
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// Payload of a compact JWS, without a signature check. OpenID Connect Core 1.0
// section 3.1.3.7 step 6: an ID Token received by direct communication with the
// Token Endpoint may rely on TLS server validation in place of the signature.
function idTokenClaims (idToken) {
  if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > MAX_ID_TOKEN) return null
  const parts = idToken.split('.')
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return isObject(claims) ? claims : null
  } catch {
    return null
  }
}

function validEmail (email) {
  return typeof email === 'string' && email.length > 0 && email.length <= MAX_EMAIL &&
    email.split('@').length === 2
}

function createGoogle (opts = {}) {
  const {
    clientId,
    clientSecret,
    redirectUri,
    endpoints = DEFAULT_ENDPOINTS,
    fetch = globalThis.fetch,
    timeoutMs = TIMEOUT_MS,
    now = Date.now
  } = opts
  for (const [name, value] of [['clientId', clientId], ['clientSecret', clientSecret], ['redirectUri', redirectUri]]) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('google: ' + name + ' ausente')
  }
  if (typeof fetch !== 'function') throw new Error('google: fetch ausente')
  const { authUrl, tokenUrl, userinfoUrl } = { ...DEFAULT_ENDPOINTS, ...endpoints }

  function authorizeUrl ({ state, codeChallenge } = {}) {
    if (typeof state !== 'string' || state.length === 0) throw new Error('google: state ausente')
    if (typeof codeChallenge !== 'string' || codeChallenge.length === 0) throw new Error('google: code_challenge ausente')
    const url = new URL(authUrl)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: SCOPE,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account'
    }).toString()
    return url.toString()
  }

  // One request with its own 10 s deadline covering headers and body; a
  // redirect is an error (redirect: 'error'), never followed. Any failure
  // after the response arrived releases it (body cancelled, request aborted)
  // so a refused response never holds a connection past this call.
  async function request (url, init) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, redirect: 'error', signal: ctrl.signal })
      try {
        if (!res.ok) throw new Error('status')
        return await readJson(res)
      } catch (err) {
        ctrl.abort()
        try { await res.body?.cancel() } catch {}
        throw err
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function exchange ({ code, codeVerifier } = {}) {
    if (typeof code !== 'string' || code.length === 0) return REFUSED
    if (typeof codeVerifier !== 'string' || codeVerifier.length === 0) return REFUSED
    try {
      const token = await request(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier
        }).toString()
      })
      if (!isObject(token) || typeof token.access_token !== 'string' || token.access_token.length === 0) return REFUSED
      const claims = idTokenClaims(token.id_token)
      if (claims === null) return REFUSED
      if (!ISSUERS.has(claims.iss)) return REFUSED
      if (claims.aud !== clientId) return REFUSED
      if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) return REFUSED

      const info = await request(userinfoUrl, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token.access_token, Accept: 'application/json' }
      })
      if (!isObject(info)) return REFUSED
      const { sub, email } = info
      if (typeof sub !== 'string' || !SUB_RE.test(sub)) return REFUSED
      if (claims.sub !== sub) return REFUSED
      if (info.email_verified !== true) return REFUSED
      if (!validEmail(email)) return REFUSED
      return { ok: true, sub, email }
    } catch {
      return REFUSED
    }
  }

  return { authorizeUrl, exchange, pkce }
}

module.exports = { createGoogle, pkce, DEFAULT_ENDPOINTS, SCOPE }
