// Push note rule and the shared push store, with injected fakes only.
'use strict'

const fs = require('fs')
const path = require('path')
const test = require('brittle')
const load = () => import('../src/push-offer.js')
const loadState = () => import('../src/push-state.js')

const DAY = 24 * 60 * 60 * 1000
const tick = () => new Promise((resolve) => setImmediate(resolve))

function defer () {
  const d = {}
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject })
  return d
}

function baseState (extra = {}) {
  return {
    support: 'ok',
    permission: 'default',
    subscribed: false,
    registration: { id: 1 },
    subscription: null,
    endpoint: null,
    p256dh: null,
    auth: null,
    swUpToDate: true,
    ...extra
  }
}

function fixture (opts = {}) {
  const f = {
    state: baseState(),
    key: 'K',
    registered: true,
    support: 'ok',
    clock: 1_000_000_000_000,
    stored: new Map(),
    writes: [],
    held: [],
    holdReads: false,
    readThrows: false,
    enableResults: [],
    disableResults: []
  }
  if (opts.stored !== undefined) f.stored.set('varanda-push-dismissed', opts.stored)
  const calls = (fn) => { fn.calls = []; return fn }
  f.getPushState = calls(function () {
    f.getPushState.calls.push([])
    if (f.readThrows) return Promise.reject(new Error('read'))
    if (f.holdReads) {
      const d = defer()
      f.held.push(d)
      return d.promise
    }
    return Promise.resolve({ ...f.state })
  })
  f.pushKey = calls(function () {
    f.pushKey.calls.push([])
    return Promise.resolve(f.key)
  })
  f.pushCheck = calls(function (arg) {
    f.pushCheck.calls.push(arg)
    return Promise.resolve({ registered: f.registered })
  })
  f.enablePush = calls(function (arg) {
    f.enablePush.calls.push(arg)
    const d = defer()
    f.enableResults.push(d)
    return d.promise
  })
  f.disablePush = calls(function (arg) {
    f.disablePush.calls.push(arg)
    const d = defer()
    f.disableResults.push(d)
    return d.promise
  })
  f.pushSupportNow = () => f.support
  f.storage = () => {
    if (f.storageThrows) throw new Error('storage')
    return {
      getItem: (k) => (f.stored.has(k) ? f.stored.get(k) : null),
      setItem: (k, v) => { f.writes.push([k, v]); f.stored.set(k, v) }
    }
  }
  f.now = () => f.clock
  f.make = async () => {
    const { createPushStore } = await load()
    return createPushStore({
      getPushState: f.getPushState,
      pushKey: f.pushKey,
      pushCheck: f.pushCheck,
      enablePush: f.enablePush,
      disablePush: f.disablePush,
      pushSupportNow: f.pushSupportNow,
      storage: f.storage,
      now: f.now
    })
  }
  return f
}

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const onState = (extra = {}) => baseState({ subscribed: true, subscription: { s: 1 }, endpoint: 'https://x/y', p256dh: 'p', auth: 'q', ...extra })

