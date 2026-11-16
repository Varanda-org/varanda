import test from 'brittle'
import {
  CONFIRM_LINES, DISCONNECTED_CAPTION, NAME_MAX, NO_NAME, RECONNECT_UNCERTAIN, UNNAMED_SELF, confirmCopy, createDeviceStore,
  deviceMemberOf, deviceName, deviceStep, notePasskeyUnlock, devicesRowShown, disconnectLabel, disconnectParams, helloDue, otherLabel, readDevices, reconnectDevice,
  reconnectFailure, rowCaption, sendHello, shapeList, shouldForceLock, sinceDate, sinceText, unknownMethod, visibleDevices
} from '../src/devices.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'
const EDGE_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'

test('deviceName: browser and system from a user agent', (t) => {
  t.is(deviceName({ userAgent: CHROME_ANDROID }), 'Chrome no Android')
  t.is(deviceName({ userAgent: SAFARI_IPHONE }), 'Safari no iPhone')
  t.is(deviceName({ userAgent: FIREFOX_WIN }), 'Firefox no Windows')
  t.is(deviceName({ userAgent: EDGE_MAC }), 'Edge no Mac')
})

test('deviceName: phone constants when there is no browser', (t) => {
  t.is(deviceName({ userAgent: '', constants: { Brand: 'google', Model: 'Pixel 8' } }), 'Google Pixel 8')
  t.is(deviceName({ constants: { Brand: 'samsung', Model: 'Samsung Galaxy S24' } }), 'Samsung Galaxy S24')
  t.is(deviceName({ constants: { Model: 'Moto G' } }), 'Moto G')
  t.is(deviceName({ constants: { interfaceIdiom: 'pad', systemName: 'iPadOS' } }), 'iPad')
  t.is(deviceName({ constants: { interfaceIdiom: 'phone', systemName: 'iOS' } }), 'iPhone')
})

test('deviceName: at most 40 characters, no control characters, never empty', (t) => {
  const long = deviceName({ constants: { Model: 'M'.repeat(100) } })
  t.is(Array.from(long).length, NAME_MAX)
  t.is(deviceName({ constants: { Model: 'Pixel\n\t 8\u0000' } }), 'Pixel 8')
  t.is(deviceName({}), UNNAMED_SELF)
  t.is(deviceName(null), UNNAMED_SELF)
  t.is(deviceName({ userAgent: 5, constants: 5 }), UNNAMED_SELF)
})

test('unknownMethod only for the unknown-method answer', (t) => {
  t.ok(unknownMethod(new Error('método desconhecido')))
  t.absent(unknownMethod(new Error('identidade bloqueada: entre com a passkey')))
  t.absent(unknownMethod(null))
  t.absent(unknownMethod('método desconhecido'))
})

test('sinceDate and sinceText: dd/mm/aaaa in the local calendar', (t) => {
  const d = new Date(2026, 10, 5, 12)
  t.is(sinceDate(d.toISOString()), '05/11/2026')
  t.is(sinceText(d.toISOString()), 'Conectado desde 05/11/2026')
  t.is(sinceDate('nope'), null)
  t.is(sinceDate(5), null)
  t.is(sinceText(null), null)
})

test('shapeList: this device, others, disconnected, previous', (t) => {
  const v = shapeList({
    self: A,
    off: false,
    devices: [
      { id: A, name: 'Chrome no Mac', since: '2026-11-01T10:00:00.000Z', on: true, writers: 3, self: true },
      { id: B, name: null, since: '2026-11-02T10:00:00.000Z', on: true, writers: 1, self: false },
      { id: C, name: 'Velho', since: '2026-10-01T10:00:00.000Z', on: false, writers: 0, self: false },
      { id: 'zz', name: 'ruim', on: true },
      null
    ],
    previous: { writers: 4 }
  })
  t.is(v.self.id, A)
  t.alike(v.others.map((d) => d.id), [B])
  t.alike(v.disconnected.map((d) => d.id), [C])
  t.alike(v.previous, { writers: 4 })
  t.absent(v.off)
})

test('shapeList: previous null and off', (t) => {
  const v = shapeList({ self: A, off: true, devices: [{ id: A, name: 'X', since: null, on: false, writers: 0, self: true }], previous: null })
  t.ok(v.off)
  t.is(v.previous, null)
  t.alike(v.others, [])
})

test('shapeList: off from this device row alone, and malformed answers', (t) => {
  t.ok(shapeList({ devices: [{ id: A, on: false, self: true }] }).off)
  for (const bad of [null, undefined, 5, 'x', {}, { devices: 'no' }]) {
    const v = shapeList(bad)
    t.is(v.self, null)
    t.alike(v.others, [])
    t.alike(v.disconnected, [])
    t.is(v.previous, null)
    t.absent(v.off)
  }
})

