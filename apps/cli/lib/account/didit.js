'use strict'

// Outbound-only client for Didit hosted age verification, used by the account
// service. Only an opaque session id, the hosted page URL and a coarse age
// outcome leave this module: the session token, the vendor JSON, birth dates,
// names and images never do. Every failure collapses into { ok: false } plus a
// coarse `reason` token ('http-403', 'tempo', 'rede', 'formato', 'entrada')
// and, for a 4xx, the names (never the values) of the fields the provider
// complained about, so the operator can tell a wrong key from a refused
// callback without any key, token or provider body reaching a log.

const DEFAULT_ENDPOINTS = Object.freeze({ base: 'https://verification.didit.me' })

const TIMEOUT_MS = 5000
const MAX_BODY = 65536
const MAX_KEY = 512
const MAX_SESSION_ID = 128
const MAX_URL = 2048
const MAX_VENDOR_DATA = 256
const MAX_CALLBACK = 2048
const SESSION_ID_RE = /^[A-Za-z0-9-]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LANGUAGE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/
const KEY_RE = /^[\x21-\x7e]+$/

// Age thresholds, pending the legal opinion (docs/design.md, LGPD section).
// FACE_ADULT_MIN is a margin above ADULT_AGE because a face estimate has an
// error of a few years: near the threshold a document is required.
const MIN_AGE = 16
const ADULT_AGE = 18
const FACE_ADULT_MIN = 21
const MAX_AGE = 150

const PENDING = new Set(['In Review', 'In Progress', 'Not Started', 'Awaiting User', 'Resubmitted'])
const EXPIRED = new Set(['Abandoned', 'Expired', 'Kyc Expired'])

const FAIL = Object.freeze({ ok: false, reason: 'entrada' })
const RETRY = Object.freeze({ ok: false, retry: true })
// Field names a provider error body may name: schema words, never values.
const FIELD_RE = /^[a-z][a-z_]{0,39}$/
const MAX_FIELDS = 5

class DiditError extends Error {
  constructor (reason, fields = []) {
    super(reason)
    this.reason = reason
    this.fields = fields
  }
}

// -> { ok: false, reason, fields } from whatever a request threw.
function failure (err) {
  if (err instanceof DiditError) return { ok: false, reason: err.reason, fields: err.fields }
  if (err && err.name === 'AbortError') return { ok: false, reason: 'tempo', fields: [] }
  return { ok: false, reason: 'rede', fields: [] }
}
const NO_RETRY = Object.freeze({ ok: false, retry: false })

function isObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function documentBand (age) {
  if (age < MIN_AGE) return { state: 'recusado' }
  if (age < ADULT_AGE) return { state: 'verificado', band: '16-17' }
  return { state: 'verificado', band: '18+' }
}

// Pure mapping from a Didit decision to our outcome. Only status fields and
// the numeric age readings are touched; nothing else of the vendor JSON is
// read or returned.
function ageOutcome (decision) {
  if (!isObject(decision)) return { state: 'inconclusivo' }
  const status = decision.status
  if (status === 'Declined') return { state: 'recusado' }
  if (PENDING.has(status)) return { state: 'pendente' }
  if (EXPIRED.has(status)) return { state: 'expirado' }
  if (status !== 'Approved') return { state: 'inconclusivo' }

  let docAge = null
  let badDoc = false
  const ids = Array.isArray(decision.id_verifications) ? decision.id_verifications : []
  for (const entry of ids) {
    if (!isObject(entry) || entry.status !== 'Approved') continue
    if (typeof entry.age !== 'number') continue
    // An approved document whose age is a number we cannot use must never be
    // passed over in favour of a face estimate; a fraction rounds down.
    if (!Number.isFinite(entry.age) || entry.age < 0 || entry.age > MAX_AGE) {
      badDoc = true
      continue
    }
    const age = Math.floor(entry.age)
    // Several approved documents that disagree: the lowest age protects most.
    if (docAge === null || age < docAge) docAge = age
  }
  if (docAge !== null) return documentBand(docAge)
  if (badDoc) return { state: 'inconclusivo' }

  let faceAge = null
  const faces = Array.isArray(decision.liveness_checks) ? decision.liveness_checks : []
  for (const entry of faces) {
    if (!isObject(entry)) continue
    if (Object.prototype.hasOwnProperty.call(entry, 'status') && entry.status !== 'Approved') continue
    const age = entry.age_estimation
    if (typeof age !== 'number' || !Number.isFinite(age) || age < 0 || age > MAX_AGE) continue
    // Several estimates that disagree: the lowest one decides, as for documents.
    if (faceAge === null || age < faceAge) faceAge = age
  }
  // A face estimate never refuses and never passes near the threshold.
  if (faceAge !== null && faceAge >= FACE_ADULT_MIN) return { state: 'verificado', band: '18+' }
  return { state: 'inconclusivo' }
}

// Reads at most MAX_BODY bytes of a JSON response; anything else throws a bare
// Error that the callers turn into FAIL.
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