test('source imports only push-state.js and install-offer.js and has no em dash', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/push-offer.js'), 'utf8')
  const specifiers = [...src.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  t.alike(specifiers.sort(), ['./install-offer.js', './push-state.js'])
  t.absent(/\brequire\s*\(/.test(src))
  t.absent(src.includes('\u2014'))
})

test('pushNoteKind', async (t) => {
  const { pushNoteKind } = await load()
  const { DISMISS_MS } = await import('../src/install-offer.js')
  const now = 1_000_000_000_000
  const kind = (state, extra = {}) => pushNoteKind({ state, fresh: state, dismissedAt: null, now, ...extra })
  const s = baseState({ key: 'K', registered: null })
  t.is(kind(s), 'offer', 'default')
  t.is(kind({ ...s, permission: 'granted' }), 'offer', 'granted not subscribed')
  t.is(kind({ ...s, subscribed: false, registered: null }), 'offer', 'subscribed false registered null')
  t.is(kind({ ...s, subscribed: true, registered: false }), 'offer', 'lost row')
  t.is(pushNoteKind({ state: null, fresh: s, dismissedAt: null, now }), 'none', 'state null')
  t.is(pushNoteKind({ state: s, fresh: null, dismissedAt: null, now }), 'none', 'fresh null')
  t.is(kind({ ...s, support: 'not-hosted' }), 'none', 'not hosted')
  t.is(kind({ ...s, support: 'unsupported' }), 'none', 'unsupported')
  t.is(kind({ ...s, key: null }), 'none', 'key null')
  t.is(kind({ ...s, registration: null }), 'none', 'registration null')
  t.is(kind({ ...s, permission: 'denied' }), 'none', 'denied')
  t.is(kind({ ...s, permission: null }), 'none', 'permission null')
  t.is(kind({ ...s, subscribed: null }), 'none', 'subscribed null')
  t.is(kind({ ...s, subscribed: true, registered: null }), 'none', 'subscribed true registered null')
  t.is(kind({ ...s, subscribed: true, registered: true }), 'none', 'on')
  t.is(kind({ ...s, swUpToDate: false }), 'none', 'stale worker')
  t.is(kind({ ...s, swUpToDate: undefined }), 'none', 'swUpToDate missing')
  t.is(kind(s, { dismissedAt: now - 10 * DAY }), 'none', 'dismissed 10 days ago')
  t.is(kind(s, { dismissedAt: now - DISMISS_MS }), 'offer', 'exactly DISMISS_MS')
  t.is(kind(s, { dismissedAt: now + DAY }), 'offer', 'future timestamp')

  const f = fixture({ stored: 'garbage' })
  const store = await f.make()
  await store.read(A)
  t.is(store.getSnapshot().note, 'offer', 'garbage stored value')
})

test('read merges state, nulls on leave and on account change', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(f.getPushState.calls.length, 1)
  t.is(f.pushKey.calls.length, 1)
  t.is(f.pushCheck.calls.length, 0, 'no endpoint, no check')
  let snap = store.getSnapshot()
  t.is(snap.member, A)
  t.alike(snap.state, { ...baseState(), key: 'K', registered: null })

  f.state = onState()
  await store.read(A)
  t.alike(f.pushCheck.calls, [{ member: A, endpoint: 'https://x/y', p256dh: 'p', auth: 'q' }])
  t.is(store.getSnapshot().state.registered, true)
  t.is(store.getSnapshot().state.key, 'K')

  const before = f.getPushState.calls.length
  await store.read(null)
  snap = store.getSnapshot()
  t.is(snap.member, null)
  t.is(snap.state, null)
  t.is(f.getPushState.calls.length, before, 'no network on null')

  await store.read(A)
  f.holdReads = true
  const old = store.read(A)
  const seen = []
  store.subscribe(() => seen.push(store.getSnapshot()))
  f.state = baseState()
  const next = store.read(B)
  t.is(store.getSnapshot().state, null, 'nulled before the new read')
  t.is(store.getSnapshot().member, B)
  t.is(seen[0].state, null)
  f.held[1].resolve({ ...baseState(), subscribed: false })
  await next
  t.is(store.getSnapshot().state.subscribed, false)
  f.held[0].resolve(onState())
  await old
  await tick()
  t.is(store.getSnapshot().state.subscribed, false, 'old read ignored')
  t.is(store.getSnapshot().member, B)
})

test('superseded reads are dropped and overlapping reads share one call', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  f.holdReads = true
  const one = store.read(A)
  const two = store.read(A)
  t.is(f.getPushState.calls.length, 2, 'joined the flight')
  f.held[0].resolve(baseState({ permission: 'granted' }))
  await Promise.all([one, two])
  t.is(store.getSnapshot().state.permission, 'granted')

  const older = store.read(A)
  const newer = store.read(B)
  t.is(f.getPushState.calls.length, 4)
  f.held[2].resolve(baseState({ permission: 'default' }))
  await newer
  f.held[1].resolve(baseState({ permission: 'granted', subscribed: null }))
  await older
  await tick()
  t.is(store.getSnapshot().member, B)
  t.is(store.getSnapshot().state.permission, 'default', 'superseded read not applied')
  t.is(store.getSnapshot().state.subscribed, false)
})

