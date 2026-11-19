'use strict'

const test = require('brittle')
const load = () => import('../src/pushDevice.js')
const record = { transport: 'apns', token: 'ab'.repeat(32), key: 'AAAAAAAAAAAAAAAAAAAAAA' }

test('device validators match the service and reject noncanonical keys', async (t) => {
  const p = await load()
  const contract = require('../../cli/lib/account/push-device-store')
  for (const transport of ['apns', 'fcm', null, 'web']) {
    t.is(p.validTransport(transport), contract.validTransport(transport))
    for (const token of [null, '', 'a', 'ab'.repeat(32), 'A'.repeat(64), 'a'.repeat(200), 'a'.repeat(201), 'a'.repeat(4096), 'a'.repeat(4097), 'a:b_-9', 'a/b', 'a\n']) {
      t.is(p.validToken(transport, token), contract.validToken(transport, token))
    }
  }
  for (const key of [null, '', record.key, record.key.slice(0, -1) + 'B', 'a'.repeat(22), 'a'.repeat(21) + 'w', record.key + '=']) {
    t.is(p.validKey(key), contract.validKey(key))
  }
  t.alike(p.deviceRecord(record), record)
  t.is(p.deviceRecord({ ...record, extra: true }), null)
  t.is(p.deviceRecord({ ...record, token: 'bad' }), null)
})

test('device key uses exactly sixteen injected random bytes', async (t) => {
  const { deviceKey } = await load()
  const bytes = Uint8Array.from({ length: 16 }, (_, i) => i * 17)
  t.is(deviceKey((n) => { t.is(n, 16); return bytes }), Buffer.from(bytes).toString('base64url'))
  t.exception(() => deviceKey(() => new Uint8Array(15)))
})

test('device states distinguish rotation, unknown check, removal and refusal', async (t) => {
  const { deviceState } = await load()
  t.is(deviceState(), 'off')
  t.is(deviceState({ record, token: record.token, registered: true }), 'on')
  t.is(deviceState({ record, token: 'cd'.repeat(32), registered: true }), 'needs-renewal')
  t.is(deviceState({ record, token: record.token, registered: false }), 'needs-renewal')
  t.is(deviceState({ record, token: null, registered: null }), 'on')
  t.is(deviceState({ record, token: record.token, registered: true, suspended: true }), 'off')
})

test('renewal permits one launch and each new token, never a failed request retry', async (t) => {
  const { createRenewal } = await load()
  const r = createRenewal()
  t.ok(r.take('launch', 'needs-renewal', 'one'))
  t.absent(r.take('launch', 'needs-renewal', 'one'))
  t.ok(r.take('token', 'needs-renewal', 'two'))
  t.absent(r.take('token', 'needs-renewal', 'two'))
  t.ok(r.take('token', 'needs-renewal', 'three'))
  r.refuse()
  t.absent(r.take('token', 'needs-renewal', 'four'))
  t.absent(r.take('launch', 'needs-renewal', 'four'))
  const next = createRenewal()
  t.absent(next.take('launch', 'on', 'one'))
  t.absent(next.take('launch', 'needs-renewal', 'one'))
  t.absent(createRenewal().take('launch', 'off', 'one'))
})

test('launch intents have the exact web destinations and no payload fields', async (t) => {
  const { deviceIntent } = await load()
  for (const kind of ['dm', 'dm-page']) t.alike(deviceIntent(kind), { kind })
  for (const kind of ['group', 'group-private']) t.alike(deviceIntent(kind), { kind: 'group' })
  for (const kind of [null, {}, 'grupo', 'unknown', { kind: 'dm', token: 'x' }]) t.is(deviceIntent(kind), null)
})

test('only a successful manual recovery resumes token renewal after failure', async (t) => {
  const { createNativePushStore, deviceState } = await load()
  const member = 'ab'.repeat(32)
  for (const recovered of [true, false]) {
    let stored = { ...record }
    let token = record.token
    let fail = true
    let registered = false
    let onToken
    const calls = []
    const client = {
      onToken (fn) { onToken = fn; return () => {} },
      async getPushState (who, changed = token) {
        return {
          support: 'ok',
          permission: 'granted',
          token: changed,
          subscribed: true,
          registered,
          deviceState: deviceState({ record: stored, token: changed, registered })
        }
      },
      async enablePush ({ token: changed = token, automatic }) {
        calls.push({ token: changed, automatic })
        if (fail) return { ok: false, reason: 'uncertain' }
        stored = { ...stored, token: changed }
        registered = true
        return { ok: true }
      }
    }
    const node = {}
    const push = createNativePushStore({ client, getNode: () => node })
    await push.read(member)
    t.is(calls.length, 1, 'launch renewal failed')
    await push.read(member)
    token = 'cd'.repeat(32)
    onToken(token)
    await push.read(member)
    t.is(calls.length, 1, 'reads and rotations never retry a failed mutation')
    fail = !recovered
    t.ok(push.toggle({ node, member }))
    await push.read(member)
    t.alike(calls[1], { token, automatic: false }, 'recovery requires an explicit tap')
    const saved = stored.token
    fail = false
    token = 'ef'.repeat(32)
    onToken(token)
    await push.read(member)
    if (recovered) {
      t.alike(calls[2], { token, automatic: true }, 'a new rotation renews after manual success')
      t.is(stored.token, token, 'the renewed token is stored')
      t.is(push.getSnapshot().state.deviceState, 'on')
    } else {
      t.is(calls.length, 2, 'manual failure keeps automatic renewal stopped')
      t.is(stored.token, saved, 'no token is stored after failure')
    }
    await push.read(member)
    onToken(token)
    await push.read(member)
    t.is(calls.length, recovered ? 3 : 2, 'neither reads nor duplicate tokens resend a request')
  }
})

for (const pendingAction of ['off', 'on']) {
  test('a suspended ' + pendingAction + ' repeats only on an explicit toggle', async (t) => {
    const { createNativePushStore } = await load()
    const { PUSH_UNCERTAIN } = await import('../src/push-state.js')
    const member = 'ab'.repeat(32)
    const calls = []
    const client = {
      onToken: () => () => {},
      getPushState: async () => ({
        support: 'ok',
        permission: 'granted',
        suspended: true,
        pendingAction,
        // The pending action must win even when switch fields are stale.
        subscribed: pendingAction === 'on',
        registered: pendingAction === 'on'
      }),
      enablePush: async () => { calls.push('on'); return { ok: false, reason: 'uncertain' } },
      disablePush: async () => { calls.push('off'); return { ok: false, reason: 'uncertain' } }
    }
    const node = {}
    const push = createNativePushStore({ client, getNode: () => node })
    await push.read(member)
    await push.read(member)
    t.alike(calls, [])
    t.is(push.getSnapshot().error, PUSH_UNCERTAIN)
    t.ok(push.toggle({ node, member }))
    await push.read(member)
    t.alike(calls, [pendingAction])
    t.is(push.getSnapshot().error, PUSH_UNCERTAIN)
  })
}
