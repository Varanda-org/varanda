'use strict'

// The 'varanda/blocklist/1' channel over two in-memory NoiseSecretStreams,
// each with the protomux that hypercore's replication stream installs (as
// the admission tests do). Snapshots are stand-ins: the module never reads
// anything but moderatorDate, seq and the signature prefix a have carries,
// and verification is the injected offer.
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const c = require('compact-encoding')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { attachAdmission } = require('../lib/admission')
const {
  PROTOCOL,
  MAX_RETRY_DELAY_MS,
  MESSAGE_BURST,
  MESSAGE_RATE,
  MAX_HAVE_BYTES,
  SIG_HEX_LENGTH,
  attachBlocklist,
  validateBlocklistMessage,
  compareHave,
  haveOf
} = require('../lib/blocklist-net')
const { until } = require('./helpers/net')

const coreRoot = path.join(__dirname, '..')
const D1 = '2026-01-01T00:00:00.000Z'
const D2 = '2026-06-01T00:00:00.000Z'
const SIG_A = '0123456789abcdef'.repeat(2)
const SIG_B = 'fedcba9876543210'.repeat(2)

function snap (moderatorDate, seq, extra = {}) {
  return { v: 1, seq, moderatorDate, blocked: [], ...extra }
}

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

// Like streams(), with the a -> b direction able to hold everything a sends
// (a suspended receiver, or the network buffering) and release it at once.
function pausableStreams (t) {
  const a = new NoiseSecretStream(true)
  const b = new NoiseSecretStream(false)
  let held = null
  a.rawStream.on('data', (d) => {
    if (held !== null) held.push(d)
    else b.rawStream.write(d)
  })
  b.rawStream.on('data', (d) => a.rawStream.write(d))
  Hypercore.createProtocolStream(a)
  Hypercore.createProtocolStream(b)
  t.teardown(() => {
    a.destroy()
    b.destroy()
  }, { force: true })
  return {
    a,
    b,
    pause: () => { held = [] },
    resume: () => {
      const q = held
      held = null
      for (const d of q) b.rawStream.write(d)
    }
  }
}

// An offer that waits for release() before deciding (a slow write queue).
function gated (offer) {
  let open = false
  const waiting = []
  return {
    offer: async (next) => {
      if (!open) await new Promise((resolve) => waiting.push(resolve))
      return offer(next)
    },
    release: () => {
      open = true
      for (const r of waiting.splice(0)) r()
    }
  }
}

// Mimics createBlocklistState(...).offer with the same ordering rule; a
// snapshot carrying `bad` is refused as an invalid signature.
function fakeState (initial = null) {
  let snapshot = initial
  const offers = []
  const saved = []
  return {
    offers,
    saved,
    current: () => snapshot,
    offer: async (next) => {
      offers.push(next)
      if (next.bad) return { adopted: false, reason: 'bad-signature' }
      if (snapshot !== null) {
        const cmp = compareHave(haveOf(next), haveOf(snapshot))
        if (cmp === 0) return { adopted: false, reason: 'same' }
        if (cmp < 0) return { adopted: false, reason: 'stale' }
      }
      saved.push(next)
      snapshot = next
      return { adopted: true, reason: null }
    }
  }
}

