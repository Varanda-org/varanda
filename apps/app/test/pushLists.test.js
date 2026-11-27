'use strict'

// The web worker's block and mute lists when the account leaves the device
// (src/pushBlocks.web.js, .native.js and the calls in src/node.js): Sair,
// Recomeçar, a forgotten configuration or another owner empty them, and no
// report made before that, or while no account is open, lands afterwards.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const K = 'a'.repeat(64)
const M = 'b'.repeat(64)
const BLOCKS = 'varanda-blocks'
const MUTES = 'varanda-mutes'

// Each import is its own module instance, so each test starts with the gate
// as a page load leaves it.
let instance = 0
const freshWeb = () => import('../src/pushBlocks.web.js?instance=' + (++instance))
const loadNative = () => import('../src/pushBlocks.native.js')
// On a build without a name, the call is skipped and the assertion says why.
const call = (fn, ...args) => (typeof fn === 'function' ? fn(...args) : undefined)
const tick = () => new Promise((resolve) => setImmediate(resolve))

function setNavigator (t, value) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'navigator')
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  t.teardown(() => {
    if (had && prev) Object.defineProperty(globalThis, 'navigator', prev)
    else delete globalThis.navigator
  })
}

const OWED = 'varanda-push-lists-clear'

// A localStorage of the page; null leaves none, 'throws' one whose every use
// throws, as in a private window or with site data blocked.
function setStorage (t, kind = 'map') {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const items = new Map()
  const fail = () => { throw new Error('storage blocked') }
  const store = kind === 'throws'
    ? { getItem: fail, setItem: fail, removeItem: fail }
    : { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, String(v)), removeItem: (k) => items.delete(k) }
  if (kind === 'getter') Object.defineProperty(globalThis, 'localStorage', { get: fail, configurable: true })
  else Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true })
  t.teardown(() => {
    if (had && prev) Object.defineProperty(globalThis, 'localStorage', prev)
    else delete globalThis.localStorage
  })
  return items
}

function controlled (t) {
  const sent = []
  setNavigator(t, { serviceWorker: { controller: { postMessage: (m) => sent.push(m) } } })
  return sent
}

test('clearPushLists posts an empty list of each type', async (t) => {
  const sent = controlled(t)
  const mod = await freshWeb()
  t.is(typeof mod.clearPushLists, 'function', 'exported')
  call(mod.clearPushLists)
  t.alike(sent, [{ type: BLOCKS, keys: [] }, { type: MUTES, keys: [] }])
})

test('a report still waiting for the worker never lands after the clear', async (t) => {
  const sent = []
  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })
  setNavigator(t, { serviceWorker: { controller: null, ready } })
  const mod = await freshWeb()
  call(mod.openPushLists)
  mod.reportBlocks([K])
  mod.reportMutes([M])
  call(mod.clearPushLists)
  resolveReady({ active: { postMessage: (m) => sent.push(m) } })
  await ready
  await tick()
  t.alike(sent, [{ type: BLOCKS, keys: [] }, { type: MUTES, keys: [] }], 'only the empty lists')
})

test('a later report replaces one still waiting for the worker', async (t) => {
  const sent = []
  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })
  setNavigator(t, { serviceWorker: { controller: null, ready } })
  const mod = await freshWeb()
  call(mod.openPushLists)
  mod.reportBlocks([K])
  mod.reportBlocks([K, M])
  resolveReady({ active: { postMessage: (m) => sent.push(m) } })
  await ready
  await tick()
  t.alike(sent, [{ type: BLOCKS, keys: [K, M] }])
})

test('after the clear, nothing is reported until the lists are opened again', async (t) => {
  const sent = controlled(t)
  const mod = await freshWeb()
  call(mod.openPushLists)
  call(mod.clearPushLists)
  sent.length = 0
  mod.reportBlocks([K])
  mod.reportMutes([M])
  t.alike(sent, [], 'a list read with no account open stays here')
  call(mod.openPushLists)
  mod.reportBlocks([K])
  mod.reportMutes([M])
  t.alike(sent, [{ type: BLOCKS, keys: [K] }, { type: MUTES, keys: [M] }])
})

test('a page load reports nothing before the lists are opened', async (t) => {
  const sent = controlled(t)
  const mod = await freshWeb()
  mod.reportBlocks([K])
  mod.reportMutes([M])
  t.alike(sent, [])
})

