import test from 'brittle'
import {
  CONFIRM_LINES, NAME_MAX, NO_NAME, UNNAMED_SELF, createDeviceStore, deviceName, disconnectLabel, disconnectParams, helloDue,
  otherLabel, readDevices, reconnectDevice, sendHello, shapeList, sinceDate, sinceText, unknownMethod
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
  for (const line of CONFIRM_LINES) t.absent(line.includes('—'))
})

test('createDeviceStore notifies on change only and resets', (t) => {
  const store = createDeviceStore()
  let calls = 0
  const off = store.subscribe(() => { calls++ })
  t.alike(store.get(), { offered: null, off: false, list: null })
  store.set({ offered: true })
  store.set({ offered: true })
  t.is(calls, 1)
  store.set({ off: true })
  store.reset()
  t.alike(store.get(), { offered: null, off: false, list: null })
  t.is(calls, 3)
  off()
  store.set({ offered: false })
  t.is(calls, 3)
})

test('readDevices records the answer; unknown method hides the entry', async (t) => {
  const store = createDeviceStore()
  const reply = { self: A, off: true, devices: [{ id: A, name: 'X', since: null, on: false, writers: 0, self: true }], previous: null }
  const view = await readDevices({ request: async (m) => { t.is(m, 'device.list'); return reply }, store })
  t.ok(view.off)
  t.alike(store.get(), { offered: true, off: true, list: reply })

  const hidden = createDeviceStore()
  hidden.set({ offered: true })
  await t.exception(readDevices({ request: async () => { throw new Error('método desconhecido') }, store: hidden }))
  t.is(hidden.get().offered, false)

  const kept = createDeviceStore()
  kept.set({ offered: true })
  await t.exception(readDevices({ request: async () => { throw new Error('sem conexão com o nó') }, store: kept }))
  t.is(kept.get().offered, true)
})

test('sendHello: one call, silent on failure, off recorded', async (t) => {
  const store = createDeviceStore()
  const calls = []
  const ok = await sendHello({ request: async (m, p) => { calls.push([m, p]); return { id: A, registered: true, off: true } }, store, name: 'Chrome no Mac' })
  t.ok(ok)
  t.alike(calls, [['device.hello', { name: 'Chrome no Mac' }]])
  t.alike(store.get(), { offered: true, off: true, list: null })

  const unknown = createDeviceStore()
  t.absent(await sendHello({ request: async () => { throw new Error('método desconhecido') }, store: unknown, name: 'x' }))
  t.is(unknown.get().offered, false)

  const other = createDeviceStore()
  let n = 0
  t.absent(await sendHello({ request: async () => { n++; throw new Error('erro') }, store: other, name: 'x' }))
  t.is(n, 1, 'no retry')
  t.is(other.get().offered, null)
})

test('reconnectDevice: one call, clears off and the list; failure rethrown', async (t) => {
  const store = createDeviceStore()
  store.set({ offered: true, off: true, list: { devices: [] } })
  const calls = []
  await reconnectDevice({ request: async (m, p) => { calls.push([m, p]) }, store, name: 'Safari no iPhone' })
  t.alike(calls, [['device.reconnect', { name: 'Safari no iPhone' }]])
  t.alike(store.get(), { offered: true, off: false, list: null })

  const failing = createDeviceStore()
  failing.set({ offered: true, off: true })
  let n = 0
  await t.exception(reconnectDevice({ request: async () => { n++; throw new Error('boom') }, store: failing, name: 'x' }))
  t.is(n, 1)
  t.ok(failing.get().off)
})

test('helloDue: once per member, never offline, never without a member', (t) => {
  t.ok(helloDue({ member: A, online: true, sent: null }))
  t.ok(helloDue({ member: A, online: undefined, sent: null }))
  t.absent(helloDue({ member: A, online: false, sent: null }))
  t.absent(helloDue({ member: A, online: true, sent: A }))
  t.ok(helloDue({ member: B, online: true, sent: A }))
  t.absent(helloDue({ member: null, online: true, sent: null }))
})