test('labels and params', (t) => {
  t.is(otherLabel({ name: null }), NO_NAME)
  t.is(otherLabel({ name: 'Firefox no Linux' }), 'Firefox no Linux')
  t.is(disconnectLabel({ name: null }), 'Desconectar Aparelho sem nome')
  t.alike(disconnectParams('previous'), { previous: true })
  t.alike(disconnectParams(B), { id: B })
  t.is(CONFIRM_LINES.length, 3)
  for (const line of CONFIRM_LINES) t.absent(line.includes(String.fromCharCode(0x2014)))
})

function bound (member = A) {
  const store = createDeviceStore()
  store.bind(member)
  return store
}

test('store: bound to a member, drops answers for another, resets when it changes', (t) => {
  const store = createDeviceStore()
  let calls = 0
  const off = store.subscribe(() => { calls++ })
  t.alike(store.get(), { member: null, offered: null, off: false, list: null, forced: false })
  store.answer(A, { offered: true })
  t.is(store.get().offered, null, 'nobody bound: dropped')
  store.bind(A)
  store.answer(A, { offered: true, off: true })
  store.answer(B, { offered: false, off: false })
  t.alike(store.get(), { member: A, offered: true, off: true, list: null, forced: false }, 'another member answer dropped')
  store.bind(A)
  t.is(calls, 2, 'same member again: no change')
  store.bind(B)
  t.alike(store.get(), { member: B, offered: null, off: false, list: null, forced: false }, 'A off never reaches B')
  store.answer(B, { offered: true })
  store.bind(null)
  t.alike(store.get(), { member: null, offered: null, off: false, list: null, forced: false }, 'null member resets')
  off()
  store.bind(A)
  t.is(calls, 5, 'unsubscribed')
})

test('store: forced survives a lock until a member unlocks; event applies to the bound member', (t) => {
  const store = bound(A)
  store.event(true)
  t.ok(store.get().off)
  store.event(false)
  t.absent(store.get().off)
  store.forceLock()
  store.bind(null)
  t.ok(store.get().forced, 'the unlock screen still says why')
  store.event(true)
  t.absent(store.get().off, 'no member: an event is ignored')
  store.bind(A)
  t.absent(store.get().forced, 'cleared once someone unlocks')
})

test('visibleDevices hides another member state', (t) => {
  const store = bound(A)
  store.answer(A, { offered: true, off: true })
  t.ok(visibleDevices(store.get(), A).off)
  t.absent(visibleDevices(store.get(), B).off, 'first frame of B')
  t.is(visibleDevices(store.get(), null).offered, null)
  store.forceLock()
  t.ok(visibleDevices(store.get(), null).forced)
})

test('readDevices records the answer; unknown method hides the entry', async (t) => {
  const store = bound()
  const reply = { self: A, off: true, devices: [{ id: A, name: 'X', since: null, on: false, writers: 0, self: true }], previous: null }
  const view = await readDevices({ request: async (m) => { t.is(m, 'device.list'); return reply }, store })
  t.ok(view.off)
  t.alike(store.get(), { member: A, offered: true, off: true, list: reply, forced: false })

  const hidden = bound()
  hidden.answer(A, { offered: true })
  await t.exception(readDevices({ request: async () => { throw new Error('método desconhecido') }, store: hidden }))
  t.is(hidden.get().offered, false)
})

test('readDevices: a failed read keeps the old list and the entry', async (t) => {
  const store = bound()
  const reply = { devices: [{ id: A, name: 'X', since: null, on: true, writers: 0, self: true }] }
  await readDevices({ request: async () => reply, store })
  await t.exception(readDevices({ request: async () => { throw new Error('sem conexão com o nó') }, store }))
  t.is(store.get().offered, true)
  t.is(store.get().list, reply)
})

test('readDevices: an answer that arrives after the member changed is dropped', async (t) => {
  const store = bound(A)
  let release
  const slow = new Promise((resolve) => { release = resolve })
  const pending = readDevices({ request: () => slow, store })
  store.bind(B)
  release({ devices: [], off: true })
  await pending
  t.alike(store.get(), { member: B, offered: null, off: false, list: null, forced: false })
})

test('sendHello: one call, silent on failure, off recorded', async (t) => {
  const store = bound()
  const calls = []
  const ok = await sendHello({ request: async (m, p) => { calls.push([m, p]); return { id: A, registered: true, off: true } }, store, name: 'Chrome no Mac' })
  t.ok(ok)
  t.alike(calls, [['device.hello', { name: 'Chrome no Mac' }]])
  t.is(store.get().offered, true)
  t.ok(store.get().off)

  const unknown = bound()
  t.absent(await sendHello({ request: async () => { throw new Error('método desconhecido') }, store: unknown, name: 'x' }))
  t.is(unknown.get().offered, false)

  const other = bound()
  let n = 0
  t.absent(await sendHello({ request: async () => { n++; throw new Error('erro') }, store: other, name: 'x' }))
  t.is(n, 1, 'no retry')
  t.is(other.get().offered, null)
})

