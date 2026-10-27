// Release policy and the browser lifecycle run without React or native APIs.
'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const load = () => import('../src/release.js')

const RELEASE_A = '0123456789abcdef'
const RELEASE_B = 'fedcba9876543210'

test('releaseState compares the running document with the served release', async (t) => {
  const { releaseState, parseWorkerRelease, UPDATE_TEXT, UPDATE_ACTION } = await load()
  t.is(UPDATE_TEXT, 'Nova versão disponível.')
  t.is(UPDATE_ACTION, 'atualizar')
  t.alike(releaseState({ running: RELEASE_A, served: RELEASE_A }), { update: false })
  t.alike(releaseState({ running: RELEASE_B, served: RELEASE_B }), { update: false })
  t.alike(releaseState({ running: RELEASE_A, served: RELEASE_B }), { update: true })
  t.alike(releaseState({ running: RELEASE_B, served: RELEASE_A }), { update: true })
  for (const running of [undefined, null, '', RELEASE_A.slice(1), RELEASE_A + '0', RELEASE_A.toUpperCase(),
    '0123456789abcdeg', 1, {}, RELEASE_A + '\n', { toString () { return RELEASE_A } }]) {
    t.alike(releaseState({ running, served: RELEASE_B }), { update: false }, 'invalid running')
  }
  for (const served of [undefined, null, '', RELEASE_B.slice(1), RELEASE_B + '0', RELEASE_B.toUpperCase(),
    'gggggggggggggggg', false]) {
    t.alike(releaseState({ running: RELEASE_A, served }), { update: false }, 'invalid served')
  }
  const throwing = new Proxy({}, { get () { throw new Error('blocked') } })
  for (const arg of [undefined, null, false, 1, 'release', Symbol('release'), {}, throwing,
    { registration: { waiting: true } }]) {
    t.alike(releaseState(arg), { update: false })
  }
  const snippet = 'const VERSION = "0123456789abcdef"\nconst PRECACHE = [{"url":"/index.html","sha256":"abc"}]\n'
  t.is(parseWorkerRelease(snippet), RELEASE_A)
  t.is(parseWorkerRelease("'use strict'\n" + snippet), RELEASE_A, 'preamble before the assignment')
  t.is(parseWorkerRelease('const VERSION = "' + RELEASE_A.toUpperCase() + '"'), null)
  t.is(parseWorkerRelease('const VERSION = "' + RELEASE_A.slice(1) + '"'), null)
  t.is(parseWorkerRelease('const VERSION = "' + RELEASE_A + '0"'), null)
  t.is(parseWorkerRelease('garbage'), null)
  for (const text of [undefined, null, 1, {}, 'const VERSION = \'' + RELEASE_A + '\'']) {
    t.is(parseWorkerRelease(text), null)
  }
})

test('shouldCheck: visible, periodic and focus cooldown boundaries', async (t) => {
  const { shouldCheck, RELEASE_CHECK_MS, RELEASE_FOCUS_MIN_MS } = await load()
  t.is(RELEASE_CHECK_MS, 30 * 60 * 1000)
  t.is(RELEASE_FOCUS_MIN_MS, 60000)
  const base = { now: 100, lastCheck: null, visible: true }
  t.ok(shouldCheck(base))
  for (const focus of [false, true]) {
    const delay = focus ? RELEASE_FOCUS_MIN_MS : RELEASE_CHECK_MS
    for (const elapsed of [0, delay - 1, delay, delay + 1]) {
      const arg = { ...base, focus, lastCheck: 100, now: 100 + elapsed }
      t.is(shouldCheck(arg), elapsed >= delay)
      t.absent(shouldCheck({ ...arg, visible: false }), 'hidden never checks')
    }
    t.absent(shouldCheck({ ...base, focus, visible: false }))
    t.ok(shouldCheck({ ...base, focus }))
  }
  for (const arg of [undefined, null, 3, {}, { ...base, now: NaN }, { ...base, now: Infinity },
    { ...base, lastCheck: '0' }, { ...base, lastCheck: 101 }, { ...base, visible: 1 }]) {
    t.absent(shouldCheck(arg))
  }
})

