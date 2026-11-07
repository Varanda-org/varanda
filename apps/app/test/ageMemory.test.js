'use strict'

// The device's age refusals (src/ageMemory.js) and the web store
// (src/ageStore.web.js). ES modules loaded through import(); storage is a
// fake globalThis.localStorage.
const test = require('brittle')

const load = () => import('../src/ageMemory.js')
const loadWeb = () => import('../src/ageStore.web.js')

const X = 'ab'.repeat(32)
const Y = 'cd'.repeat(32)
const A = 'https://varanda.example'
const B = 'http://localhost:8080'
const T1 = '2026-10-27T12:00:00.000Z'
const T2 = '2026-10-28T12:00:00.000Z'
const T3 = '2026-10-29T12:00:00.000Z'
const key = (i) => i.toString(16).padStart(64, '0')
const rec = (denied = []) => ({ v: 2, denied })

test('constants', async (t) => {
  const m = await load()
  t.is(m.STORAGE_KEY, 'varanda-age')
  t.is(m.FILE_NAME, 'varanda-age.json')
  t.is(m.MAX_DENIED, 32)
  t.alike(m.emptyAgeRecord(), rec())
  t.is(m.denialKey(X, A), X + '\n' + A)
  t.not(m.denialKey(X, A), m.denialKey(X, B))
})

test('only the refusal helpers are exported', async (t) => {
  const m = await load()
  t.alike(Object.keys(m).sort(), [
    'AGE_RECORD_UNREADABLE', 'FILE_NAME', 'MAX_DENIED', 'STORAGE_KEY', 'ageAnswerOutcome', 'ageRecordOf', 'ageRecordRead', 'ageStateShown', 'certVouches',
    'denialKey', 'emptyAgeRecord', 'isDenied', 'nodeVouches', 'withDenied', 'withoutDenied'
  ])
})

test('ageRecordOf: a v2 record round trips as a copy', async (t) => {
  const { ageRecordOf, MAX_DENIED } = await load()
  const r = rec([{ member: X, origin: A }, { member: Y, origin: B }, { member: X, origin: B }])
  const out = ageRecordOf(r)
  t.alike(out, r)
  t.not(out === r)
  out.denied[0].origin = B
  t.is(r.denied[0].origin, A, 'input untouched')
  t.alike(ageRecordOf(JSON.parse(JSON.stringify(r))), r, 'survives a save and load')
  const full = []
  for (let i = 0; i < MAX_DENIED; i++) full.push({ member: key(i), origin: A })
  t.ok(ageRecordOf(rec(full)))
})

test('ageRecordOf: the v1 shape (members / since) reads as null', async (t) => {
  const { ageRecordOf } = await load()
  t.is(ageRecordOf({ v: 1, members: { [X]: { origin: A, verifiedAt: T1 } }, since: { [A]: '1970-01-01T00:00:00.000Z' }, denied: {} }), null)
  t.is(ageRecordOf({ v: 1, members: { [X]: { origin: A, verifiedAt: T1 } }, since: {} }), null)
  t.is(ageRecordOf({ v: 2, members: {}, denied: [] }), null)
})

test('ageRecordRead: valid, v1 (replaceable) or unreadable', async (t) => {
  const { ageRecordRead, AGE_RECORD_UNREADABLE } = await load()
  t.ok(Object.isFrozen(AGE_RECORD_UNREADABLE))
  const r = rec([{ member: X, origin: A }])
  t.alike(ageRecordRead(r), r)
  t.is(ageRecordRead({ v: 1, members: {}, since: {}, denied: {} }), null, 'the v1 shape may be replaced')
  t.is(ageRecordRead({ v: 2, denied: [{ member: X }] }), AGE_RECORD_UNREADABLE, 'partial')
  t.is(ageRecordRead({ v: 3, denied: [] }), AGE_RECORD_UNREADABLE, 'unknown version')
  t.is(ageRecordRead('x'), AGE_RECORD_UNREADABLE)
  t.is(ageRecordRead(null), AGE_RECORD_UNREADABLE)
})

