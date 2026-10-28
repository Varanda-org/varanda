'use strict'

// The account service's reader of the post a report points at. A report
// carries the reporter's quote, which the reporter chose; judging that text
// would let anyone frame an author with words the author never wrote
// (packages/core/lib/report.js). Triage judges the block the author signed
// instead, read from the local seeder over its token-gated loopback route
// GET <baseUrl>/moderation-post/<diaryKey>/<seq> (apps/cli/lib/seed-ws.js,
// POST_RE), which answers 200 with exactly { v: 1, fork, length, block0,
// block } (raw blocks 0 and <seq>, base64) and a generic 404 otherwise.
//
// Trust boundary: the route returns raw blocks the seeder's own Hypercore
// already verified when they arrived; JSON over loopback is not a portable
// proof (no signature or tree nodes travel with it), so authenticity rests
// on the local seeder plus the Bearer-token loopback. The re-validation here
// guards against malformed, wrong-type, wrong-fork, bad-certificate and
// revoked-issuer responses: block 0 must be a valid member certificate for
// diaryKey under the trusted association with a non-revoked issuer (the
// gate Seeder applies, packages/core/lib/seeder.js gateVerdict), and block
// <seq> must be a valid 'post' record.
//
// createPostReader({ baseUrl, token, association, revokedIssuers, timeoutMs })
// -> { read({ diaryKey, seq }) }. read never throws and resolves either
//   { ok: true, text, hasMedia, hasQuote, textCp, contentHash, seq }
// with `text` exactly as stored (no trimming or normalisation), `textCp` its
// code-point length and `contentHash` report.js digest(text), or
//   { ok: false, code }
// with code one of: config (a bad argument or configuration), timeout,
// recusado (refused, unreachable, redirected, oversized or malformed
// answer), ausente (404), certificado (block 0 fails the gate),
// nao-e-publicacao (block <seq> is not a valid post).
//
// Nothing is logged: not the text, keys, token or address. Only the post
// record is read: no /media fetch, no Corestore, no DHT, no replication.
const { decodeBlock, validateRecord, validRecordCopy } = require('@varanda/core/lib/records')
const { certForKey } = require('@varanda/core/lib/cert')
const { digest } = require('@varanda/core/lib/report')

// The route answers at most POST_MAX_BODY (seed-ws.js) bytes; anything
// longer is not from it.
const MAX_BODY = 65536
const HEX64_RE = /^[0-9a-f]{64}$/
// Loopback only, an explicit port, no path (a trailing '/' is tolerated).
const BASE_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const RESPONSE_KEYS = ['v', 'fork', 'length', 'block0', 'block']

function fail (code) {
  return { ok: false, code }
}

// The origin to request, or null when baseUrl is not a loopback http URL.
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

// Strict base64 (Buffer.from is lenient and skips junk), or null.
function decodeBase64 (s) {
  if (typeof s !== 'string' || !BASE64_RE.test(s)) return null
  return Buffer.from(s, 'base64')
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

function createPostReader ({ baseUrl, token, association, revokedIssuers = () => new Set(), timeoutMs = 5000 } = {}) {
  const origin = loopbackOrigin(baseUrl)
  const configured = origin !== null &&
    typeof token === 'string' && HEX64_RE.test(token) &&
    typeof association === 'string' && HEX64_RE.test(association) &&
    typeof revokedIssuers === 'function' &&
    Number.isFinite(timeoutMs) && timeoutMs > 0

  async function fetchAnswer (diaryKey, seq) {
    let res
    try {
      res = await fetch(origin + '/moderation-post/' + diaryKey + '/' + seq, {
        method: 'GET',
        headers: { authorization: 'Bearer ' + token },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      // A redirect (redirect: 'error'), a refused connection or any other
      // network error is 'recusado'; only the deadline is 'timeout'.
      return isTimeout(err) ? fail('timeout') : fail('recusado')
    }
    let body
    try {
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        return res.status === 404 ? fail('ausente') : fail('recusado')
      }
      body = await readCapped(res)
    } catch (err) {
      return isTimeout(err) ? fail('timeout') : fail('recusado')
    }
    if (body === null) return fail('recusado')
    let json
    try {
      json = JSON.parse(body.toString('utf8'))
    } catch {
      return fail('recusado')
    }
    if (!isPlainObject(json) || !hasExactKeys(json, RESPONSE_KEYS)) return fail('recusado')
    if (json.v !== 1 || json.fork !== 0) return fail('recusado')
    if (!Number.isSafeInteger(json.length) || json.length <= seq) return fail('recusado')
    const block0 = decodeBase64(json.block0)
    const block = decodeBase64(json.block)
    if (block0 === null || block === null) return fail('recusado')
    return { ok: true, block0, block }
  }

  function certified (block0, diaryKey) {
    try {
      const record0 = decodeBlock(block0)
      if (record0 === null || validateRecord(record0, 0) !== null) return false
      // A throwing snapshot getter fails closed, and so does one that does
      // not return a Set-like value: certForKey treats a value without
      // has() as "nothing revoked", and the snapshot's own field is an array.
      const revoked = revokedIssuers()
      if (revoked === null || typeof revoked !== 'object' || typeof revoked.has !== 'function') return false
      const r = certForKey(record0.cert, diaryKey, association, { revokedIssuers: revoked })
      return r.ok === true
    } catch {
      return false
    }
  }

  // Destructured inside the try: read(null) must resolve 'config', never reject.
  async function read (args) {
    try {
      const { diaryKey, seq } = args !== null && typeof args === 'object' ? args : {}
      if (!configured) return fail('config')
      if (typeof diaryKey !== 'string' || !HEX64_RE.test(diaryKey)) return fail('config')
      if (!Number.isSafeInteger(seq) || seq < 1) return fail('config')
      const answer = await fetchAnswer(diaryKey, seq)
      if (!answer.ok) return answer
      if (!certified(answer.block0, diaryKey)) return fail('certificado')
      // validRecordCopy validates a plain-data copy, so nothing read below
      // can change after validation.
      const record = validRecordCopy(decodeBlock(answer.block), seq)
      if (record === null || record.type !== 'post') return fail('nao-e-publicacao')
      const text = record.text
      // records.js allows lone surrogates; UTF-8 turns them into U+FFFD, so
      // digest() would collide with different text and the ledger refuses
      // the string. Such a post is not something the AI can judge.
      if (typeof text !== 'string' || !text.isWellFormed()) return fail('nao-e-publicacao')
      return {
        ok: true,
        text,
        hasMedia: Array.isArray(record.media) && record.media.length >= 1,
        hasQuote: record.quote !== undefined,
        textCp: Array.from(text).length,
        contentHash: digest(text),
        seq
      }
    } catch {
      return fail('recusado')
    }
  }

  return { read }
}

module.exports = {
  MAX_BODY,
  createPostReader
}
