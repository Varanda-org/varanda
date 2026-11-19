'use strict'

// The 'varanda/dm-notice/1' channel over two in-memory NoiseSecretStreams,
// each with the protomux that hypercore's replication stream installs (as
// dm-net.test.js). No DHT at all.
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const {
  attachDmNotice, validateNoticeMessage, DM_NOTICE_PROTOCOL, MAX_BAD_DM_NOTICE
} = require('../lib/dm-notice-net')
const { createNoticeWindow, sealDmNotice, openDmNotice, DM_NOTICE_BOX_BYTES } = require('../lib/dm-notice')
const { until } = require('./helpers/net')

function streams (t) {
  const a = new NoiseSecretStream(true)
  const b = new NoiseSecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  Hypercore.createProtocolStream(a)
  Hypercore.createProtocolStream(b)
  t.teardown(() => {
    a.destroy()
    b.destroy()
  }, { force: true })
  return { a, b }
}

function rawPeer (noise) {
  const received = []
  const ch = noise.userData.createChannel({ protocol: DM_NOTICE_PROTOCOL })
  const m = ch.addMessage({
    encoding: c.buffer,
    onmessage: (buf) => received.push(JSON.parse(b4a.toString(buf, 'utf8')))
  })
  ch.open()
  return {
    received,
    opened: ch.fullyOpened(),
    get closed () { return ch.closed },
    sendJson: (o) => m.send(b4a.from(JSON.stringify(o), 'utf8')),
    sendRaw: (buf) => m.send(buf)
  }
}

function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

function boxKeyPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(32)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function seeder (t, a, windowOpts) {
  const window = createNoticeWindow(windowOpts)
  const woken = []
  const hs = attachDmNotice(a, { role: 'seeder', window, onWake: (box) => woken.push(box) })
  return { hs, window, woken }
}

test('a wake for a stored drop: one onWake with the same box, and an ack', async (t) => {
  const { a, b } = streams(t)
  const { hs, window, woken } = seeder(t, a)
  const hm = attachDmNotice(b, { role: 'member' })
  t.is(await hs.supported, true)
  t.is(await hm.supported, true)

  const service = boxKeyPair()
  const recipient = b4a.toString(randomBytes(32), 'hex')
  const box = sealDmNotice(recipient, service.publicKey)
  const dropId = randomBytes(32)
  window.add(dropId)

  t.is(await hm.notice(dropId, box), true)
  await until(() => woken.length === 1, { name: 'one wake' })
  t.alike(woken[0], box)
  t.is(openDmNotice(woken[0], service), recipient)
  t.is(hs.badMessages, 0)
  t.is(hm.badMessages, 0)
})

test('an unknown, expired or repeated id is acked and wakes nobody', async (t) => {
  const { a, b } = streams(t)
  let now = 0
  const { window, woken } = seeder(t, a, { ttlMs: 1000, now: () => now })
  const hm = attachDmNotice(b, { role: 'member' })
  const box = sealDmNotice(randomBytes(32), boxKeyPair().publicKey)

  t.is(await hm.notice(randomBytes(32), box), true, 'unknown id acked')

  const expired = b4a.toString(randomBytes(32), 'hex')
  window.add(expired)
  now += 1000
  t.is(await hm.notice(expired, box), true, 'expired id acked')

  now += 1
  const once = randomBytes(32)
  window.add(once)
  t.is(await hm.notice(once, box), true)
  t.is(await hm.notice(once, box), true, 'the second wake of an id is acked')
  await delay(50)
  t.is(woken.length, 1, 'only the first wake of the one live id')
})

test('a malformed wake wakes nobody, is counted, and closes the channel past the cap', async (t) => {
  const { a, b } = streams(t)
  const { hs, window, woken } = seeder(t, a)
  const raw = rawPeer(b)
  await raw.opened
  const id = b4a.toString(randomBytes(32), 'hex')
  window.add(id)
  const box = b4a.toString(randomBytes(DM_NOTICE_BOX_BYTES), 'base64')

  raw.sendJson({ type: 'wake', id, box, extra: 1 })
  raw.sendJson({ type: 'wake', id, box: b4a.toString(randomBytes(DM_NOTICE_BOX_BYTES - 1), 'base64') })
  raw.sendJson({ type: 'wake', id, box: b4a.toString(randomBytes(DM_NOTICE_BOX_BYTES + 1), 'base64') })
  raw.sendJson({ type: 'ack' })
  raw.sendJson({ type: 'wake', id: id.toUpperCase(), box })
  await until(() => hs.badMessages === MAX_BAD_DM_NOTICE, { name: 'five bad messages' })
  await delay(50)
  t.absent(raw.closed, 'five bad messages are tolerated')
  t.is(raw.received.length, 0, 'no ack for a bad frame')
  raw.sendJson({ type: 'wake', id })
  await until(() => raw.closed, { name: 'channel closed' })
  t.is(woken.length, 0)
  t.is(window.take(id), true, 'the id was never spent')
  t.absent(a.destroyed, 'the socket stays up')
  t.absent(b.destroyed)

  const again = rawPeer(b)
  await until(() => again.closed, { name: 'a reopen is refused' })
})

test('the seeder never answers more than an ack', async (t) => {
  const { a, b } = streams(t)
  const { window } = seeder(t, a)
  const raw = rawPeer(b)
  await raw.opened
  const id = b4a.toString(randomBytes(32), 'hex')
  window.add(id)
  const box = b4a.toString(randomBytes(DM_NOTICE_BOX_BYTES), 'base64')
  raw.sendJson({ type: 'wake', id, box })
  raw.sendJson({ type: 'wake', id: b4a.toString(randomBytes(32), 'hex'), box })
  await until(() => raw.received.length === 2, { name: 'two acks' })
  t.alike(raw.received, [{ type: 'ack' }, { type: 'ack' }])
})

