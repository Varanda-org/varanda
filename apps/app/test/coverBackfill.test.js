'use strict'

const test = require('brittle')
const { register } = require('node:module')

let start = 0
const load = () => import('../src/coverBackfill.js?start=' + ++start)
const OWN = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const PAGE = 'ef'.repeat(32)
const ref = (seq, diary = OWN) => diary + ':' + seq
const own = (seq) => ({ ref: ref(seq), kind: 'own' })
const page = (seq) => ({ ref: ref(seq, PAGE), kind: 'page' })
const entry = (seq, outcome = 'done') => ({ ref: ref(seq), outcome })

function memory (initial = []) {
  const values = new Map(initial)
  return {
    values,
    read: (identity) => values.has(identity) ? values.get(identity) : null,
    write: async (identity, text) => { values.set(identity, text) }
  }
}

function deferred () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

async function begin (store, identity = OWN) {
  const m = await load()
  return m.createBackfillPlanner({ store, identity }).beginPass()
}

async function finish (pass, candidates, outcome = 'done') {
  const candidate = await pass.nextStep(candidates)
  await pass.claim(candidate.ref)
  await pass.settle(candidate.ref, outcome)
  return candidate
}

test('backfill caps a pass at four, with own posts before at most one page', async (t) => {
  const m = await load()
  t.is(m.MAX_PER_PASS, 4)
  t.is(m.MAX_PAGE_PER_PASS, 1)
  const store = memory()
  const pass = m.createBackfillPlanner({ store, identity: OWN }).beginPass()
  const candidates = [page(0), own(0), page(1), own(1), own(2)]
  for (const candidate of [own(0), own(1), own(2), page(0)]) {
    t.alike(await finish(pass, candidates), candidate)
  }
  t.is(await pass.nextStep([...candidates, own(3)]), null, 'four claims exhaust the pass')
  t.is(JSON.parse(store.read(OWN)).length, 4)
})

test('backfill page limit leaves room for own posts', async (t) => {
  const pass = await begin(memory())
  t.alike(await finish(pass, [page(0), page(1)]), page(0))
  t.is(await pass.nextStep([page(1)]), null)
  t.alike(await finish(pass, [page(1), own(0)]), own(0))
})

test('backfill only begins once per identity in the module lifetime', async (t) => {
  const m = await load()
  const store = memory()
  const planner = m.createBackfillPlanner({ store, identity: OWN })
  const pass = planner.beginPass()
  t.ok(pass)
  t.is(planner.beginPass(), null)
  await finish(pass, [own(0)])
  t.is(m.createBackfillPlanner({ store, identity: OWN }).beginPass(), null, 'recreating a planner cannot reset the start')
  t.ok(m.createBackfillPlanner({ store, identity: OTHER }).beginPass(), 'another identity has its own pass')
  const restarted = await begin(store)
  t.alike(await restarted.nextStep([own(0), own(1)]), own(1), 'new module simulates a new process, keeping the ledger')
})

test('backfill never returns an attempted ref, for every outcome and after restart', async (t) => {
  for (const outcome of ['pending', 'done', 'no-decode', 'failed', 'uncertain']) {
    const store = memory()
    const pass = await begin(store)
    t.alike(await pass.nextStep([own(0)]), own(0))
    await pass.claim(ref(0))
    if (outcome !== 'pending') await pass.settle(ref(0), outcome)
    t.is(await pass.nextStep([own(0)]), null, outcome + ' blocks another attempt')
    t.alike(JSON.parse(store.read(OWN)), [entry(0, outcome)])
    const restarted = await begin(store)
    t.alike(await restarted.nextStep([own(0), own(1)]), own(1), outcome + ' survives restart')
  }
})

test('backfill ref validation rejects aliases, unsafe numbers and foreign own posts', async (t) => {
  const m = await load()
  for (const value of [ref(0), ref(1), ref(Number.MAX_SAFE_INTEGER), ref(0, PAGE)]) t.ok(m.isBackfillRef(value), String(value))
  const invalid = [null, {}, 0, '', OWN, ref(-1), ref(1.5), ref('01'), ref('+1'), ref('-0'), ref('1e2'),
    ref(''), ref(' 1'), ref('1\n'), ref(Number.MAX_SAFE_INTEGER + 1), ref(1, OWN.toUpperCase()), ref(1, 'a'.repeat(63)), ref('0:1')]
  for (const value of invalid) t.absent(m.isBackfillRef(value), String(value))
  const pass = m.createBackfillPlanner({ store: memory(), identity: OWN }).beginPass()
  const candidates = invalid.map((value) => ({ ref: value, kind: 'own' }))
  candidates.push({ ref: ref(0, OTHER), kind: 'own' }, { ...own(0), kind: 'page' }, { ...own(0), kind: 'other' }, own(1))
  t.alike(await pass.nextStep(candidates), own(1))
  t.exception(() => m.createBackfillPlanner({ store: memory(), identity: '../invalid' }))
})

