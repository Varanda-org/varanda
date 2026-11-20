'use strict'

const test = require('brittle')
const rpc = require('..')
const event = require('../lib/event')

const START = '2026-12-24T20:00:00.000Z'
const END = '2026-12-24T23:00:00.000Z'
const ok = { title: 'Ceia', start: START, end: END, place: 'Casa da vó' }

test('event is exported from the package index', (t) => {
  t.is(rpc.event, event)
  t.is(rpc.isEvent, event.isEvent)
  t.is(rpc.isEventInstant, event.isEventInstant)
  t.alike([rpc.MAX_EVENT_TITLE, rpc.MAX_EVENT_PLACE, rpc.GROUP_EVENTS_LIMIT], [80, 120, 30])
  t.alike([event.MAX_EVENT_TITLE, event.MAX_EVENT_PLACE], [80, 120])
  t.alike([...event.EVENT_KEYS], ['title', 'start', 'end', 'place'])
  t.ok(Object.isFrozen(event.EVENT_KEYS))
  t.is(rpc.EVENT_MIN_MS, Date.UTC(2020, 0, 1))
  t.is(rpc.EVENT_MAX_MS, Date.UTC(2100, 0, 1))
})

test('isEvent: the valid shapes', (t) => {
  t.is(event.isEvent(ok), true)
  t.is(event.isEvent({ ...ok, end: null }), true, 'no end')
  t.is(event.isEvent({ ...ok, place: '' }), true, 'no place')
  t.is(event.isEvent({ title: 'a'.repeat(80), start: START, end: null, place: 'b'.repeat(120) }), true, 'at the limits')
  t.is(event.isEvent({ title: '\u{1f600}'.repeat(80), start: START, end: null, place: '\u{1f600}'.repeat(120) }), true, 'counts code points')
  t.is(event.isEvent(Object.assign(Object.create(null), ok)), true, 'a null-prototype object')
  t.is(event.isEvent({ ...ok, end: '2026-12-24T20:00:00.001Z' }), true, 'one millisecond later')
  t.is(event.isEvent({ ...ok, start: '2020-01-01T00:00:00.000Z', end: null }), true, 'the first instant')
  t.is(event.isEvent({ ...ok, start: '2100-01-01T00:00:00.000Z', end: null }), true, 'the last instant')
})

test('isEvent: exact key set', (t) => {
  for (const k of Object.keys(ok)) {
    const missing = { ...ok }
    delete missing[k]
    t.is(event.isEvent(missing), false, 'missing ' + k)
  }
  t.is(event.isEvent({ ...ok, extra: 1 }), false, 'extra key')
  t.is(event.isEvent({ ...ok, __proto__x: 1 }), false)
  t.is(event.isEvent({ title: ok.title, start: ok.start, place: ok.place, end: undefined }), false, 'end undefined')
  const sym = { ...ok }
  sym[Symbol('x')] = 1
  t.is(event.isEvent(sym), false, 'a symbol key')
  const hidden = { ...ok }
  Object.defineProperty(hidden, 'x', { value: 1, enumerable: false })
  t.is(event.isEvent(hidden), false, 'a non-enumerable extra key')
  for (const bad of [null, undefined, 5, 'x', true, [], [ok], new Date(), new Map(), () => ok, Object.create(ok)]) {
    t.is(event.isEvent(bad), false, String(bad))
  }
  class E { constructor () { Object.assign(this, ok) } }
  t.is(event.isEvent(new E()), false, 'a class instance')
})

test('isEvent: hostile getters never throw and never pass', (t) => {
  const getter = { ...ok }
  Object.defineProperty(getter, 'title', { get () { throw new Error('boom') }, enumerable: true })
  t.is(event.isEvent(getter), false, 'a throwing getter')
  let n = 0
  const flip = { ...ok }
  Object.defineProperty(flip, 'title', { get () { return n++ === 0 ? 'ok' : '' }, enumerable: true })
  t.is(event.isEvent(flip), false, 'an accessor is no data property')
  const proxy = new Proxy({ ...ok }, { ownKeys () { throw new Error('boom') } })
  t.is(event.isEvent(proxy), false, 'a throwing proxy')
  t.is(event.copyEvent(getter), getter, 'copyEvent passes a hostile object through')
})

test('isEvent: title is 1..80 code points on one line that show something', (t) => {
  const withTitle = (title) => event.isEvent({ ...ok, title })
  t.is(withTitle('a'.repeat(81)), false, 'over the limit')
  t.is(withTitle('\u{1f600}'.repeat(81)), false)
  t.is(withTitle(''), false)
  for (const blank of [' ', '\t', '​', '­⁠', 'ㅤ']) t.is(withTitle(blank), false, 'blank ' + JSON.stringify(blank))
  for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u202eb', 'a\u2066b', 'a\ud800b', 'a\udc00']) {
    t.is(withTitle(bad), false, JSON.stringify(bad))
  }
  for (const bad of [5, null, undefined, {}, ['a'], true]) t.is(withTitle(bad), false, String(bad))
})