// A hand-driven peer on the blocklist protocol.
function rawPeer (noise) {
  const received = []
  const ch = noise.userData.createChannel({ protocol: PROTOCOL })
  const m = ch.addMessage({
    encoding: c.buffer,
    onmessage: (buf) => received.push(JSON.parse(b4a.toString(buf, 'utf8')))
  })
  ch.open()
  return {
    received,
    opened: ch.fullyOpened(),
    sendJson: (o) => m.send(b4a.from(JSON.stringify(o), 'utf8')),
    sendRaw: (buf) => m.send(buf)
  }
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('message validation and ordering key', (t) => {
  t.ok(validateBlocklistMessage({ type: 'have', moderatorDate: '', seq: 0, sig: '' }))
  t.ok(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 3, sig: '' }))
  t.ok(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 3, sig: SIG_A }))
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: -1, sig: '' }))
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 1.5, sig: '' }))
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: '2026-01-01', seq: 1, sig: '' }))
  t.absent(validateBlocklistMessage({ type: 'have', seq: 1, sig: '' }))
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 1, sig: '', x: 1 }))
  // sig: required, '' or exactly 32 lowercase hex characters, and '' when
  // there is no snapshot (moderatorDate '').
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 1 }), 'sig missing')
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 1, sig: SIG_A.slice(0, 31) }), 'sig too short')
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 1, sig: SIG_A + 'a' }), 'sig too long')
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 1, sig: SIG_A.toUpperCase() }), 'sig uppercase')
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 1, sig: 'g'.repeat(32) }), 'sig not hex')
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: D1, seq: 1, sig: null }), 'sig not a string')
  t.absent(validateBlocklistMessage({ type: 'have', moderatorDate: '', seq: 0, sig: SIG_A }), 'sig without a snapshot')
  t.ok(validateBlocklistMessage({ type: 'snapshot', snapshot: {} }))
  t.absent(validateBlocklistMessage({ type: 'snapshot', snapshot: [] }))
  t.absent(validateBlocklistMessage({ type: 'snapshot', snapshot: null }))
  t.absent(validateBlocklistMessage({ type: 'other' }))
  t.absent(validateBlocklistMessage(null))

  t.is(compareHave({ moderatorDate: '', seq: 0 }, { moderatorDate: D1, seq: 1 }), -1)
  t.is(compareHave({ moderatorDate: D1, seq: 2 }, { moderatorDate: D1, seq: 1 }), 1)
  t.is(compareHave({ moderatorDate: D1, seq: 1 }, { moderatorDate: D1, seq: 1 }), 0)
  // A newer moderator's seq 1 beats the older moderator's seq 100.
  t.is(compareHave({ moderatorDate: D2, seq: 1 }, { moderatorDate: D1, seq: 100 }), 1)
  // sig takes no part in the order.
  t.is(compareHave({ moderatorDate: D1, seq: 1, sig: SIG_A }, { moderatorDate: D1, seq: 1, sig: SIG_B }), 0)
  t.alike(haveOf(null), { moderatorDate: '', seq: 0, sig: '' })
  t.alike(haveOf(snap(D1, 3, { signature: SIG_A + SIG_B + SIG_A + SIG_B })), { moderatorDate: D1, seq: 3, sig: SIG_A })
  t.alike(haveOf(snap(D1, 3)), { moderatorDate: D1, seq: 3, sig: '' }, 'no signature: empty sig')
  t.alike(haveOf(snap(D1, 3, { signature: 'XYZ' })), { moderatorDate: D1, seq: 3, sig: '' }, 'malformed signature: empty sig')
  t.is(MAX_RETRY_DELAY_MS, 300000)
  t.is(MESSAGE_BURST, 512)
  t.is(MESSAGE_RATE, 2)
  t.is(MAX_HAVE_BYTES, 256)
  t.is(SIG_HEX_LENGTH, 32)
  // Our own largest have (extended-year date, MAX_SAFE_INTEGER, a 32-hex
  // sig) is under the bound.
  for (const moderatorDate of [D1, '+275760-09-13T00:00:00.000Z']) {
    const have = { type: 'have', moderatorDate, seq: Number.MAX_SAFE_INTEGER, sig: 'f'.repeat(SIG_HEX_LENGTH) }
    t.ok(validateBlocklistMessage(have))
    t.ok(b4a.byteLength(JSON.stringify(have)) < MAX_HAVE_BYTES, 'own have fits: ' + moderatorDate)
  }
})