test('no navigator read at import, and nothing throws', async (t) => {
  setNavigator(t, new Proxy({}, { get () { throw new Error('navigator read') } }))
  const mod = await freshWeb()
  t.execution(() => call(mod.clearPushLists))
  t.execution(() => call(mod.openPushLists))
  t.execution(() => mod.reportBlocks([K]))
  t.execution(() => mod.reportMutes([M]))
})

test('a throwing worker or a ready that rejects is harmless', async (t) => {
  setNavigator(t, { serviceWorker: { controller: { postMessage () { throw new Error('closed') } } } })
  const mod = await freshWeb()
  t.execution(() => call(mod.clearPushLists))
  t.execution(() => call(mod.openPushLists))
  t.execution(() => mod.reportBlocks([K]))
  const rejecting = await freshWeb()
  const ready = Promise.reject(new Error('no worker'))
  ready.catch(() => {})
  globalThis.navigator.serviceWorker = { controller: null, ready }
  t.execution(() => call(rejecting.clearPushLists))
  await tick()
})

test('a clear that may not have reached the worker is sent again on each page load until the open account reports both lists', async (t) => {
  const items = setStorage(t)
  setNavigator(t, {})
  const leaving = await freshWeb()
  call(leaving.clearPushLists)
  t.is(items.get(OWED), '1', 'no worker to take it: the clear is still owed')

  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })
  globalThis.navigator = { serviceWorker: { controller: null, ready } }
  const sent = []
  await freshWeb()
  resolveReady({ active: { postMessage: (m) => sent.push(m) } })
  await ready
  await tick()
  t.alike(sent, [{ type: BLOCKS, keys: [] }, { type: MUTES, keys: [] }], 'the next load sends it once a worker is active, gate closed')

  sent.length = 0
  globalThis.navigator = { serviceWorker: { controller: { postMessage: (m) => sent.push(m) } } }
  const again = await freshWeb()
  t.alike(sent, [{ type: BLOCKS, keys: [] }, { type: MUTES, keys: [] }], 'and the one after, at once to a controlling worker')
  t.is(items.get(OWED), '1', 'sending is no proof the worker kept it')

  call(again.openPushLists)
  again.reportBlocks([K])
  again.reportMutes([M])
  t.absent(items.has(OWED), 'the open account\'s own lists replaced the old ones')
  sent.length = 0
  await freshWeb()
  t.alike(sent, [], 'no clear once they did')
})

test('opening is not enough: the clear stays owed until both lists of the open account were reported', async (t) => {
  const items = setStorage(t)
  const sent = controlled(t)
  const leaving = await freshWeb()
  call(leaving.clearPushLists)
  call(leaving.openPushLists)
  t.is(items.get(OWED), '1', 'opened, with no list read yet')
  leaving.reportBlocks([K])
  t.is(items.get(OWED), '1', 'the mutes list of the old account may still be there')

  sent.length = 0
  const reload = await freshWeb()
  t.alike(sent, [{ type: BLOCKS, keys: [] }, { type: MUTES, keys: [] }], 'the next load sends the clear again')
  call(reload.openPushLists)
  reload.reportMutes([M])
  t.is(items.get(OWED), '1', 'a load starts over: one list is not both')
  reload.reportBlocks([K])
  t.absent(items.has(OWED), 'both lists reported')

  call(reload.clearPushLists)
  call(reload.openPushLists)
  reload.reportBlocks([K])
  t.is(items.get(OWED), '1', 'a later clear starts the count over')
  reload.reportMutes([M])
  t.absent(items.has(OWED), 'and both lists settle it again')

  call(reload.clearPushLists)
  reload.reportBlocks([K])
  reload.reportMutes([M])
  t.is(items.get(OWED), '1', 'reports with the gate closed never settle it')
})

test('a report that waits for the worker on a page load still beats the owed clear', async (t) => {
  const items = setStorage(t)
  items.set(OWED, '1')
  const sent = []
  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })
  setNavigator(t, { serviceWorker: { controller: null, ready } })
  const mod = await freshWeb()
  call(mod.openPushLists)
  mod.reportBlocks([K])
  mod.reportMutes([M])
  resolveReady({ active: { postMessage: (m) => sent.push(m) } })
  await ready
  await tick()
  t.alike(sent, [{ type: BLOCKS, keys: [K] }, { type: MUTES, keys: [M] }], 'only the open account\'s lists')
})

test('only the clear notes it: reports and the gate never do', async (t) => {
  const items = setStorage(t)
  controlled(t)
  const mod = await freshWeb()
  mod.reportBlocks([K])
  call(mod.openPushLists)
  mod.reportBlocks([K])
  mod.reportMutes([M])
  t.absent(items.has(OWED), 'a lock keeps the lists and sets nothing')
})