test('activate calls enablePush synchronously before any listener', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  const reg = store.getSnapshot().state.registration
  const counts = () => [f.getPushState.calls.length, f.pushKey.calls.length, f.pushCheck.calls.length]
  const start = counts()
  let checked = false
  const unsub = store.subscribe(() => {
    if (checked) return
    checked = true
    t.is(f.enablePush.calls.length, 1, 'step ran before the first emit')
    t.alike(counts(), start, 'nothing read before the step')
  })
  const node = { hosted: true }
  t.is(store.activate({ node, member: A }), true)
  t.is(f.enablePush.calls.length, 1, 'called before activate returned')
  t.ok(checked)
  unsub()
  const arg = f.enablePush.calls[0]
  t.is(arg.key, 'K')
  t.is(arg.registration, reg)
  t.is(arg.subscriptionKnown, true)
  t.is(arg.node, node)
  t.is(arg.member, A)
  t.is(store.getSnapshot().pending, true)

  f.state = onState({ subscription: {} })
  f.registered = true
  f.enableResults[0].resolve({ ok: true, subscription: {}, endpoint: 'https://x/y' })
  await tick(); await tick(); await tick()
  const snap = store.getSnapshot()
  t.is(snap.state.subscribed, true)
  t.is(snap.state.registered, true)
  t.is(snap.pending, false)
  t.is(snap.error, '')
  t.is(snap.note, 'none')
  t.is(f.disablePush.calls.length, 0)
})

test('the follow-up read decides, not the step result', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  store.activate({ member: A })
  f.state = baseState({ subscribed: false })
  f.enableResults[0].resolve({ ok: true, subscription: {}, endpoint: 'https://x/y' })
  await tick(); await tick(); await tick()
  const snap = store.getSnapshot()
  t.is(snap.state.subscribed, false)
  t.is(snap.state.registered, null)
  t.is(snap.pending, false)
})

test('busy, already on and lost row guards', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(store.activate({ member: A }), true)
  t.is(store.activate({ member: A }), false)
  t.is(store.toggle({ member: A }), false)
  t.is(f.enablePush.calls.length, 1)
  t.is(f.disablePush.calls.length, 0)
  f.enableResults[0].resolve({ ok: false, reason: 'failed' })
  await tick(); await tick(); await tick()

  const g = fixture()
  g.state = onState()
  const on = await g.make()
  await on.read(A)
  t.is(on.activate({ member: A }), false)
  t.is(g.enablePush.calls.length, 0)
  t.is(g.disablePush.calls.length, 0)

  const h = fixture()
  h.state = onState()
  h.registered = false
  const lost = await h.make()
  await lost.read(A)
  t.is(lost.activate({ member: A }), true)
  t.is(h.enablePush.calls.length, 1)
  t.is(h.disablePush.calls.length, 0)

  const i = fixture()
  const other = await i.make()
  t.is(other.activate({ member: A }), false, 'state null')
  await other.read(A)
  t.is(other.activate({ member: B }), false, 'other member')
  t.is(other.activate({ member: null }), false, 'no member')
  t.is(other.toggle({ member: B }), false)
  t.is(i.enablePush.calls.length, 0)
})

test('failures map to errors and are not retried', async (t) => {
  const { PUSH_DENIED, PUSH_FAILED } = await loadState()
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  store.activate({ member: A })
  f.state = baseState({ permission: 'denied' })
  f.enableResults[0].resolve({ ok: false, reason: 'denied', permission: 'denied' })
  await tick(); await tick(); await tick()
  t.is(store.getSnapshot().error, PUSH_DENIED)
  t.is(store.getSnapshot().note, 'none')

  const g = fixture()
  const s2 = await g.make()
  await s2.read(A)
  s2.activate({ member: A })
  g.enableResults[0].resolve({ ok: false, reason: 'failed' })
  await tick(); await tick(); await tick()
  t.is(s2.getSnapshot().error, PUSH_FAILED)
  t.is(s2.getSnapshot().note, 'offer')
  t.is(g.enablePush.calls.length, 1)

  const h = fixture()
  const s3 = await h.make()
  await s3.read(A)
  s3.activate({ member: A })
  h.readThrows = true
  h.enableResults[0].resolve({ ok: true, subscription: { s: 1 }, endpoint: 'https://x/y' })
  await tick(); await tick(); await tick()
  const snap = s3.getSnapshot()
  t.is(h.getPushState.calls.length, 2, 'follow-up read once, no retry')
  t.is(snap.state.subscribed, true, 'pushStateAfter fallback over the held subscription')
  t.is(snap.state.registered, true)
  t.is(snap.error, '')
  t.is(snap.pending, false)
  t.is(h.enablePush.calls.length, 1)
})

