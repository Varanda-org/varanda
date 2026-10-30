// Install policy, injected browser lifecycle and native no-op contract in Node.
'use strict'

const test = require('brittle')
const load = () => import('../src/install-offer.js')
const loadNative = () => import('../src/install.native.js')

const android = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
const samsung = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36'
const samsungDesktop = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Safari/537.36'
const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
const instagram = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.0.0'
const ipod = 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1'
const ipad = 'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1'
const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
const desktop = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const none = { note: 'none', canPrompt: false }
const ready = { note: 'prompt', canPrompt: true }

function eventTarget () {
  const listeners = new Map()
  return {
    listeners,
    addEventListener (name, fn) { listeners.set(name, fn) },
    removeEventListener (name, fn) {
      if (listeners.get(name) === fn) listeners.delete(name)
    },
    dispatch (name, event) {
      const fn = listeners.get(name)
      if (fn) fn(event)
    }
  }
}

function fakeWindow () {
  const mql = { ...eventTarget(), matches: false }
  return {
    ...eventTarget(),
    mql,
    queries: [],
    matchMedia (query) {
      this.queries.push(query)
      return mql
    },
    standalone (matches) {
      mql.matches = matches
      mql.dispatch('change')
    }
  }
}

function fixture (create, overrides = {}) {
  const win = fakeWindow()
  const nav = { userAgent: android, platform: 'Linux armv8l', maxTouchPoints: 5 }
  const values = new Map()
  const writes = []
  const storage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem (key, value) {
      writes.push([key, value])
      values.set(key, value)
    }
  }
  const clock = { value: 100000 }
  const offer = create({ eligible: true, win, nav, storage: () => storage, now: () => clock.value, ...overrides })
  return { offer, win, nav, values, writes, clock }
}

function dialog (outcome = 'dismissed') {
  return {
    prevented: 0,
    called: 0,
    preventDefault () { this.prevented++ },
    prompt () { this.called++ },
    userChoice: Promise.resolve({ outcome })
  }
}

function waiting () {
  let resolve
  const promise = new Promise((_resolve) => { resolve = _resolve })
  return { promise, resolve }
}

function fail () { throw new Error('blocked') }