test('a newer snapshot is delivered once and persisted; the older side sends nothing', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 2))
  const sb = fakeState(snap(D1, 1))
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer })
  const hb = attachBlocklist(b, { current: sb.current, offer: sb.offer })

  t.is(await ha.supported, true)
  t.is(await hb.supported, true)
  await until(() => sb.saved.length === 1, { name: 'snapshot persisted' })
  t.is(sb.saved[0].seq, 2)
  // The receiver acknowledges with its new key.
  await until(() => ha.remoteHave && ha.remoteHave.seq === 2, { name: 'have after adoption' })

  // Re-announcing never resends the same key to the same peer.
  t.ok(ha.announce())
  t.ok(hb.announce())
  await delay(200)
  t.is(sb.offers.length, 1, 'delivered once')
  t.is(sa.offers.length, 0, 'the older side never sent its snapshot')
  t.is(ha.badMessages + hb.badMessages, 0)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('a newer moderator travels toward a holder of the older moderator at a higher seq', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D2, 1))
  const sb = fakeState(snap(D1, 100))
  attachBlocklist(a, { current: sa.current, offer: sa.offer })
  attachBlocklist(b, { current: sb.current, offer: sb.offer })
  await until(() => sb.saved.length === 1, { name: 'newer moderator adopted' })
  t.alike(haveOf(sb.current()), { moderatorDate: D2, seq: 1, sig: '' })
  t.is(sa.offers.length, 0)
})

test('announce pushes a snapshot adopted later to a peer that holds an older one', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 1))
  const sb = fakeState(snap(D1, 1))
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 0 })
  attachBlocklist(b, { current: sb.current, offer: sb.offer, minIntervalMs: 0 })
  await until(() => ha.remoteHave !== null, { name: 'have exchanged' })
  await delay(100)
  t.is(sb.offers.length, 0, 'equal keys: nothing sent')

  // A adopts seq 2 elsewhere (another connection) and fans out.
  await sa.offer(snap(D1, 2))
  ha.announce()
  await until(() => sb.saved.length === 1, { name: 'fan-out delivered' })
  t.is(sb.saved[0].seq, 2)
})

test('a lower or equal snapshot is ignored and stale never counts', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 5))
  const logged = []
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 0, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  t.is(await raw.opened, true)
  t.is(await ha.supported, true)

  // Our have arrives at once; an equal have triggers no snapshot.
  raw.sendJson({ type: 'have', moderatorDate: D1, seq: 5, sig: '' })
  await until(() => raw.received.length >= 1, { name: 'have received' })
  t.alike(raw.received[0], { type: 'have', moderatorDate: D1, seq: 5, sig: '' })

  // One at a time, each against the credit of the have that answers the
  // previous verdict.
  for (let i = 1; i <= 10; i++) {
    raw.sendJson({ type: 'snapshot', snapshot: snap(D1, (i % 5) + 1) })
    await until(() => sa.offers.length === i && raw.received.length === i + 1, { name: 'verdict ' + i })
  }
  await delay(100)
  t.is(sa.saved.length, 0, 'nothing older or equal adopted')
  t.is(ha.badMessages, 0, "'stale' and 'same' never count")
  t.is(logged.length, 0)
  t.absent(a.destroyed)
  t.is(raw.received.length, 11, 'one have per verdict, no snapshot')
  t.ok(raw.received.every((m) => m.type === 'have' && m.seq === 5), 'each have carries our real key')
})

test('a lower have from the peer gets our snapshot once', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 3))
  attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 0 })
  const raw = rawPeer(b)
  await raw.opened
  raw.sendJson({ type: 'have', moderatorDate: '', seq: 0, sig: '' })
  raw.sendJson({ type: 'have', moderatorDate: D1, seq: 1, sig: '' })
  await until(() => raw.received.some((m) => m.type === 'snapshot'), { name: 'snapshot sent' })
  await delay(100)
  const snaps = raw.received.filter((m) => m.type === 'snapshot')
  t.is(snaps.length, 1)
  t.alike(snaps[0].snapshot, snap(D1, 3))
})