test('storage that throws, or none, keeps the clear sent once', async (t) => {
  for (const kind of ['throws', 'getter']) {
    const sub = t.test(kind)
    sub.plan(4)
    setStorage(sub, kind)
    const sent = controlled(sub)
    const mod = await freshWeb()
    sub.execution(() => call(mod.clearPushLists))
    sub.alike(sent, [{ type: BLOCKS, keys: [] }, { type: MUTES, keys: [] }], 'sent at once')
    sent.length = 0
    const next = await freshWeb()
    sub.alike(sent, [], 'nothing on the next load')
    sub.execution(() => call(next.openPushLists))
    await sub
  }
})

test('native: the same four names, no-ops that touch no browser global', async (t) => {
  setNavigator(t, new Proxy({}, { get () { throw new Error('navigator read') } }))
  const mod = await loadNative()
  for (const name of ['reportBlocks', 'reportMutes', 'clearPushLists', 'openPushLists']) {
    t.is(typeof mod[name], 'function', name)
    t.is(call(mod[name], [K]), undefined, name)
  }
})

const NODE = fs.readFileSync(path.join(__dirname, '../src/node.js'), 'utf8')
const between = (src, from, to) => {
  const start = src.indexOf(from)
  return start === -1 ? '' : src.slice(start, src.indexOf(to, start + from.length))
}

test('node.js: the owner change, a forgotten configuration, Sair and Recomeçar clear the lists; a lock keeps them', (t) => {
  t.ok(NODE.includes("import { clearPushLists } from './pushBlocks'"), 'imports it')
  const calls = NODE.split('\n').filter((line) => line.includes('clearPushLists()'))
  t.is(calls.length, 3, 'called in three places')

  const owner = between(NODE, 'const noteOwner = useCallback', '}, [])')
  t.ok(/if \(ownerRef\.current !== null && ownerRef\.current !== key\) clearPushLists\(\)/.test(owner), 'another owner')
  t.ok(owner.indexOf('clearPushLists()') < owner.indexOf('ownerRef.current = key'), 'before the new owner is noted')
  const readPasskey = between(NODE, 'const readPasskey = useCallback', '}, [bumpGeneration])')
  t.ok(readPasskey.indexOf('noteOwner(st)') !== -1 && readPasskey.indexOf('noteOwner(st)') < readPasskey.indexOf('setPkStatus(st)'), 'before the status shows the new owner')

  const forget = between(NODE, 'const forgetConfig = useCallback(async () => {', '}, [begin, setConnection])')
  const clearAt = forget.indexOf('clearPushLists()')
  t.ok(clearAt !== -1 && clearAt < forget.indexOf('attemptsRef.current.begin()'), 'a forgotten configuration, at once')

  const op = between(NODE, 'const passkeyOp = useCallback', '}, [readPasskey, bumpEpoch])')
  const dispatchAt = op.indexOf('conn.identity[op](')
  const successAt = op.indexOf('async (result) => {')
  const failureAt = op.indexOf('async (err) => {')
  const opClear = op.indexOf("if (op === 'signOut' || op === 'reset') clearPushLists()")
  t.ok(dispatchAt !== -1 && successAt > dispatchAt, 'the operation is dispatched first')
  // An older node without identity.signOut runs a lock for Sair, which keeps
  // the session: the clear follows what ran, not what was asked.
  const ranAt = op.indexOf('let op = name')
  const fallbackAt = op.indexOf("op = name === 'signOut' && typeof conn.identity.signOut !== 'function' ? 'lock' : name")
  t.ok(ranAt !== -1 && ranAt < op.indexOf('try {') && fallbackAt > ranAt && fallbackAt < dispatchAt, 'the operation that ran stays in scope of the success path')
  t.absent(/const op = /.test(op), 'not shadowed inside the try')
  t.absent(/name === 'signOut'[^\n]*clearPushLists/.test(op), 'not by the name asked for')
  t.ok(opClear > successAt && opClear < failureAt, 'Sair and Recomeçar, only once the operation succeeded')
  t.ok(opClear < op.indexOf('setPkStatus(', successAt), 'before the status update')
  t.is(op.split('clearPushLists()').length - 1, 1, 'once in passkeyOp')
  for (const line of calls) t.absent(line.includes("'lock'"), 'never for a lock')
})
