'use strict'

const test = require('brittle')
const { validateRequest, validateResponse, validateEvent, EVENTS, STOP_REASONS, MAX_ID } = require('..')

const req = (over = {}) => ({ v: 1, id: 1, method: 'node.info', params: {}, ...over })

test('request: valid envelope', (t) => {
  const r = validateRequest(req())
  t.ok(r.ok)
  t.alike(r.value, { v: 1, id: 1, method: 'node.info', params: {} })
})

test('request: ids', (t) => {
  t.ok(validateRequest(req({ id: MAX_ID })).ok)
  for (const id of [0, -1, MAX_ID + 1, 1.5, '1', null, NaN, Infinity, 2 ** 53]) {
    const r = validateRequest(req({ id }))
    t.absent(r.ok, 'id ' + String(id))
    t.is(r.code, 'USAGE')
  }
})

test('request: version, method, params, keys', (t) => {
  t.absent(validateRequest(req({ v: 2 })).ok)
  t.absent(validateRequest(req({ v: '1' })).ok)
  t.absent(validateRequest(req({ method: 'nope' })).ok)
  t.absent(validateRequest(req({ method: 'toString' })).ok, 'prototype names are not methods')
  t.absent(validateRequest(req({ method: '__proto__' })).ok)
  t.absent(validateRequest(req({ params: [] })).ok, 'array params')
  t.absent(validateRequest(req({ params: null })).ok)
  t.absent(validateRequest(req({ params: 'x' })).ok)
  t.absent(validateRequest({ v: 1, id: 1, method: 'node.info' }).ok, 'missing params')
  t.absent(validateRequest(req({ extra: 1 })).ok, 'extra key')
  t.absent(validateRequest(JSON.parse('{"v":1,"id":1,"method":"node.info","params":{},"__proto__":{}}')).ok)
  t.absent(validateRequest([]).ok)
  t.absent(validateRequest(null).ok)
  t.absent(validateRequest('x').ok)
  t.absent(validateRequest(Object.assign(Object.create({ a: 1 }), req())).ok, 'non-plain object')
})

test('request: never throws on hostile input', (t) => {
  const hostile = new Proxy({}, { ownKeys () { throw new Error('boom') }, getPrototypeOf () { return Object.prototype } })
  const r = validateRequest(hostile)
  t.absent(r.ok)
  t.is(r.code, 'USAGE')
  const getter = { v: 1, id: 1, method: 'node.info' }
  Object.defineProperty(getter, 'params', { enumerable: true, get () { throw new Error('boom') } })
  t.absent(validateRequest(getter).ok)
})

test('response: success and error', (t) => {
  t.ok(validateResponse({ v: 1, id: 3, ok: true, result: { a: 1 } }).ok)
  t.ok(validateResponse({ v: 1, id: 3, ok: false, error: { code: 'NOT_FOUND', message: 'x' } }).ok)
  t.absent(validateResponse({ v: 1, id: 3, ok: true, result: [] }).ok, 'array result')
  t.absent(validateResponse({ v: 1, id: 3, ok: true, result: null }).ok)
  t.absent(validateResponse({ v: 1, id: 3, ok: true }).ok)
  t.absent(validateResponse({ v: 1, id: 3, ok: true, result: {}, error: null }).ok)
  t.absent(validateResponse({ v: 1, id: 3, ok: false, error: { code: 'TIMEOUT', message: 'x' } }).ok, 'client-only code')
  t.absent(validateResponse({ v: 1, id: 3, ok: false, error: { code: 'NOPE', message: 'x' } }).ok)
  t.absent(validateResponse({ v: 1, id: 3, ok: false, error: { code: 'USAGE', message: 'x', stack: 'y' } }).ok)
  t.absent(validateResponse({ v: 1, id: 3, ok: false, error: { code: 'USAGE' } }).ok)
  t.absent(validateResponse({ v: 1, id: 0, ok: true, result: {} }).ok)
  t.absent(validateResponse({ v: 2, id: 1, ok: true, result: {} }).ok)
  t.absent(validateResponse({ v: 1, id: 1, ok: 'true', result: {} }).ok)
  t.absent(validateResponse({ v: 1, id: 1, ok: true, result: {}, x: 1 }).ok)
})