test('reconnectDevice: one call, clears off and the list', async (t) => {
  const store = bound()
  store.answer(A, { offered: true, off: true, list: { devices: [] } })
  const calls = []
  await reconnectDevice({ request: async (m, p) => { calls.push([m, p]) }, store, name: 'Safari no iPhone' })
  t.alike(calls, [['device.reconnect', { name: 'Safari no iPhone' }]])
  t.is(store.get().off, false)
  t.is(store.get().list, null)
})

test('reconnectDevice: a failure reads the list once (not a retry) and rethrows', async (t) => {
  const store = bound()
  store.answer(A, { offered: true, off: true })
  const calls = []
  const request = async (m) => {
    calls.push(m)
    if (m === 'device.reconnect') throw Object.assign(new Error('x'), { uncertain: true })
    return { devices: [{ id: A, name: 'X', since: null, on: true, writers: 0, self: true }], off: false }
  }
  await t.exception(reconnectDevice({ request, store, name: 'x' }))
  t.alike(calls, ['device.reconnect', 'device.list'])
  t.is(store.get().off, false, 'the read settled it')

  const still = bound()
  still.answer(A, { offered: true, off: true })
  const failing = async (m) => { throw new Error(m === 'device.list' ? 'sem conexão com o nó' : 'boom') }
  await t.exception(reconnectDevice({ request: failing, store: still, name: 'x' }))
  t.ok(still.get().off, 'a failed read leaves it as it was')
})

test('reconnectFailure: plain words, never the incerto text', (t) => {
  const show = (m) => 'texto: ' + m
  t.is(reconnectFailure(Object.assign(new Error('x'), { uncertain: true }), show), RECONNECT_UNCERTAIN)
  t.absent(RECONNECT_UNCERTAIN.includes('incerto'))
  t.is(reconnectFailure(new Error('sem conexão'), show), 'texto: sem conexão')
  t.is(reconnectFailure(null, show), 'texto: erro')
})

test('helloDue: once per member, never offline, never without a member', (t) => {
  t.ok(helloDue({ member: A, online: true, sent: null }))
  t.ok(helloDue({ member: A, online: undefined, sent: null }))
  t.absent(helloDue({ member: A, online: false, sent: null }))
  t.absent(helloDue({ member: A, online: true, sent: A }))
  t.ok(helloDue({ member: B, online: true, sent: A }))
  t.absent(helloDue({ member: null, online: true, sent: null }))
})

test('deviceMemberOf: passkey key when unlocked, own key without a passkey', (t) => {
  const base = { ready: true, termsOk: true }
  t.is(deviceMemberOf({ ...base, hasPasskey: true, status: { unlocked: true, publicKey: A.toUpperCase() }, ownKey: B }), A)
  t.is(deviceMemberOf({ ...base, hasPasskey: true, status: { unlocked: false, publicKey: A }, ownKey: B }), null, 'locked')
  t.is(deviceMemberOf({ ...base, hasPasskey: true, status: null, ownKey: B }), null)
  t.is(deviceMemberOf({ ...base, hasPasskey: false, status: null, ownKey: B }), B, 'core node: own key')
  t.is(deviceMemberOf({ ...base, hasPasskey: false, status: null, ownKey: null }), null)
  t.is(deviceMemberOf({ ...base, hasPasskey: false, status: null, ownKey: 'nope' }), null)
  t.is(deviceMemberOf({ ready: false, termsOk: true, hasPasskey: false, status: null, ownKey: B }), null)
  t.is(deviceMemberOf({ ready: true, termsOk: false, hasPasskey: false, status: null, ownKey: B }), null)
})

test('devicesRowShown: offered, unlocked when there is a passkey, never hosted', (t) => {
  t.ok(devicesRowShown({ offered: true, hasPasskey: true, unlocked: true }))
  t.absent(devicesRowShown({ offered: true, hasPasskey: true, unlocked: false }))
  t.ok(devicesRowShown({ offered: true, hasPasskey: false, unlocked: false }), 'core node, nothing to unlock')
  t.absent(devicesRowShown({ offered: false, hasPasskey: false, unlocked: false }))
  t.absent(devicesRowShown({ offered: null, hasPasskey: true, unlocked: true }))
})

