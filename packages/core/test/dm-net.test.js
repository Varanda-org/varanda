'use strict'

// The anonymous 'varanda/dm/1' channel over two in-memory
// NoiseSecretStreams, each with the protomux that hypercore's replication
// stream installs (as notices-net.test.js). No DHT at all. The seeder's put()
// and page() are stand-ins over an in-memory list.
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const hcrypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { attachDm, validateDmMessage, MAX_BAD_DM, VISIT_PROTOCOL } = require('../lib/dm-net')
const {
  DM_PROTOCOL, DM_DROP_BYTES, DM_PAGE_MAX, DM_MAX_MESSAGE,
  buildInner, sealInner, encodeDrop, newDropId
} = require('../lib/dm')
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
  const ch = noise.userData.createChannel({ protocol: DM_PROTOCOL })
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

// Records every frame either side receives on the dm channel: the whole
// transcript of the channel, in clear.
function tap (noise, frames) {
  const mux = noise.userData
  const createChannel = mux.createChannel.bind(mux)
  mux.createChannel = (opts) => {
    const ch = createChannel(opts)
    if (ch === null || opts.protocol !== DM_PROTOCOL) return ch
    const addMessage = ch.addMessage.bind(ch)
    ch.addMessage = (mopts) => addMessage({
      ...mopts,
      onmessage: (buf, ...rest) => {
        frames.push(b4a.from(buf))
        return mopts.onmessage(buf, ...rest)
      }
    })
    return ch
  }
}

function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

// Never starts with 0xff, the byte fakePool refuses as invalid: a random first
// byte made about one run in twenty fail.
function fakeDrop () {
  const out = randomBytes(DM_DROP_BYTES)
  if (out[0] === 0xff) out[0] = 0
  return out
}

// A real drop: a signed message from a diary key, sealed to a box key. The
// stamp is random bytes (this channel never checks it).
function realDrop (diary, toHex) {
  const box = { publicKey: b4a.alloc(32), secretKey: b4a.alloc(32) }
  sodium.crypto_box_keypair(box.publicKey, box.secretKey)
  const inner = buildInner({ kind: 'msg', to: toHex, text: 'oi' }, diary)
  const sealed = sealInner(inner, b4a.toString(box.publicKey, 'hex'))
  return encodeDrop({ dropId: newDropId(), kid: randomBytes(8), rsaSig: randomBytes(256), token: randomBytes(32), sealed })
}

