'use strict'

// The anonymous 'varanda/blob/1' channel. Most tests run over two in-memory
// NoiseSecretStreams, each with the protomux that hypercore's replication
// stream installs (as dm-net.test.js); one runs over a real swarm on the
// local testnet (helpers/net.js), never the public DHT. The seeder side
// stores into a real blob pool on a temporary directory, with a stand-in
// stamp verifier.
const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const Corestore = require('corestore')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { attachBlob, validateBlobMessage, MAX_BAD_BLOB } = require('../lib/blob-net')
const { createBlobPool } = require('../lib/blob-pool')
const { BLOB_PROTOCOL, BLOB_CHUNK_BYTES, BLOB_FRAME_BYTES, BLOB_MAX_MESSAGE, encodeChunk, newBlobId } = require('../lib/blob')
const { createSwarm, topicFor, joinAndFlush } = require('../lib/net')
const { testnet, until, localSwarmOptions } = require('./helpers/net')
const { tmpDir } = require('./helpers/tmp')

const DAY = 86400000
const GOOD_KID = b4a.from('00112233aabbccdd', 'hex')

function randomBytes (n) {
  const out = b4a.alloc(n)
  sodium.randombytes_buf(out)
  return out
}

function verifyStamp (kid, token, sig) {
  return kid === '00112233aabbccdd' && token.byteLength === 32 && sig.byteLength === 256
}

