'use strict'

// The two direct message links (lib/dm-link.js) against a loopback seeder
// stand-in (helpers/dm-seeder.js).
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const dm = require('@varanda/core/lib/dm')
const postage = require('@varanda/core/lib/dm-postage')
const { diaryKeyOfSigner } = require('@varanda/core/lib/diary-signer')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocketServer } = require('ws')
const { createSeederCert } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachBlob } = require('@varanda/core/lib/blob-net')
const { BLOB_FRAME_BYTES } = require('@varanda/core/lib/blob')
const { openDmLink, openStampLink, openBlobLink, openVisitLink } = require('../lib/dm-link')
const { attachDm } = require('@varanda/core/lib/dm-net')
const { attachDmNotice, DM_NOTICE_PROTOCOL } = require('@varanda/core/lib/dm-notice-net')
const { createNoticeWindow, openDmNotice } = require('@varanda/core/lib/dm-notice')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const { dmSeeder } = require('./helpers/dm-seeder')
const { wsStream } = require('../lib/ws-stream')

function noop () {}

function createSocket (url) {
  const ws = new WebSocket(url)
  ws.on('error', noop)
  return ws
}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function stamp (seeder, keyPair, opts = {}) {
  const link = await openStampLink({ seederUrl: seeder.url, createSocket, association: seeder.assoc, keyPair, ...opts })
  try {
    const pub = await link.key()
    const { n } = postage.parsePublicKey(pub)
    const token = postage.newToken(n)
    const { blinded, r } = postage.blind(postage.representative(token), n)
    const res = await link.issue(postage.toBase64(blinded))
    const sig = postage.unblind(postage.fromBase64(res.sig), r, n)
    return { pub, token, sig: postage.bigToBytes(sig), kid: res.kid }
  } finally {
    link.close()
  }
}

test('stamp link proves the diary, issues a stamp that verifies; dm link puts and pages it anonymously', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  seeder.assoc = hex(assoc.publicKey)
  const identity = crypto.keyPair()
  const s = await stamp(seeder, identity)
  t.is(s.kid, seeder.pub.kid)
  t.ok(postage.verify(s.token, s.sig, s.pub), 'unblinded stamp verifies')
  t.alike(seeder.stampProofs, [hex(identity.publicKey)], 'the budget is charged to the proved diary')

  const box = crypto.keyPair()
  const sodium = require('sodium-universal')
  const pk = b4a.alloc(32)
  const sk = b4a.alloc(32)
  sodium.crypto_box_keypair(pk, sk)
  const inner = dm.buildInner({ kind: 'msg', to: hex(box.publicKey), text: 'oi' }, identity)
  const sealed = dm.sealInner(inner, hex(pk))
  const drop = dm.encodeDrop({ dropId: dm.newDropId(), kid: b4a.from(s.kid, 'hex'), rsaSig: s.sig, token: s.token, sealed })

  const link = await openDmLink({ seederUrl: seeder.url, createSocket, association: seeder.assoc })
  t.alike(await link.put(drop), { ok: true, reason: null })
  t.alike(await link.put(drop), { ok: true, reason: null }, 'an identical drop again is a repeated success')
  const page = await link.page({ after: 0, limit: dm.DM_PAGE_MAX })
  t.is(page.items.length, 1)
  t.ok(b4a.equals(page.items[0].bytes, drop))
  const opened = dm.openSealed(dm.decodeDrop(page.items[0].bytes).sealed, { publicKey: pk, secretKey: sk })
  t.ok(opened !== null, 'the recipient opens it')
  link.close()
  for (const text of seeder.traffic) t.absent(text.includes(hex(identity.publicKey)), 'no diary key on the dm channel')
})

test('stamp link with diary: a core node\'s diary proves with v2 and the budget is the diary\'s', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  seeder.assoc = hex(assoc.publicKey)
  const identity = crypto.keyPair()
  const diary = hex(diaryKeyOfSigner(identity.publicKey))
  const s = await stamp(seeder, identity, { diary })
  t.ok(postage.verify(s.token, s.sig, s.pub), 'unblinded stamp verifies')
  t.alike(seeder.stampProofs, [diary], 'charged to the diary key, not the signer')
})