test('a read during a toggle awaits it and applies its view', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  store.activate({ member: A })
  const r = store.read(A)
  f.state = onState()
  f.enableResults[0].resolve({ ok: true, subscription: { s: 1 }, endpoint: 'https://x/y' })
  await r
  t.is(store.getSnapshot().state.subscribed, true)
  t.is(store.getSnapshot().state.registered, true)
  await tick()
  t.is(f.getPushState.calls.length, 2)
})

test('toggle on an on state turns off with the held registration', async (t) => {
  const f = fixture()
  f.state = onState()
  const store = await f.make()
  await store.read(A)
  const held = store.getSnapshot().state
  t.is(store.toggle({ node: 'n', member: A }), true)
  t.is(f.enablePush.calls.length, 0)
  t.is(f.disablePush.calls.length, 1)
  t.alike(f.disablePush.calls[0], { node: 'n', member: A, registration: held.registration, subscription: held.subscription })
  t.is(f.disablePush.calls[0].registration, held.registration)
  f.state = baseState()
  f.disableResults[0].resolve({ ok: true, unsubscribed: true })
  await tick(); await tick(); await tick()
  t.is(store.getSnapshot().state.subscribed, false)
  t.is(store.getSnapshot().pending, false)
})

test('dismiss writes only the push key', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(store.getSnapshot().note, 'offer')
  let emitted = 0
  store.subscribe(() => { emitted++ })
  store.dismiss()
  t.alike(f.writes, [['varanda-push-dismissed', String(f.clock)]])
  t.is(store.getSnapshot().note, 'none')
  t.is(emitted, 1)

  const g = fixture({ stored: String(f.clock) })
  const again = await g.make()
  await again.read(A)
  t.is(again.getSnapshot().note, 'none', 'starts dismissed')

  const h = fixture()
  h.storageThrows = true
  const broken = await h.make()
  await broken.read(A)
  broken.dismiss()
  t.is(broken.getSnapshot().note, 'none', 'storage throw swallowed')
})

test('offHere', async (t) => {
  const f = fixture()
  f.state = onState()
  const store = await f.make()
  await store.read(A)
  const held = store.getSnapshot().state
  const p = store.offHere({ node: 'n', member: A })
  t.ok(held.subscription !== null, 'a subscription is held')
  t.alike(f.disablePush.calls[0], { node: 'n', member: A, registration: held.registration, subscription: null }, 'the held subscription is never handed over')
  f.disableResults[0].reject(new Error('x'))
  await p
  t.pass('resolves when disablePush rejects')

  f.support = 'unsupported'
  await store.offHere({ member: A })
  f.support = 'ok'
  await store.offHere({ member: null })
  t.is(f.disablePush.calls.length, 1)

  const g = fixture()
  const empty = await g.make()
  const q = empty.offHere({ node: 'n', member: A })
  t.alike(g.disablePush.calls[0], { node: 'n', member: A, registration: null, subscription: null })
  g.disableResults[0].resolve({ ok: true })
  await q

  const h = fixture()
  const busy = await h.make()
  await busy.read(A)
  busy.activate({ member: A })
  const w = busy.offHere({ member: A })
  h.disableResults[0].resolve({ ok: true })
  await w
  t.is(busy.getSnapshot().pending, true, 'resolved while the enable is still pending')
  t.is(h.enableResults.length, 1)
})

test('snapshot identity and unsubscribe', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(store.getSnapshot(), store.getSnapshot())
  let n = 0
  const unsub = store.subscribe(() => { n++ })
  store.dismiss()
  t.is(n, 1)
  unsub()
  await store.read(A)
  store.dismiss()
  t.is(n, 1)
})