test('deviceOf: phone, tablet and Safari detection uses device signals', async (t) => {
  const { deviceOf } = await load()
  const cases = [
    [{ userAgent: android }, true, false],
    [{ userAgent: android.replace(' Mobile', '') }, false, false],
    [{ userAgent: iphone }, true, true],
    [{ userAgent: iphone.replace('Version/17.4', 'CriOS/124.0.6367.88') }, true, false],
    [{ userAgent: instagram }, true, false],
    [{ userAgent: ipod }, true, true],
    [{ userAgent: ipad }, true, true],
    [{ userAgent: mac, platform: 'MacIntel', maxTouchPoints: 5 }, true, true],
    [{ userAgent: mac, platform: 'MacIntel', maxTouchPoints: 0 }, false, false],
    [{ userAgent: mac, maxTouchPoints: 5 }, true, true],
    [{ userAgent: 'Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 }, true, true],
    [{ userAgent: desktop }, false, false],
    [{ userAgent: desktop, mobileHint: true }, true, false],
    [{ userAgent: desktop, mobileHint: 1 }, false, false],
    [{ userAgent: mac, platform: 'MacIntel', maxTouchPoints: '5' }, false, false]
  ]
  for (const [arg, handheld, iosSafari] of cases) {
    t.alike(deviceOf(arg), { handheld, iosSafari, samsungInternet: false }, JSON.stringify(arg))
  }
  for (const token of ['CriOS', 'FxiOS', 'EdgiOS', 'OPiOS', 'DuckDuckGo/7', 'GSA/', 'FBAN', 'FBAV', 'Instagram', 'Line/']) {
    t.alike(deviceOf({ userAgent: iphone + ' ' + token }), { handheld: true, iosSafari: false, samsungInternet: false }, token)
  }
  for (const arg of [undefined, null, 3, 'iPhone', {}, { userAgent: 5, platform: {} }]) {
    t.alike(deviceOf(arg), { handheld: false, iosSafari: false, samsungInternet: false }, 'invalid device input')
  }
})

test('deviceOf: Samsung Internet is detected by its SamsungBrowser/ token on any form factor', async (t) => {
  const { deviceOf } = await load()
  t.alike(deviceOf({ userAgent: samsung }), { handheld: true, iosSafari: false, samsungInternet: true })
  t.alike(deviceOf({ userAgent: samsung.replace(' Mobile', '') }), { handheld: false, iosSafari: false, samsungInternet: true })
  t.alike(deviceOf({ userAgent: samsungDesktop }), { handheld: false, iosSafari: false, samsungInternet: true })
  t.is(deviceOf({ userAgent: samsung.replace('SamsungBrowser/', 'SamsungBrowser') }).samsungInternet, false)
  t.is(deviceOf({ userAgent: android }).samsungInternet, false)
})

test('dismissal parsing and expiry reject malformed and future stamps', async (t) => {
  const { DISMISS_KEY, DISMISS_MS, dismissedAtOf, dismissalActive } = await load()
  t.is(DISMISS_KEY, 'varanda-install-dismissed')
  t.is(DISMISS_MS, 30 * 24 * 60 * 60 * 1000)
  for (const raw of ['0', '1234567890123', '999999999999999', '00001']) t.is(dismissedAtOf(raw), Number(raw))
  for (const raw of [undefined, null, 1, '', ' 1', '1.5', '-3', '1e2', 'abc', '1000000000000000', {}, Symbol('stamp')]) {
    t.is(dismissedAtOf(raw), null)
  }
  t.ok(dismissalActive(0, 0))
  t.ok(dismissalActive(0, DISMISS_MS - 1))
  t.absent(dismissalActive(0, DISMISS_MS))
  t.absent(dismissalActive(1, 0))
  t.absent(dismissalActive(null, 0))
  t.absent(dismissalActive(0, NaN))
  t.absent(dismissalActive(Infinity, Infinity))
  t.absent(dismissalActive('0', 0))
})

test('installView: strict gates, note priority and independent settings button', async (t) => {
  const { installView } = await load()
  const base = { eligible: true, handheld: true, hasPrompt: true, iosSafari: true, now: 100 }
  t.alike(installView(base), ready, 'prompt wins over Safari instructions')
  for (const over of [{ eligible: false }, { eligible: 1 }, { standalone: true }, { installed: true }]) {
    t.alike(installView({ ...base, ...over }), none)
  }
  for (const over of [{ handheld: false }, { handheld: 1 }, { dismissedAt: 0 }]) {
    t.alike(installView({ ...base, ...over }), { note: 'none', canPrompt: true })
  }
  t.alike(installView({ ...base, hasPrompt: false }), { note: 'ios', canPrompt: false })
  t.alike(installView({ ...base, hasPrompt: 1, iosSafari: 1 }), none)
  t.alike(installView({ ...base, hasPrompt: false, iosSafari: false }), none, 'non-Safari iPhone')
  t.alike(installView({ ...base, samsungInternet: true }), none)
  for (const samsungInternet of [1, 'true', false]) t.alike(installView({ ...base, samsungInternet }), ready)
  t.alike(installView({ ...base, standalone: 1, installed: 1 }), ready)
  for (const arg of [undefined, null, false, 'yes']) t.alike(installView(arg), none)
})

test('controller: defaults and ineligible pages attach nothing', async (t) => {
  const { createInstallOffer } = await load()
  for (const arg of [undefined, null, 5, 'yes', { eligible: true, win: 3, nav: 7, storage: 1, now: 'bad' }]) {
    const offer = createInstallOffer(arg)
    t.alike(offer.getSnapshot(), none)
    t.is(await offer.prompt(), 'unavailable')
    offer.dismiss()
    offer.stop()
  }
  for (const eligible of [false, 1, 'true']) {
    const { offer, win } = fixture(createInstallOffer, { eligible })
    t.is(win.listeners.size, 0)
    t.is(win.mql.listeners.size, 0)
    t.alike(offer.getSnapshot(), none)
    t.is(await offer.prompt(), 'unavailable')
  }
})

test('controller: Chrome prompt runs inside the tap, pending blocks reuse, acceptance latches', async (t) => {
  const { createInstallOffer } = await load()
  const { offer, win } = fixture(createInstallOffer)
  t.alike([...win.listeners.keys()], ['beforeinstallprompt', 'appinstalled'])
  t.alike([...win.mql.listeners.keys()], ['change'])
  t.alike(win.queries, ['(display-mode: standalone)'])
  const choice = waiting()
  const e = dialog()
  e.userChoice = choice.promise
  win.dispatch('beforeinstallprompt', e)
  t.is(e.prevented, 1)
  t.alike(offer.getSnapshot(), ready)
  let notified = false
  offer.subscribe(() => {
    notified = true
    t.is(e.called, 1, 'prompt called before subscriber notification')
  })
  const result = offer.prompt()
  t.is(e.called, 1, 'prompt has ALREADY run when offer.prompt returns, before awaiting')
  t.ok(notified)
  t.alike(offer.getSnapshot(), none)
  t.is(await offer.prompt(), 'unavailable')
  choice.resolve({ outcome: 'accepted' })
  t.is(await result, 'accepted')
  t.alike(offer.getSnapshot(), none)
  const later = dialog()
  win.dispatch('beforeinstallprompt', later)
  t.is(later.prevented, 1)
  t.alike(offer.getSnapshot(), none)
  t.is(await offer.prompt(), 'unavailable')
  offer.stop()
})

test('controller: Samsung Internet never stores or runs the install prompt', async (t) => {
  const { createInstallOffer } = await load()
  const { offer, win } = fixture(createInstallOffer, { nav: { userAgent: samsung, platform: 'Linux armv8l', maxTouchPoints: 5 } })
  t.alike([...win.listeners.keys()], ['beforeinstallprompt', 'appinstalled'])
  const e = dialog()
  win.dispatch('beforeinstallprompt', e)
  t.is(e.prevented, 1)
  t.alike(offer.getSnapshot(), none)
  t.is(await offer.prompt(), 'unavailable')
  t.is(e.called, 0)
  offer.stop()
})

function fakeDoc (overrides = {}) {
  const doc = {
    queries: [],
    removed: [0, 0],
    querySelectorAll (selector) {
      doc.queries.push(selector)
      return [0, 1].map((i) => ({ remove () { doc.removed[i]++ } }))
    },
    ...overrides
  }
  return doc
}

test('controller: Samsung Internet drops the manifest link once, only when eligible and not installed', async (t) => {
  const { createInstallOffer } = await load()
  const nav = { userAgent: samsung }
  const eligible = fakeDoc()
  fixture(createInstallOffer, { nav, doc: eligible })
  t.alike(eligible.queries, ['link[rel="manifest"]'])
  t.alike(eligible.removed, [1, 1])
  const skipped = []
  const win = fakeWindow()
  win.mql.matches = true
  skipped.push([{ nav, eligible: false }, fakeDoc()])
  skipped.push([{ nav, win }, fakeDoc()])
  skipped.push([{ nav: { userAgent: samsung, standalone: true } }, fakeDoc()])
  skipped.push([{ nav: { userAgent: android } }, fakeDoc()])
  skipped.push([{ nav: { userAgent: iphone } }, fakeDoc()])
  for (const [over, doc] of skipped) {
    fixture(createInstallOffer, { ...over, doc })
    t.is(doc.queries.length, 0)
    t.alike(doc.removed, [0, 0])
  }
})

test('controller: manifest removal failures are contained', async (t) => {
  const { createInstallOffer } = await load()
  const nav = { userAgent: samsung }
  const throwing = fakeDoc({ querySelectorAll: fail })
  const docs = [null, undefined, {}, throwing, fakeDoc({ querySelectorAll: () => null })]
  for (const doc of docs) {
    const { offer } = fixture(createInstallOffer, { nav, doc })
    t.alike(offer.getSnapshot(), none)
    t.is(await offer.prompt(), 'unavailable')
  }
  let removed = 0
  const partial = { querySelectorAll: () => [{ remove: fail }, { remove () { removed++ } }] }
  const { offer } = fixture(createInstallOffer, { nav, doc: partial })
  t.is(removed, 1, 'a throwing link does not skip the others')
  t.alike(offer.getSnapshot(), none)
  t.is(await offer.prompt(), 'unavailable')
})

test('controller: declined dialogs do not dismiss the note for future events', async (t) => {
  const { createInstallOffer, DISMISS_KEY } = await load()
  const { offer, win, values, writes } = fixture(createInstallOffer)
  win.dispatch('beforeinstallprompt', dialog())
  t.is(await offer.prompt(), 'dismissed')
  t.absent(values.has(DISMISS_KEY))
  t.is(writes.length, 0)
  t.alike(offer.getSnapshot(), none)
  const choice = waiting()
  const first = dialog()
  first.userChoice = choice.promise
  win.dispatch('beforeinstallprompt', first)
  t.alike(offer.getSnapshot(), ready)
  const result = offer.prompt()
  const newer = dialog()
  win.dispatch('beforeinstallprompt', newer)
  t.alike(offer.getSnapshot(), none, 'new event remains unavailable while pending')
  choice.resolve({ outcome: 'dismissed' })
  t.is(await result, 'dismissed')
  t.alike(offer.getSnapshot(), ready)
  t.is(await offer.prompt(), 'dismissed')
  t.is(newer.called, 1, 'newer event survives the earlier decline')
  t.is(writes.length, 0)
})

test('controller: prompt and choice failures always resolve safely', async (t) => {
  const { createInstallOffer } = await load()
  for (const prompt of [fail, () => Promise.reject(new Error('prompt rejected'))]) {
    const { offer, win } = fixture(createInstallOffer)
    win.dispatch('beforeinstallprompt', { ...dialog(), prompt })
    t.is(await offer.prompt(), 'unavailable')
    t.alike(offer.getSnapshot(), none)
    win.dispatch('beforeinstallprompt', dialog())
    t.alike(offer.getSnapshot(), ready, 'failure clears pending')
  }
  for (const getChoice of [() => undefined, () => Promise.reject(new Error('choice rejected')), fail, () => ({ outcome: 'unknown' })]) {
    const { offer, win } = fixture(createInstallOffer)
    const e = dialog()
    Object.defineProperty(e, 'userChoice', { get: getChoice })
    win.dispatch('beforeinstallprompt', e)
    t.is(await offer.prompt(), 'dismissed')
    t.alike(offer.getSnapshot(), none)
  }
})

test('controller: every event is prevented; only usable events replace the deferred prompt', async (t) => {
  const { createInstallOffer } = await load()
  const { offer, win } = fixture(createInstallOffer)
  const invalid = { prevented: 0, preventDefault () { this.prevented++ } }
  win.dispatch('beforeinstallprompt', invalid)
  t.is(invalid.prevented, 1)
  t.alike(offer.getSnapshot(), none)
  const first = dialog()
  const second = dialog()
  second.preventDefault = fail
  win.dispatch('beforeinstallprompt', first)
  win.dispatch('beforeinstallprompt', second)
  win.dispatch('beforeinstallprompt', invalid)
  win.dispatch('beforeinstallprompt', null)
  t.is(invalid.prevented, 2)
  t.is(await offer.prompt(), 'dismissed')
  t.is(first.called, 0)
  t.is(second.called, 1, 'later valid event replaces the first even if preventDefault throws')
})

test('controller: appinstalled clears the prompt; late results cannot undo installation', async (t) => {
  const { createInstallOffer } = await load()
  const initial = fixture(createInstallOffer)
  initial.win.dispatch('beforeinstallprompt', dialog())
  initial.win.dispatch('appinstalled')
  t.alike(initial.offer.getSnapshot(), none)
  t.is(await initial.offer.prompt(), 'unavailable')
  for (const outcome of ['dismissed', 'accepted', 'unavailable']) {
    const { offer, win } = fixture(createInstallOffer)
    const completion = waiting()
    const e = dialog()
    if (outcome === 'unavailable') e.prompt = () => completion.promise.then(fail)
    else e.userChoice = completion.promise
    win.dispatch('beforeinstallprompt', e)
    const result = offer.prompt()
    win.dispatch('appinstalled')
    completion.resolve({ outcome })
    t.is(await result, outcome)
    const later = dialog()
    win.dispatch('beforeinstallprompt', later)
    t.is(later.prevented, 1)
    t.alike(offer.getSnapshot(), none)
    t.is(await offer.prompt(), 'unavailable')
  }
})

test('controller: standalone reads are independent and media changes update the view', async (t) => {
  const { createInstallOffer } = await load()
  const win = fakeWindow()
  win.mql.matches = true
  const { offer, nav } = fixture(createInstallOffer, { win })
  win.dispatch('beforeinstallprompt', dialog())
  t.alike(offer.getSnapshot(), none)
  t.is(await offer.prompt(), 'unavailable')
  win.standalone(false)
  t.alike(offer.getSnapshot(), ready)
  win.standalone(true)
  t.alike(offer.getSnapshot(), none)
  nav.standalone = true
  win.standalone(false)
  t.alike(offer.getSnapshot(), none)
  for (const matchMedia of [undefined, fail]) {
    const broken = { ...fakeWindow(), matchMedia }
    const f = fixture(createInstallOffer, { win: broken, nav: { standalone: true, userAgent: iphone } })
    broken.dispatch('beforeinstallprompt', dialog())
    t.alike(f.offer.getSnapshot(), none)
    t.is(await f.offer.prompt(), 'unavailable')
  }
  const broken = fakeWindow()
  Object.defineProperty(broken.mql, 'matches', { get: fail })
  const f = fixture(createInstallOffer, { win: broken, nav: { standalone: true, userAgent: iphone } })
  t.alike(f.offer.getSnapshot(), none, 'throwing matches cannot hide standalone flag')
})

test('controller: close stores a dismissal while the settings action survives, with exact expiry', async (t) => {
  const { createInstallOffer, DISMISS_KEY, DISMISS_MS } = await load()
  const { offer, win, writes, clock } = fixture(createInstallOffer)
  win.dispatch('beforeinstallprompt', dialog())
  clock.value = 100000.75
  offer.dismiss()
  t.alike(writes, [[DISMISS_KEY, '100000']])
  t.alike(offer.getSnapshot(), { note: 'none', canPrompt: true })
  clock.value = 100000 + DISMISS_MS - 1
  t.alike(offer.getSnapshot(), { note: 'none', canPrompt: true })
  clock.value++
  t.alike(offer.getSnapshot(), ready, 'render after expiry restores note without a timer')
  t.is(await offer.prompt(), 'dismissed', 'close leaves the deferred event usable')
})

test('controller: stored stamps, unavailable storage and independent device reads', async (t) => {
  const { createInstallOffer } = await load()
  for (const [stamp, note] of [['99999', 'none'], ['bad', 'ios'], ['100001', 'ios']]) {
    const { offer } = fixture(createInstallOffer, { nav: { userAgent: iphone }, storage: () => ({ getItem: () => stamp }) })
    t.alike(offer.getSnapshot(), { note, canPrompt: false })
  }
  for (const storage of [fail, () => ({ getItem: fail, setItem: fail })]) {
    const { offer, win } = fixture(createInstallOffer, { storage })
    win.dispatch('beforeinstallprompt', dialog())
    t.alike(offer.getSnapshot(), ready)
    offer.dismiss()
    t.alike(offer.getSnapshot(), { note: 'none', canPrompt: true })
  }
  const nav = { userAgent: iphone, standalone: true }
  Object.defineProperty(nav, 'platform', { get: fail })
  Object.defineProperty(nav, 'userAgentData', { get: fail })
  const { offer, win } = fixture(createInstallOffer, { nav, storage: fail })
  t.alike(offer.getSnapshot(), none)
  nav.standalone = false
  win.standalone(false)
  t.alike(offer.getSnapshot(), { note: 'ios', canPrompt: false }, 'failed reads do not erase the UA')
  const hinted = fixture(createInstallOffer, { nav: { userAgent: desktop, userAgentData: { mobile: true } } })
  hinted.win.dispatch('beforeinstallprompt', dialog())
  t.alike(hinted.offer.getSnapshot(), ready)
  for (const now of [fail, () => 'bad', () => NaN]) {
    const f = fixture(createInstallOffer, { now })
    f.win.dispatch('beforeinstallprompt', dialog())
    f.offer.dismiss()
    t.alike(f.offer.getSnapshot(), { note: 'none', canPrompt: true }, 'invalid clock safely falls back')
  }
})

test('controller: stable snapshots and isolated subscribers with copied notification list', async (t) => {
  const { createInstallOffer } = await load()
  const { offer, win } = fixture(createInstallOffer)
  const initial = offer.getSnapshot()
  t.is(offer.getSnapshot(), initial)
  offer.subscribe(fail)
  let calls = 0
  let addedCalls = 0
  const added = () => { addedCalls++ }
  const unsubscribe = offer.subscribe(() => {
    calls++
    offer.subscribe(added)
  })
  t.is(typeof offer.subscribe(null), 'function')
  offer.subscribe(3)()
  win.dispatch('beforeinstallprompt', dialog())
  t.is(calls, 1, 'throwing subscriber did not block later subscriber')
  t.is(addedCalls, 0, 'new subscriber waits until next emission')
  const promptView = offer.getSnapshot()
  t.not(promptView, initial)
  t.is(offer.getSnapshot(), promptView)
  unsubscribe()
  win.dispatch('beforeinstallprompt', dialog())
  t.is(calls, 1)
  t.is(addedCalls, 1)
  t.is(offer.getSnapshot(), promptView, 'same values preserve identity after an event')
  offer.stop()
  offer.stop()
  t.is(win.listeners.size, 0)
  t.is(win.mql.listeners.size, 0)
})

test('controller: legacy media listeners are removed; throwing bindings are safe', async (t) => {
  const { createInstallOffer } = await load()
  const win = fakeWindow()
  delete win.mql.addEventListener
  delete win.mql.removeEventListener
  let handler
  win.mql.addListener = (fn) => { handler = fn }
  win.mql.removeListener = (fn) => { if (handler === fn) handler = null }
  const { offer } = fixture(createInstallOffer, { win, nav: { userAgent: iphone } })
  t.is(typeof handler, 'function')
  t.alike(offer.getSnapshot(), { note: 'ios', canPrompt: false })
  win.mql.matches = true
  handler()
  t.alike(offer.getSnapshot(), none)
  offer.stop()
  t.is(handler, null)
  t.is(win.listeners.size, 0)
  const broken = fakeWindow()
  broken.addEventListener = fail
  broken.mql.addEventListener = fail
  const f = fixture(createInstallOffer, { win: broken })
  t.alike(f.offer.getSnapshot(), none)
  f.offer.stop()
  const removing = fixture(createInstallOffer)
  removing.win.removeEventListener = fail
  removing.win.mql.removeEventListener = fail
  removing.offer.stop()
  t.pass('failed attachment and removal do not escape')
})

test('native: exactly six exports, immutable snapshots, stable hook value and harmless actions', async (t) => {
  const native = await loadNative()
  t.alike(Object.keys(native).sort(), ['dismissInstall', 'getInstall', 'getInstallCard', 'promptInstall', 'subscribeInstall', 'useInstall'])
  t.alike(native.getInstall(), none)
  t.is(native.getInstallCard(), 'none')
  t.ok(Object.isFrozen(native.getInstall()))
  t.is(native.getInstall(), native.getInstall())
  t.is(await native.promptInstall(), 'unavailable')
  const unsubscribe = native.subscribeInstall(() => t.fail('native never notifies'))
  t.is(typeof unsubscribe, 'function')
  unsubscribe()
  native.dismissInstall()
  const view = native.useInstall()
  t.is(view, native.useInstall())
  t.ok(Object.isFrozen(view))
  t.alike(view, { ...none, card: 'none', promptInstall: native.promptInstall, dismissInstall: native.dismissInstall })
})

test('installCard: gates, dismissal and priority', async (t) => {
  const { installCard, DISMISS_MS } = await load()
  const base = { eligible: true, hasPrompt: true, iosSafari: true, now: 100 }
  t.is(installCard(base), 'prompt')
  t.is(installCard({ ...base, hasPrompt: false }), 'ios')
  t.is(installCard({ ...base, hasPrompt: false, iosSafari: false }), 'none')
  for (const gate of [{ eligible: false }, { standalone: true }, { installed: true }, { samsungInternet: true }]) {
    t.is(installCard({ ...base, ...gate }), 'none', JSON.stringify(gate))
  }
  t.is(installCard({ ...base, dismissedAt: 100 }), 'none')
  t.is(installCard({ ...base, dismissedAt: 100, now: 100 + DISMISS_MS + 1 }), 'prompt')
  t.is(installCard({ ...base, handheld: false }), 'prompt')
  t.is(installCard(undefined), 'none')
  t.is(installCard(null), 'none')
})

test('controller: getCard follows the prompt, dismissal and installation', async (t) => {
  const { createInstallOffer } = await load()
  const f = fixture(createInstallOffer)
  t.is(f.offer.getCard(), 'none')
  f.win.dispatch('beforeinstallprompt', dialog())
  t.is(f.offer.getCard(), 'prompt')
  f.offer.dismiss()
  t.is(f.offer.getCard(), 'none')
  const g = fixture(createInstallOffer)
  g.win.dispatch('beforeinstallprompt', dialog())
  t.is(g.offer.getCard(), 'prompt')
  g.win.dispatch('appinstalled')
  t.is(g.offer.getCard(), 'none')
  f.offer.stop()
  g.offer.stop()
})

test('install card texts are plain strings without em dashes', async (t) => {
  const { INSTALL_CARD_TITLE, INSTALL_CARD_TEXT } = await load()
  for (const text of [INSTALL_CARD_TITLE, INSTALL_CARD_TEXT.prompt, INSTALL_CARD_TEXT.ios]) {
    t.ok(typeof text === 'string' && text.length > 0)
    t.absent(text.includes('—'))
  }
})