test('ageRecordOf refuses every invalid shape', async (t) => {
  const { ageRecordOf, MAX_DENIED } = await load()
  const entry = { member: X, origin: A }
  const tooMany = []
  for (let i = 0; i <= MAX_DENIED; i++) tooMany.push({ member: key(i), origin: A })
  class Box { constructor () { this.v = 2; this.denied = [] } }
  const cases = {
    null: null,
    undefined,
    string: 'x',
    array: [],
    'extra top key': { ...rec(), extra: 1 },
    'missing denied': { v: 2 },
    'v 1': { v: 1, denied: [] },
    'v string': { v: '2', denied: [] },
    'denied object': { v: 2, denied: {} },
    'entry extra key': rec([{ ...entry, verifiedAt: T1 }]),
    'entry missing origin': rec([{ member: X }]),
    'entry array': rec([[X, A]]),
    'entry string': rec([X]),
    'uppercase member': rec([{ member: 'AB'.repeat(32), origin: A }]),
    '63-char member': rec([{ member: X.slice(1), origin: A }]),
    'empty origin': rec([{ member: X, origin: '' }]),
    'ftp origin': rec([{ member: X, origin: 'ftp://x' }]),
    'origin with path': rec([{ member: X, origin: 'https://a.b/path' }]),
    'origin with trailing slash': rec([{ member: X, origin: 'https://a.b/' }]),
    'long origin': rec([{ member: X, origin: 'https://' + 'a'.repeat(200) + '.b' }]),
    duplicate: rec([entry, { ...entry }]),
    'too many': rec(tooMany),
    'class instance': new Box(),
    'null-prototype record': Object.assign(Object.create(null), rec()),
    'null-prototype entry': rec([Object.assign(Object.create(null), entry)])
  }
  for (const [name, value] of Object.entries(cases)) t.is(ageRecordOf(value), null, name)
  const throwing = rec()
  Object.defineProperty(throwing, 'denied', { enumerable: true, get () { throw new Error('boom') } })
  t.is(ageRecordOf(throwing), null, 'a throwing getter')
})

test('withDenied / isDenied: per member and installation, cap, newest last', async (t) => {
  const { withDenied, isDenied, MAX_DENIED } = await load()
  const r = withDenied(null, X, A)
  t.alike(r, rec([{ member: X, origin: A }]))
  t.is(isDenied(r, X, A), true)
  t.is(isDenied(r, X, B), false, 'another installation')
  t.is(isDenied(r, Y, A), false, 'another member')
  t.is(isDenied(null, X, A), false)
  t.is(isDenied({ ...r, extra: 1 }, X, A), false, 'invalid record')
  t.alike(withDenied(r, 'AB'.repeat(32), A), r, 'invalid member changes nothing')
  t.alike(withDenied(r, Y, 'ftp://x'), r, 'invalid origin changes nothing')

  const two = withDenied(withDenied(r, Y, A), X, A)
  t.alike(two.denied, [{ member: Y, origin: A }, { member: X, origin: A }], 'written again moves last, no duplicate')
  t.alike(r.denied, [{ member: X, origin: A }], 'input untouched')

  let full = null
  for (let i = 0; i < MAX_DENIED; i++) full = withDenied(full, key(i), A)
  const out = withDenied(full, X, B)
  t.is(out.denied.length, MAX_DENIED)
  t.alike(out.denied[MAX_DENIED - 1], { member: X, origin: B }, 'the denial just written is last')
  t.is(isDenied(out, key(0), A), false, 'the oldest denial goes')
  t.is(isDenied(out, key(1), A), true)
})

test('withoutDenied clears only the same installation', async (t) => {
  const { withDenied, withoutDenied, isDenied } = await load()
  const both = withDenied(withDenied(withDenied(null, X, A), X, B), Y, A)
  const out = withoutDenied(both, X, A)
  t.is(isDenied(out, X, A), false, 'cleared at A')
  t.is(isDenied(out, X, B), true, 'a denial at origin B survives a verificado at origin A')
  t.is(isDenied(out, Y, A), true, 'another member at A survives')
  t.is(isDenied(both, X, A), true, 'input untouched')
  t.alike(withoutDenied(null, X, A), rec())
})

test('ageAnswerOutcome: only recusado denies, only verificado clears', async (t) => {
  const { ageAnswerOutcome } = await load()
  const { AGE_STATES } = await import('../src/age.js')
  const expected = { verificado: 'clear', recusado: 'deny', pendente: 'show', inconclusivo: 'show', expirado: 'show', nenhum: 'show' }
  t.alike([...AGE_STATES].sort(), Object.keys(expected).sort(), 'every AGE_STATES value is covered')
  for (const s of AGE_STATES) t.is(ageAnswerOutcome(s), expected[s], s)
  for (const s of [undefined, null, 'Verificado', 'Recusado', 'x', '', 1, new Error('x')]) t.is(ageAnswerOutcome(s), 'show', String(s))
})

test('ageStateShown', async (t) => {
  const { ageStateShown } = await load()
  t.is(ageStateShown({ answered: 'recusado', remembered: true }), 'recusado')
  t.is(ageStateShown({ answered: undefined, remembered: true }), 'verificado')
  t.is(ageStateShown({ answered: undefined, remembered: false }), undefined)
  t.is(ageStateShown({ answered: null, remembered: true }), null)
  t.is(ageStateShown(), undefined)
})

