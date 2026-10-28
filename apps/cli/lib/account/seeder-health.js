'use strict'

// The account service's reader of the local seeder's anonymous counts, for
// the moderation panel's usage statistics. It reads the seeder's public
// loopback route GET <baseUrl>/health (apps/cli/lib/health.js), which
// answers 200 with { status: 'ok', ...counts } once the seeder runs and 503
// while it starts or closes. The route needs no token, so none is sent.
//
// Loopback only: the base URL must be http on 127.0.0.1, localhost or [::1]
// with an explicit port and no path; anything else is refused before any
// request, so a misconfiguration can never send the request off the box.
//
// Counts only: the answer is whitelisted to FIELDS, each a non-negative
// safe integer or null (null = missing or invalid, e.g. an older seeder
// without activeDay/activeWeek). Every other key (firewalled, blocked,
// blocklistSeq, maxConnections, or anything a future seeder adds) is
// dropped, so no key, address or identifier can reach the panel through
// here.
//
// createSeederHealthReader({ baseUrl, timeoutMs, fetch }) -> { read() }.
// read never rejects and resolves either null (bad configuration, network
// error, timeout, non-200, oversized, non-JSON or malformed answer) or an
// object with exactly the FIELDS keys.
//
// Nothing is logged: not the answer, the URL or the error.

const DEFAULT_SEEDER_HEALTH = 'http://127.0.0.1:8788'
const FIELDS = Object.freeze(['uptimeSeconds', 'admitted', 'activeDay', 'activeWeek', 'blocks', 'bytes', 'mediaBytes', 'topicPosts', 'connections', 'external'])
// /health is a small flat object; anything longer is not from it.
const MAX_BODY = 16384
// A local copy of SEEDER_HTTP_RE (apps/cli/lib/commands/account.js): http,
// a loopback host, an explicit port and no path (a trailing '/' is
// tolerated). Copied, not imported, so this module stays independent of
// the CLI command layer.
const SEEDER_HTTP_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/

// The base URL without its trailing '/', the default for undefined or '',
// or null when it is not a loopback http URL with a valid port.
function parseSeederHealthUrl (value) {
  if (value === undefined || value === '') return DEFAULT_SEEDER_HEALTH
  if (typeof value !== 'string') return null
  const m = SEEDER_HTTP_RE.exec(value)
  if (m === null) return null
  const port = Number(m[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function isCount (v) {
  return Number.isSafeInteger(v) && v >= 0
}

// The body as a Buffer, or null beyond MAX_BODY (the stream is cancelled
// then, so a huge answer is never buffered). Copied from
// ai/read-post.js readCapped. Errors (timeouts included) propagate.
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

function createSeederHealthReader ({ baseUrl, timeoutMs = 3000, fetch = globalThis.fetch } = {}) {
  const origin = parseSeederHealthUrl(baseUrl)
  const configured = origin !== null &&
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 &&
    typeof fetch === 'function'

  // Every failure collapses to null: the panel only needs "unavailable",
  // and a reason string could leak details nobody asked for.
  async function read () {
    if (!configured) return null
    try {
      const res = await fetch(origin + '/health', {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (res.status !== 200) {
        // 503 means the seeder is starting or closing.
        await res.body?.cancel().catch(() => {})
        return null
      }
      const body = await readCapped(res)
      if (body === null) return null
      const json = JSON.parse(body.toString('utf8'))
      if (!isPlainObject(json) || json.status !== 'ok' || !isCount(json.admitted)) return null
      const out = {}
      for (const k of FIELDS) {
        const v = Object.prototype.hasOwnProperty.call(json, k) ? json[k] : undefined
        out[k] = isCount(v) ? v : null
      }
      return out
    } catch {
      return null
    }
  }

  return { read }
}

module.exports = {
  DEFAULT_SEEDER_HEALTH,
  FIELDS,
  MAX_BODY,
  parseSeederHealthUrl,
  createSeederHealthReader
}
