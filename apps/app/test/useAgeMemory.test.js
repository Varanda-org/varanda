'use strict'

// src/useAgeMemory.js without React: 'react' is replaced with a stub that
// keeps the effects in globalThis.__ageEffects (so a test runs the mount and
// its cleanup by hand), and './ageStore' resolves to the web store, as Metro
// would pick one per platform. Storage is a fake globalThis.localStorage.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

const hooks = `
const react = 'export const useCallback = (f) => f; export const useEffect = (f) => { (globalThis.__ageEffects ||= []).push(f) }; export const useRef = (v) => ({ current: v }); export const useState = (v) => [v, () => {}]'
export async function resolve (specifier, context, next) {
  if (specifier === 'react') return { url: 'data:text/javascript,' + encodeURIComponent(react), shortCircuit: true }
  if (specifier === './ageStore' && context.parentURL && context.parentURL.includes('/src/')) {
    return next('./ageStore.web.js', context)
  }
  return next(specifier, context)
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), pathToFileURL(__filename))

const load = () => import('../src/useAgeMemory.js')
const memory = () => import('../src/ageMemory.js')

const M = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const ORIGIN = 'https://varanda.example.test'
const ORIGIN_B = 'https://outra.example.test'
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

function fakeStorage (t) {
  const map = new Map()
  let failSet = 0
  const storage = {
    getItem: (k) => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => {
      if (failSet > 0) { failSet--; throw new Error('quota') }
      map.set(k, String(v))
    }
  }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => storage })
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete globalThis.localStorage
  })
  return {
    read: () => map.has('varanda-age') ? JSON.parse(map.get('varanda-age')) : null,
    write: (r) => map.set('varanda-age', JSON.stringify(r)),
    raw: (text) => map.set('varanda-age', text),
    rawValue: () => map.get('varanda-age'),
    failNextSet: (n = 1) => { failSet = n }
  }
}

// One "render" of the hook; the mount effect is returned, not run.
async function mountHook () {
  const { useAgeMemory } = await load()
  globalThis.__ageEffects = []
  const api = useAgeMemory()
  const effects = globalThis.__ageEffects
  globalThis.__ageEffects = []
  return { api, mount: effects[0] }
}

test('openNow: the session set and the record close it; only the node vouch opens it', async (t) => {
  const { openNow } = await load()
  const { withDenied, denialKey } = await memory()
  const denied = withDenied(null, M, ORIGIN)
  t.is(openNow(null, new Set(), M, ORIGIN, true), true, 'the node vouch alone opens it')
  t.is(openNow(null, new Set(), M, ORIGIN, false), false, 'nothing else opens it')
  t.is(openNow(null, new Set(), M, ORIGIN), false)
  t.is(openNow(null, new Set(), M, ORIGIN, 'true'), false, 'only a boolean vouch counts')
  t.is(openNow(null, new Set([denialKey(M, ORIGIN)]), M, ORIGIN, true), false, 'refused this run, even when the node vouches')
  t.is(openNow(null, new Set([denialKey(M, ORIGIN_B)]), M, ORIGIN, true), true, 'a refusal this run at another installation')
  t.is(openNow(null, new Set([M]), M, ORIGIN, true), true, 'the set is keyed by member and installation, not member')
  t.is(openNow(denied, new Set(), M, ORIGIN, true), false, 'a denial on record wins over the node vouch')
  t.is(openNow(denied, new Set(), M, ORIGIN_B, true), true, 'only at that installation')
  t.is(openNow(denied, new Set(), OTHER, ORIGIN, true), true, 'only that member')
  t.is(openNow(denied, null, M, ORIGIN, true), false, 'no set')
})

test('openNow: no record the helpers can produce opens anything without the node', async (t) => {
  const { openNow } = await load()
  const m = await memory()
  const records = [
    null,
    m.emptyAgeRecord(),
    m.withDenied(null, M, ORIGIN),
    m.withoutDenied(m.withDenied(null, M, ORIGIN), M, ORIGIN),
    m.withDenied(m.withDenied(null, OTHER, ORIGIN_B), OTHER, ORIGIN),
    { v: 1, members: { [M]: { origin: ORIGIN, verifiedAt: '2026-11-04T12:00:00.000Z' } }, since: { [ORIGIN]: '1970-01-01T00:00:00.000Z' }, denied: {} },
    { v: 2, denied: [], verified: [{ member: M, origin: ORIGIN }] }
  ]
  for (const r of records) {
    for (const member of [M, OTHER]) {
      for (const origin of [ORIGIN, ORIGIN_B]) t.is(openNow(r, new Set(), member, origin, false), false, JSON.stringify(r))
    }
  }
})

test('applyPending: deny and clear, in order, on top of the loaded record', async (t) => {
  const { applyPending } = await load()
  const { withDenied, isDenied } = await memory()
  const loaded = withDenied(withDenied(null, OTHER, ORIGIN), M, ORIGIN_B)
  const out = applyPending(loaded, [{ op: 'deny', member: M, origin: ORIGIN }])
  t.is(isDenied(out, M, ORIGIN), true, 'the queued deny applies')
  t.is(isDenied(out, OTHER, ORIGIN), true, 'other members survive')
  t.is(isDenied(out, M, ORIGIN_B), true, 'other installations survive')
  t.is(isDenied(loaded, M, ORIGIN), false, 'input untouched')

  const cleared = applyPending(loaded, [{ op: 'clear', member: M, origin: ORIGIN }])
  t.is(isDenied(cleared, M, ORIGIN_B), true, 'a clear at origin A keeps the denial at origin B')
  t.is(isDenied(applyPending(loaded, [{ op: 'clear', member: M, origin: ORIGIN_B }]), M, ORIGIN_B), false)

  const order = applyPending(null, [{ op: 'deny', member: M, origin: ORIGIN }, { op: 'clear', member: M, origin: ORIGIN }])
  t.is(isDenied(order, M, ORIGIN), false, 'applied in order')
  t.is(isDenied(applyPending(null, [{ op: 'clear', member: M, origin: ORIGIN }, { op: 'deny', member: M, origin: ORIGIN }]), M, ORIGIN), true)
  t.alike(applyPending(loaded, []), loaded, 'nothing queued')
  t.alike(applyPending(loaded, [null, 5, { op: 'remember', member: M, origin: ORIGIN }, { op: 'since' }]), loaded, 'junk and old ops ignored')
})

test('persistOps: re-reads the store before every write, one retry', async (t) => {
  const { persistOps } = await load()
  const { withDenied, isDenied } = await memory()
  let stored = withDenied(null, OTHER, ORIGIN)
  const saved = []
  const store = { load: async () => stored, save: async (r) => { saved.push(r); stored = r; return true } }
  const out = await persistOps(store, [{ op: 'deny', member: M, origin: ORIGIN }])
  t.is(isDenied(out, M, ORIGIN), true)
  t.is(isDenied(out, OTHER, ORIGIN), true, 'the denial written by another tab is kept')
  t.is(saved.length, 1)

  let calls = 0
  const flaky = { load: async () => { calls++; return calls === 2 ? withDenied(null, OTHER, ORIGIN_B) : null }, save: async () => calls === 2 }
  const again = await persistOps(flaky, [{ op: 'deny', member: M, origin: ORIGIN }], true)
  t.is(calls, 2, 'retried with a fresh read')
  t.is(isDenied(again, OTHER, ORIGIN_B), true, 'the retry applies on top of what it read')

  calls = 0
  t.is(await persistOps({ load: async () => null, save: () => { calls++; throw new Error('disk') } }, [], true), null)
  t.is(calls, 2, 'never more than one retry, never throws')
  calls = 0
  t.is(await persistOps({ load: async () => null, save: () => { calls++; return 'yes' } }, []), null, 'only true counts')
  t.is(calls, 1, 'no retry unless asked')
})

test('persistOps: an unreadable or failed read is never saved over', async (t) => {
  const { persistOps } = await load()
  const { AGE_RECORD_UNREADABLE } = await memory()
  let saves = 0
  let loads = 0
  const unreadable = { load: async () => { loads++; return AGE_RECORD_UNREADABLE }, save: async () => { saves++; return true } }
  t.is(await persistOps(unreadable, [{ op: 'deny', member: M, origin: ORIGIN }], true), null)
  t.is(saves, 0, 'the other refusals in that record are not replaced')
  t.is(loads, 1, 'no retry: a second read would find the same record')
  const throwing = { load: () => { throw new Error('disk') }, save: async () => { saves++; return true } }
  t.is(await persistOps(throwing, [{ op: 'clear', member: M, origin: ORIGIN }], true), null)
  t.is(saves, 0, 'a read that failed is not "no record"')
  const lockFails = { load: async () => null, save: async () => { saves++; return true }, lock: () => { throw new Error('lock') } }
  t.is(await persistOps(lockFails, [{ op: 'deny', member: M, origin: ORIGIN }], true), null, 'a failed lock never throws')
  t.is(saves, 0)
})

test('persistOps: concurrent denials under a serializing lock both survive', async (t) => {
  const { persistOps } = await load()
  const { isDenied } = await memory()
  let stored = null
  // Each step yields, so two unlocked read-change-saves would interleave.
  const store = {
    load: async () => { await tick(); return stored },
    save: async (r) => { await tick(); stored = r; return true }
  }
  let chain = Promise.resolve()
  let held = 0
  let overlap = false
  store.lock = (fn) => {
    const run = chain.then(async () => {
      if (++held > 1) overlap = true
      try { return await fn() } finally { held-- }
    })
    chain = run.catch(() => {})
    return run
  }
  await Promise.all([
    persistOps(store, [{ op: 'deny', member: M, origin: ORIGIN }], true),
    persistOps(store, [{ op: 'deny', member: OTHER, origin: ORIGIN_B }], true)
  ])
  t.is(overlap, false, 'one read-change-save at a time')
  t.is(isDenied(stored, M, ORIGIN), true, 'first denial kept')
  t.is(isDenied(stored, OTHER, ORIGIN_B), true, 'second denial kept')
})

test('useAgeMemory: an unreadable stored record is read as empty and never overwritten', async (t) => {
  const store = fakeStorage(t)
  store.raw('{"v":2,"denied":[{"member":"' + OTHER + '"')
  const { api, mount } = await mountHook()
  mount()
  await tick()
  t.is(api.open(M, ORIGIN, true), true, 'no refusal known from it')
  api.deny(M, ORIGIN)
  await tick()
  t.is(store.rawValue(), '{"v":2,"denied":[{"member":"' + OTHER + '"', 'the file is left as it was')
  t.is(api.open(M, ORIGIN, true), false, 'the denial still holds for this run')
})

test('useAgeMemory: a failed clear is retried once with a fresh read', async (t) => {
  const store = fakeStorage(t)
  const { isDenied, withDenied } = await memory()
  store.write(withDenied(withDenied(null, M, ORIGIN), OTHER, ORIGIN_B))
  const { api, mount } = await mountHook()
  mount()
  await tick()
  store.failNextSet()
  api.clearDenial(M, ORIGIN)
  await tick()
  const saved = store.read()
  t.is(isDenied(saved, M, ORIGIN), false, 'the refusal left the disk on the retry')
  t.is(isDenied(saved, OTHER, ORIGIN_B), true, 'the other refusal kept')
})

function fakeWindow (t) {
  const listeners = new Set()
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: (type, fn) => { if (type === 'storage') listeners.add(fn) },
      removeEventListener: (type, fn) => { if (type === 'storage') listeners.delete(fn) }
    }
  })
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'window', had)
    else delete globalThis.window
  })
  return { fire: (key) => { for (const fn of [...listeners]) fn({ key }) }, count: () => listeners.size }
}

test('openNow: a key cleared this run ignores a stale refusal on the record', async (t) => {
  const { openNow } = await load()
  const { withDenied, denialKey } = await memory()
  const rec = withDenied(null, M, ORIGIN)
  const cleared = new Set([denialKey(M, ORIGIN)])
  t.is(openNow(rec, new Set(), M, ORIGIN, true, cleared), true)
  t.is(openNow(rec, new Set(), M, ORIGIN, false, cleared), false, 'still only the node opens it')
  t.is(openNow(rec, new Set([denialKey(M, ORIGIN)]), M, ORIGIN, true, cleared), false, 'a session denial wins')
  t.is(openNow(withDenied(rec, M, ORIGIN_B), new Set(), M, ORIGIN_B, true, cleared), false, 'only that installation')
})

test('useAgeMemory: a clear that never reached the disk sticks for the run', async (t) => {
  const store = fakeStorage(t)
  const { isDenied, withDenied } = await memory()
  store.write(withDenied(null, M, ORIGIN))
  const { api, mount } = await mountHook()
  mount()
  await tick()
  store.failNextSet(2)
  api.clearDenial(M, ORIGIN)
  await tick()
  t.is(isDenied(store.read(), M, ORIGIN), true, 'both writes failed')
  api.deny(OTHER, ORIGIN_B)
  await tick()
  t.is(isDenied(store.read(), M, ORIGIN), true, 'the next save re-read the stale refusal')
  t.is(api.open(M, ORIGIN, true), true, 'this run\'s verificado still holds')
  t.is(Object.keys(api).sort().join(','), 'clearDenial,deny,loaded,open', 'the API the shell uses, nothing else')
  api.deny(M, ORIGIN)
  t.is(api.open(M, ORIGIN, true), false, 'a later refusal closes it again')
})

test('useAgeMemory: another tab\'s saved refusal reaches this tab', async (t) => {
  const store = fakeStorage(t)
  const win = fakeWindow(t)
  const { withDenied } = await memory()
  const { api, mount } = await mountHook()
  const cleanup = mount()
  await tick()
  t.is(api.open(M, ORIGIN, true), true)
  store.write(withDenied(null, M, ORIGIN))
  win.fire('other-key')
  await tick()
  t.is(api.open(M, ORIGIN, true), true, 'other keys are ignored')
  win.fire('varanda-age')
  await tick()
  t.is(api.open(M, ORIGIN, true), false, 'tab A\'s refusal closes tab B')
  t.is(store.read().denied.length, 1, 'a reread never saves')
  t.is(win.count(), 1)
  cleanup()
  t.is(win.count(), 0, 'unsubscribed on unmount')
})

test('useAgeMemory: a deny re-reads the stored record, so a second tab is not overwritten', async (t) => {
  const store = fakeStorage(t)
  const { isDenied, withDenied } = await memory()
  const { api, mount } = await mountHook()
  mount()
  await tick()
  // Another tab writes after this one loaded.
  store.write(withDenied(null, OTHER, ORIGIN_B))
  api.deny(M, ORIGIN)
  await tick()
  const saved = store.read()
  t.is(isDenied(saved, M, ORIGIN), true, 'this tab\'s denial saved')
  t.is(isDenied(saved, OTHER, ORIGIN_B), true, 'the other tab\'s denial kept')
})

test('useAgeMemory: a denial queued before the load is saved even after unmount', async (t) => {
  const store = fakeStorage(t)
  const { isDenied, withDenied } = await memory()
  store.write(withDenied(null, OTHER, ORIGIN))
  const { api, mount } = await mountHook()
  const cleanup = mount()
  api.deny(M, ORIGIN)
  cleanup()
  await tick()
  const saved = store.read()
  t.is(isDenied(saved, M, ORIGIN), true, 'the queued denial reached the disk')
  t.is(isDenied(saved, OTHER, ORIGIN), true, 'on top of the loaded record')
})

test('useAgeMemory: a verificado at origin A never clears origin B', async (t) => {
  const store = fakeStorage(t)
  const { isDenied, withDenied } = await memory()
  store.write(withDenied(null, M, ORIGIN_B))
  const { api, mount } = await mountHook()
  mount()
  await tick()
  api.deny(M, ORIGIN)
  api.clearDenial(M, ORIGIN)
  await tick()
  const saved = store.read()
  t.is(isDenied(saved, M, ORIGIN), false, 'cleared at A')
  t.is(isDenied(saved, M, ORIGIN_B), true, 'the denial at B survives')
  t.is(api.open(M, ORIGIN_B, true), false, 'and the hook still keeps B closed')
})

test('useAgeMemory: a refusal this run closes it even when the save fails', async (t) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied') } })
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete globalThis.localStorage
  })
  const { api, mount } = await mountHook()
  mount()
  await tick()
  api.deny(M, ORIGIN)
  await tick()
  t.is(api.open(M, ORIGIN, true), false, 'closed for this run')
  t.is(api.open(M, ORIGIN_B, true), true, 'only that installation')
  api.clearDenial(M, ORIGIN)
  t.is(api.open(M, ORIGIN, true), true, 'a verificado reopens it')
})

test('useAgeMemory source: no write is dropped or decided against an unloaded record', (t) => {
  const s = require('fs').readFileSync(require('path').join(__dirname, '../src/useAgeMemory.js'), 'utf8')
  t.ok(s.includes('pending.current.push(op)'), 'queued while loading')
  t.ok(s.includes('applyPending(r, ops)'), 'applied to the loaded record')
  t.ok(s.includes('persistOps({ load: loadAgeRecord, save: saveAgeRecord, lock: withAgeLock }, ops, true)'), 'every save re-reads the store under the lock, deny or clear retried')
  t.ok(s.includes('denialKey(member, origin)'), 'the session set is keyed by member and installation')
  t.absent(s.includes('if (!live) return'), 'an unmount never drops the queued ops')
  for (const gone of ['remember', 'forgetBlocked', 'sinceOf', 'setSince', 'withVerified', 'isRemembered']) {
    t.absent(new RegExp('\\b' + gone + '\\b').test(s), gone + ' is gone')
  }
})