test('a read started before a turn-on never overwrites its outcome', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  f.holdReads = true
  const old = store.read(A)
  f.holdReads = false
  t.is(store.activate({ member: A }), true)
  f.state = onState({ subscription: {} })
  f.registered = true
  f.enableResults[0].resolve({ ok: true, subscription: {}, endpoint: 'https://x/y' })
  await tick(); await tick(); await tick()
  t.is(store.getSnapshot().state.subscribed, true)
  f.held[0].resolve(baseState({ subscribed: false }))
  await old
  await tick()
  const snap = store.getSnapshot()
  t.is(snap.state.subscribed, true)
  t.is(snap.state.registered, true)
  t.is(snap.note, 'none')
})

test('reads of an invalidated session are never reused', async (t) => {
  const f = fixture()
  const store = await f.make()
  f.holdReads = true
  const first = store.read(A)
  await store.read(null)
  const second = store.read(A)
  t.is(f.getPushState.calls.length, 2)
  f.held[1].resolve(baseState({ permission: 'granted' }))
  await second
  f.held[0].resolve(baseState({ permission: 'default', subscribed: null }))
  await first
  await tick()
  t.is(store.getSnapshot().state.permission, 'granted')
  t.is(store.getSnapshot().state.subscribed, false)
})

test('the note follows the last real read, not the reconciled state', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  store.activate({ member: A })
  f.key = null
  f.enableResults[0].resolve({ ok: false, reason: 'failed' })
  await tick(); await tick(); await tick()
  let snap = store.getSnapshot()
  t.is(snap.state.key, 'K', 'pushStateAfter kept the old key')
  t.is(snap.note, 'none')

  const g = fixture()
  const s2 = await g.make()
  await s2.read(A)
  s2.activate({ member: A })
  g.readThrows = true
  g.enableResults[0].resolve({ ok: false, reason: 'failed' })
  await tick(); await tick(); await tick()
  snap = s2.getSnapshot()
  t.is(snap.state.subscribed, false)
  t.is(snap.note, 'none')
})

test('a read a listener starts on pending joins the operation', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  let joined = null
  store.subscribe(() => {
    if (joined === null && store.getSnapshot().pending) joined = store.read(A)
  })
  t.is(store.activate({ member: A }), true)
  t.ok(joined !== null)
  f.state = onState()
  f.enableResults[0].resolve({ ok: true, subscription: { s: 1 }, endpoint: 'https://x/y' })
  await joined
  await tick()
  const snap = store.getSnapshot()
  t.is(snap.state.subscribed, true)
  t.is(snap.state.registered, true)
  t.is(snap.note, 'none')
  t.is(f.getPushState.calls.length, 2, 'the initial read and the follow-up read only')
})

test('a lock and unlock during a turn-on reads again once it settles', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(store.activate({ member: A }), true)
  await store.read(null)
  f.state = onState()
  f.registered = false
  await store.read(A)
  t.is(store.getSnapshot().state.registered, false, 'the new session read before the step finished')
  f.registered = true
  f.enableResults[0].resolve({ ok: true, subscription: { s: 1 }, endpoint: 'https://x/y' })
  await tick(); await tick(); await tick(); await tick()
  const snap = store.getSnapshot()
  t.is(snap.pending, false)
  t.is(snap.state.subscribed, true)
  t.is(snap.state.registered, true)
  t.is(f.enablePush.calls.length, 1)
})

test('the corrective read never reuses a flight begun before the step ended', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(store.activate({ member: A }), true)
  await store.read(null)
  f.holdReads = true
  const unlock = store.read(A)
  f.state = onState()
  f.registered = true
  f.enableResults[0].resolve({ ok: true, subscription: { s: 1 }, endpoint: 'https://x/y' })
  await tick(); await tick()
  t.is(f.held.length, 2, 'the step re-read is held too')
  f.held[1].resolve(onState())
  await tick(); await tick(); await tick()
  t.is(f.held.length, 3, 'the corrective read is a new call')
  t.is(store.getSnapshot().pending, true, 'pending until the corrective read lands')
  t.is(store.activate({ member: A }), false)
  f.held[0].resolve(baseState({ subscribed: false }))
  await unlock
  if (f.held[2]) f.held[2].resolve(onState())
  await tick(); await tick(); await tick(); await tick()
  const snap = store.getSnapshot()
  t.is(snap.pending, false)
  t.is(snap.state.subscribed, true)
  t.is(snap.state.registered, true)
  t.is(snap.note, 'none')
  t.is(f.enablePush.calls.length, 1)
})