test('backfill doubtful stored ledgers fail closed', async (t) => {
  const { LEDGER_CAP } = await load()
  const invalid = [
    '', '{bad', 'null', '{}', 'false', '42', '"text"', undefined, [],
    JSON.stringify({ entries: [] }), JSON.stringify([null]), JSON.stringify([[]]),
    JSON.stringify([{ ref: 'bad', outcome: 'done' }]),
    JSON.stringify([{ ...entry(0), outcome: 'other' }]),
    JSON.stringify([{ ref: ref(0) }]),
    JSON.stringify([{ ...entry(0), url: 'https://example.invalid' }]),
    JSON.stringify([entry(0), entry(0, 'uncertain')]),
    JSON.stringify(Array.from({ length: LEDGER_CAP + 1 }, (_, seq) => entry(seq)))
  ]
  for (const text of invalid) {
    const store = memory([[OWN, text]])
    const pass = await begin(store)
    t.is(await pass.nextStep([own(LEDGER_CAP + 2)]), null, 'doubtful ledger blocks work')
    t.is(store.read(OWN), text, 'no repair or eviction')
    store.values.delete(OWN)
    t.is(await pass.nextStep([own(0)]), null, 'the failed pass stays stopped')
  }
})

test('backfill full ledger stops without eviction, including when the last slot is claimed', async (t) => {
  const { LEDGER_CAP } = await load()
  const entries = Array.from({ length: LEDGER_CAP - 1 }, (_, seq) => entry(seq))
  const store = memory([[OWN, JSON.stringify(entries)]])
  const pass = await begin(store)
  await finish(pass, [own(LEDGER_CAP)])
  t.alike(JSON.parse(store.read(OWN)), [...entries, entry(LEDGER_CAP)])
  t.is(await pass.nextStep([own(LEDGER_CAP + 1)]), null)
  const restarted = await begin(store)
  t.is(await restarted.nextStep([own(LEDGER_CAP + 1)]), null)
  t.is(JSON.parse(store.read(OWN)).length, LEDGER_CAP)
})

test('backfill claim waits for durable pending before returning permission to work', async (t) => {
  const store = memory()
  const entered = deferred()
  const durable = deferred()
  const write = store.write
  store.write = async (identity, text) => {
    entered.resolve()
    await durable.promise
    await write(identity, text)
  }
  const pass = await begin(store)
  await pass.nextStep([own(0)])
  let startedWork = false
  const claiming = pass.claim(ref(0)).then(() => { startedWork = true })
  await entered.promise
  for (let i = 0; i < 10; i++) await Promise.resolve()
  t.absent(startedWork, 'claim must not resolve before the store write')
  t.is(store.read(OWN), null, 'the delayed write has not persisted yet')
  t.is(await pass.nextStep([own(1)]), null, 'no parallel step while writing')
  durable.resolve()
  await claiming
  t.ok(startedWork)
  t.alike(JSON.parse(store.read(OWN)), [entry(0, 'pending')])
})

test('backfill claim write failure rejects and permanently stops the pass', async (t) => {
  const store = memory()
  let writes = 0
  store.write = async () => { writes++; throw new Error('disk full') }
  const pass = await begin(store)
  await pass.nextStep([own(0)])
  await t.exception(pass.claim(ref(0)), /disk full/)
  t.is(await pass.nextStep([own(1)]), null)
  await t.exception(pass.claim(ref(0)))
  t.is(writes, 1, 'no retry')
  t.is(store.read(OWN), null)
})

test('backfill an uncertain store write still leaves a ref attempted across restart', async (t) => {
  const store = memory()
  const write = store.write
  store.write = async (identity, text) => {
    await write(identity, text)
    throw new Error('lost acknowledgement')
  }
  const pass = await begin(store)
  await pass.nextStep([own(0)])
  await t.exception(pass.claim(ref(0)), /lost acknowledgement/)
  const restarted = await begin(store)
  t.is(await restarted.nextStep([own(0)]), null)
})