function validSessionId (id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID && SESSION_ID_RE.test(id)
}

function validHostedUrl (url) {
  if (typeof url !== 'string' || url.length > MAX_URL || !url.startsWith('https://')) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
  } catch {
    return false
  }
}

function createDidit (opts = {}) {
  const {
    apiKey,
    workflowId,
    endpoints = DEFAULT_ENDPOINTS,
    fetch = globalThis.fetch,
    timeoutMs = TIMEOUT_MS
  } = opts
  // The messages never carry the offending value: it may be the secret.
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > MAX_KEY || !KEY_RE.test(apiKey)) {
    throw new TypeError('didit: chave de API inválida')
  }
  if (typeof workflowId !== 'string' || !UUID_RE.test(workflowId)) {
    throw new TypeError('didit: workflow inválido')
  }
  if (typeof fetch !== 'function') throw new TypeError('didit: fetch ausente')
  const { base } = { ...DEFAULT_ENDPOINTS, ...endpoints }
  if (typeof base !== 'string' || base.length === 0) throw new TypeError('didit: endpoint inválido')

  const headers = Object.freeze({
    'x-api-key': apiKey,
    'content-type': 'application/json',
    accept: 'application/json'
  })

  // One request with its own deadline covering headers and body; a redirect
  // is an error (redirect: 'error'), never followed. `handle` reads the
  // response inside the deadline. Any failure after the response arrived
  // releases it so a refused response never holds a connection.
  async function request (method, path, body, handle) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const init = { method, headers, redirect: 'error', signal: ctrl.signal }
      if (body !== undefined) init.body = JSON.stringify(body)
      const res = await fetch(base + path, init)
      try {
        return await handle(res)
      } catch (err) {
        ctrl.abort()
        try { await res.body?.cancel() } catch {}
        throw err
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function getJson (res) {
    if (!res.ok) throw new DiditError('http-' + res.status, await errorFields(res))
    try {
      return await readJson(res)
    } catch (err) {
      // A body that stalls past the deadline or a connection that drops while
      // streaming is not a format problem: failure() reports 'tempo'/'rede'.
      if (err instanceof SyntaxError || (err && (err.message === 'not json' || err.message === 'too large'))) {
        throw new DiditError('formato')
      }
      throw err
    }
  }

  // The top-level keys of a 4xx JSON body (e.g. 'callback', 'workflow_id'),
  // filtered to schema-like names; the values are dropped unread.
  async function errorFields (res) {
    if (res.status < 400 || res.status >= 500) return []
    try {
      const body = await readJson(res)
      if (!isObject(body)) return []
      return Object.keys(body).filter((k) => FIELD_RE.test(k)).slice(0, MAX_FIELDS)
    } catch {
      return []
    }
  }

  async function createSession ({ vendorData, callback, language = 'pt' } = {}) {
    if (typeof vendorData !== 'string' || vendorData.length === 0 || vendorData.length > MAX_VENDOR_DATA) return FAIL
    if (!validHostedUrl(callback) || callback.length > MAX_CALLBACK) return FAIL
    if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) return FAIL
    try {
      const json = await request('POST', '/v3/session/', {
        workflow_id: workflowId,
        vendor_data: vendorData,
        callback,
        language
      }, getJson)
      if (!isObject(json)) return { ok: false, reason: 'formato', fields: [] }
      const sessionId = json.session_id
      const url = json.url
      if (!validSessionId(sessionId) || !validHostedUrl(url)) return { ok: false, reason: 'formato', fields: [] }
      return { ok: true, sessionId, url }
    } catch (err) {
      return failure(err)
    }
  }

  async function decision (sessionId) {
    if (!validSessionId(sessionId)) return FAIL
    try {
      const json = await request('GET', '/v3/session/' + encodeURIComponent(sessionId) + '/decision/', undefined, getJson)
      return { ok: true, outcome: ageOutcome(json) }
    } catch (err) {
      return failure(err)
    }
  }

  async function deleteSession (sessionId) {
    if (!validSessionId(sessionId)) return NO_RETRY
    let status
    try {
      status = await request('DELETE', '/v3/session/' + encodeURIComponent(sessionId) + '/delete/',
        { retain_face_embeddings: false },
        async (res) => {
          // Only the status matters; the body is released unread.
          try { await res.body?.cancel() } catch {}
          return res.status
        })
    } catch {
      // Timeout, network error or a refused redirect: try again later.
      return RETRY
    }
    if (status === 200 || status === 404) return { ok: true }
    // Throttling and server-side failures are temporary: the session (and its
    // images) would otherwise stay at the provider.
    if (status === 429 || status >= 500) return RETRY
    return NO_RETRY
  }

  return { createSession, decision, deleteSession }
}

module.exports = { createDidit, ageOutcome, DEFAULT_ENDPOINTS, MIN_AGE, ADULT_AGE, FACE_ADULT_MIN }