test('stamp link refuses a diary its key pair does not sign, before connecting', async (t) => {
  const assoc = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: assoc })
  seeder.assoc = hex(assoc.publicKey)
  const identity = crypto.keyPair()
  const bad = [hex(diaryKeyOfSigner(crypto.keyPair().publicKey)), hex(identity.publicKey), 'zz', hex(diaryKeyOfSigner(identity.publicKey)).toUpperCase(), 1]
  for (const diary of bad) {
    await t.exception.all(openStampLink({ seederUrl: seeder.url, createSocket, association: seeder.assoc, keyPair: identity, diary }), /diário inválido/)
  }
  t.is(seeder.stampProofs.length, 0)
})

test('a seeder of another association is refused before any proof', async (t) => {
  const assoc = generateAssociationKeyPair()
  const other = generateAssociationKeyPair()
  const seeder = await dmSeeder(t, { signer: other })
  const err = await openStampLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey), keyPair: crypto.keyPair() }).then(() => null, (e) => e)
  t.is(err && err.message, 'sem conexão com o semeador')
  t.is(seeder.stampProofs.length, 0)
  const err2 = await openDmLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey) }).then(() => null, (e) => e)
  t.is(err2 && err2.message, 'sem conexão com o semeador')
})

// A seeder stand-in for the blob channel only: admission and
// 'varanda/blob/1' with a put that records every frame and answers ack.
async function blobOnlySeeder (t, { signer, answer = () => ({ ok: true }) }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const seeder = { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', puts: [], members: [] }
  t.teardown(async () => {
    for (const s of wss.clients) s.terminate()
    await new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', noop)
    noise.once('connect', () => {
      seeder.members.push(hex(noise.remotePublicKey))
      Hypercore.createProtocolStream(noise)
      attachBlob(noise, {
        role: 'seeder',
        put: (bytes) => {
          seeder.puts.push(b4a.from(bytes))
          return answer(seeder.puts.length - 1)
        }
      })
      attachAdmission(noise, { role: 'seeder', cert, have: [] })
    })
  })
  return seeder
}

test('blob link puts a frame anonymously on a fresh Noise key and returns the ack', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobOnlySeeder(t, { signer: assoc, answer: (n) => (n === 0 ? { ok: true } : 'cheio') })
  const frame = b4a.alloc(BLOB_FRAME_BYTES, 7)
  const one = await openBlobLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey) })
  t.alike(await one.put(frame), { ok: true, reason: null })
  t.alike(await one.put(frame), { ok: false, reason: 'cheio' })
  await t.exception.all(one.put(new Uint8Array(10)), TypeError, 'a wrong-size frame is a programming error')
  one.close()
  t.is(seeder.puts.length, 2)
  t.ok(b4a.equals(seeder.puts[0], frame))

  const two = await openBlobLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey) })
  two.close()
  t.is(seeder.members.length, 2)
  t.not(seeder.members[0], seeder.members[1], 'every blob link has its own ephemeral key')
})

test('blob link: a seeder of another association is refused before any put; a lost link reads as no seeder', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const other = generateAssociationKeyPair()
  const wrong = await blobOnlySeeder(t, { signer: other })
  const err = await openBlobLink({ seederUrl: wrong.url, createSocket, association: hex(assoc.publicKey) }).then(() => null, (e) => e)
  t.is(err && err.message, 'sem conexão com o semeador')
  t.is(wrong.puts.length, 0)

  const hang = await blobOnlySeeder(t, { signer: assoc, answer: () => new Promise(noop) })
  const link = await openBlobLink({ seederUrl: hang.url, createSocket, association: hex(assoc.publicKey), limits: { requestTimeoutMs: 300 } })
  const lost = await link.put(b4a.alloc(BLOB_FRAME_BYTES)).then(() => null, (e) => e)
  t.is(lost && lost.message, 'sem conexão com o semeador', 'an unanswered put fails and is not repeated')
  t.is(hang.puts.length, 1)
  link.close()
})