test('one step at a time on this browser, across a session change', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(store.activate({ member: A }), true)
  await store.read(B)
  t.is(store.getSnapshot().pending, true, 'the step in flight belongs to the browser')
  t.is(store.activate({ member: B }), false)
  t.is(store.toggle({ member: B }), false)
  t.is(f.enablePush.calls.length, 1)
  f.enableResults[0].resolve({ ok: false, reason: 'failed' })
  await tick(); await tick(); await tick(); await tick(); await tick()
  t.is(store.getSnapshot().pending, false)
  t.is(store.activate({ member: B }), true)
  t.is(f.enablePush.calls.length, 2)
  t.is(f.enablePush.calls[1].member, B)
})

test('the row never claims a subscription it did not see the browser lack', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  store.activate({ member: A })
  t.is(f.enablePush.calls[0].subscriptionKnown, true)
  f.state = baseState({ subscribed: null })
  f.enableResults[0].resolve({ ok: false, reason: 'failed' })
  await tick(); await tick(); await tick()
  t.is(store.getSnapshot().state.subscribed, false)
  t.is(store.toggle({ member: A }), true)
  t.is(f.enablePush.calls[1].subscriptionKnown, false)
})

test('another account on this browser reads again once a turn-on settles', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(store.activate({ member: A }), true)
  await store.read(B)
  t.is(store.getSnapshot().state.subscribed, false)
  f.state = onState()
  f.registered = true
  f.enableResults[0].resolve({ ok: true, subscription: { s: 1 }, endpoint: 'https://x/y' })
  await tick(); await tick(); await tick(); await tick(); await tick()
  t.is(f.getPushState.calls.length, 4, 'initial, B, the step re-read and the corrective read')
  t.is(f.pushCheck.calls[f.pushCheck.calls.length - 1].member, B)
  const snap = store.getSnapshot()
  t.is(snap.member, B)
  t.is(snap.state.subscribed, true)
  t.is(snap.pending, false)
})

test('a lock and unlock never allow a second step while one is in flight', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(store.activate({ member: A }), true)
  await store.read(null)
  await store.read(A)
  t.is(store.getSnapshot().pending, true)
  t.is(store.activate({ member: A }), false)
  t.is(store.toggle({ member: A }), false)
  t.is(f.enablePush.calls.length, 1)
})

test('a read without a registration never counts as seeing no subscription', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  store.activate({ member: A })
  f.state = baseState({ registration: null })
  f.enableResults[0].resolve({ ok: false, reason: 'failed' })
  await tick(); await tick(); await tick()
  t.is(store.toggle({ member: A }), true)
  t.is(f.enablePush.calls[1].subscriptionKnown, false)
})

test('a failed corrective read shows nothing instead of the pre-step snapshot', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  t.is(store.activate({ member: A }), true)
  await store.read(null)
  await store.read(A)
  t.is(store.getSnapshot().state.subscribed, false)
  f.readThrows = true
  f.enableResults[0].resolve({ ok: true, subscription: { s: 1 }, endpoint: 'https://x/y' })
  await tick(); await tick(); await tick(); await tick(); await tick()
  const snap = store.getSnapshot()
  t.is(snap.pending, false)
  t.is(snap.state, null)
  t.is(snap.note, 'none')
  t.is(store.toggle({ member: A }), false)
  t.is(f.enablePush.calls.length, 1)
})

test('an unknown subscription in the last real read never offers the note', async (t) => {
  const f = fixture()
  const store = await f.make()
  await store.read(A)
  store.activate({ member: A })
  f.state = baseState({ subscribed: null })
  f.enableResults[0].resolve({ ok: false, reason: 'failed' })
  await tick(); await tick(); await tick()
  const snap = store.getSnapshot()
  t.is(snap.state.subscribed, false, 'the reconciled state says off from the step alone')
  t.is(snap.note, 'none')
  t.is(store.activate({ member: A }), false)
})