test('the 5th bad message destroys the socket', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 5))
  const logged = []
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 0, maxBytes: 1024, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await raw.opened
  await ha.supported

  raw.sendRaw(b4a.from('{not json', 'utf8'))
  raw.sendJson({ type: 'unknown' })
  raw.sendJson({ type: 'have', moderatorDate: D1, seq: -1, sig: '' })
  raw.sendJson({ type: 'snapshot', snapshot: snap(D1, 9, { bad: true }) })
  await until(() => ha.badMessages === 4, { name: 'four bad messages' })
  await delay(50)
  t.absent(a.destroyed, 'four bad messages are tolerated')
  t.is(logged.length, 0)

  // Oversized (checked on the raw buffer before parsing).
  raw.sendRaw(b4a.alloc(2048, 0x20))
  await until(() => a.destroyed, { name: 'socket destroyed' })
  t.is(ha.badMessages, 5)
  t.alike(logged, [{ event: 'peer-dropped', peerKey: ha.peerKey, reason: 'blocklist' }])
})

test('a credited snapshot that arrives early is held for the interval, not counted', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 1))
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 300 })
  const raw = rawPeer(b)
  await raw.opened
  // Spends the credit of our have on open, then the one of the have that
  // acknowledges the adoption, at once.
  raw.sendJson({ type: 'snapshot', snapshot: snap(D1, 2) })
  await until(() => raw.received.some((m) => m.type === 'have' && m.seq === 2), { name: 'first adopted' })
  const firstAt = Date.now()
  raw.sendJson({ type: 'snapshot', snapshot: snap(D1, 3) })
  await delay(100)
  t.is(sa.offers.length, 1, 'the second is held, not offered early')
  await until(() => sa.saved.length === 2, { name: 'second adopted' })
  t.ok(Date.now() - firstAt >= 250, 'held for the interval')
  t.is(sa.saved[1].seq, 3)
  t.is(ha.badMessages, 0, 'an early credited snapshot is not bad')
  t.absent(a.destroyed)
})

test('seven publishes bunched after a suspension: the receiver ends on the newest, no strike', async (t) => {
  const { a, b, pause, resume } = pausableStreams(t)
  const sa = fakeState(snap(D1, 1))
  const sb = fakeState(snap(D1, 1))
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 50 })
  const hb = attachBlocklist(b, { current: sb.current, offer: sb.offer, minIntervalMs: 50 })
  await until(() => ha.remoteHave !== null && hb.remoteHave !== null, { name: 'have exchanged' })

  // The receiver is suspended while the moderator side adopts seven
  // snapshots in a row, spaced as an honest sender spaces them, announcing
  // each one; everything it sends meanwhile is delivered at once afterwards.
  pause()
  for (let seq = 2; seq <= 8; seq++) {
    await sa.offer(snap(D1, seq))
    ha.announce()
    await delay(80)
  }
  resume()

  await until(() => haveOf(sb.current()).seq === 8, { name: 'newest adopted' })
  await delay(200)
  t.is(sb.current().seq, 8)
  t.alike(sb.offers.map((s) => s.seq), [2, 8], 'one snapshot per credit: the first, then the newest')
  t.is(hb.badMessages, 0)
  t.is(ha.badMessages, 0)
  t.absent(a.destroyed)
  t.absent(b.destroyed)
})

