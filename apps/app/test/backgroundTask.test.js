'use strict'

// The background refresh task (src/backgroundTask.native.js) and the
// foreground gate (src/foregroundGate.js): the task never reaches the
// identity or the keychain, the boot and the cold-start preview wait for the
// first 'active' state, and every wipe unregisters the task.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const SRC = path.join(APP, 'src')
const read = (file) => fs.readFileSync(path.join(APP, file), 'utf8')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

function specifiers (src) {
  const out = []
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const re of patterns) {
    for (const m of withoutComments(src).matchAll(re)) out.push(m[1])
  }
  return out
}

// Resolves a relative import as Metro does on native: .native.js first.
function resolveNative (from, spec) {
  const base = path.resolve(path.dirname(from), spec)
  const candidates = base.endsWith('.js') ? [base] : [base + '.native.js', base + '.js', path.join(base, 'index.native.js'), path.join(base, 'index.js')]
  return candidates.find((f) => fs.existsSync(f)) || null
}

// Every app module and package the native task module reaches.
function reachable (entry) {
  const files = new Set()
  const packages = new Set()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (files.has(file)) continue
    files.add(file)
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) {
        packages.add(spec)
        continue
      }
      const target = resolveNative(file, spec)
      // The packed worklet bundle is the node itself, a string run in Bare:
      // what it may do is decided by the requests the task sends.
      if (target !== null && target.startsWith(SRC)) queue.push(target)
    }
  }
  return { files: [...files].map((f) => path.relative(APP, f)), packages: [...packages] }
}

test('the task module never reaches the identity, the session store or the keychain', (t) => {
  const { files, packages } = reachable(path.join(SRC, 'backgroundTask.native.js'))
  t.ok(files.includes('src/backgroundRefresh.js'), 'walks the task deps')
  const forbidden = files.filter((f) => /(^|\/)(identity|sessionStore|passkey|authSession)[^/]*\.js$/i.test(f))
  t.alike(forbidden, [], 'no identity or session module')
  const keychain = packages.filter((p) => /secure-store|passkey|keychain/i.test(p))
  t.alike(keychain, [], 'no keychain package')
  const own = specifiers(read('src/backgroundTask.native.js'))
  t.ok(own.includes('expo-task-manager') && own.includes('expo-background-task'))
})