test('native release watcher is a no-op with a safe unsubscribe', async (t) => {
  const { watchRelease } = await import('../src/pwa.native.js')
  let called = false
  const stop = watchRelease(() => { called = true })
  t.is(typeof stop, 'function')
  stop()
  stop()
  t.absent(called)
})

function eventTarget () {
  const listeners = new Map()
  return {
    listeners,
    addEventListener (name, fn) { listeners.set(name, fn) },
    removeEventListener (name, fn) {
      if (listeners.get(name) === fn) listeners.delete(name)
    },
    dispatch (name) { if (listeners.has(name)) listeners.get(name)() }
  }
}

function workerScript (version) {
  return 'const VERSION = "' + version + '"\nconst PRECACHE = [{"url":"/index.html","sha256":"' + RELEASE_A + '"}]\n'
}

function byteStream (text) {
  const bytes = Buffer.from(text)
  let offset = 0
  return {
    getReader () {
      return {
        read () {
          if (offset >= bytes.length) return Promise.resolve({ done: true })
          const end = Math.min(offset + 1024, bytes.length)
          const value = bytes.subarray(offset, end)
          offset = end
          return Promise.resolve({ done: false, value })
        },
        cancel () {
          offset = bytes.length
          return Promise.resolve()
        }
      }
    }
  }
}

function responseFor (hooks) {
  const text = hooks.body != null ? hooks.body : workerScript(hooks.served)
  const res = {
    ok: hooks.status >= 200 && hooks.status < 300,
    status: hooks.status,
    text: () => Promise.resolve(text)
  }
  if (hooks.stream) res.body = byteStream(text)
  return res
}

