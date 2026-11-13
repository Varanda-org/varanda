'use strict'

const test = require('brittle')
const rpc = require('..')
const music = require('../lib/music')

const { isMomentMusic, MOMENT_MUSIC_KEYS, MOMENT_SNIPPET_S } = music

const OK = { p: 'audius', id: 'D7KyD', start: 0 }

test('music rules: exported from the package index', (t) => {
  for (const k of Object.keys(music)) t.is(rpc[k], music[k], k)
  t.alike(MOMENT_MUSIC_KEYS, ['p', 'id', 'start'])
  t.is(MOMENT_SNIPPET_S, 15)
})

test('isMomentMusic: accepts exactly p, id and start', (t) => {
  t.ok(isMomentMusic(OK))
  t.ok(isMomentMusic({ start: 7200, id: 'A'.repeat(32), p: 'audius' }), 'key order is free, maximal values')
  t.ok(isMomentMusic({ p: 'audius', id: 'a1', start: 15 }))
  const bare = Object.create(null)
  Object.assign(bare, OK)
  t.ok(isMomentMusic(bare), 'a null-prototype object')
})

test('isMomentMusic: refuses anything else and never throws', (t) => {
  for (const v of [
    undefined, null, 0, 'audius', true, [], [OK], {},
    { p: 'audius', id: 'D7KyD' },
    { p: 'audius', start: 0 },
    { id: 'D7KyD', start: 0 },
    { ...OK, title: 'x' },
    { ...OK, url: 'https://audius.co/a/b' },
    { ...OK, p: 'Audius' },
    { ...OK, p: 'spotify' },
    { ...OK, p: null },
    { ...OK, id: '' },
    { ...OK, id: 'A'.repeat(33) },
    { ...OK, id: 'ab-c' },
    { ...OK, id: 'ab_c' },
    { ...OK, id: 'abc\n' },
    { ...OK, id: 'á' },
    { ...OK, id: 12 },
    { ...OK, start: -1 },
    { ...OK, start: 7201 },
    { ...OK, start: 1.5 },
    { ...OK, start: '0' },
    { ...OK, start: null },
    { ...OK, start: NaN },
    { ...OK, start: Infinity },
    new Map(Object.entries(OK)),
    Object.assign(Object.create({ inherited: 1 }), OK)
  ]) t.absent(isMomentMusic(v), JSON.stringify(v) === undefined ? String(v) : JSON.stringify(v))
  const inherited = Object.create(OK)
  t.absent(isMomentMusic(inherited), 'inherited keys')
  const throwing = new Proxy({}, { ownKeys () { throw new Error('boom') } })
  t.absent(isMomentMusic(throwing), 'a throwing proxy')
  const getter = { p: 'audius', id: 'D7KyD' }
  Object.defineProperty(getter, 'start', { enumerable: true, get () { throw new Error('boom') } })
  t.absent(isMomentMusic(getter), 'a throwing getter')
})