test('the task is defined at module scope and registered for 6 hours', (t) => {
  const src = withoutComments(read('src/backgroundTask.native.js'))
  t.ok(/^TaskManager\.defineTask\(TASK_NAME, refresh\)$/m.test(src), 'defineTask at the top level')
  t.ok(/registerTaskAsync\(TASK_NAME, \{ minimumInterval: MINIMUM_INTERVAL_MINUTES \}\)/.test(src))
  t.ok(/MINIMUM_INTERVAL_MINUTES = BG_MIN_GAP_MS \/ 60000/.test(src), 'minutes, from the 6 h gap')
  t.ok(/unregisterTaskAsync\(TASK_NAME\)/.test(src))
  t.ok(/registerLocalCache\(\{\s*wipe: \(\) => \{\s*forgetLastUse\(\)\s*return unregisterBackgroundRefresh\(\)/.test(src), 'a wipe unregisters')
  t.ok(/if \(gate\.seen\(\)\) return/.test(src), 'a process that was active never runs it')
  t.ok(/await result\.settle/.test(src), 'an unsettled start is waited for')
})

test('wipeLocalCaches unregisters the task', async (t) => {
  const { registerLocalCache, wipeLocalCaches } = await import('../src/localCaches.js')
  let calls = 0
  const unregister = () => { calls++; return Promise.resolve() }
  const remove = registerLocalCache({ wipe: unregister })
  wipeLocalCaches()
  t.is(calls, 1)
  remove()
})

test('index.js imports the task module before registerRootComponent', (t) => {
  const src = withoutComments(read('index.js'))
  const task = src.indexOf("import './src/backgroundTask'")
  const app = src.indexOf("import App from './App'")
  const root = src.indexOf('registerRootComponent(App)')
  t.ok(task !== -1, 'imported')
  t.ok(task < app && task < root, 'before the app and its registration')
})

test('the boot awaits the first active state and the cancel before any connect', (t) => {
  const src = withoutComments(read('src/node.js'))
  const begin = src.slice(src.indexOf('const begin = useCallback'))
  const gate = begin.indexOf('await whenForeground()')
  t.ok(gate !== -1, 'begin waits for the foreground')
  t.ok(/await whenForeground\(\)\s*if \(obsolete\(\)\) return/.test(begin), 'the attempt token guards the wait')
  for (const later of ['loadInstallation()', 'loadConfig()', 'discoverConfig(', 'connect(']) {
    const at = begin.indexOf(later)
    t.ok(at === -1 || at > gate, later + ' comes after the gate')
  }
  const connectNow = src.slice(src.indexOf('const connectNow = useCallback'), src.indexOf('const connect = useCallback'))
  const cancel = connectNow.indexOf('await cancelBackgroundRefresh()')
  t.ok(cancel !== -1 && cancel < connectNow.indexOf('connectNode('), 'the refresh stops before the worklet starts')
  t.ok(/await cancelBackgroundRefresh\(\)\s*if \(obsolete\(\)\) return/.test(connectNow), 'the attempt token guards the cancel')
  const active = connectNow.indexOf('await whenActive()')
  t.ok(active > cancel && active < connectNow.indexOf('connectNode('), 'active right now, after the cancel and before the start')
  t.ok(/await whenActive\(\)\s*if \(obsolete\(\)\) return/.test(connectNow), 'the attempt token guards the active wait')
})

test('restart into a core configuration unregisters the task', (t) => {
  const src = withoutComments(read('src/node.js'))
  const restart = src.slice(src.indexOf('const restart = useCallback'), src.indexOf('const reconnect = useCallback'))
  t.ok(/if \(!cfg \|\| cfg\.kind !== 'hosted'\) unregisterBackgroundRefresh\(\)/.test(restart))
  t.ok(restart.indexOf('unregisterBackgroundRefresh()') < restart.indexOf('connect(cfg'), 'before the new node starts')
})

test('App.js reads the keychain for the preview only after the first active state', (t) => {
  const src = withoutComments(read('App.js'))
  t.ok(src.includes('useState(() => noteAppState(AppState.currentState))'), 'starts from the process latch')
  t.ok(src.includes("if (state === 'active') activeSeen = true"), 'opened only by an active state')
  const guard = src.indexOf('if (!previewCapable || !appActive || previewAsked.current) return')
  const probe = src.indexOf('sessionStore.', guard)
  t.ok(guard > 0 && probe > guard, 'the keychain probe comes after the gate, in the same effect')
  t.is(src.indexOf('sessionStore.'), probe, 'no keychain read anywhere before it')
  t.absent(/sessionStore\.load\(/.test(src), 'App.js never loads the session itself')
  t.ok(/registerBackgroundRefresh\(\)/.test(src), 'App.js registers the task')
})

test('App.js registers only with a valid snapshot on disk and unregisters when the condition goes', (t) => {
  const src = withoutComments(read('App.js'))
  const effect = src.slice(src.indexOf('const refreshHosted ='), src.indexOf('generationRef.current = generation'))
  const off = effect.indexOf('unregisterBackgroundRefresh()')
  const on = effect.indexOf('registerBackgroundRefresh()', off + 3)
  t.ok(off > 0, 'unregisters')
  t.ok(/if \(binding === null \|\| passkey === null \|\| refreshOwner === null\) \{\s*unregisterBackgroundRefresh\(\)/.test(effect), 'when not hosted, no passkey, locked or signed out')
  t.ok(/refreshOwner = !locked && pkStatus !== null && pkStatus\.signedOut !== true/.test(effect))
  t.ok(/if \(refreshSnapshotOk\(binding, refreshOwner\)\) registerBackgroundRefresh\(\)/.test(effect), 'registers only with a snapshot')
  t.ok(on > off)
  t.absent(/feedBoot\.page\)\s*return/.test(effect), 'never from the page latch alone')
  const ok = src.slice(src.indexOf('function refreshSnapshotOk'), src.indexOf('function setupComplete'))
  t.ok(ok.includes('parseSnapshot(loadSnapshotText(), { ...binding, owner, now: Date.now() })'), 'read from the store, bound to the owner')
  t.ok(ok.includes('snapshot.items.length > 0'))
})

test('the web twin is no-ops with an open gate', async (t) => {
  const web = await import('../src/backgroundTask.web.js')
  t.is(web.foregroundSeen(), true)
  await web.whenForeground()
  await web.cancelBackgroundRefresh()
  await web.registerBackgroundRefresh()
  await web.unregisterBackgroundRefresh()
  const native = withoutComments(read('src/backgroundTask.native.js'))
  for (const name of ['foregroundSeen', 'whenForeground', 'whenActive', 'noteForegroundUse', 'cancelBackgroundRefresh', 'registerBackgroundRefresh', 'unregisterBackgroundRefresh', 'TASK_NAME']) {
    t.ok(new RegExp('export (const|async function|function) ' + name + '\\b').test(native), 'native exports ' + name)
  }
})

function fakeAppState (initial) {
  let current = initial
  const listeners = new Set()
  return {
    state: () => current,
    subscribe: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    set (s) {
      current = s
      for (const fn of [...listeners]) fn(s)
    },
    listeners
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('gate: a background launch reads nothing until the first active state', async (t) => {
  const { createForegroundGate } = await import('../src/foregroundGate.js')
  const app = fakeAppState('background')
  const gate = createForegroundGate(app)
  let loads = 0
  const boot = gate.wait().then(() => { loads++ })
  t.is(gate.seen(), false)
  await tick()
  t.is(loads, 0, 'no keychain read while in the background')
  app.set('inactive')
  await tick()
  t.is(loads, 0, 'inactive is not active')
  app.set('active')
  await boot
  t.is(loads, 1)
  t.is(app.listeners.size, 0, 'the listener goes once open')
  app.set('background')
  t.is(gate.seen(), true, 'a one-way latch')
  await gate.wait()
})

test('gate: a foreground launch is open at once, and a missed change is caught', async (t) => {
  const { createForegroundGate } = await import('../src/foregroundGate.js')
  const open = createForegroundGate(fakeAppState('active'))
  t.is(open.seen(), true)
  await open.wait()

  // The state turned active with no change event (it changed before the
  // subscription): the next read still opens the gate.
  const app = fakeAppState('unknown')
  const gate = createForegroundGate({ state: app.state, subscribe: () => () => {} })
  const waiting = gate.wait()
  app.set('active')
  t.is(gate.seen(), true)
  await waiting
})

test('gate: waitActive waits for the app to be active again, latch or not', async (t) => {
  const { createForegroundGate } = await import('../src/foregroundGate.js')
  const app = fakeAppState('active')
  const gate = createForegroundGate(app)
  t.is(gate.seen(), true)
  await gate.waitActive()
  // Locked again after the latch opened: the start waits.
  app.set('background')
  let started = 0
  const start = gate.waitActive().then(() => { started++ })
  await tick()
  t.is(started, 0, 'no start while not active, though the latch is open')
  app.set('inactive')
  await tick()
  t.is(started, 0)
  app.set('active')
  await start
  t.is(started, 1)
  t.is(app.listeners.size, 0, 'the listener goes')
})

test('last use: the task runs only within 14 days of the app being opened', async (t) => {
  const { lastUseFresh, LAST_USE_MAX_MS } = await import('../src/foregroundGate.js')
  const DAY = 24 * 60 * 60 * 1000
  const now = 1000 * DAY
  t.is(LAST_USE_MAX_MS, 14 * DAY)
  t.is(lastUseFresh(now - DAY, now), true)
  t.is(lastUseFresh(now - 14 * DAY, now), true)
  t.is(lastUseFresh(now - 14 * DAY - 1, now), false, 'older than 14 days')
  t.is(lastUseFresh(null, now), false, 'missing')
  t.is(lastUseFresh('x', now), false)
  t.is(lastUseFresh(now + 2 * DAY, now), false, 'dated in the future')
  t.is(lastUseFresh(now + 1000, now), true, 'a small clock skew')
})

test('the task refuses and unregisters when stale, missing, or with a saved manual configuration', (t) => {
  const src = withoutComments(read('src/backgroundTask.native.js'))
  const body = src.slice(src.indexOf('async function refresh'), src.indexOf('TaskManager.defineTask'))
  t.ok(/if \(!lastUseFresh\(readLastUse\(\), Date\.now\(\)\)\) \{\s*await unregisterBackgroundRefresh\(\)/.test(body), 'stale or missing last use')
  t.ok(/if \(\(await loadConfig\(\)\) !== null\) \{\s*await unregisterBackgroundRefresh\(\)/.test(body), 'a saved core configuration wins')
  t.ok(body.indexOf('lastUseFresh(') < body.indexOf('runRefresh('))
  t.ok(body.indexOf('loadConfig()') < body.indexOf('runRefresh('))
  const reg = src.slice(src.indexOf('export function registerBackgroundRefresh'), src.indexOf('export function unregisterBackgroundRefresh'))
  t.ok(reg.includes('noteForegroundUse()'), 'registering records the use')
  const node = withoutComments(read('src/node.js'))
  const begin = node.slice(node.indexOf('const begin = useCallback'))
  t.ok(/await whenForeground\(\)\s*if \(obsolete\(\)\) return\s*noteForegroundUse\(\)/.test(begin), 'every foreground start records it')
})

test('gate: never throws on a broken state source', async (t) => {
  const { createForegroundGate } = await import('../src/foregroundGate.js')
  const gate = createForegroundGate({ state: () => { throw new Error('x') }, subscribe: () => { throw new Error('y') } })
  t.is(gate.seen(), false)
  let done = false
  gate.wait().then(() => { done = true })
  await tick()
  t.is(done, false)
})