test('backfill failed settlement keeps pending and stops the pass', async (t) => {
  const store = memory()
  const pass = await begin(store)
  await pass.nextStep([own(0)])
  await pass.claim(ref(0))
  store.write = async () => { throw new Error('disk full') }
  await t.exception(pass.settle(ref(0), 'done'), /disk full/)
  t.alike(JSON.parse(store.read(OWN)), [entry(0, 'pending')])
  t.is(await pass.nextStep([own(1)]), null)
  const restarted = await begin(store)
  t.is(await restarted.nextStep([own(0)]), null)
})

test('backfill claims only the selected ref once and settles only final outcomes', async (t) => {
  const pass = await begin(memory())
  await t.exception(pass.claim(ref(0)), 'cannot bypass selection')
  await pass.nextStep([own(0)])
  t.is(await pass.nextStep([own(1)]), null, 'one selected item at a time')
  await t.exception(pass.claim(ref(1)))
  await t.exception(pass.settle(ref(0), 'done'))
  await pass.claim(ref(0))
  await t.exception(pass.claim(ref(0)))
  await t.exception(pass.settle(ref(0), 'pending'))
  await t.exception(pass.settle(ref(0), 'unknown'))
  await pass.settle(ref(0), 'done')
  await t.exception(pass.settle(ref(0), 'done'))
})

test('backfill rereads strictly at selection, claim and settlement', async (t) => {
  for (const phase of ['selection', 'claim', 'settlement']) {
    const store = memory()
    const pass = await begin(store)
    if (phase !== 'selection') await pass.nextStep([own(0)])
    if (phase === 'settlement') await pass.claim(ref(0))
    store.values.set(OWN, '{bad')
    if (phase === 'selection') t.is(await pass.nextStep([own(0)]), null)
    if (phase === 'claim') await t.exception(pass.claim(ref(0)))
    if (phase === 'settlement') await t.exception(pass.settle(ref(0), 'done'))
    t.is(store.read(OWN), '{bad', 'does not overwrite doubtful evidence')
    t.is(await pass.nextStep([own(1)]), null)
  }
})

test('backfill a throwing read and disappearing evidence stop work', async (t) => {
  const store = memory()
  const pass = await begin(store)
  store.read = () => { throw new Error('unavailable') }
  t.is(await pass.nextStep([own(0)]), null)
  const other = memory([[OWN, JSON.stringify([entry(0)])]])
  const second = await begin(other)
  await second.nextStep([own(1)])
  other.values.delete(OWN)
  await t.exception(second.claim(ref(1)))
  t.is(await second.nextStep([own(2)]), null)
})

test('backfill ledgers are separate and persist only refs and outcomes', async (t) => {
  const m = await load()
  const store = memory([[OWN, '{bad']])
  const blocked = m.createBackfillPlanner({ store, identity: OWN }).beginPass()
  const pass = m.createBackfillPlanner({ store, identity: OTHER }).beginPass()
  t.is(await blocked.nextStep([own(0)]), null)
  await finish(pass, [{ ...page(0), name: 'unused', url: 'https://example.invalid', bytes: [1, 2], key: OWN }])
  t.alike(JSON.parse(store.read(OTHER)), [{ ref: ref(0, PAGE), outcome: 'done' }])
  t.is(store.read(OWN), '{bad')
  const restarted = await begin(store, OWN)
  t.is(await restarted.nextStep([page(0)]), null, 'another identity cannot unblock this one')
  store.values.delete(OWN)
  const fresh = await begin(store, OWN)
  t.alike(await fresh.nextStep([page(0)]), page(0), 'other identity attempts do not block this identity')
})

test('backfill native file adapter serializes identities and preserves doubtful ledgers', async (t) => {
  const m = await load()
  let raw = JSON.stringify({ [OWN]: [{ ref: 'bad', outcome: 'done' }] })
  const store = m.createBackfillFileStore({ read: async () => raw, write: async (text) => { raw = text } })
  const first = JSON.stringify([entry(1)])
  const second = JSON.stringify([entry(2, 'pending')])
  t.is(await store.read(OTHER), null)
  await Promise.all([store.write(OTHER, first), store.write(PAGE, second)])
  t.is(await store.read(OTHER), first)
  t.is(await store.read(PAGE), second)
  t.alike(JSON.parse(await store.read(OWN)), [{ ref: 'bad', outcome: 'done' }])
  const blocked = m.createBackfillPlanner({ store, identity: OWN }).beginPass()
  t.is(await blocked.nextStep([own(0)]), null)
  await t.exception(store.write(OWN, '{bad'))
  for (const text of ['{bad', 'null', '[]', '{"unknown":[]}']) {
    raw = text
    await t.exception.all(store.read(OWN))
    await t.exception.all(store.write(OTHER, first))
    t.is(raw, text)
  }
})

