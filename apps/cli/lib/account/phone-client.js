'use strict'

// Outbound-only client for Didit phone verification, used by the account
// service. Only coarse tokens leave this module: the number, the code, the
// request id, the carrier name and the provider body never do, and nothing is
// logged here. Every failure collapses into { ok: false } plus a coarse
// `reason` ('http-NNN', 'tempo', 'rede', 'formato', 'entrada') and, for a 4xx,
// the names (never the values) of the fields the provider complained about.
//
// The code goes by SMS only (owner decision, 2026-11-11), so there is no
// channel argument. Nothing about the person beyond the number is sent: no
// signals, IP, metadata, workflow id or member key.
//
// Provider behaviour NOT yet confirmed in the sandbox lives only in this file:
// the exact paths and field names, the absence of a deletion call for phone
// records, 401 versus 403, the carrier type vocabulary, whether a Retry is
// billed, and what Declined and Failed mean. The operator's sandbox checklist
// in the README covers each of them before the key is set.

const crypto = require('node:crypto')
const { isBrMobile } = require('@varanda/core/lib/phone')
const { DEFAULT_ENDPOINTS, readJson, failure, DiditError } = require('./didit')

const TIMEOUT_MS = 5000
const MAX_KEY = 512
const KEY_RE = /^[\x21-\x7e]+$/
const CODE_RE = /^[0-9]{6}$/
// Field names a provider error body may name: schema words, never values.
const FIELD_RE = /^[a-z][a-z_]{0,39}$/
const MAX_FIELDS = 5

// Didit's send docs: Retry re-sends the code of the pending verification, so
// a code is on its way exactly as for Success.
const SEND_STATUS = Object.freeze({ Success: 'enviado', Retry: 'enviado', Blocked: 'bloqueado' })
const DENY_TYPES = new Set(['landline', 'fixed', 'fixed_line', 'fixedline', 'voip', 'isp', 'vpn', 'pager', 'tollfree', 'toll_free', 'premium'])
const MOBILE_TYPES = new Set(['mobile', 'cellular', 'wireless'])

const BAD_INPUT = Object.freeze({ ok: false, reason: 'entrada', fields: [] })

function isObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function result (outcome, unknownType = false) {
  return { outcome, unknownType }
}

// Pure mapping from a check answer to our outcome. Only the status, the two
// line flags and the carrier type are read; country_code is ignored on
// purpose, since isBrMobile already requires +55 and the provider's token for
// it is unconfirmed.
function phoneOutcome (json) {
  if (!isObject(json)) return result('desconhecido')
  const phone = isObject(json.phone) ? json.phone : null
  const carrier = phone !== null && isObject(phone.carrier) ? phone.carrier : null
  const type = carrier !== null && typeof carrier.type === 'string' ? carrier.type.trim().toLowerCase() : null
  const refusedLine = phone !== null && (phone.is_virtual === true || phone.is_disposable === true || (type !== null && DENY_TYPES.has(type)))
  switch (json.status) {
    case 'Approved':
      if (refusedLine) return result('recusado-linha')
      // A type we cannot read or do not know is accepted: refusing it could
      // lock out a real mobile whose carrier label we have not seen yet. The
      // caller logs it.
      return result('aprovado', type === null || !MOBILE_TYPES.has(type))
    case 'Declined':
      // Without a line signal, Declined means the attempts are used up.
      return result(refusedLine ? 'recusado-linha' : 'expirado')
    case 'Failed':
      return result('codigo-invalido')
    case 'Expired or Not Found':
      return result('expirado')
    default:
      return result('desconhecido')
  }
}

function createPhoneClient (opts = {}) {
  const {
    apiKey,
    endpoints,
    fetch = globalThis.fetch,
    timeoutMs = TIMEOUT_MS
  } = opts
  // The messages never carry the offending value: it may be the secret.
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > MAX_KEY || !KEY_RE.test(apiKey)) {
    throw new TypeError('telefone: chave de API inválida')
  }
  if (typeof fetch !== 'function') throw new TypeError('telefone: fetch ausente')
  const { base } = { ...DEFAULT_ENDPOINTS, ...endpoints }
  if (typeof base !== 'string' || base.length === 0) throw new TypeError('telefone: endpoint inválido')

  const headers = Object.freeze({
    'x-api-key': apiKey,
    'content-type': 'application/json',
    accept: 'application/json'
  })

  // One request with its own deadline covering headers and body; a redirect
  // is an error, never followed. Any failure after the response arrived
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
      // A stalled body or a dropped connection is not a format problem:
      // failure() reports 'tempo' or 'rede'.
      if (err instanceof SyntaxError || (err && (err.message === 'not json' || err.message === 'too large'))) {
        throw new DiditError('formato')
      }
      throw err
    }
  }

  // The top-level keys of a 4xx JSON body, filtered to schema-like names; the
  // values are dropped unread.
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

  async function send ({ phone } = {}) {
    if (!isBrMobile(phone)) return { ...BAD_INPUT, fields: [] }
    try {
      const json = await request('POST', '/v3/phone/send/', {
        phone_number: phone,
        options: { preferred_channel: 'sms', locale: 'pt-BR', code_size: 6 },
        vendor_data: crypto.randomBytes(16).toString('base64url')
      }, getJson)
      const raw = isObject(json) ? json.status : undefined
      const status = typeof raw === 'string' && Object.prototype.hasOwnProperty.call(SEND_STATUS, raw) ? SEND_STATUS[raw] : null
      if (status === null) return { ok: false, reason: 'formato', fields: [] }
      return { ok: true, status }
    } catch (err) {
      return failure(err)
    }
  }

  async function check ({ phone, code } = {}) {
    if (!isBrMobile(phone) || typeof code !== 'string' || !CODE_RE.test(code)) return { ...BAD_INPUT, fields: [] }
    try {
      const json = await request('POST', '/v3/phone/check/', {
        phone_number: phone,
        code,
        voip_number_action: 'DECLINE',
        disposable_number_action: 'DECLINE',
        duplicated_phone_number_action: 'NO_ACTION'
      }, getJson)
      const { outcome, unknownType } = phoneOutcome(json)
      return { ok: true, outcome, unknownType }
    } catch (err) {
      return failure(err)
    }
  }

  return { send, check }
}

module.exports = { createPhoneClient, phoneOutcome }
