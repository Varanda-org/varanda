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
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const { WebSocketServer } = require('ws')
const { createSeederCert } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachBlob } = require('@varanda/core/lib/blob-net')
const { BLOB_FRAME_BYTES } = require('@varanda/core/lib/blob')
const { openDmLink, openStampLink, openBlobLink } = require('../lib/dm-link')
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

async function stamp (seeder, keyPair) {
  const link = await openStampLink({ seederUrl: seeder.url, createSocket, association: seeder.assoc, keyPair })
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