test('event names and stop reasons (sync.started and preempted included)', (t) => {
  t.alike([...EVENTS], ['sync.started', 'sync.event', 'sync.stopped', 'warning', 'follows.changed'])
  t.alike([...STOP_REASONS], ['done', 'stopped', 'preempted', 'timeout', 'error', 'idle'])
  t.is(STOP_REASONS.length, 6)
  t.ok(Object.isFrozen(EVENTS))
  t.ok(Object.isFrozen(STOP_REASONS))
})

test('event: sync.stopped reason idle (the browser node\'s lease)', (t) => {
  const ev = (data) => validateEvent({ v: 1, event: 'sync.stopped', seq: 3, data })
  t.ok(ev({ runId: 1, reason: 'idle' }).ok, 'idle without result validates')
  t.alike(ev({ runId: 1, reason: 'idle' }).value.data, { runId: 1, reason: 'idle' })
  t.absent(ev({ runId: 1, reason: 'leased' }).ok, 'an unknown reason does not')
  t.absent(ev({ runId: 1, reason: 'Idle' }).ok)
  t.absent(ev({ runId: 1, reason: 'idle', result: [] }).ok)
})

test('event: shapes', (t) => {
  t.ok(validateEvent({ v: 1, event: 'warning', seq: 1, data: { line: 'aviso' } }).ok)
  t.ok(validateEvent({ v: 1, event: 'sync.event', seq: 2, data: { runId: 1, line: 'sync ready' } }).ok)
  t.ok(validateEvent({ v: 1, event: 'sync.stopped', seq: 3, data: { runId: 1, reason: 'done', result: { ok: true } } }).ok)
  t.ok(validateEvent({ v: 1, event: 'sync.stopped', seq: 3, data: { runId: 1, reason: 'stopped' } }).ok)
  t.ok(validateEvent({ v: 1, event: 'sync.stopped', seq: 3, data: { runId: 1, reason: 'preempted' } }).ok)
  t.absent(validateEvent({ v: 1, event: 'sync.stopped', seq: 3, data: { runId: 1, reason: 'other' } }).ok)
  t.ok(validateEvent({ v: 1, event: 'sync.started', seq: 4, data: { runId: 2, once: false } }).ok)
  t.ok(validateEvent({ v: 1, event: 'sync.started', seq: 4, data: { runId: 2, once: true } }).ok)
  t.absent(validateEvent({ v: 1, event: 'sync.started', seq: 4, data: { runId: 2 } }).ok)
  t.absent(validateEvent({ v: 1, event: 'sync.started', seq: 4, data: { runId: 2, once: 'false' } }).ok)
  t.absent(validateEvent({ v: 1, event: 'sync.started', seq: 4, data: { runId: 0, once: false } }).ok)
  t.absent(validateEvent({ v: 1, event: 'sync.started', seq: 4, data: { runId: 2, once: false, line: 'x' } }).ok)
  t.absent(validateEvent({ v: 1, event: 'sync.stopped', seq: 3, data: { runId: 1, reason: 'done', result: [] } }).ok)
  t.absent(validateEvent({ v: 1, event: 'warning', seq: 0, data: { line: 'x' } }).ok)
  t.absent(validateEvent({ v: 1, event: 'warning', seq: 1, data: { line: 'x', extra: 1 } }).ok)
  t.absent(validateEvent({ v: 1, event: 'warning', seq: 1, data: { line: 'x'.repeat(513) } }).ok)
  t.absent(validateEvent({ v: 1, event: 'nope', seq: 1, data: {} }).ok)
  t.absent(validateEvent({ v: 1, event: 'warning', seq: 1, data: [] }).ok)
  t.absent(validateEvent({ v: 1, event: 'warning', seq: 1, data: { line: 'x' }, id: 1 }).ok)
})

test('event: follows.changed', (t) => {
  const ev = (data) => validateEvent({ v: 1, event: 'follows.changed', seq: 1, data })
  t.ok(ev({ count: 0 }).ok)
  t.ok(ev({ count: 12 }).ok)
  t.ok(ev({ count: Number.MAX_SAFE_INTEGER }).ok)
  t.alike(ev({ count: 3 }).value, { v: 1, event: 'follows.changed', seq: 1, data: { count: 3 } })
  for (const data of [{}, { count: -1 }, { count: 1.5 }, { count: '1' }, { count: null }, { count: 2 ** 53 }, { count: 1, extra: 1 }, { runId: 1 }, [], null]) {
    t.absent(ev(data).ok, JSON.stringify(data))
  }
})
