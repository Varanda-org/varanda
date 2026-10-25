'use strict'

const { PROTOCOL, MAX_LINE } = require('./limits')
const { WIRE_CODES, MAX_ERROR_MESSAGE } = require('./errors')
const { charLength } = require('./text')
const { isMethod, validateParams, isPlainObject, hasOwn, isId } = require('./methods')

const EVENTS = Object.freeze(['sync.started', 'sync.event', 'sync.stopped', 'warning', 'follows.changed'])
const STOP_REASONS = Object.freeze(['done', 'stopped', 'preempted', 'timeout', 'error'])

function fail (message) {
  return { ok: false, code: 'USAGE', message }
}

function exactKeys (obj, required, optional = []) {
  const own = Object.keys(obj)
  for (const k of own) if (!required.includes(k) && !optional.includes(k)) return false
  return required.every((k) => hasOwn(obj, k))
}

function isLine (v) {
  return typeof v === 'string' && charLength(v) <= MAX_LINE
}

// { v: 1, id, method, params } -> { ok: true, value } with normalized params,
// or { ok: false, code: 'USAGE', message }. Never throws.
function validateRequest (obj) {
  try {
    if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'id', 'method', 'params'])) return fail('envelope inválido')
    if (obj.v !== PROTOCOL) return fail('versão não suportada')
    if (!isId(obj.id)) return fail('id inválido')
    if (!isMethod(obj.method)) return fail('método desconhecido')
    const p = validateParams(obj.method, obj.params)
    if (!p.ok) return p
    return { ok: true, value: { v: PROTOCOL, id: obj.id, method: obj.method, params: p.value } }
  } catch {
    return fail('envelope inválido')
  }
}

// Success: { v, id, ok: true, result: <object> }; failure: { v, id, ok: false,
// error: { code, message } } with a wire code. Never throws.
function validateResponse (obj) {
  try {
    if (!isPlainObject(obj)) return fail('envelope inválido')
    if (obj.ok === true) {
      if (!exactKeys(obj, ['v', 'id', 'ok', 'result'])) return fail('envelope inválido')
    } else if (obj.ok === false) {
      if (!exactKeys(obj, ['v', 'id', 'ok', 'error'])) return fail('envelope inválido')
    } else {
      return fail('envelope inválido')
    }
    if (obj.v !== PROTOCOL) return fail('versão não suportada')
    if (!isId(obj.id)) return fail('id inválido')
    if (obj.ok) {
      if (!isPlainObject(obj.result)) return fail('resultado inválido')
      return { ok: true, value: { v: PROTOCOL, id: obj.id, ok: true, result: obj.result } }
    }
    const e = obj.error
    if (!isPlainObject(e) || !exactKeys(e, ['code', 'message'])) return fail('erro inválido')
    if (typeof e.code !== 'string' || !WIRE_CODES.includes(e.code)) return fail('erro inválido')
    if (typeof e.message !== 'string' || e.message.length > MAX_ERROR_MESSAGE) return fail('erro inválido')
    return { ok: true, value: { v: PROTOCOL, id: obj.id, ok: false, error: { code: e.code, message: e.message } } }
  } catch {
    return fail('envelope inválido')
  }
}

function validateEventData (event, data) {
  if (!isPlainObject(data)) return false
  if (event === 'warning') return exactKeys(data, ['line']) && isLine(data.line)
  if (event === 'sync.event') return exactKeys(data, ['runId', 'line']) && isId(data.runId) && isLine(data.line)
  if (event === 'sync.started') return exactKeys(data, ['runId', 'once']) && isId(data.runId) && typeof data.once === 'boolean'
  // The new number of follows.
  if (event === 'follows.changed') return exactKeys(data, ['count']) && Number.isSafeInteger(data.count) && data.count >= 0
  // sync.stopped
  if (!exactKeys(data, ['runId', 'reason'], ['result'])) return false
  if (!isId(data.runId) || !STOP_REASONS.includes(data.reason)) return false
  return !hasOwn(data, 'result') || isPlainObject(data.result)
}

// { v: 1, event, seq, data }. Never throws.
function validateEvent (obj) {
  try {
    if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'event', 'seq', 'data'])) return fail('envelope inválido')
    if (obj.v !== PROTOCOL) return fail('versão não suportada')
    if (typeof obj.event !== 'string' || !EVENTS.includes(obj.event)) return fail('evento desconhecido')
    if (!Number.isSafeInteger(obj.seq) || obj.seq < 1) return fail('seq inválido')
    if (!validateEventData(obj.event, obj.data)) return fail('dados do evento inválidos')
    return { ok: true, value: { v: PROTOCOL, event: obj.event, seq: obj.seq, data: obj.data } }
  } catch {
    return fail('envelope inválido')
  }
}

module.exports = { EVENTS, STOP_REASONS, validateRequest, validateResponse, validateEvent }