test('isEvent: place is 0..120 code points on one line', (t) => {
  const withPlace = (place) => event.isEvent({ ...ok, place })
  t.is(withPlace('a'.repeat(121)), false, 'over the limit')
  t.is(withPlace(' '), false, 'a blank place is no place')
  t.is(withPlace('​'), false)
  for (const bad of ['a\nb', 'a\u0000b', 'a\ud800b', 'a\u202eb']) t.is(withPlace(bad), false, JSON.stringify(bad))
  for (const bad of [5, null, undefined, {}, true]) t.is(withPlace(bad), false, String(bad))
})

test('isEvent: instants are canonical, in range, end after start', (t) => {
  const at = (start, end = null) => event.isEvent({ ...ok, start, end })
  for (const bad of [
    '2026-12-24', '2026-12-24T20:00:00Z', '2026-12-24T20:00:00.0Z', '2026-12-24T20:00:00.000+00:00', '2026-12-24T20:00:00.000-03:00',
    '2026-12-24T20:00:00.000', '2026-12-24 20:00:00.000Z', '2026-12-24t20:00:00.000z', '2026-02-30T20:00:00.000Z', '2026-13-01T00:00:00.000Z',
    '2026-12-24T24:00:00.000Z', '2026-12-24T20:60:00.000Z', '+002026-12-24T20:00:00.000Z', ' 2026-12-24T20:00:00.000Z', '2026-12-24T20:00:00.000Z ',
    '2026-12-24T20:00:00.000Z\n', '', 'now', 0, 1.7e12, null, undefined, {}, true
  ]) t.is(at(bad), false, 'start ' + JSON.stringify(bad))
  t.is(at('2019-12-31T23:59:59.999Z'), false, 'before the range')
  t.is(at('2100-01-01T00:00:00.001Z'), false, 'after the range')
  t.is(at('0000-01-01T00:00:00.000Z'), false)
  t.is(at('9999-12-31T23:59:59.999Z'), false)
  t.is(at(START, START), false, 'end equals start')
  t.is(at(START, '2026-12-24T19:59:59.999Z'), false, 'end before start')
  t.is(at(START, 'x'), false, 'a bad end')
  t.is(at(START, ''), false, 'an empty end')
  t.is(at(START, 0), false)
  t.is(at(START, '2100-01-01T00:00:00.001Z'), false, 'end after the range')
  t.is(at('2026-01-01T00:00:00.000Z', '2027-01-02T00:00:00.000Z'), true, 'exactly the longest span (366 days)')
  t.is(at('2026-01-01T00:00:00.000Z', '2027-01-02T00:00:00.001Z'), false, 'over the longest span')
  t.is(event.isEventInstant(START), true)
  t.is(event.isEventInstant('2026-12-24T20:00:00Z'), false)
  t.is(event.isEventInstant(null), false)
})

test('copyEvent: exactly the four keys in order', (t) => {
  const copy = event.copyEvent({ place: 'p', end: null, start: START, title: 't' })
  t.alike(Object.keys(copy), ['title', 'start', 'end', 'place'])
  t.is(event.copyEvent(5), 5)
  t.is(event.copyEvent(null), null)
  const withExtra = { ...ok, extra: 1 }
  t.is(event.copyEvent(withExtra), withExtra, 'an object with extra keys is passed through for isEvent to reject')
  t.is(event.isEvent(event.copyEvent(withExtra)), false)
})

test('isEvent and copyEvent: a Proxy cannot answer differently after the check', (t) => {
  const big = 'a'.repeat(5000)
  const target = { ...ok }
  const get = new Proxy(target, { get (o, k) { return k === 'title' ? big : o[k] } })
  t.is(event.isEvent(get), true, 'the checked values are the target data properties')
  const copy = event.copyEvent(get)
  t.not(copy, get, 'a plain copy, not the proxy')
  t.is(copy.title, ok.title, 'the copy holds the checked value, not the trap answer')
  t.alike(copy, ok)
  let n = 0
  const flip = new Proxy({ ...ok }, {
    getOwnPropertyDescriptor (o, k) {
      const d = Reflect.getOwnPropertyDescriptor(o, k)
      return k === 'title' && n++ > 0 ? { ...d, value: big } : d
    }
  })
  const once = event.copyEvent(flip)
  t.is(event.isEvent(once), true, 'one snapshot: the copy validates')
  t.is(once.title, ok.title)
  const bigOnFirst = new Proxy({ ...ok }, { getOwnPropertyDescriptor (o, k) { const d = Reflect.getOwnPropertyDescriptor(o, k); return k === 'title' ? { ...d, value: big } : d } })
  t.is(event.isEvent(bigOnFirst), false, 'an oversized title read from the descriptor is rejected')
})