test('certVouches', async (t) => {
  const { certVouches } = await load()
  t.is(certVouches({ certDate: T2, since: T1, until: T3 }), true, 'between')
  t.is(certVouches({ certDate: T1, since: T1, until: T3 }), true, 'equal to since')
  t.is(certVouches({ certDate: T3, since: T1, until: T3 }), true, 'equal to until')
  t.is(certVouches({ certDate: T1, since: T2, until: T3 }), false, 'before since')
  t.is(certVouches({ certDate: T3, since: T1, until: T2 }), false, 'after until')
  t.is(certVouches({ certDate: T2, since: T1 }), false, 'no until')
  t.is(certVouches({ certDate: T2, since: T1, until: null }), false, 'until null')
  for (const [certDate, since, until] of [
    [null, T1, T3], [T2, null, T3], [undefined, T1, T3], [T2, undefined, T3], ['lixo', T1, T3], [T2, 'lixo', T3], [T2, T1, 'lixo'],
    [T2, '2026-10-27T12:00:00Z', T3], ['2026-10-27T12:00:00Z', T1, T3], [T2, T1, '2026-10-29T12:00:00Z'],
    [Date.parse(T2), T1, T3], [T2, Date.parse(T1), T3], [T2, T1, Date.parse(T3)]
  ]) {
    t.is(certVouches({ certDate, since, until }), false, String([certDate, since, until]))
  }
  t.is(certVouches(), false)
})

test('nodeVouches truth table', async (t) => {
  const { nodeVouches } = await load()
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: null, ageSince: null, ageSinceUntil: null }), false, 'nothing')
  t.is(nodeVouches({ ageVerifiedDate: T1, memberCertDate: null, ageSince: null, ageSinceUntil: null }), true, 'age-verified attestation')
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T2, ageSince: T1, ageSinceUntil: T3 }), true, 'cert after since')
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T1, ageSince: T1, ageSinceUntil: T3 }), true, 'cert at since')
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T3, ageSince: T1, ageSinceUntil: T3 }), true, 'cert at until')
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T1, ageSince: T2, ageSinceUntil: T3 }), false, 'cert before since')
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T3, ageSince: T1, ageSinceUntil: T2 }), false, 'cert after until')
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T2, ageSince: T1, ageSinceUntil: null }), false, 'until null')
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T2, ageSince: T1 }), false, 'until missing')
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T2, ageSince: null, ageSinceUntil: T3 }), false, 'cert without since')
  t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: null, ageSince: T1, ageSinceUntil: T3 }), false, 'since without cert')
  for (const bad of ['2026-10-27T12:00:00Z', '2026-10-27', 'lixo', '', 1, true, {}, []]) {
    t.is(nodeVouches({ ageVerifiedDate: bad, memberCertDate: null, ageSince: null, ageSinceUntil: null }), false, 'ageVerifiedDate ' + String(bad))
    t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: bad, ageSince: T1, ageSinceUntil: T3 }), false, 'memberCertDate ' + String(bad))
    t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T2, ageSince: bad, ageSinceUntil: T3 }), false, 'ageSince ' + String(bad))
    t.is(nodeVouches({ ageVerifiedDate: null, memberCertDate: T2, ageSince: T1, ageSinceUntil: bad }), false, 'ageSinceUntil ' + String(bad))
  }
  t.is(nodeVouches(), false)
  t.is(nodeVouches({}), false)
})

test('every record the helpers produce holds refusals only', async (t) => {
  const m = await load()
  const produced = [
    m.emptyAgeRecord(),
    m.withDenied(null, X, A),
    m.withoutDenied(m.withDenied(null, X, A), X, A),
    m.withDenied(m.withDenied(null, Y, B), Y, A),
    m.withDenied({ v: 1, members: { [X]: { origin: A, verifiedAt: T1 } }, since: { [A]: T1 }, denied: {} }, Y, A)
  ]
  for (const r of produced) {
    t.alike(Object.keys(r).sort(), ['denied', 'v'], JSON.stringify(r))
    for (const d of r.denied) t.alike(Object.keys(d).sort(), ['member', 'origin'])
  }
  t.absent(JSON.stringify(produced).includes(X + '","origin":"' + A + '","verifiedAt'), 'a v1 verified entry is never carried over')
})

function fakeStorage (t, impl) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => impl() })
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete globalThis.localStorage
  })
}

