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
  const opClear = op.indexOf("if (name === 'signOut' || name === 'reset') clearPushLists()")
  t.ok(dispatchAt !== -1 && successAt > dispatchAt, 'the operation is dispatched first')
  t.ok(opClear > successAt && opClear < failureAt, 'Sair and Recomeçar, only once the operation succeeded')
  t.ok(opClear < op.indexOf('setPkStatus(', successAt), 'before the status update')
  t.is(op.split('clearPushLists()').length - 1, 1, 'once in passkeyOp')
  for (const line of calls) t.absent(line.includes("'lock'"), 'never for a lock')
})
