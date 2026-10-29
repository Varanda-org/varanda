'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/intro.js')
const loadWeb = () => import('../src/introStore.web.js')
const AT = '2026-10-27T12:00:00.000Z'
const rec = (seenVersion = 1, at = AT) => ({ v: 1, seenVersion, at })

test('introRecordOf accepts valid records and returns a copy', async (t) => {
  const { introRecordOf } = await load()
  for (const version of [1, 2, 9999]) {
    const record = rec(version)
    const out = introRecordOf(record)
    t.alike(out, record)
    t.not(out, record)
  }
})

test('introRecordOf refuses invalid shapes, versions and dates', async (t) => {
  const { introRecordOf } = await load()
  const bad = [
    null, undefined, 1, 'x', [], [rec()], {},
    { v: 1, seenVersion: 1 },
    { ...rec(), extra: 1 },
    { ...rec(), v: 2 },
    { ...rec(), v: '1' },
    rec(0), rec(10000), rec(1.5), rec('1'), rec(NaN), rec(Infinity),
    rec(1, '2026-10-27'),
    rec(1, '2026-10-27T12:00:00Z'),
    rec(1, '2026-10-27T12:00:00.000+00:00'),
    rec(1, '2026-02-30T12:00:00.000Z'),
    rec(1, 'invalid'), rec(1, 5), rec(1, null),
    Object.assign(Object.create(null), rec()),
    Object.assign(Object.create({ inherited: true }), rec()),
    { ...rec(), [Symbol('extra')]: true },
    Object.defineProperty(rec(), 'hidden', { value: true })
  ]
  for (const value of bad) t.is(introRecordOf(value), null, JSON.stringify(value))
  const throwing = Object.defineProperty(rec(), 'at', { get () { throw new Error('unavailable') } })
  t.is(introRecordOf(throwing), null, 'throwing getter')
})

test('introDecision: loading takes precedence, newer versions show again', async (t) => {
  const { introDecision } = await load()
  for (const status of ['loading', 'failed', undefined, null]) {
    for (const record of [null, rec(1), rec(2), rec(3)]) {
      t.is(introDecision({ status, record, version: 2 }), 'loading')
    }
  }
  for (const [record, expected] of [[null, 'show'], [rec(1), 'show'], [rec(2), 'done'], [rec(3), 'done']]) {
    t.is(introDecision({ status: 'ready', record, version: 2 }), expected)
  }
})

test('withSeen creates a fresh valid presentation record', async (t) => {
  const { withSeen, introRecordOf, INTRO_VERSION, FILE_NAME } = await load()
  t.is(INTRO_VERSION, 1)
  t.is(FILE_NAME, 'varanda-intro.json')
  for (const version of [INTRO_VERSION, 2, 9999]) {
    const record = withSeen(version, AT)
    t.alike(record, rec(version))
    t.alike(introRecordOf(record), record)
    t.not(withSeen(version, AT), record)
  }
})

function fakeStorage (t, impl) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => impl() })
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete globalThis.localStorage
  })
}

test('introStore.web: round trip and invalid records', async (t) => {
  const { loadIntroRecord, saveIntroRecord } = await loadWeb()
  const { STORAGE_KEY } = await load()
  const map = new Map()
  const storage = { getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)) }
  fakeStorage(t, () => storage)
  t.is(STORAGE_KEY, 'varanda-intro')
  t.is(await loadIntroRecord(), null, 'empty')
  t.is(await saveIntroRecord(rec(2)), true)
  t.alike(JSON.parse(map.get(STORAGE_KEY)), rec(2))
  t.alike(await loadIntroRecord(), rec(2))
  t.is(await saveIntroRecord({ ...rec(), extra: 1 }), false)
  t.alike(await loadIntroRecord(), rec(2), 'invalid save preserves the stored record')
  map.set(STORAGE_KEY, '{invalid')
  t.is(await loadIntroRecord(), null, 'corrupt JSON')
  map.set(STORAGE_KEY, JSON.stringify({ ...rec(), extra: 1 }))
  t.is(await loadIntroRecord(), null, 'invalid shape')
})

test('introStore.web: throwing or missing storage is guarded on every call', async (t) => {
  const { loadIntroRecord, saveIntroRecord } = await loadWeb()
  let impl = () => { throw new Error('SecurityError') }
  fakeStorage(t, () => impl())
  t.is(await loadIntroRecord(), null)
  t.is(await saveIntroRecord(rec()), false)
  impl = () => ({ getItem () { throw new Error('read refused') }, setItem () { throw new Error('QuotaExceeded') } })
  t.is(await loadIntroRecord(), null)
  t.is(await saveIntroRecord(rec()), false)
  impl = () => undefined
  t.is(await loadIntroRecord(), null)
  t.is(await saveIntroRecord(rec()), false)
})

test('INTRO_CARDS: three frozen cards with plain text and existing icons', async (t) => {
  const { INTRO_CARDS } = await load()
  const source = readFileSync(join(__dirname, '../src/ui/Icon.js'), 'utf8')
  const glyphBlock = source.match(/const GLYPHS = \{([^}]+)\}/)
  t.ok(glyphBlock, 'GLYPHS found without importing React')
  const icons = new Set([...glyphBlock[1].matchAll(/^\s+(\w+):/gm)].map((match) => match[1]))
  const technical = /(^|[^\p{L}])(semeador|chave|certificado|nó)(?![\p{L}])/iu
  t.is(INTRO_CARDS.length, 3)
  t.ok(Object.isFrozen(INTRO_CARDS))
  t.is(new Set(INTRO_CARDS.map((card) => card.id)).size, 3, 'distinct ids')
  for (const card of INTRO_CARDS) {
    t.ok(Object.isFrozen(card))
    t.alike(Object.keys(card).sort(), ['body', 'icon', 'id', 'title'])
    t.ok(icons.has(card.icon), card.icon)
    for (const text of Object.values(card)) {
      t.is(typeof text, 'string')
      t.ok(text.length > 0)
      t.absent(text.includes('\u2014'), text)
      t.absent(technical.test(text), text)
    }
  }
})