test('a snapshot sent without credit is a strike and is never offered', async (t) => {
  const { a, b } = streams(t)
  const inner = fakeState(snap(D1, 1))
  const gate = gated(inner.offer)
  const ha = attachBlocklist(a, { current: inner.current, offer: gate.offer, minIntervalMs: 0 })
  const raw = rawPeer(b)
  await raw.opened
  await until(() => raw.received.length === 1, { name: 'have on open' })

  // One credit (our have on open): the first is accepted and offered (the
  // offer waits on the gate, so no have answers it); the second was never
  // asked for.
  raw.sendJson({ type: 'snapshot', snapshot: snap(D1, 2) })
  raw.sendJson({ type: 'snapshot', snapshot: snap(D1, 3) })
  await until(() => ha.badMessages === 1, { name: 'strike' })
  t.is(inner.offers.length, 0, 'the credited one waits on the gate')
  gate.release()
  await until(() => inner.saved.length === 1, { name: 'credited adopted' })
  await delay(100)
  t.alike(inner.offers.map((s) => s.seq), [2], 'the uncredited snapshot is never offered')
  t.is(ha.badMessages, 1)
  t.absent(a.destroyed)
})

for (const [label, elsewhere] of [['same', 2], ['stale', 3]]) {
  test(`a '${label}' verdict sends a have and the honest sender then sends its newer snapshot`, async (t) => {
    const { a, b } = streams(t)
    const sa = fakeState(snap(D1, 2))
    const inner = fakeState(snap(D1, 1))
    const gate = gated(inner.offer)
    const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 50 })
    const hb = attachBlocklist(b, { current: inner.current, offer: gate.offer, minIntervalMs: 50 })
    // A sends seq 2 against B's have on open; B's offer waits on the gate.
    await until(() => hb.remoteHave !== null && hb.remoteHave.seq === 2, { name: 'have exchanged' })
    await delay(100)

    // Meanwhile B adopts `elsewhere` on another connection (no announce),
    // and A adopts seq 4: A has spent its credit, so only its have goes out.
    await inner.offer(snap(D1, elsewhere))
    await sa.offer(snap(D1, 4))
    ha.announce()
    await until(() => hb.remoteHave.seq === 4, { name: 'A announces seq 4' })
    t.is(inner.saved.length, 1, 'nothing newer reached B yet')

    gate.release()
    await until(() => inner.current().seq === 4, { name: 'newer snapshot adopted' })
    t.alike(inner.offers.map((s) => s.seq), [elsewhere, 2, 4])
    t.is(ha.badMessages + hb.badMessages, 0)
    t.absent(a.destroyed)
  })
}

test('a flood of valid haves beyond the bucket drops the peer; a burst under it does not', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 5))
  const logged = []
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 0, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await raw.opened

  const have = { type: 'have', moderatorDate: D1, seq: 5, sig: '' }
  for (let i = 0; i < MESSAGE_BURST - 4; i++) raw.sendJson(have)
  await until(() => ha.remoteHave !== null, { name: 'haves received' })
  await delay(150)
  t.absent(a.destroyed, 'a burst under the bucket is fine')
  t.is(ha.badMessages, 0)
  t.is(logged.length, 0)

  for (let i = 0; i < 20; i++) raw.sendJson(have)
  await until(() => a.destroyed, { name: 'flooding peer dropped' })
  t.alike(logged, [{ event: 'peer-dropped', peerKey: ha.peerKey, reason: 'message-rate' }])
  t.is(ha.badMessages, 0, 'valid haves are not bad, only too many')
})

test('a whitespace-padded valid have over MAX_HAVE_BYTES counts as bad and grants nothing', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 5))
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 0 })
  const raw = rawPeer(b)
  await raw.opened
  const padded = '{"type":"have",' + ' '.repeat(MAX_HAVE_BYTES) + '"moderatorDate":"","seq":0,"sig":""}'
  t.ok(validateBlocklistMessage(JSON.parse(padded)), 'the padded have is valid JSON and shape')
  raw.sendRaw(b4a.from(padded, 'utf8'))
  await until(() => ha.badMessages === 1, { name: 'padded have counted' })
  await delay(100)
  t.is(ha.remoteHave, null, 'ignored')
  t.absent(raw.received.some((m) => m.type === 'snapshot'), 'no snapshot sent against it')
  t.absent(a.destroyed)
})