test('ageStore.web: round trip under varanda-age', async (t) => {
  const { loadAgeRecord, saveAgeRecord } = await loadWeb()
  const map = new Map()
  const storage = { getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)) }
  fakeStorage(t, () => storage)
  t.is(await loadAgeRecord(), null, 'empty')
  const r = rec([{ member: X, origin: A }])
  t.is(await saveAgeRecord(r), true)
  t.alike(JSON.parse(map.get('varanda-age')), r)
  t.alike(await loadAgeRecord(), r)
  map.clear()
  t.is(await saveAgeRecord({ v: 2 }), false, 'invalid record not saved')
  t.is(await saveAgeRecord(rec([{ member: X, origin: A, ageBand: '18+' }])), false, 'extra field not saved')
  t.is(map.size, 0, 'nothing stored')
  const { AGE_RECORD_UNREADABLE } = await load()
  map.set('varanda-age', '{nope')
  t.is(await loadAgeRecord(), AGE_RECORD_UNREADABLE, 'corrupt JSON is there, not absent')
  map.set('varanda-age', JSON.stringify({ ...r, extra: 1 }))
  t.is(await loadAgeRecord(), AGE_RECORD_UNREADABLE, 'invalid shape')
  map.set('varanda-age', JSON.stringify({ v: 1, members: { [X]: { origin: A, verifiedAt: T1 } }, since: {}, denied: {} }))
  t.is(await loadAgeRecord(), null, 'a v1 record reads as nothing')
})

test('ageStore.web: never throws when localStorage is missing or throws', async (t) => {
  const { loadAgeRecord, saveAgeRecord } = await loadWeb()
  const r = rec([{ member: X, origin: A }])
  let mode = 'getter'
  const boom = () => { throw new Error('denied') }
  fakeStorage(t, () => {
    if (mode === 'getter') boom()
    if (mode === 'missing') return undefined
    return { getItem: boom, setItem: boom }
  })
  const { AGE_RECORD_UNREADABLE } = await load()
  for (const m of ['getter', 'missing', 'methods']) {
    mode = m
    t.is(await loadAgeRecord(), AGE_RECORD_UNREADABLE, m + ': load is unknown, never "no record"')
    t.is(await saveAgeRecord(r), false, m + ': save')
  }
})

test('ageStore.web: withAgeLock uses Web Locks when present, runs directly otherwise', async (t) => {
  const { withAgeLock } = await loadWeb()
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'navigator', had)
    else delete globalThis.navigator
  })
  const names = []
  Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({ locks: { request: async (name, fn) => { names.push(name); return fn() } } }) })
  t.is(await withAgeLock(async () => 7), 7)
  t.alike(names, ['varanda-age'])
  Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => ({}) })
  t.is(await withAgeLock(async () => 8), 8, 'no locks API')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, get: () => { throw new Error('nope') } })
  t.is(await withAgeLock(async () => 9), 9, 'navigator throws')
})

test('ageStore.web: onAgeRecordChange listens for this key only, and is a no-op without window', async (t) => {
  const { onAgeRecordChange } = await loadWeb()
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'window', had)
    else delete globalThis.window
  })
  delete globalThis.window
  const noop = onAgeRecordChange(() => {})
  t.is(typeof noop, 'function')
  noop()
  const fns = new Set()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (ty, f) => fns.add(f), removeEventListener: (ty, f) => fns.delete(f) } })
  let n = 0
  const off = onAgeRecordChange(() => { n++ })
  for (const f of fns) {
    f({ key: 'x' })
    f({ key: 'varanda-age' })
    f({ key: null })
  }
  t.is(n, 2, 'its key and clear()')
  off()
  t.is(fns.size, 0)
  Object.defineProperty(globalThis, 'window', { configurable: true, get: () => { throw new Error('nope') } })
  t.is(typeof onAgeRecordChange(() => {}), 'function', 'never throws')
})

test('ageStore.native: atomic replace, unreadable never saved over, passthrough lock', (t) => {
  const s = require('fs').readFileSync(require('path').join(__dirname, '../src/ageStore.native.js'), 'utf8')
  const appearance = require('fs').readFileSync(require('path').join(__dirname, '../src/appearanceStore.native.js'), 'utf8')
  const body = (src) => src.slice(src.indexOf('function replaceFile (text) {'), src.indexOf('\n}\n', src.indexOf('function replaceFile (text) {')))
  t.ok(body(s).length > 0 && body(s) === body(appearance), 'same .tmp/.bak replace as appearanceStore.native.js')
  t.ok(s.includes('replaceFile(JSON.stringify(valid))'), 'the save goes through it')
  t.absent(/\bf\.write\(/.test(s), 'no in-place write')
  t.ok(s.includes("if (!f.exists) f = file('.bak')"), 'a crash between the moves still reads the .bak')
  t.ok(s.includes('return AGE_RECORD_UNREADABLE'), 'a present but unreadable file is reported as such')
  t.ok(s.includes('export async function withAgeLock (fn) {\n  return fn()\n}'), 'passthrough lock')
  t.ok(s.includes('export function onAgeRecordChange () {\n  return () => {}\n}'), 'no other writer to hear')
})