async function fixture (overrides = {}) {
  const policy = await load()
  const { pwaBoot } = await import('../src/pwa-boot.js')
  const reg = {
    ...eventTarget(),
    waiting: null,
    installing: null,
    checks: 0,
    update () { this.checks++; return Promise.resolve() }
  }
  const hooks = {
    running: RELEASE_A,
    served: RELEASE_A,
    status: 200,
    fail: false,
    body: null,
    stream: false,
    hold: null
  }
  const fetches = []
  const document = {
    ...eventTarget(),
    visibilityState: 'visible',
    querySelector: () => ({ getAttribute: () => hooks.running })
  }
  const window = eventTarget()
  const clock = { now: 0 }
  const intervals = new Map()
  const scheduledAt = []
  // Replace only module wiring; exercise the actual web adapter with browser
  // events, a controlled clock and the same pure policy used by the bundle.
  const source = fs.readFileSync(path.join(__dirname, '../src/pwa.web.js'), 'utf8')
    .replace(/^import .+$/gm, '')
    .replace(/^export /gm, '')
  const context = {
    ...policy,
    pwaBoot,
    hostedPage: true,
    webMode: 'browser',
    document,
    window,
    navigator: { serviceWorker: { getRegistration: () => Promise.resolve(reg) } },
    Date: { now: () => clock.now },
    setInterval (fn, ms) { scheduledAt.push(clock.now); intervals.set(fn, ms); return fn },
    clearInterval (id) { intervals.delete(id) },
    fetch (url, opts) {
      fetches.push({ url, opts })
      if (hooks.fail) return Promise.reject(hooks.fail instanceof Error ? hooks.fail : new Error('offline'))
      if (typeof hooks.hold === 'function') return hooks.hold()
      return Promise.resolve(responseFor(hooks))
    },
    ...overrides
  }
  vm.runInNewContext(source, context)
  return { ...context, reg, clock, intervals, scheduledAt, hooks, fetches, document, window }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('web watcher: compares releases, honors cooldowns and cleans up', async (t) => {
  const f = await fixture()
  const states = []
  const stop = f.watchRelease((state) => states.push(state.update))
  await settle()
  t.alike(states, [false])
  t.is(f.reg.checks, 1, 'checks on subscribing')
  t.is(f.fetches.length, 1, 'reads the served release on subscribing')
  t.is(f.fetches[0].url, '/sw.js')
  // The options object comes from the VM context (another Object prototype):
  // compare a host-side copy of its fields.
  t.alike({ ...f.fetches[0].opts }, { cache: 'no-store', credentials: 'omit' })
  t.alike([...f.intervals.values()], [f.RELEASE_CHECK_MS])

  // A waiting worker is only a hint: the ids still match, so no notice.
  const worker = eventTarget()
  f.reg.installing = worker
  f.reg.waiting = worker
  f.reg.dispatch('updatefound')
  await settle()
  worker.dispatch('statechange')
  await settle()
  t.alike(states, [false], 'a waiting worker is not the signal')
  t.is(f.reg.checks, 1, 'updatefound does not call registration.update()')

  f.hooks.served = RELEASE_B
  worker.dispatch('statechange')
  worker.dispatch('statechange')
  await settle()
  t.alike(states, [false, true], 'only a changed release is delivered')

  const before = f.fetches.length
  f.clock.now = f.RELEASE_FOCUS_MIN_MS - 1
  f.window.dispatch('focus')
  t.is(f.reg.checks, 1)
  t.is(f.fetches.length, before, 'focus inside the cooldown does not fetch')
  f.clock.now++
  f.document.dispatch('visibilitychange')
  f.window.dispatch('focus')
  await settle()
  t.is(f.reg.checks, 2, 'paired visibility/focus checks once')
  t.is(f.fetches.length, before + 1)
  t.alike(f.scheduledAt, [0, f.RELEASE_FOCUS_MIN_MS], 'focus restarts the 30-minute interval')
  t.is(f.intervals.size, 1, 'only one interval remains')
  const tick = [...f.intervals.keys()][0]
  // A periodic tick is paced by its interval: it checks even a millisecond
  // short of RELEASE_CHECK_MS after the last check (timers drift).
  f.clock.now += f.RELEASE_CHECK_MS - 1
  tick()
  await settle()
  t.is(f.reg.checks, 3, 'a periodic tick checks without the cooldown')
  f.document.visibilityState = 'hidden'
  f.clock.now += f.RELEASE_CHECK_MS
  const hidden = f.fetches.length
  tick()
  f.window.dispatch('focus')
  f.document.dispatch('visibilitychange')
  t.is(f.reg.checks, 3, 'hidden events do not check')
  t.is(f.fetches.length, hidden, 'hidden events do not fetch')
  f.document.visibilityState = 'visible'
  // Reloading into the release the server is serving now clears the notice,
  // even while the previous worker is still waiting.
  f.hooks.served = RELEASE_A
  f.document.dispatch('visibilitychange')
  await settle()
  t.is(f.reg.checks, 4)
  t.alike(states, [false, true, false])

  f.clock.now += f.RELEASE_FOCUS_MIN_MS
  let late
  f.hooks.served = RELEASE_B
  f.hooks.hold = () => new Promise((resolve) => { late = resolve })
  f.window.dispatch('focus')
  t.is(f.reg.checks, 5)
  stop()
  stop()
  t.is(f.reg.listeners.size + worker.listeners.size + f.document.listeners.size + f.window.listeners.size, 0)
  t.is(f.intervals.size, 0)
  late({ ok: true, status: 200, text: () => Promise.resolve(workerScript(RELEASE_B)) })
  tick()
  await settle()
  t.alike(states, [false, true, false], 'pending checks cannot notify after cleanup')
})

test('web watcher: eligibility matches registration and early cleanup cancels setup', async (t) => {
  for (const overrides of [
    { hostedPage: false }, { webMode: 'serve' }, { navigator: {} },
    { document: { querySelector: () => null } },
    { document: { querySelector: () => ({ getAttribute: () => '' }) } }
  ]) {
    const f = await fixture(overrides)
    const states = []
    const stop = f.watchRelease((s) => states.push(s))
    await settle()
    t.is(typeof stop, 'function')
    stop()
    t.alike(states, [])
    t.is(f.intervals.size, 0)
    t.is(f.reg.checks, 0)
  }
  const f = await fixture()
  f.watchRelease(() => t.fail('unsubscribed before registration resolved'))()
  await settle()
  t.is(f.intervals.size, 0)
  t.is(f.reg.listeners.size, 0)
  t.is(f.fetches.length, 0, 'a cancelled setup does not fetch')
})

test('web watcher: ready fallback, failures and late results never escape', async (t) => {
  const reg = {
    ...eventTarget(),
    waiting: {},
    checks: 0,
    update () { this.checks++; return Promise.reject(new Error('offline')) }
  }
  const f = await fixture({ navigator: { serviceWorker: { getRegistration: () => null, ready: Promise.resolve(reg) } } })
  f.hooks.fail = new Error('offline')
  const states = []
  const stop = f.watchRelease((state) => { states.push(state.update); throw new Error('callback') })
  await settle()
  t.alike(states, [], 'offline leaves the notice unchanged even if a worker is waiting')
  t.is(reg.checks, 1, 'still asks the registration to update')
  f.hooks.fail = false
  for (const status of [404, 503]) {
    f.hooks.status = status
    f.clock.now += f.RELEASE_FOCUS_MIN_MS
    f.window.dispatch('focus')
    await settle()
  }
  t.alike(states, [], '404 and 5xx leave the notice unchanged')
  t.is(reg.checks, 3)
  f.hooks.status = 200
  f.hooks.served = RELEASE_B
  f.clock.now += f.RELEASE_FOCUS_MIN_MS
  f.window.dispatch('focus')
  await settle()
  t.alike(states, [true], 'a different release is reported')
  reg.update = () => { reg.checks++; throw new Error('blocked') }
  f.clock.now += f.RELEASE_FOCUS_MIN_MS
  f.window.dispatch('focus')
  t.is(reg.checks, 5, 'retry survives a synchronous failure')
  stop()
  for (const serviceWorker of [
    { getRegistration () { throw new Error('blocked') } },
    { getRegistration: () => Promise.reject(new Error('blocked')) }
  ]) {
    const broken = await fixture({ navigator: { serviceWorker } })
    const end = broken.watchRelease(() => t.fail('no registration'))
    await settle()
    end()
    t.is(broken.intervals.size, 0)
  }
})

test('web watcher: reads at most 64 KiB of /sw.js', async (t) => {
  const head = 'const VERSION = "' + RELEASE_B + '"\nconst PRECACHE = ['
  const huge = head + 'x'.repeat(64 * 1024)
  for (const stream of [false, true]) {
    const f = await fixture()
    f.hooks.body = huge
    f.hooks.stream = stream
    const states = []
    const stop = f.watchRelease((state) => states.push(state.update))
    await settle()
    t.alike(states, [true], stream ? 'stream prefix keeps the version' : 'text prefix keeps the version')
    stop()
  }
  const buried = 'x'.repeat(64 * 1024) + 'const VERSION = "' + RELEASE_B + '"\n'
  for (const stream of [false, true]) {
    const f = await fixture()
    f.hooks.body = buried
    f.hooks.stream = stream
    const states = []
    const stop = f.watchRelease((state) => states.push(state.update))
    await settle()
    // Unreadable within the cap = a failed check: no state is delivered.
    t.alike(states, [], stream ? 'a version past 64 KiB of the stream is ignored' : 'a version past 64 KiB is ignored')
    stop()
  }
})