test('a failing offer is retried after the backoff and never counts as bad', async (t) => {
  const { a, b } = streams(t)
  const inner = fakeState(snap(D1, 1))
  const logged = []
  const calls = []
  let failures = 1
  const offer = async (next) => {
    calls.push(Date.now())
    if (failures > 0) {
      failures--
      throw new Error('storage unavailable')
    }
    return inner.offer(next)
  }
  const ha = attachBlocklist(a, { current: inner.current, offer, minIntervalMs: 300, log: (e) => logged.push(e) })
  const raw = rawPeer(b)
  await raw.opened
  raw.sendJson({ type: 'snapshot', snapshot: snap(D1, 2) })
  await until(() => calls.length === 1, { name: 'first offer' })
  await delay(100)
  t.is(calls.length, 1, 'not retried at once')
  await until(() => inner.saved.length === 1, { name: 'adopted on the retry' })
  t.is(calls.length, 2)
  t.ok(calls[1] - calls[0] >= 250, 'retried after the backoff')
  t.is(inner.saved[0].seq, 2)
  t.is(ha.badMessages, 0, 'a local failure is not the peer\'s fault')
  t.alike(logged, [{ event: 'blocklist-offer-failed', peerKey: ha.peerKey }])
  // The receiver acknowledges the adoption with its new key.
  await until(() => raw.received.some((m) => m.type === 'have' && m.seq === 2), { name: 'have after retry' })
  t.absent(a.destroyed)
})

test('close drops a held snapshot: no offer after close', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 1))
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 200 })
  const raw = rawPeer(b)
  await raw.opened
  raw.sendJson({ type: 'snapshot', snapshot: snap(D1, 2) })
  await until(() => raw.received.some((m) => m.type === 'have' && m.seq === 2), { name: 'first adopted' })
  raw.sendJson({ type: 'snapshot', snapshot: snap(D1, 3) }) // credited, held
  await delay(50)
  ha.close()
  await delay(400)
  t.is(sa.offers.length, 1, 'the held snapshot was never offered')
  t.is(ha.badMessages, 0)
  t.absent(a.destroyed)

  // The same holds when the socket closes while a snapshot is held.
  const { a: a2, b: b2 } = streams(t)
  const sa2 = fakeState(snap(D1, 1))
  attachBlocklist(a2, { current: sa2.current, offer: sa2.offer, minIntervalMs: 200 })
  const raw2 = rawPeer(b2)
  await raw2.opened
  raw2.sendJson({ type: 'snapshot', snapshot: snap(D1, 2) })
  await until(() => raw2.received.some((m) => m.type === 'have' && m.seq === 2), { name: 'first adopted (socket)' })
  raw2.sendJson({ type: 'snapshot', snapshot: snap(D1, 3) })
  await delay(50)
  a2.destroy()
  await delay(400)
  t.is(sa2.offers.length, 1, 'the held snapshot was never offered after the socket closed')
})

test('a peer without the blocklist channel still completes admission; supported resolves false', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 1))
  const pa = attachAdmission(a, { role: 'member' })
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer })
  // The old peer: admission only, no blocklist channel and no pair handler.
  const pb = attachAdmission(b, { role: 'member' })

  t.is(await ha.supported, false)
  const [helloA, helloB] = await Promise.all([pa.hello, pb.hello])
  t.is(helloA && helloA.type, 'hello')
  t.is(helloB && helloB.type, 'hello')
  await delay(100)
  t.absent(a.destroyed, 'our socket stays up')
  t.absent(b.destroyed, 'the old peer is not dropped')
  t.is(ha.announce(), false, 'nothing to announce on')
  t.is(sa.offers.length, 0)
})

test('a peer that attaches after rejecting our open is still paired', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(snap(D1, 1))
  const sb = fakeState(snap(D1, 4))
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer })
  t.is(await ha.supported, false, 'our first open was rejected')

  // B attaches late: its open finds our pair handler, which opens a channel.
  const hb = attachBlocklist(b, { current: sb.current, offer: sb.offer })
  t.is(await hb.supported, true)
  await until(() => sa.saved.length === 1, { name: 'late peer snapshot adopted' })
  t.is(sa.saved[0].seq, 4)
})