// A seeder stand-in with the dm channel and, when `visit`, the quiet visit
// lane, each over its own recorded in-memory list. notice: 'none' (a seeder
// from before the channel), 'ack' (the seeder role, its window per link fed
// by the drops put on that link; every wake frame is recorded in `wakes`, a
// handed-on box in `boxes`) or 'silent' (the channel opens, records the
// frames and never answers).
async function laneSeeder (t, { signer, visit = true, notice = 'none' }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const seeder = { url: 'ws://127.0.0.1:' + wss.address().port + '/seeder', dm: [], visit: [], wakes: [], boxes: [] }
  t.teardown(async () => {
    for (const s of wss.clients) s.terminate()
    await new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  const lane = (list, window = null) => ({
    role: 'seeder',
    put: (bytes) => {
      list.push(b4a.from(bytes))
      const d = dm.decodeDrop(bytes)
      if (window !== null && d !== null) window.add(d.dropId)
      return { seq: list.length }
    },
    page: ({ after, limit }) => {
      const items = list.map((bytes, i) => ({ seq: i + 1, bytes })).filter((e) => e.seq > after).slice(0, limit)
      return { items, next: null, oldest: 1 }
    }
  })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', noop)
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      const window = createNoticeWindow()
      attachDm(noise, lane(seeder.dm, window))
      if (visit) attachDm(noise, { ...lane(seeder.visit), protocol: dm.VISIT_PROTOCOL })
      if (notice === 'ack') {
        const taking = { take: (id) => { seeder.wakes.push(id); return window.take(id) } }
        attachDmNotice(noise, { role: 'seeder', window: taking, onWake: (box) => seeder.boxes.push(b4a.from(box)) })
      } else if (notice === 'silent') {
        const ch = noise.userData.createChannel({ protocol: DM_NOTICE_PROTOCOL })
        ch.addMessage({ encoding: c.buffer, onmessage: (buf) => seeder.wakes.push(JSON.parse(b4a.toString(buf, 'utf8')).id) })
        ch.open()
      }
      attachAdmission(noise, { role: 'seeder', cert, have: [] })
    })
  })
  return seeder
}

test('visit link puts and pages on the visit lane only', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await laneSeeder(t, { signer: assoc })
  const drop = b4a.alloc(dm.DM_DROP_BYTES, 3)
  const link = await openVisitLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey) })
  t.alike(await link.put(drop), { ok: true, reason: null })
  const page = await link.page({ after: 0, limit: dm.DM_PAGE_MAX })
  t.is(page.items.length, 1)
  t.ok(b4a.equals(page.items[0].bytes, drop))
  await t.exception.all(link.put(new Uint8Array(10)), TypeError, 'a wrong-size drop is a programming error')
  link.close()
  t.is(seeder.visit.length, 1)
  t.is(seeder.dm.length, 0, 'nothing went into the dm pool')
})

test('visit link: a seeder without the lane is unsupported, and nothing falls back to the dm channel', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await laneSeeder(t, { signer: assoc, visit: false })
  const err = await openVisitLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey) }).then(() => null, (e) => e)
  t.ok(err !== null && err.unsupported === true, 'unsupported')
  t.is(err && err.message, 'semeador sem visitas')
  t.is(seeder.dm.length, 0)
  t.is(seeder.visit.length, 0)
  const other = generateAssociationKeyPair()
  const wrong = await openVisitLink({ seederUrl: seeder.url, createSocket, association: hex(other.publicKey) }).then(() => null, (e) => e)
  t.is(wrong && wrong.message, 'sem conexão com o semeador', 'another association is no seeder')
  t.absent(wrong && wrong.unsupported)
})

function serviceKeyPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(32)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function fakeDrop () {
  return dm.encodeDrop({
    dropId: dm.newDropId(),
    kid: b4a.alloc(8, 1),
    rsaSig: b4a.alloc(256, 2),
    token: crypto.randomBytes(32),
    sealed: b4a.alloc(dm.DM_SEALED_BYTES, 3)
  })
}