test('shouldForceLock: only a resumed session of a disconnected device', (t) => {
  const on = { off: true, hasPasskey: true, unlocked: true, resumed: true }
  t.ok(shouldForceLock(on), 'kept session: lock')
  t.absent(shouldForceLock({ ...on, resumed: false }), 'passkey in this open: only the note')
  t.absent(shouldForceLock({ ...on, off: false }))
  t.absent(shouldForceLock({ ...on, hasPasskey: false }), 'core node: no lock')
  t.absent(shouldForceLock({ ...on, unlocked: false }), 'already locked: no loop')
})

test('shouldForceLock: a member that unlocked by passkey in this open is never locked again', (t) => {
  const on = { off: true, hasPasskey: true, unlocked: true, resumed: true }
  t.ok(shouldForceLock({ ...on, passkeyHere: false }))
  t.absent(shouldForceLock({ ...on, passkeyHere: true }), 'a later native reconnect reports resumed again')
})

test('notePasskeyUnlock: remembers a passkey unlock for the open, not a resume', (t) => {
  const seen = new Set()
  t.absent(notePasskeyUnlock(seen, { member: A, unlocked: true, resumed: true }), 'kept session')
  t.absent(notePasskeyUnlock(seen, { member: A, unlocked: false, resumed: false }), 'locked')
  t.absent(notePasskeyUnlock(seen, { member: null, unlocked: true, resumed: false }))
  t.ok(notePasskeyUnlock(seen, { member: A, unlocked: true, resumed: false }), 'passkey ceremony')
  t.ok(notePasskeyUnlock(seen, { member: A, unlocked: true, resumed: true }), 'stays for the open: resumed again after a reconnect')
  t.absent(notePasskeyUnlock(seen, { member: B, unlocked: true, resumed: true }), 'another member')
})

test('deviceStep: hello once, then one read when the member comes back', (t) => {
  t.is(deviceStep({ member: A, online: true, helloSent: null, readFor: null }), 'hello')
  t.is(deviceStep({ member: A, online: false, helloSent: null, readFor: null }), null, 'offline waits')
  t.is(deviceStep({ member: A, online: true, helloSent: A, readFor: A }), null, 'nothing more')
  t.is(deviceStep({ member: A, online: true, helloSent: A, readFor: null }), 'read', 'back after a lock')
  t.is(deviceStep({ member: null, online: true, helloSent: A, readFor: null }), null)
  t.is(deviceStep({ member: B, online: true, helloSent: A, readFor: A }), 'hello')
})

test('forced lock then passkey unlock: the read brings the off notice back', async (t) => {
  const store = createDeviceStore()
  const state = { helloSent: null, readFor: null }
  const reply = { devices: [{ id: A, name: 'X', since: null, on: false, writers: 0, self: true }], off: true }
  const calls = []
  const request = async (m) => { calls.push(m); return m === 'device.hello' ? { id: A, registered: false, off: true } : reply }
  // The shell's step for the current member, as App.js runs it.
  const run = async (member) => {
    store.bind(member)
    if (member === null) { state.readFor = null; return }
    const step = deviceStep({ member, online: true, helloSent: state.helloSent, readFor: state.readFor })
    if (step === 'hello') { state.helloSent = member; state.readFor = member; await sendHello({ request, store, name: 'x' }) } else if (step === 'read') { state.readFor = member; await readDevices({ request, store }) }
  }
  await run(A)
  t.ok(store.get().off, 'hello said off')
  store.forceLock()
  await run(null)
  t.ok(store.get().forced)
  t.absent(store.get().off, 'the lock wiped it')
  await run(A)
  t.ok(store.get().off, 'the read after the unlock restored it')
  t.absent(store.get().forced)
  t.alike(calls, ['device.hello', 'device.list'])
})

test('rowCaption and confirmCopy: disconnected rows, plural previous', (t) => {
  t.is(rowCaption({ on: false, since: '2026-11-01T10:00:00.000Z' }), DISCONNECTED_CAPTION)
  t.ok(rowCaption({ on: true, since: new Date(2026, 10, 5, 12).toISOString() }).startsWith('Conectado desde'))
  t.is(rowCaption({ on: true, since: null }), null)
  const one = confirmCopy(B)
  const many = confirmCopy('previous')
  t.is(one.title, 'Desconectar aparelho')
  t.is(many.title, 'Desconectar aparelhos anteriores')
  t.is(many.done, 'Aparelhos desconectados.')
  t.is(many.lines.length, 3)
  t.ok(many.lines[2].includes('Eles só voltam'))
})

test('deviceName: iPadOS reports a Mac user agent, touch points tell it apart', (t) => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  t.is(deviceName({ userAgent: mac, maxTouchPoints: 5 }), 'Safari no iPad')
  t.is(deviceName({ userAgent: mac, maxTouchPoints: 0 }), 'Safari no Mac')
  t.is(deviceName({ userAgent: mac }), 'Safari no Mac')
})
