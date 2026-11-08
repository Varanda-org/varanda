'use strict'

// The account service's reader of a Feira listing, over the local seeder's
// token-gated loopback routes (apps/cli/lib/seed-ws.js), with the same
// Bearer VARANDA_TRIAGE_TOKEN as the report triage (./ai/read-post.js):
//
//   - readListing(author, seq): GET <baseUrl>/feira-listing/<author>/<seq>,
//     which answers exactly { ok: true } only when block <seq> is the root
//     of a live listing of an admitted, served, visible diary
//     (Seeder#listingPublic). That route has its own budget on the seeder,
//     so the Feira entry never spends the report triage's /moderation-post
//     budget. The status is never read: a vendido listing still opens the
//     Feira entry, since the link people share outlives the sale.
//     -> { author, seq } or a token.
//   - readCurrent(author, seq): GET <baseUrl>/moderation-listing/<author>/<seq>,
//     the seeder's folded current version of the listing, exactly
//     { title, text, priceLabel, city, uf, kind, status } (each a string or
//     null) for the moderation panel. -> that object (a fresh copy) or a token.
//
// The trust boundary is read-post.js's: this local seeder plus the
// token-authenticated loopback. The answers are re-validated here against
// malformed shapes. The folded view carries raw peer text: whoever renders
// it escapes it.
//
// Tokens: config (a bad argument or configuration), timeout, recusado
// (refused, unreachable, redirected, oversized or malformed answer), ausente
// (404, which is also what the seeder answers for anything that is not a
// live listing root). Neither reader throws, and nothing is logged: not the
// text, keys, token or address.

// The routes answer at most 64 KiB (seed-ws.js); anything longer is not
// from them.
const MAX_BODY = 65536
const MAX_FIELD = 16384
const HEX64_RE = /^[0-9a-f]{64}$/
// Loopback only, an explicit port, no path (a trailing '/' is tolerated).
const BASE_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/
const VIEW_KEYS = ['title', 'text', 'priceLabel', 'city', 'uf', 'kind', 'status']

function loopbackOrigin (baseUrl) {
  if (typeof baseUrl !== 'string') return null
  const m = BASE_RE.exec(baseUrl)
  if (m === null) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return 'http://' + m[1] + ':' + port
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

function isTimeout (err) {
  return err !== null && typeof err === 'object' && (err.name === 'TimeoutError' || err.code === 23)
}

// The body as a Buffer, or null beyond MAX_BODY (the stream is cancelled
// then, so a huge answer is never buffered). Timeouts propagate.
async function readCapped (res) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (res.body === null) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

function validRef (author, seq) {
  return typeof author === 'string' && HEX64_RE.test(author) && Number.isSafeInteger(seq) && seq >= 1
}

function createListingReader ({ baseUrl, token, association, timeoutMs = 5000 } = {}) {
  const origin = loopbackOrigin(baseUrl)
  const configured = origin !== null &&
    typeof token === 'string' && HEX64_RE.test(token) &&
    typeof association === 'string' && HEX64_RE.test(association) &&
    Number.isFinite(timeoutMs) && timeoutMs > 0

  // -> the parsed JSON body of a 200, or a token.
  async function getJson (pathname) {
    let res
    try {
      res = await fetch(origin + pathname, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + token },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      // A redirect (redirect: 'error'), a refused connection or any other
      // network error is 'recusado'; only the deadline is 'timeout'.
      return isTimeout(err) ? 'timeout' : 'recusado'
    }
    let body
    try {
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        return res.status === 404 ? 'ausente' : 'recusado'
      }
      body = await readCapped(res)
    } catch (err) {
      return isTimeout(err) ? 'timeout' : 'recusado'
    }
    if (body === null) return 'recusado'
    try {
      const json = JSON.parse(body.toString('utf8'))
      return isPlainObject(json) ? { json } : 'recusado'
    } catch {
      return 'recusado'
    }
  }

  async function readListing (author, seq) {
    try {
      if (!configured || !validRef(author, seq)) return 'config'
      const answer = await getJson('/feira-listing/' + author + '/' + seq)
      if (typeof answer === 'string') return answer
      const json = answer.json
      if (!hasExactKeys(json, ['ok']) || json.ok !== true) return 'recusado'
      return { author, seq }
    } catch {
      return 'recusado'
    }
  }

  async function readCurrent (author, seq) {
    try {
      if (!configured || !validRef(author, seq)) return 'config'
      const answer = await getJson('/moderation-listing/' + author + '/' + seq)
      if (typeof answer === 'string') return answer
      const json = answer.json
      if (!hasExactKeys(json, VIEW_KEYS)) return 'recusado'
      const view = {}
      for (const k of VIEW_KEYS) {
        const v = json[k]
        if (v !== null && (typeof v !== 'string' || v.length > MAX_FIELD)) return 'recusado'
        view[k] = v
      }
      return view
    } catch {
      return 'recusado'
    }
  }

  return { readListing, readCurrent }
}

module.exports = {
  MAX_BODY,
  createListingReader
}