test('backfill web store uses identity keys and refuses failed reads and writes', async (t) => {
  const store = await import('../src/coverBackfillStore.web.js')
  const values = new Map()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, text) => values.set(key, text)
    }
  })
  t.teardown(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  })
  t.is(store.read(OWN), null)
  await store.write(OWN, JSON.stringify([entry(0)]))
  t.is(store.read(OWN), values.get('varanda.coverBackfill.' + OWN))
  t.is(store.read(OTHER), null)
  globalThis.localStorage.getItem = () => { throw new Error('denied') }
  t.is(store.read(OWN), null)
  await t.exception(store.write(OWN, '[]'), /indisponível/)
  t.alike(JSON.parse(values.get('varanda.coverBackfill.' + OWN)), [entry(0)])
  globalThis.localStorage.getItem = (key) => values.get(key) ?? null
  store.read(OWN)
  globalThis.localStorage.setItem = () => { throw new Error('quota') }
  await t.exception(store.write(OWN, '[]'), /quota/)
  delete globalThis.localStorage
  t.is(store.read(OTHER), null)
  await t.exception(store.write(OTHER, '[]'))
})

const nativeStub = `
export const Paths = { document: { uri: 'file:///stub/Documents/' } }
export class File {
  constructor (dir, name) { this.uri = dir.uri + name }
  get exists () { return globalThis.__backfillFiles.has(this.uri) }
  create () { globalThis.__backfillFiles.set(this.uri, '') }
  write (text) {
    if (globalThis.__backfillFailWrite) {
      globalThis.__backfillFiles.set(this.uri, text.slice(0, 5))
      throw new Error('disk full')
    }
    globalThis.__backfillFiles.set(this.uri, text)
  }
  async text () { return globalThis.__backfillFiles.get(this.uri) }
  delete () { globalThis.__backfillFiles.delete(this.uri) }
  move (dest) {
    if (globalThis.__backfillFailMove && this.uri.endsWith('.tmp')) throw new Error('move failed')
    if (dest.exists) throw new Error('exists')
    globalThis.__backfillFiles.set(dest.uri, globalThis.__backfillFiles.get(this.uri))
    globalThis.__backfillFiles.delete(this.uri)
    this.uri = dest.uri
  }
}
`
const hooks = `
export async function resolve (specifier, context, next) {
  if (specifier === 'expo-file-system') return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(nativeStub))}, shortCircuit: true }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks))

test('backfill native store keeps one atomic file and falls back to the backup', async (t) => {
  const store = await import('../src/coverBackfillStore.native.js')
  const files = new Map()
  globalThis.__backfillFiles = files
  t.teardown(() => {
    delete globalThis.__backfillFiles
    delete globalThis.__backfillFailWrite
    delete globalThis.__backfillFailMove
  })
  const name = 'file:///stub/Documents/varanda-cover-backfill.json'
  const text = JSON.stringify([entry(0, 'pending')])
  t.is(await store.read(OWN), null)
  await store.write(OWN, text)
  t.is(await store.read(OWN), text)
  t.alike([...files.keys()], [name])
  for (const failure of ['__backfillFailWrite', '__backfillFailMove']) {
    globalThis[failure] = true
    await t.exception(store.write(OWN, JSON.stringify([entry(0)])))
    globalThis[failure] = false
    t.is(await store.read(OWN), text, 'pending survives ' + failure)
    t.alike([...files.keys()], [name], 'temporary files cleaned up')
  }
  files.set(name + '.bak', files.get(name))
  files.delete(name)
  t.is(await store.read(OWN), text)
  await store.write(OTHER, JSON.stringify([entry(1)]))
  t.is(await store.read(OWN), text, 'another identity preserves the backup ledger')
  t.alike([...files.keys()], [name])
  globalThis.__backfillFiles = null
  await t.exception.all(store.read(OWN))
  await t.exception.all(store.write(OWN, text))
})