test('haves carry the signature prefix of the held snapshot; remoteHave keeps it', async (t) => {
  const { a, b } = streams(t)
  const sigA = SIG_A + SIG_B + SIG_A + SIG_B
  const sigB = SIG_B + SIG_A + SIG_B + SIG_A
  // Same ordering key, different contents (an operator restored an old
  // backup and signed another change at the same seq).
  const sa = fakeState(snap(D1, 3, { signature: sigA }))
  const sb = fakeState(snap(D1, 3, { signature: sigB }))
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer, minIntervalMs: 0 })
  const hb = attachBlocklist(b, { current: sb.current, offer: sb.offer, minIntervalMs: 0 })
  await until(() => ha.remoteHave !== null && hb.remoteHave !== null, { name: 'have exchanged' })
  t.alike(ha.remoteHave, { moderatorDate: D1, seq: 3, sig: SIG_B })
  t.alike(hb.remoteHave, { moderatorDate: D1, seq: 3, sig: SIG_A })
  await delay(100)
  t.is(sa.offers.length + sb.offers.length, 0, 'equal ordering keys: nothing sent, sig ignored by the order')

  const { a: a2, b: b2 } = streams(t)
  const h2 = attachBlocklist(a2, { current: sa.current, offer: sa.offer, minIntervalMs: 0 })
  const raw2 = rawPeer(b2)
  await raw2.opened
  await until(() => raw2.received.length >= 1, { name: 'our have' })
  t.alike(raw2.received[0], { type: 'have', moderatorDate: D1, seq: 3, sig: SIG_A })
  raw2.sendJson({ type: 'have', moderatorDate: D1, seq: 3, sig: SIG_A.toUpperCase() })
  await until(() => h2.badMessages === 1, { name: 'uppercase sig is bad' })
  t.is(h2.remoteHave, null)
})

test('close unpairs and settles', async (t) => {
  const { a, b } = streams(t)
  const sa = fakeState(null)
  const sb = fakeState(null)
  const ha = attachBlocklist(a, { current: sa.current, offer: sa.offer })
  const hb = attachBlocklist(b, { current: sb.current, offer: sb.offer })
  t.is(await ha.supported, true)
  await until(() => hb.remoteHave !== null, { name: 'have exchanged' })
  t.alike(hb.remoteHave, { moderatorDate: '', seq: 0, sig: '' })
  t.is(attachBlocklist(a, { current: sa.current, offer: sa.offer }), ha, 'one handle per socket')
  ha.close()
  t.is(ha.announce(), false)
  await delay(50)
  t.absent(a.destroyed, 'closing the channel keeps the socket')
})

test('blocklist-net.js loads without node-only modules or hypercore', (t) => {
  const code = "require('./lib/blocklist-net.js'); process.stdout.write(JSON.stringify(Object.keys(require.cache)))"
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const cached = JSON.parse(r.stdout)
  t.ok(cached.length > 0, 'modules were loaded')
  for (const frag of ['/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/', '/udx/', '/rocksdb/', '/corestore/', '/protomux/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
  const builtins = spawnSync(process.execPath, ['-e', "const m = require('node:module'); const seen = []; const orig = m.prototype.require; m.prototype.require = function (id) { seen.push(id); return orig.apply(this, arguments) }; require('./lib/blocklist-net.js'); process.stdout.write(JSON.stringify(seen))"], { cwd: coreRoot, encoding: 'utf8' })
  t.is(builtins.status, 0, builtins.stderr)
  const ids = JSON.parse(builtins.stdout)
  for (const id of ['fs', 'node:fs', 'net', 'node:net', 'http', 'node:http']) {
    t.absent(ids.includes(id), 'not required: ' + id)
  }
})