test('an onWake that throws or rejects is swallowed', async (t) => {
  const { a, b } = streams(t)
  const window = createNoticeWindow()
  let calls = 0
  attachDmNotice(a, {
    role: 'seeder',
    window,
    onWake: (box) => {
      calls++
      if (calls === 1) throw new Error('boom')
      return Promise.reject(new Error('boom'))
    }
  })
  const hm = attachDmNotice(b, { role: 'member' })
  const box = sealDmNotice(randomBytes(32), boxKeyPair().publicKey)
  const one = randomBytes(32)
  const two = randomBytes(32)
  window.add(one)
  window.add(two)
  t.is(await hm.notice(one, box), true)
  t.is(await hm.notice(two, box), true)
  t.is(calls, 2)
})

test('member: a seeder without the channel resolves false at once', async (t) => {
  const { b } = streams(t)
  const hm = attachDmNotice(b, { role: 'member' })
  const box = sealDmNotice(randomBytes(32), boxKeyPair().publicKey)
  const started = Date.now()
  t.is(await hm.notice(randomBytes(32), box, { timeoutMs: 5000 }), false)
  t.ok(Date.now() - started < 2000, 'well before the timeout')
  t.is(await hm.supported, false)
  t.is(await hm.notice(randomBytes(32), box), false, 'a later notice too')
})

test('member: no ack within the timeout resolves false and closes the channel', async (t) => {
  const { a, b } = streams(t)
  const raw = rawPeer(a)
  const hm = attachDmNotice(b, { role: 'member' })
  await raw.opened
  const box = sealDmNotice(randomBytes(32), boxKeyPair().publicKey)
  t.is(await hm.notice(randomBytes(32), box, { timeoutMs: 100 }), false)
  await until(() => raw.received.length === 1, { name: 'the wake arrived' })
  t.is(raw.received[0].type, 'wake')
  await until(() => raw.closed, { name: 'channel closed' })
  raw.sendJson({ type: 'ack' })
  t.is(await hm.notice(randomBytes(32), box), false, 'the channel is done')
  t.is(raw.received.length, 1, 'never repeated')
})

test('member: an ack nobody waits for and any other reply are bad', async (t) => {
  const { a, b } = streams(t)
  const raw = rawPeer(a)
  const hm = attachDmNotice(b, { role: 'member', maxBad: 1 })
  await raw.opened
  raw.sendJson({ type: 'ack' })
  await until(() => hm.badMessages === 1, { name: 'unsolicited ack' })
  t.absent(raw.closed)
  raw.sendJson({ type: 'ack', ok: true })
  await until(() => raw.closed, { name: 'closed past the cap' })
  t.is(hm.badMessages, 2)
})

test('member: bad input resolves false, never throws', async (t) => {
  const { a, b } = streams(t)
  seeder(t, a)
  const hm = attachDmNotice(b, { role: 'member' })
  const box = sealDmNotice(randomBytes(32), boxKeyPair().publicKey)
  t.is(await hm.notice('nope', box), false)
  t.is(await hm.notice(randomBytes(31), box), false)
  t.is(await hm.notice(randomBytes(32), box.subarray(1)), false)
  t.is(await hm.notice(randomBytes(32), box, null), true, 'null options take the default timeout')
  t.is(await hm.notice(randomBytes(32), box, { timeoutMs: 0 }), false)
})

test('validateNoticeMessage: exact keys and canonical sizes', (t) => {
  const id = b4a.toString(randomBytes(32), 'hex')
  const box = b4a.toString(randomBytes(DM_NOTICE_BOX_BYTES), 'base64')
  t.ok(validateNoticeMessage({ type: 'wake', id, box }))
  t.ok(validateNoticeMessage({ type: 'ack' }))
  t.absent(validateNoticeMessage({ type: 'wake', id, box, x: 1 }))
  t.absent(validateNoticeMessage({ type: 'wake', id }))
  t.absent(validateNoticeMessage({ type: 'wake', id: id.slice(2), box }))
  t.absent(validateNoticeMessage({ type: 'wake', id: id.toUpperCase(), box }))
  t.absent(validateNoticeMessage({ type: 'wake', id, box: box.slice(0, -1) + '-' }))
  t.absent(validateNoticeMessage({ type: 'wake', id, box: box + '=' }))
  t.absent(validateNoticeMessage({ type: 'ack', ok: true }))
  t.absent(validateNoticeMessage({ type: 'nack' }))
  t.absent(validateNoticeMessage([]))
  t.absent(validateNoticeMessage(null))
})

test('options: role, window and onWake are checked; one handle per socket', (t) => {
  const { a } = streams(t)
  t.exception.all(() => attachDmNotice(a, { role: 'x' }), TypeError)
  t.exception.all(() => attachDmNotice(a, { role: 'seeder', onWake: () => {} }), TypeError)
  t.exception.all(() => attachDmNotice(a, { role: 'seeder', window: createNoticeWindow() }), TypeError)
  const h = attachDmNotice(a, { role: 'seeder', window: createNoticeWindow(), onWake: () => {} })
  t.is(attachDmNotice(a, { role: 'seeder', window: createNoticeWindow(), onWake: () => {} }), h)
  t.exception.all(() => attachDmNotice(a, { role: 'member' }), TypeError)
})