test('dm link notice: one wake naming the drop just put, its box opens to the recipient for the service only', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await laneSeeder(t, { signer: assoc, notice: 'ack' })
  const service = serviceKeyPair()
  const recipient = hex(crypto.keyPair().publicKey)
  const link = await openDmLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey), noticeKey: () => service.publicKey })
  const drop = fakeDrop()
  t.alike(await link.put(drop), { ok: true, reason: null })
  const id = dm.decodeDrop(drop).dropId
  t.is(await link.notice(id, recipient), true, 'acked')
  t.alike(seeder.wakes, [hex(id)], 'one wake, the drop id as lowercase hex')
  t.is(seeder.boxes.length, 1, 'the window took it: the box is handed on')
  t.is(openDmNotice(seeder.boxes[0], service), recipient, 'the service opens the recipient key')
  t.is(openDmNotice(seeder.boxes[0], serviceKeyPair()), null, 'nobody else does')
  t.absent(seeder.wakes.some((w) => w === recipient), 'the recipient key never crosses in clear')
  link.close()
})

test('dm link notice: no key set sends nothing; a key set later is read at the notice', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await laneSeeder(t, { signer: assoc, notice: 'ack' })
  let key = null
  const link = await openDmLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey), noticeKey: () => key })
  const drop = fakeDrop()
  await link.put(drop)
  const id = dm.decodeDrop(drop).dropId
  t.is(await link.notice(id, hex(crypto.keyPair().publicKey)), false)
  t.is(seeder.wakes.length, 0, 'no frame without a key')
  key = serviceKeyPair().publicKey
  t.is(await link.notice(id, hex(crypto.keyPair().publicKey)), true)
  t.is(seeder.wakes.length, 1)
  t.is(await link.notice(id, 'not a key'), false, 'a bad recipient resolves false, never throws')
  t.is(seeder.wakes.length, 1)
  link.close()

  const plain = await openDmLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey) })
  t.is(await plain.notice(id, hex(crypto.keyPair().publicKey)), false, 'no noticeKey option: none set')
  plain.close()
  t.is(seeder.wakes.length, 1)
})

test('dm link notice: a seeder without the channel answers false at once, and puts go on as before', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await laneSeeder(t, { signer: assoc })
  const link = await openDmLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey), noticeKey: () => serviceKeyPair().publicKey })
  const drop = fakeDrop()
  t.alike(await link.put(drop), { ok: true, reason: null })
  const started = Date.now()
  t.is(await link.notice(dm.decodeDrop(drop).dropId, hex(crypto.keyPair().publicKey)), false)
  t.ok(Date.now() - started < 2000, 'well before the 3 s cap')
  t.alike(await link.put(fakeDrop()), { ok: true, reason: null })
  t.is(seeder.dm.length, 2)
  link.close()
})

test('dm link notice: a seeder that never acks costs at most the cap, the wake is never repeated, and the dm lane stays', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await laneSeeder(t, { signer: assoc, notice: 'silent' })
  const link = await openDmLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey), noticeKey: () => serviceKeyPair().publicKey })
  const drop = fakeDrop()
  await link.put(drop)
  const id = dm.decodeDrop(drop).dropId
  const started = Date.now()
  t.is(await link.notice(id, hex(crypto.keyPair().publicKey)), false)
  const took = Date.now() - started
  t.ok(took >= 2900 && took < 6000, 'the default 3 s cap (' + took + ' ms)')
  t.is(await link.notice(id, hex(crypto.keyPair().publicKey)), false, 'the channel is done after a timeout')
  t.alike(seeder.wakes, [hex(id)], 'one frame, never repeated')
  t.alike(await link.put(fakeDrop()), { ok: true, reason: null }, 'the dm lane still works')
  link.close()
})

test('the visit link opens no notice channel', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await laneSeeder(t, { signer: assoc, notice: 'ack' })
  const link = await openVisitLink({ seederUrl: seeder.url, createSocket, association: hex(assoc.publicKey) })
  t.absent('notice' in link)
  link.close()
})