function fakePool () {
  const stored = []
  const calls = { put: 0, page: [] }
  return {
    stored,
    calls,
    put (bytes) {
      calls.put++
      const i = stored.findIndex((s) => b4a.equals(s, bytes))
      if (i !== -1) return { seq: i + 1, repeated: true }
      if (bytes[0] === 0xff) return null
      stored.push(b4a.from(bytes))
      return { seq: stored.length }
    },
    page ({ after, limit }) {
      calls.page.push({ after, limit })
      const items = []
      for (let s = after + 1; s <= stored.length && items.length < limit; s++) items.push({ seq: s, bytes: stored[s - 1] })
      const last = items.length ? items[items.length - 1].seq : after
      return { items, next: last < stored.length ? last : null, oldest: 1 }
    }
  }
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('put, ack, page, items; an identical put is a repeated success', async (t) => {
  const { a, b } = streams(t)
  const pool = fakePool()
  const hs = attachDm(a, { role: 'seeder', put: pool.put, page: pool.page })
  const hm = attachDm(b, { role: 'member' })
  t.is(await hs.supported, true)
  t.is(await hm.supported, true)

  const d1 = fakeDrop()
  d1[0] = 1
  const d2 = fakeDrop()
  d2[0] = 2
  t.alike(await hm.put(d1), { ok: true, reason: null })
  t.alike(await hm.put(d2), { ok: true, reason: null })
  t.alike(await hm.put(d1), { ok: true, reason: null }, 'repeated put is a success')
  t.is(pool.stored.length, 2)

  const bad = fakeDrop()
  bad[0] = 0xff
  t.alike(await hm.put(bad), { ok: false, reason: 'invalido' })

  const p = await hm.requestPage({ after: 0, limit: 1 })
  t.is(p.items.length, 1)
  t.is(p.items[0].seq, 1)
  t.ok(b4a.equals(p.items[0].bytes, d1))
  t.is(p.next, 1)
  t.is(p.oldest, 1)
  const p2 = await hm.requestPage({ after: p.next })
  t.is(p2.items.length, 1)
  t.ok(b4a.equals(p2.items[0].bytes, d2))
  t.is(p2.next, null)
  t.is(hs.badMessages + hm.badMessages, 0)
  await t.exception.all(hm.put(b4a.alloc(10)), /bytes/)
})

test('a page of DM_PAGE_MAX drops fits DM_MAX_MESSAGE and arrives intact', async (t) => {
  t.is(DM_PAGE_MAX, 8)
  const { a, b } = streams(t)
  const pool = fakePool()
  for (let i = 0; i < DM_PAGE_MAX + 2; i++) pool.stored.push(fakeDrop())
  const hs = attachDm(a, { role: 'seeder', put: pool.put, page: pool.page })
  const hm = attachDm(b, { role: 'member', maxBytes: DM_MAX_MESSAGE })
  const p = await hm.requestPage({ after: 0, limit: DM_PAGE_MAX })
  t.is(p.items.length, DM_PAGE_MAX)
  for (let i = 0; i < DM_PAGE_MAX; i++) {
    t.is(p.items[i].seq, i + 1)
    t.ok(b4a.equals(p.items[i].bytes, pool.stored[i]))
  }
  t.is(p.next, DM_PAGE_MAX)
  const json = JSON.stringify({ type: 'items', items: pool.stored.slice(0, DM_PAGE_MAX).map((d, i) => ({ seq: 2 ** 40 + i, drop: b4a.toString(d, 'base64') })), next: 2 ** 40, oldest: 2 ** 40 })
  t.ok(b4a.byteLength(json) < DM_MAX_MESSAGE, 'a full page with large seqs fits')
  t.is(hs.badMessages + hm.badMessages, 0)
})

test('the channel transcript never carries the diary key of the sender or the recipient', async (t) => {
  const { a, b } = streams(t)
  const frames = []
  tap(a, frames)
  tap(b, frames)
  const pool = fakePool()
  attachDm(a, { role: 'seeder', put: pool.put, page: pool.page })
  const hm = attachDm(b, { role: 'member' })
  const sender = hcrypto.keyPair()
  const recipient = hcrypto.keyPair()
  const drop = realDrop(sender, b4a.toString(recipient.publicKey, 'hex'))
  t.alike(await hm.put(drop), { ok: true, reason: null })
  const p = await hm.requestPage({})
  t.is(p.items.length, 1)
  t.ok(frames.length >= 2)
  const transcript = b4a.concat(frames)
  const text = b4a.toString(transcript, 'utf8')
  for (const kp of [sender, recipient]) {
    const keyHex = b4a.toString(kp.publicKey, 'hex')
    t.absent(text.includes(keyHex), 'no hex key')
    t.absent(text.includes(b4a.toString(kp.publicKey, 'base64').slice(0, 40)), 'no base64 key')
    t.is(b4a.indexOf(transcript, kp.publicKey), -1, 'no raw key')
    for (const f of frames) {
      if (f.byteLength < 100) continue
      const msg = JSON.parse(b4a.toString(f, 'utf8'))
      const drops = msg.type === 'put' ? [msg.drop] : msg.items.map((it) => it.drop)
      for (const d of drops) t.is(b4a.indexOf(b4a.from(d, 'base64'), kp.publicKey), -1, 'no raw key in the drop')
    }
  }
})

test('more than MAX_BAD_DM bad messages drop the peer', async (t) => {
  const { a, b } = streams(t)
  const pool = fakePool()
  const logged = []
  const hs = attachDm(a, { role: 'seeder', put: pool.put, page: pool.page, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await raw.opened
  raw.sendJson({ type: 'put', drop: 'AAAA' })
  raw.sendJson({ type: 'put', drop: b4a.toString(fakeDrop(), 'base64'), extra: 1 })
  raw.sendJson({ type: 'page', after: -1, limit: 1 })
  raw.sendJson({ type: 'page', after: 0, limit: DM_PAGE_MAX + 1 })
  raw.sendJson({ type: 'ack', ok: true, reason: null })
  await until(() => hs.badMessages === MAX_BAD_DM, { name: 'five bad messages' })
  await delay(50)
  t.absent(a.destroyed, 'five bad messages are tolerated')
  raw.sendRaw(b4a.from('not json'))
  await until(() => a.destroyed, { name: 'socket destroyed' })
  t.is(pool.calls.put, 0)
  t.is(pool.calls.page.length, 0)
  t.alike(logged, [{ event: 'peer-dropped', reason: 'dm' }])
})

test('a drop that is not the canonical base64 of DM_DROP_BYTES is bad', (t) => {
  const d = b4a.toString(fakeDrop(), 'base64')
  t.ok(validateDmMessage({ type: 'put', drop: d }))
  t.absent(validateDmMessage({ type: 'put', drop: b4a.toString(randomBytes(DM_DROP_BYTES - 1), 'base64') }))
  t.absent(validateDmMessage({ type: 'put', drop: d.slice(0, -1) + '-' }))
  t.absent(validateDmMessage({ type: 'put', drop: d + '=' }))
  t.absent(validateDmMessage({ type: 'ack', ok: true, reason: 'cheio' }))
  t.absent(validateDmMessage({ type: 'ack', ok: false, reason: null }))
  t.absent(validateDmMessage({ type: 'items', items: [{ seq: 2, drop: d }, { seq: 2, drop: d }], next: null, oldest: 1 }), 'seqs ascend strictly')
})

test('a second request while one is unanswered is bad', async (t) => {
  const { a, b } = streams(t)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const pool = fakePool()
  const hs = attachDm(a, {
    role: 'seeder',
    put: async (bytes) => { await gate; return pool.put(bytes) },
    page: pool.page
  })
  const raw = rawPeer(b)
  await raw.opened
  raw.sendJson({ type: 'put', drop: b4a.toString(fakeDrop(), 'base64') })
  raw.sendJson({ type: 'page', after: 0, limit: 1 })
  await until(() => hs.badMessages === 1, { name: 'second request is bad' })
  release()
  await until(() => raw.received.length === 1, { name: 'ack' })
  t.alike(raw.received[0], { type: 'ack', ok: true, reason: null })

  const hm = attachDm(streams(t).b, { role: 'member' })
  const first = hm.requestPage({})
  await t.exception(hm.requestPage({}), /in flight/)
  hm.close()
  await t.exception(first, /closed/)
})

for (const kind of ['put', 'page']) {
  const ask = (h) => kind === 'put' ? h.put(fakeDrop()) : h.requestPage({ after: 0, limit: 1 })

  test('one ' + kind + ' in flight per socket: a reopened channel waits, a late result never answers it', async (t) => {
    const { a, b } = streams(t)
    const pool = fakePool()
    let calls = 0
    let release
    const held = (fn) => (arg) => {
      calls++
      if (calls === 1) return new Promise((resolve) => { release = () => resolve(fn(arg)) })
      return fn(arg)
    }
    const hs = attachDm(a, { role: 'seeder', put: held(pool.put), page: held(pool.page) })
    const first = attachDm(b, { role: 'member' })
    const pending = ask(first)
    await until(() => calls === 1, { name: 'first request running' })
    first.close()
    await t.exception(pending, /closed/)

    const second = attachDm(b, { role: 'member', requestTimeoutMs: 1000 })
    t.is(await second.supported, true)
    let settled = null
    const during = ask(second).then((v) => { settled = v }, (e) => { settled = e })
    await until(() => hs.badMessages === 1, { name: 'second request refused' })
    t.is(calls, 1, 'the second request is not run while the first is held')

    release()
    await delay(100)
    t.is(settled, null, 'the first result never answers the new channel')
    await during
    t.ok(settled instanceof Error && /timed out/.test(settled.message))

    const third = attachDm(b, { role: 'member' })
    t.ok(await ask(third), 'the lock is released once the first request settles')
    t.is(calls, 2)
  })

  test('a ' + kind + ' that throws after a reopen closes only its own channel', async (t) => {
    const { a, b } = streams(t)
    const pool = fakePool()
    let calls = 0
    let fail
    const logged = []
    const held = (fn) => (arg) => {
      calls++
      if (calls === 1) return new Promise((resolve, reject) => { fail = reject })
      return fn(arg)
    }
    attachDm(a, { role: 'seeder', put: held(pool.put), page: held(pool.page), log: (e) => logged.push(e) })
    const first = attachDm(b, { role: 'member' })
    const pending = ask(first)
    await until(() => calls === 1, { name: 'first request running' })
    first.close()
    await t.exception(pending, /closed/)

    const second = attachDm(b, { role: 'member' })
    t.is(await second.supported, true)
    fail(new Error('disk'))
    await delay(100)
    t.alike(logged, [{ event: 'dm-' + kind + '-failed', reason: 'erro' }])
    t.ok(await ask(second), 'the newer channel stays open')
    t.is(calls, 2)
  })
}

test('pages over the page rate drop the peer; puts over their budget are answered ritmo', async (t) => {
  const { a, b } = streams(t)
  const pool = fakePool()
  const logged = []
  attachDm(a, { role: 'seeder', put: pool.put, page: pool.page, log: (e) => logged.push(e), pageBurst: 3, pageRate: 0.001, putBurst: 2, putRate: 0.001 })
  const hm = attachDm(b, { role: 'member' })
  t.alike(await hm.put(fakeDrop()), { ok: true, reason: null })
  t.alike(await hm.put(fakeDrop()), { ok: true, reason: null })
  t.alike(await hm.put(fakeDrop()), { ok: false, reason: 'ritmo' })
  t.is(pool.calls.put, 2)
  for (let i = 0; i < 3; i++) await hm.requestPage({})
  await t.exception(hm.requestPage({}), /closed|dropped/)
  await until(() => a.destroyed, { name: 'socket destroyed' })
  t.alike(logged, [{ event: 'peer-dropped', reason: 'dm-page-rate' }])
})

test('a seeder put() or page() that throws closes the channel, never answers ok', async (t) => {
  const { a, b } = streams(t)
  const logged = []
  attachDm(a, {
    role: 'seeder',
    put: () => { throw new Error('disk /secret/path') },
    page: () => { throw new Error('disk /secret/path') },
    log: (e) => logged.push(e)
  })
  const hm = attachDm(b, { role: 'member' })
  await t.exception(hm.put(fakeDrop()), /closed/)
  t.alike(logged[0], { event: 'dm-put-failed', reason: 'erro' }, 'a fixed reason, never the error text')
  const hm2 = attachDm(b, { role: 'member' })
  await t.exception(hm2.requestPage({ after: 0, limit: 1 }), /closed/)
  t.alike(logged.find((e) => e.event === 'dm-page-failed'), { event: 'dm-page-failed', reason: 'erro' })
  t.absent(JSON.stringify(logged).includes('secret'))
  await delay(20)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('member: an unsolicited reply is bad; a request timeout closes the channel only', async (t) => {
  const { a, b } = streams(t)
  const hm = attachDm(b, { role: 'member', requestTimeoutMs: 100 })
  const raw = rawPeer(a)
  await raw.opened
  raw.sendJson({ type: 'ack', ok: true, reason: null })
  await until(() => hm.badMessages === 1, { name: 'unsolicited ack' })
  await t.exception(hm.requestPage({ limit: 2 }), /timed out/)
  t.alike(raw.received[0], { type: 'page', after: 0, limit: 2 })
  await t.exception(hm.requestPage({}), /closed/)
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('member: items at or before the cursor, or more than asked, are bad', async (t) => {
  const { a, b } = streams(t)
  const hm = attachDm(b, { role: 'member', requestTimeoutMs: 1000 })
  const raw = rawPeer(a)
  await raw.opened
  const d = b4a.toString(fakeDrop(), 'base64')
  const p = hm.requestPage({ after: 5, limit: 1 })
  await until(() => raw.received.length === 1, { name: 'page' })
  raw.sendJson({ type: 'items', items: [{ seq: 5, drop: d }], next: null, oldest: 1 })
  raw.sendJson({ type: 'items', items: [{ seq: 6, drop: d }, { seq: 7, drop: d }], next: null, oldest: 1 })
  await until(() => hm.badMessages === 2, { name: 'two bad replies' })
  raw.sendJson({ type: 'items', items: [{ seq: 6, drop: d }], next: 6, oldest: 1 })
  const r = await p
  t.is(r.items[0].seq, 6)
})

test('a side that never opens the channel: supported false, the socket stays up', async (t) => {
  const { a, b } = streams(t)
  const pool = fakePool()
  const hs = attachDm(a, { role: 'seeder', put: pool.put, page: pool.page })
  t.is(await hs.supported, false)
  await delay(50)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('protocol: only the dm and the visit lanes; each lane keeps its own slot', async (t) => {
  const { a, b } = streams(t)
  const pool = fakePool()
  t.exception.all(() => attachDm(a, { role: 'member', protocol: 'varanda/other/1' }), /invalid protocol/)
  t.exception.all(() => attachDm(a, { role: 'member', protocol: 7 }), /invalid protocol/)
  const dm = attachDm(a, { role: 'seeder', put: pool.put, page: pool.page })
  const visit = attachDm(a, { role: 'seeder', protocol: VISIT_PROTOCOL, put: pool.put, page: pool.page })
  t.not(dm, visit)
  t.is(dm.protocol, DM_PROTOCOL)
  t.is(visit.protocol, VISIT_PROTOCOL)
  t.is(a._varandaDm, dm)
  t.is(a._varandaVisit, visit)
  const hm = attachDm(b, { role: 'member', protocol: VISIT_PROTOCOL })
  t.is(await hm.supported, true)
  t.is(await visit.supported, true)
})

test('a slot taken by the other lane is refused, never handed back', (t) => {
  const { a } = streams(t)
  const pool = fakePool()
  const dm = attachDm(a, { role: 'seeder', put: pool.put, page: pool.page })
  t.exception.all(() => attachDm(a, { role: 'member', protocol: VISIT_PROTOCOL, slot: '_varandaDm' }), /another protocol/,
    'a visit asked on the dm slot would land in the dm pool')
  t.is(a._varandaDm, dm, 'the dm handle stays')
  const visit = attachDm(a, { role: 'seeder', protocol: VISIT_PROTOCOL, put: pool.put, page: pool.page })
  t.exception.all(() => attachDm(a, { role: 'member', slot: '_varandaVisit' }), /another protocol/)
  t.is(attachDm(a, { role: 'seeder', put: pool.put, page: pool.page }), dm, 'the same lane on its slot is the same handle')
  t.is(attachDm(a, { role: 'seeder', protocol: VISIT_PROTOCOL, put: pool.put, page: pool.page }), visit)
})

test('the dm and visit lanes share one socket close listener and leave none behind', async (t) => {
  const { a } = streams(t)
  const pool = fakePool()
  const before = a.listenerCount('close')
  const dm = attachDm(a, { role: 'seeder', put: pool.put, page: pool.page })
  const visit = attachDm(a, { role: 'seeder', protocol: VISIT_PROTOCOL, put: pool.put, page: pool.page })
  t.is(a.listenerCount('close') - before, 1, 'one listener for both lanes')
  dm.close()
  t.is(a.listenerCount('close') - before, 1, 'the visit lane still listens')
  visit.close()
  t.is(a.listenerCount('close'), before, 'the last lane gone detaches it')
  const again = attachDm(a, { role: 'seeder', protocol: VISIT_PROTOCOL, put: pool.put, page: pool.page })
  const dm2 = attachDm(a, { role: 'seeder', put: pool.put, page: pool.page })
  t.is(a.listenerCount('close') - before, 1)
  a.destroy()
  await new Promise((resolve) => a.once('close', resolve))
  t.absent(a._varandaVisit, 'socket close ends the visit lane')
  t.absent(a._varandaDm, 'and the dm lane')
  t.is(again.protocol, VISIT_PROTOCOL)
  t.is(dm2.protocol, DM_PROTOCOL)
})