function blob (count, { id = newBlobId(), kid = GOOD_KID } = {}) {
  const frames = []
  for (let i = 0; i < count; i++) {
    frames.push(encodeChunk({ id, index: i, count, kid, sig: randomBytes(256), token: randomBytes(32), bytes: randomBytes(i === count - 1 ? 7 : BLOB_CHUNK_BYTES) }))
  }
  return { id, frames }
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

function rawPeer (noise) {
  const received = []
  const ch = noise.userData.createChannel({ protocol: BLOB_PROTOCOL })
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

function clock (start) {
  const k = { t: start }
  k.now = () => k.t
  return k
}

function pool (t, extra = {}) {
  const p = createBlobPool({ dir: tmpDir(t), verifyStamp, sweepMs: 0, ...extra })
  t.teardown(() => p.close())
  return p
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const OK = { ok: true, reason: null }

test('valid put, idempotent repeat, incomplete blob not readable', async (t) => {
  const { a, b } = streams(t)
  const p = pool(t)
  const hs = attachBlob(a, { role: 'seeder', put: p.submit })
  const hm = attachBlob(b, { role: 'member' })
  t.is(await hs.supported, true)
  t.is(await hm.supported, true)

  const x = blob(2)
  t.alike(await hm.put(x.frames[0]), OK)
  t.is(p.read(x.id, 0), null, 'incomplete blob not readable')
  t.alike(await hm.put(x.frames[0]), OK, 'identical repeat is a success')
  t.alike(await hm.put(x.frames[1]), OK)
  t.alike(p.info(x.id), { count: 2, have: 2, complete: true })
  t.ok(b4a.equals(p.read(x.id, 1), x.frames[1]))
  t.is(hs.badMessages + hm.badMessages, 0)
})

test('refusals: bad stamp, mismatched repeat, spent token, byte cap', async (t) => {
  const { a, b } = streams(t)
  const k = clock(1700000000000)
  const p = pool(t, { now: k.now, maxBytes: 2 * BLOB_CHUNK_BYTES })
  attachBlob(a, { role: 'seeder', put: p.submit })
  const hm = attachBlob(b, { role: 'member' })

  t.alike(await hm.put(blob(1, { kid: b4a.alloc(8) }).frames[0]), { ok: false, reason: 'invalido' }, 'bad stamp')
  const x = blob(1)
  t.alike(await hm.put(x.frames[0]), OK)
  const other = b4a.from(x.frames[0])
  other[60] ^= 1
  t.alike(await hm.put(other), { ok: false, reason: 'invalido' }, 'mismatched repeat')
  // The cap counts stored chunks: the second chunk that would pass it is refused.
  const y = blob(2)
  t.alike(await hm.put(y.frames[0]), OK)
  t.alike(await hm.put(y.frames[1]), { ok: false, reason: 'cheio' }, 'byte cap')
  const badMagic = b4a.from(blob(1).frames[0])
  badMagic[0] = 0
  t.alike(await hm.put(badMagic), { ok: false, reason: 'invalido' })

  k.t += 7 * DAY
  t.is(p.sweep(), 2)
  t.alike(await hm.put(x.frames[0]), { ok: false, reason: 'invalido' }, 'spent token refused')
})

test('a truncated frame is refused: the member will not send it, the seeder counts it bad', async (t) => {
  const { a, b } = streams(t)
  const p = pool(t)
  const logged = []
  const hs = attachBlob(a, { role: 'seeder', put: p.submit, log: (e) => logged.push(e) })
  const frame = blob(1).frames[0]
  const truncated = frame.subarray(0, BLOB_FRAME_BYTES - 1)

  const member = attachBlob(streams(t).b, { role: 'member' })
  await t.exception.all(member.put(truncated), /bytes/)

  const raw = rawPeer(b)
  await raw.opened
  raw.sendJson({ type: 'put', chunk: b4a.toString(truncated, 'base64') })
  raw.sendJson({ type: 'put', chunk: b4a.toString(frame, 'base64').slice(0, -4) })
  raw.sendJson({ type: 'put', chunk: b4a.toString(frame, 'base64'), extra: 1 })
  raw.sendRaw(b4a.from('not json'))
  raw.sendJson({ type: 'ack', ok: true, reason: null })
  await until(() => hs.badMessages === 5, { name: 'bad messages' })
  t.is(raw.received.length, 0, 'nothing acked')
  t.is(p.size, 0)
  raw.sendRaw(b4a.alloc(BLOB_MAX_MESSAGE + 1))
  await until(() => logged.some((e) => e.event === 'peer-dropped'), { name: 'dropped' })
  t.alike(logged, [{ event: 'peer-dropped', reason: 'blob' }])
  t.is(MAX_BAD_BLOB, 5)
})

test('message shapes', (t) => {
  const chunk = b4a.toString(blob(1).frames[0], 'base64')
  t.ok(validateBlobMessage({ type: 'put', chunk }))
  t.absent(validateBlobMessage({ type: 'put', chunk: chunk + '=' }))
  t.absent(validateBlobMessage({ type: 'put', chunk: chunk.replace(/[^=](?==*$)/, '=') }))
  t.ok(validateBlobMessage({ type: 'ack', ok: true, reason: null }))
  for (const reason of ['cheio', 'invalido', 'ritmo']) t.ok(validateBlobMessage({ type: 'ack', ok: false, reason }))
  t.absent(validateBlobMessage({ type: 'ack', ok: true, reason: 'cheio' }))
  t.absent(validateBlobMessage({ type: 'ack', ok: false, reason: null }))
  t.absent(validateBlobMessage({ type: 'ack', ok: false, reason: 'outro' }))
  t.absent(validateBlobMessage({ type: 'get', id: 'x' }))
  t.absent(validateBlobMessage(null))
  t.absent(validateBlobMessage([]))
})

test('a put over the budget is answered ritmo and stored nowhere', async (t) => {
  const { a, b } = streams(t)
  const p = pool(t)
  attachBlob(a, { role: 'seeder', put: p.submit, putBurst: 2, putRate: 0.001 })
  const hm = attachBlob(b, { role: 'member' })
  const x = blob(3)
  t.alike(await hm.put(x.frames[0]), OK)
  t.alike(await hm.put(x.frames[1]), OK)
  t.alike(await hm.put(x.frames[2]), { ok: false, reason: 'ritmo' })
  t.alike(p.info(x.id), { count: 3, have: 2, complete: false })
})

test('a pool failure closes the channel: the put is uncertain, never acked, never repeated', async (t) => {
  const { a, b } = streams(t)
  let calls = 0
  const logged = []
  attachBlob(a, { role: 'seeder', put: () => { calls++; throw new Error('disk') }, log: (e) => logged.push(e) })
  const hm = attachBlob(b, { role: 'member' })
  await t.exception(hm.put(blob(1).frames[0]), /closed/)
  await delay(50)
  t.is(calls, 1, 'no automatic retry')
  t.alike(logged, [{ event: 'blob-put-failed', reason: 'erro' }])
})

test('one put in flight; a timeout is terminal for the channel', async (t) => {
  const { a, b } = streams(t)
  let release
  attachBlob(a, { role: 'seeder', put: () => new Promise((resolve) => { release = resolve }) })
  const hm = attachBlob(b, { role: 'member', requestTimeoutMs: 200 })
  const first = hm.put(blob(1).frames[0])
  await t.exception(hm.put(blob(1).frames[0]), /in flight/)
  await t.exception(first, /timed out/)
  release({ ok: true, complete: true })
  await t.exception(hm.put(blob(1).frames[0]), /closed/)
})

test('one put in flight per socket: a reopened channel waits, a late result never acks it', async (t) => {
  const { a, b } = streams(t)
  let calls = 0
  let release
  const hs = attachBlob(a, {
    role: 'seeder',
    put: () => {
      calls++
      if (calls === 1) return new Promise((resolve) => { release = resolve })
      return { ok: true, complete: true }
    }
  })
  const first = attachBlob(b, { role: 'member' })
  const held = first.put(blob(1).frames[0])
  await until(() => calls === 1, { name: 'first put running' })
  first.close()
  await t.exception(held, /closed/)

  const second = attachBlob(b, { role: 'member', requestTimeoutMs: 1000 })
  t.is(await second.supported, true)
  let settled = null
  const during = second.put(blob(1).frames[0]).then((v) => { settled = v }, (e) => { settled = e })
  await until(() => hs.badMessages === 1, { name: 'second put refused' })
  t.is(calls, 1, 'the second put is not run while the first is held')

  release({ ok: true, complete: true })
  await delay(100)
  t.is(settled, null, 'the first put result never acks the new channel')
  await during
  t.ok(settled instanceof Error && /timed out/.test(settled.message))

  const third = attachBlob(b, { role: 'member' })
  t.alike(await third.put(blob(1).frames[0]), OK, 'the lock is released once the first put settles')
  t.is(calls, 2)
})

test('a put that throws after a reopen closes only its own channel', async (t) => {
  const { a, b } = streams(t)
  let calls = 0
  let fail
  const logged = []
  attachBlob(a, {
    role: 'seeder',
    log: (e) => logged.push(e),
    put: () => {
      calls++
      if (calls === 1) return new Promise((resolve, reject) => { fail = reject })
      return { ok: true, complete: true }
    }
  })
  const first = attachBlob(b, { role: 'member' })
  const held = first.put(blob(1).frames[0])
  await until(() => calls === 1, { name: 'first put running' })
  first.close()
  await t.exception(held, /closed/)

  const second = attachBlob(b, { role: 'member' })
  t.is(await second.supported, true)
  fail(new Error('disk'))
  await delay(100)
  t.alike(logged, [{ event: 'blob-put-failed', reason: 'erro' }])
  t.alike(await second.put(blob(1).frames[0]), OK, 'the newer channel stays open and gets no false ack')
  t.is(calls, 2)
})

test('logs never carry an id', async (t) => {
  const { a, b } = streams(t)
  const p = pool(t)
  const logged = []
  attachBlob(a, { role: 'seeder', put: p.submit, log: (e) => logged.push(e), putBurst: 1, putRate: 0.001 })
  const hm = attachBlob(b, { role: 'member' })
  const x = blob(2)
  await hm.put(x.frames[0])
  await hm.put(x.frames[1])
  const text = JSON.stringify(logged)
  t.absent(text.includes(b4a.toString(x.id, 'hex')))
})

test('a blob put end to end over the local testnet', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const p = pool(t)
  const topic = topicFor('ab'.repeat(32))
  let seeder = null
  let member = null

  async function node (onconnection) {
    const store = new Corestore(tmpDir(t, 'varanda-blob-net-'))
    await store.ready()
    const swarm = createSwarm(localSwarmOptions(bootstrap))
    t.teardown(() => swarm.destroy(), { force: true })
    t.teardown(() => store.close(), { force: true })
    swarm.on('connection', (socket) => {
      socket.on('error', () => {})
      store.replicate(socket)
      onconnection(socket)
    })
    return swarm
  }

  // Both sides join as client and server, so a duplicate connection is
  // normal and Hyperswarm destroys one of them: keep the first, as net.test.js.
  const s = await node((socket) => {
    if (seeder) return
    seeder = attachBlob(socket, { role: 'seeder', put: p.submit })
  })
  const m = await node((socket) => {
    if (member) return
    member = attachBlob(socket, { role: 'member' })
  })
  await joinAndFlush(s, [topic])
  await joinAndFlush(m, [topic])
  await until(() => seeder && member, { name: 'peers' })
  t.is(await member.supported, true)

  const x = blob(3)
  for (const f of x.frames) t.alike(await member.put(f), OK)
  t.alike(p.info(x.id), { count: 3, have: 3, complete: true })
  t.is(seeder.badMessages + member.badMessages, 0)
})
