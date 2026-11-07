'use strict'

// The browser node's blob client (lib/blob.js) against a loopback seeder
// stand-in: admission, the stamp channel with separate DM and blob keys, the
// blob channel over the real pool (@varanda/core lib/blob-pool.js) in a
// temporary directory, and an HTTP /blob route on 127.0.0.1.
const test = require('brittle')
const http = require('node:http')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocket, WebSocketServer } = require('ws')
const { createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachDmStamp } = require('@varanda/core/lib/dm-stamp-net')
const { attachBlob } = require('@varanda/core/lib/blob-net')
const { createBlobPool } = require('@varanda/core/lib/blob-pool')
const coreBlob = require('@varanda/core/lib/blob')
const postage = require('@varanda/core/lib/dm-postage')
const gc = require('@varanda/core/lib/group-crypto')
const sodium = require('../lib/sodium-browser')
const { sealBlob, createBlobClient, fetchBlob, seederOrigin, BLOB_STAMP_WALLET, BLOB_STAMP_WALLET_LOW, FORCE_MARGIN } = require('../lib/blob')
const store = require('../lib/node-store')
const { memoryNodeStorage } = require('../lib/node-storage')
const { openBlobLink, openStampLink } = require('../lib/dm-link')
const { wsStream } = require('../lib/ws-stream')
const { rsaKey } = require('./helpers/dm-seeder')
const { tmpDir } = require('./helpers/net')

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function createSocket (url) {
  const ws = new WebSocket(url)
  ws.on('error', noop)
  return ws
}

function fromBase64url (s) {
  return BigInt('0x' + Buffer.from(s, 'base64url').toString('hex'))
}

let blobRsa = null
function blobKey () {
  if (blobRsa === null) {
    const { privateKey } = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 })
    const jwk = privateKey.export({ format: 'jwk' })
    blobRsa = { n: fromBase64url(jwk.n), d: fromBase64url(jwk.d) }
  }
  return blobRsa
}

// A PNG header the media bounds accept, then size bytes of IDAT payload.
function png (size) {
  const out = b4a.alloc(8 + 25 + 12 + size)
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  out.writeUInt32BE(13, 8)
  out.write('IHDR', 12, 'ascii')
  out.writeUInt32BE(64, 16)
  out.writeUInt32BE(48, 20)
  out[24] = 8
  out[25] = 6
  out.writeUInt32BE(size, 33)
  out.write('IDAT', 37, 'ascii')
  nodeCrypto.randomFillSync(out, 41, size)
  return out
}

async function blobSeeder (t, { signer, blobBudget = 10000, partialMs } = {}) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const dmRsa = rsaKey()
  const bRsa = blobKey()
  const dmPub = postage.publicKey(dmRsa.n)
  const blobPub = postage.publicKey(bRsa.n)
  const pool = createBlobPool({
    dir: tmpDir(t),
    sweepMs: 0,
    ...(partialMs === undefined ? {} : { partialMs }),
    verifyStamp: (kidHex, token, sig) => kidHex === blobPub.kid && postage.verify(token, sig, blobPub, 'blob')
  })
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const seeder = {
    url: 'ws://127.0.0.1:' + wss.address().port + '/seeder',
    assoc: hex(signer.publicKey),
    dmPub,
    blobPub,
    pool,
    puts: [],
    acks: [],
    blobProofs: [],
    // Blob stamp issues answered (a refused one included).
    blobIssues: 0,
    gets: [],
    blobBudget,
    // tamper(frame, index) -> frame: the HTTP route serves what it returns.
    tamper: null,
    // status(index) -> a status to answer instead of the frame.
    status: null,
    // refuse(index) -> a pool result ('cheio' or null) to answer instead of
    // storing the frame, or undefined to store it.
    refuse: null,
    // Noise connections opened (stamp and blob links).
    connections: 0
  }
  const issued = new Map()
  wss.on('connection', (ws) => {
    seeder.connections++
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', noop)
    noise.once('connect', () => {
      Hypercore.createProtocolStream(noise)
      attachDmStamp(noise, {
        role: 'seeder',
        issueBurst: 1000,
        issueRate: 1000,
        blobIssueBurst: 1000,
        blobIssueRate: 1000,
        postage: { publicKey: dmPub, sign: (blinded) => postage.sign(blinded, dmRsa.n, dmRsa.d) },
        budget: { take: () => true },
        blobPostage: { publicKey: blobPub, sign: (blinded) => postage.sign(blinded, bRsa.n, bRsa.d) },
        blobBudget: {
          take (diary) {
            seeder.blobIssues++
            seeder.blobProofs.push(diary)
            const n = issued.get(diary) || 0
            if (n >= seeder.blobBudget) return false
            issued.set(diary, n + 1)
            return true
          }
        }
      })
      attachBlob(noise, {
        role: 'seeder',
        putBurst: 1000,
        putRate: 1000,
        put: (bytes) => {
          seeder.puts.push(b4a.from(bytes))
          const c = coreBlob.decodeChunk(bytes)
          const forced = seeder.refuse && c ? seeder.refuse(c.index) : undefined
          const r = forced !== undefined ? forced : pool.submit(bytes)
          seeder.acks.push(r)
          return r
        }
      })
      attachAdmission(noise, { role: 'seeder', cert, have: [] })
    })
  })
  const server = http.createServer((req, res) => {
    seeder.gets.push({ url: req.url, cookie: req.headers.cookie || null, authorization: req.headers.authorization || null })
    const m = /^\/blob\/([0-9a-f]{64})\/(0|[1-9][0-9]{0,2})$/.exec(req.url)
    const index = m ? Number(m[2]) : -1
    const status = m && seeder.status ? seeder.status(index) : null
    if (status) {
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end('x')
      return
    }
    let frame = m ? pool.read(m[1], index) : null
    if (frame === null) {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      res.end('não encontrado')
      return
    }
    if (seeder.tamper) frame = seeder.tamper(b4a.from(frame), index)
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': frame.byteLength })
    res.end(frame)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  seeder.origin = 'http://127.0.0.1:' + server.address().port
  t.teardown(async () => {
    for (const s of wss.clients) s.terminate()
    await new Promise((resolve) => wss.close(() => resolve()))
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve()))
    pool.close()
  }, { force: true })
  return seeder
}

// The local key seals each wallet stamp exactly as the DM wallet does.
function localSeal (key = nodeCrypto.randomBytes(32)) {
  return { key, seal: (v) => gc.sealRecord(v, key), open: (b) => gc.openRecord(b, key) }
}

// wallet: the injected wallet size (small by default, to keep tests fast).
function clientFor (seeder, { storage = memoryNodeStorage(), local = localSeal(), wallet = 8, walletLow = 4, ...limits } = {}) {
  const client = createBlobClient({
    seederUrl: seeder.url,
    createSocket,
    association: seeder.assoc,
    storage,
    seal: local.seal,
    open: local.open,
    limits: { wallet, walletLow, issuePaceMs: 0, ...limits }
  })
  client.storage = storage
  client.local = local
  return client
}

function tokensOf (frames) {
  return frames.map((f) => hex(coreBlob.decodeChunk(f).token))
}

async function walletTokens (client) {
  const w = await store.readBlobStamps(client.storage)
  return w.items.map((s) => client.local.open(s).token)
}

// Records every buffer blob.js wipes, with its contents right after.
function spyWipes (t) {
  const original = sodium.sodium_memzero
  const wiped = []
  sodium.sodium_memzero = (buf) => {
    original(buf)
    wiped.push(buf)
  }
  t.teardown(() => { sodium.sodium_memzero = original })
  return wiped
}

test('seal, stamp, put and fetch a multi-chunk image round trip; a user retry re-puts the same frames', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const plain = png(2 * coreBlob.BLOB_CHUNK_BYTES + 1000)

  const wiped = spyWipes(t)
  const sealed = sealBlob(plain)
  t.ok(wiped.some((b) => b.byteLength === 32 && b.every((x) => x === 0)), 'the seal key buffer is wiped')
  const d = sealed.descriptor
  t.ok(coreBlob.validateBlobDescriptor(d), 'the descriptor validates')
  t.is(d.chunks, 3)
  t.is(d.bytes, plain.byteLength + coreBlob.BLOB_MAC_BYTES)

  const client = clientFor(seeder)
  await client.send(sealed, identity)
  t.is(seeder.puts.length, 3)
  t.ok(seeder.acks.every((a) => a !== null && a !== 'cheio' && a.ok === true))
  t.alike(seeder.blobProofs, Array(8).fill(hex(identity.publicKey)), 'the short wallet forced one fill, charged to the proved diary')
  t.is(await client.walletSize(), 5, 'the three spent stamps left the wallet')
  for (const frame of seeder.puts) {
    t.is(frame.indexOf(identity.publicKey), -1, 'no diary key in a blob frame')
    t.is(frame.indexOf(b4a.from(d.key, 'hex')), -1, 'no blob key in a blob frame')
  }

  sealed.acked.fill(false)
  await client.put(sealed)
  t.is(seeder.puts.length, 6)
  for (let i = 0; i < 3; i++) t.ok(b4a.equals(seeder.puts[i], seeder.puts[i + 3]), 'the retry puts identical bytes')
  t.ok(seeder.acks.slice(3).every((a) => a.ok === true && a.repeated === true), 'the pool answers a repeated success')
  t.is(seeder.blobProofs.length, 8, 'the retry issues no new stamp')
  t.is(await client.walletSize(), 5, 'the retry spends no wallet stamp')

  const seen = []
  const spy = (url, init) => {
    seen.push({ url, init })
    return fetch(url, init)
  }
  wiped.length = 0
  const got = await fetchBlob(d, seeder.origin, { mime: 'image/png', fetch: spy })
  t.ok(b4a.equals(got.bytes, plain), 'the fetched plaintext matches')
  t.alike(got.bounds && [got.bounds.width, got.bounds.height], [64, 48])
  t.ok(wiped.some((b) => b.byteLength === 32 && b.every((x) => x === 0)), 'the open key buffer is wiped')
  t.is(seen.length, 3)
  for (const [i, s] of seen.entries()) {
    t.is(s.url, seeder.origin + '/blob/' + d.id + '/' + i, 'only the seeder origin is fetched')
    t.is(s.init.credentials, 'omit')
    t.is(s.init.redirect, 'error')
  }
  t.ok(seeder.gets.every((g) => g.cookie === null && g.authorization === null))
  t.is(typeof got, 'object')
  t.absent(JSON.stringify(Object.keys(got)).includes('url'), 'no remote URL is returned')
})

test('a flipped byte anywhere fails the fetch', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const plain = png(coreBlob.BLOB_CHUNK_BYTES + 10)
  const sealed = sealBlob(plain)
  await clientFor(seeder).send(sealed, crypto.keyPair())
  const d = sealed.descriptor
  const bad = (p) => p.then(() => null, (e) => e)

  for (const at of [coreBlob.FRAME.BYTES_OFFSET + 5, coreBlob.FRAME.ID_OFFSET, coreBlob.FRAME.CHECK_OFFSET]) {
    seeder.tamper = (frame, index) => {
      if (index === 1) frame[at] ^= 1
      return frame
    }
    const err = await bad(fetchBlob(d, seeder.origin))
    t.is(err && err.message, 'mídia inválida', 'a flipped frame byte at ' + at + ' is refused')
  }
  // A frame re-built with a valid check over other ciphertext: only the
  // descriptor's sha256 catches it.
  seeder.tamper = (frame, index) => {
    if (index !== 0) return frame
    const c = coreBlob.decodeChunk(frame)
    c.bytes[7] ^= 1
    return coreBlob.encodeChunk({ id: c.id, index: c.index, count: c.count, kid: c.kid, sig: c.sig, token: c.token, bytes: c.bytes })
  }
  const wiped = spyWipes(t)
  let err = await bad(fetchBlob(d, seeder.origin))
  t.is(err && err.message, 'mídia inválida', 'a ciphertext the sha256 does not match is refused')
  t.is(wiped.filter((b) => b.byteLength === 32).length, 0, 'nothing is opened before the sha256 check')
  seeder.tamper = null

  const flip = (s) => (s[0] === '0' ? '1' : '0') + s.slice(1)
  for (const field of ['sha256', 'key', 'nonce']) {
    err = await bad(fetchBlob({ ...d, [field]: flip(d[field]) }, seeder.origin))
    t.is(err && err.message, 'mídia inválida', 'a flipped descriptor ' + field + ' is refused')
  }
  err = await bad(fetchBlob({ ...d, bytes: d.bytes - 1 }, seeder.origin))
  t.is(err && err.message, 'mídia inválida', 'a wrong length is refused')

  const ok = await fetchBlob(d, seeder.origin)
  t.ok(b4a.equals(ok.bytes, plain), 'the untampered blob still opens')
})

test('a DM stamp is refused for a blob put', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const sealed = sealBlob(png(100))
  const id = sealed.id
  const bytes = sealed.cipher

  const stampLink = await openStampLink({ seederUrl: seeder.url, createSocket, association: seeder.assoc, keyPair: identity })
  let frame
  try {
    const pub = await stampLink.key()
    t.is(pub.kid, seeder.dmPub.kid, 'the default kind is the DM key')
    const blobPub = await stampLink.key('blob')
    t.is(blobPub.kid, seeder.blobPub.kid)
    t.not(pub.kid, blobPub.kid)
    const { n } = postage.parsePublicKey(pub)
    for (const kind of ['dm', 'blob']) {
      // A random token blinded under the DM key, in either domain.
      const token = postage.newToken(n, kind)
      const { blinded, r } = postage.blind(postage.representative(token, kind), n)
      const res = await stampLink.issue(postage.toBase64(blinded))
      const sig = postage.unblind(postage.fromBase64(res.sig), r, n)
      t.ok(postage.verify(token, sig, pub, kind), 'a valid DM-key stamp in the ' + kind + ' domain')
      frame = coreBlob.encodeChunk({ id, index: 0, count: 1, kid: b4a.from(pub.kid, 'hex'), sig: postage.bigToBytes(sig), token, bytes })
      const link = await openBlobLink({ seederUrl: seeder.url, createSocket, association: seeder.assoc })
      t.alike(await link.put(frame), { ok: false, reason: 'invalido' }, 'the seeder refuses it')
      link.close()
    }
  } finally {
    stampLink.close()
  }
  t.is(seeder.blobProofs.length, 0, 'no blob budget was spent')
  t.is(seeder.pool.info(id), null, 'nothing was stored')

  sealed.frames[0] = frame
  const err = await clientFor(seeder).put(sealed).then(() => null, (e) => e)
  t.is(err && err.message, 'mídia recusada pelo semeador', 'the client surfaces the refusal')
  t.absent(err && err.uncertain, 'a refusal is certain')
  t.is(sealed.acked[0], false)
})

test('the daily blob budget: a short wallet takes no stamp and keeps what was bought', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc, blobBudget: 1 })
  const identity = crypto.keyPair()
  const sealed = sealBlob(png(coreBlob.BLOB_CHUNK_BYTES + 10))
  const client = clientFor(seeder)
  const err = await client.send(sealed, identity).then(() => null, (e) => e)
  t.is(err && err.message, 'o limite de envio de mídia de hoje acabou')
  t.ok(sealed.frames.every((f) => f === null), 'all or none: no frame is stamped')
  t.is(await client.walletSize(), 1, 'the stamp bought stays in the wallet')
  t.is(seeder.puts.length, 0, 'nothing is put before every chunk is stamped')
  const err2 = await client.put(sealed).then(() => null, (e) => e)
  t.ok(err2 instanceof TypeError)
})

test('the wallet fills in the background and a send with a full wallet issues no stamp', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const client = clientFor(seeder, { wallet: 10, walletLow: 5 })
  t.is(await client.topUp(identity), 10)
  t.is(await client.walletSize(), 10)
  t.is(await client.topUp(identity), 0, 'no unforced top-up within the interval')
  t.is(seeder.blobIssues, 10)

  const kv = JSON.stringify(await client.storage.readJson('blobStamps'))
  for (const tok of await walletTokens(client)) t.absent(kv.includes(tok), 'no plain token in kv')

  const a = sealBlob(png(2 * coreBlob.BLOB_CHUNK_BYTES))
  const before = await walletTokens(client)
  await client.send(a, identity)
  t.is(seeder.blobIssues, 10, 'no stamp is issued during the send')
  t.is(seeder.puts.length, 3)
  const spent = tokensOf(a.frames)
  t.alike(spent, before.slice(0, 3), 'the frames carry wallet tokens')
  const after = await walletTokens(client)
  t.is(after.length, 7)
  for (const tok of spent) t.absent(after.includes(tok), 'a spent stamp leaves the wallet')

  const b = sealBlob(png(3 * coreBlob.BLOB_CHUNK_BYTES))
  await client.send(b, identity)
  t.is(seeder.blobIssues, 10)
  const all = [...spent, ...tokensOf(b.frames)]
  t.is(new Set(all).size, all.length, 'a spent stamp is never reused')
  t.ok(seeder.acks.every((r) => r.ok === true && r.repeated !== true))
})

test('a short wallet forces one top-up before the put', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const client = clientFor(seeder, { wallet: 4, walletLow: 2 })
  t.is(await client.topUp(identity), 4)
  const sealed = sealBlob(png(5 * coreBlob.BLOB_CHUNK_BYTES))
  t.is(sealed.descriptor.chunks, 6)
  await client.send(sealed, identity)
  t.is(seeder.blobIssues, 4 + 2, 'one forced top-up, up to what the blob needs')
  t.is(seeder.puts.length, 6)
  t.is(await client.walletSize(), 0)
})

test('stamps of a kid outside the current and previous pair are not used', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const client = clientFor(seeder, { wallet: 3, walletLow: 1 })
  // A wallet whose kids name two other keys, and one stamp under a third.
  const old = { kid: 'ab'.repeat(8), ...client.local.seal({ token: 'cd'.repeat(32), sig: postage.toBase64(5n) }) }
  await store.writeBlobStamps(client.storage, { items: [old], kids: ['01'.repeat(8), '02'.repeat(8)] })
  t.is(await client.walletSize(), 0, 'an old-kid stamp is not usable')
  const sealed = sealBlob(png(100))
  await client.send(sealed, identity)
  t.is(seeder.blobIssues, 3, 'the send forced a top-up')
  t.not(tokensOf(sealed.frames)[0], 'cd'.repeat(32), 'the old stamp was not spent')
  t.ok(seeder.acks.every((r) => r.ok === true))
  const w = await store.readBlobStamps(client.storage)
  t.alike(w.kids, [seeder.blobPub.kid, '01'.repeat(8)], 'the verified key became current')
  t.is(w.items.filter((s) => s.kid === 'ab'.repeat(8)).length, 0, 'the out-of-pair stamp was dropped')
})

test('the sealed wallet survives a reopen and opens only under its key', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const storage = memoryNodeStorage()
  const local = localSeal()
  const first = clientFor(seeder, { storage, local, wallet: 5 })
  t.is(await first.topUp(identity), 5)
  const tokens = await walletTokens(first)

  const again = clientFor(seeder, { storage, local: localSeal(local.key), wallet: 5 })
  t.is(await again.walletSize(), 5, 'a new client on the same kv sees the wallet')
  const sealed = sealBlob(png(100))
  await again.send(sealed, identity)
  t.is(seeder.blobIssues, 5, 'the reopened wallet pays without issuing')
  t.is(tokensOf(sealed.frames)[0], tokens[0])

  const other = clientFor(seeder, { storage, wallet: 5 })
  t.is(await other.walletSize(), 0, 'another local key opens nothing')
})

test('blob stamp kv: shape checks and the size cap', async (t) => {
  const storage = memoryNodeStorage()
  t.alike(await store.readBlobStamps(storage), { items: [], kids: [] })
  const local = localSeal()
  const items = []
  for (let i = 0; i < store.MAX_BLOB_STAMPS + 5; i++) items.push({ kid: '0a'.repeat(8), ...local.seal({ token: 'ee'.repeat(32), sig: 'AQ==' }) })
  items.push({ kid: 'nothex', ...local.seal({ token: 'ee'.repeat(32), sig: 'AQ==' }) })
  await store.writeBlobStamps(storage, { items: [{ kid: 'zz', nonce: 'x', box: 'y' }, ...items], kids: ['0a'.repeat(8), 'bad', '0b'.repeat(8), '0c'.repeat(8)] })
  const w = await store.readBlobStamps(storage)
  t.is(w.items.length, store.MAX_BLOB_STAMPS, 'invalid items dropped and the count capped')
  t.alike(w.kids, ['0a'.repeat(8), '0b'.repeat(8)])
  t.is(await storage.readJson('dmStamps'), null, 'its own kv key, apart from the DM wallet')
  t.ok(store.MAX_BLOB_STAMPS >= BLOB_STAMP_WALLET)
})

test('a DM data reset also clears the blob stamp wallet', async (t) => {
  const storage = memoryNodeStorage()
  const local = localSeal()
  await store.writeBlobStamps(storage, { items: [{ kid: '0a'.repeat(8), ...local.seal({ token: 'ee'.repeat(32), sig: 'AQ==' }) }], kids: ['0a'.repeat(8)] })
  t.is((await store.readBlobStamps(storage)).items.length, 1)
  await store.deleteDmData(storage)
  t.alike(await store.readBlobStamps(storage), { items: [], kids: [] })
  t.is(await storage.readJson('blobStamps'), null)
})

test('the wallet fills to the real BLOB_STAMP_WALLET from the seeder', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const client = clientFor(seeder, { wallet: BLOB_STAMP_WALLET, walletLow: BLOB_STAMP_WALLET_LOW })
  t.is(await client.topUp(identity), BLOB_STAMP_WALLET)
  t.is(await client.walletSize(), BLOB_STAMP_WALLET, 'the kv cap keeps every stamp')
  t.is(seeder.blobIssues, BLOB_STAMP_WALLET)
})

test('the real wallet constants fit the largest item', (t) => {
  t.is(BLOB_STAMP_WALLET, 300)
  t.is(BLOB_STAMP_WALLET_LOW, 150)
  t.ok(BLOB_STAMP_WALLET >= coreBlob.BLOB_MAX_CHUNKS, 'one maximum item fits a full wallet')
})

// Bare's URL (bare-url, the app worklet's global) has no origin getter: a
// check that reads it refused every seeder there, so no DM photo opened.
test('the seeder origin is checked without URL.prototype.origin', (t) => {
  const NodeURL = globalThis.URL
  globalThis.URL = class extends NodeURL {
    get origin () { return undefined }
  }
  try {
    t.is(seederOrigin('https://example.com/'), 'https://example.com')
    t.is(seederOrigin('https://example.com'), 'https://example.com')
    t.is(seederOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
    t.is(seederOrigin('http://[::1]:8080/'), 'http://[::1]:8080')
    for (const origin of ['http://example.com', 'https://a:b@example.com', 'https://example.com/x', 'https://example.com?q=1', 'https://example.com#x', 'https://example.com:443', 'https://EXAMPLE.com', 'ftp://127.0.0.1', 'javascript:alert(1)']) {
      t.exception(() => seederOrigin(origin), 'refused: ' + origin)
    }
  } finally {
    globalThis.URL = NodeURL
  }
})

test('fetch refuses other origins; a 404 is never retried and a 429 only a bounded number of times', async (t) => {
  t.timeout(120000)
  for (const origin of ['http://example.com', 'https://a:b@example.com', 'https://example.com/x', 'https://example.com?q=1', 'ftp://127.0.0.1', 'javascript:alert(1)']) {
    t.exception(() => seederOrigin(origin), 'refused: ' + origin)
  }
  t.is(seederOrigin('https://example.com/'), 'https://example.com')
  t.is(seederOrigin('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')

  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const sealed = sealBlob(png(200))
  const d = sealed.descriptor
  let calls = 0
  const counting = (url, init) => {
    calls++
    return fetch(url, init)
  }
  let err = await fetchBlob(d, 'http://example.com', { fetch: counting }).then(() => null, (e) => e)
  t.is(err && err.message, 'endereço do semeador inválido')
  t.is(calls, 0, 'nothing is fetched for a refused origin')

  err = await fetchBlob(d, seeder.origin, { fetch: counting }).then(() => null, (e) => e)
  t.is(err && err.message, 'mídia indisponível', 'a blob not stored is a 404')
  t.is(calls, 1)

  await clientFor(seeder).send(sealed, crypto.keyPair())
  seeder.status = () => 429
  calls = 0
  err = await fetchBlob(d, seeder.origin, { fetch: counting, limits: { retryDefaultMs: 5 } }).then(() => null, (e) => e)
  t.is(err && err.message, 'muitos envios seguidos: aguarde um pouco', 'a 429 that persists is a normal error')
  t.is(calls, 4, 'the read is retried at most 3 times')
  seeder.status = null

  err = await fetchBlob({ ...d, chunks: 2 }, seeder.origin, { fetch: counting }).then(() => null, (e) => e)
  t.is(err && err.message, 'mídia inválida', 'an invalid descriptor is refused')
  err = await fetchBlob(d, seeder.origin, { mime: 'image/jpeg' }).then(() => null, (e) => e)
  t.is(err && err.message, 'mídia inválida', 'bytes that are not the named image type are refused')
})

test('sealBlob bounds', (t) => {
  t.exception.all(() => sealBlob(new Uint8Array(0)), TypeError)
  t.exception.all(() => sealBlob('x'), TypeError)
  const err = (() => { try { sealBlob(new Uint8Array(8 * 1024 * 1024 + 1)) } catch (e) { return e } })()
  t.is(err && err.message, 'mídia grande demais')
  const big = sealBlob(new Uint8Array(8 * 1024 * 1024))
  t.is(big.descriptor.chunks, coreBlob.BLOB_MAX_CHUNKS, 'an 8 MiB plaintext fills 257 chunks')
  t.ok(coreBlob.validateBlobDescriptor(big.descriptor))
})

// A fake /blob route in memory: the frames of a sealed blob under made-up
// stamps (fetchBlob never checks a stamp), behind a token bucket like the
// seeder's /media one. answer(index, n) -> { status, retryAfter } overrides
// the n-th GET (from 1) of a chunk.
function fakeRoute (sealed, { burst = Infinity, perSecond = 0, answer = null } = {}) {
  const d = sealed.descriptor
  const frames = []
  for (let i = 0; i < d.chunks; i++) {
    frames.push(coreBlob.encodeChunk({
      id: sealed.id,
      index: i,
      count: d.chunks,
      kid: b4a.alloc(8, 1),
      sig: postage.bigToBytes(5n),
      token: b4a.alloc(32, 2),
      bytes: sealed.cipher.subarray(i * coreBlob.BLOB_CHUNK_BYTES, Math.min(d.bytes, (i + 1) * coreBlob.BLOB_CHUNK_BYTES))
    }))
  }
  const route = { gets: [], statuses: [], tokens: burst, at: Date.now() }
  const reply = (status, body, headers) => ({
    status,
    redirected: false,
    headers: { get: (name) => (headers[name.toLowerCase()] === undefined ? null : String(headers[name.toLowerCase()])) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  })
  route.fetch = async (url) => {
    const index = Number(url.split('/').pop())
    route.gets.push(index)
    const n = route.gets.filter((i) => i === index).length
    const now = Date.now()
    route.tokens = Math.min(burst, route.tokens + (now - route.at) * perSecond / 1000)
    route.at = now
    let status = 200
    let retryAfter
    if (route.tokens < 1) {
      status = 503
    } else {
      route.tokens--
      const o = answer ? answer(index, n) : null
      if (o) ({ status, retryAfter } = o)
    }
    route.statuses.push(status)
    if (status !== 200) return reply(status, b4a.from('x'), retryAfter === undefined ? {} : { 'retry-after': retryAfter })
    return reply(200, frames[index], { 'content-length': frames[index].byteLength })
  }
  return route
}

test('a key rotation counts only the stamps that stay usable before the send', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const client = clientFor(seeder, { wallet: 4, walletLow: 2 })
  // Two stamps under the pair's current key and two under its previous one;
  // the seeder now signs under a third key, so the previous key's stamps go.
  const cur = 'a1'.repeat(8)
  const prev = 'b2'.repeat(8)
  const items = []
  for (let i = 0; i < 2; i++) items.push({ kid: cur, ...client.local.seal({ token: (i + 1).toString(16).padStart(64, '0'), sig: postage.toBase64(5n) }) })
  for (let i = 0; i < 2; i++) items.push({ kid: prev, ...client.local.seal({ token: (i + 9).toString(16).padStart(64, '0'), sig: postage.toBase64(5n) }) })
  await store.writeBlobStamps(client.storage, { items, kids: [cur, prev] })
  t.is(await client.walletSize(), 4)
  const sealed = sealBlob(png(5 * coreBlob.BLOB_CHUNK_BYTES))
  t.is(sealed.descriptor.chunks, 6)
  await client.stamp(sealed, identity)
  t.ok(sealed.frames.every((f) => f !== null), 'every chunk got a stamp')
  t.is(seeder.blobIssues, 4, 'the top-up bought against the two stamps that stay usable')
  const w = await store.readBlobStamps(client.storage)
  t.alike(w.kids, [seeder.blobPub.kid, cur])
  t.is(w.items.length, 0)
})

test('a forced top-up from an empty wallet buys only the shortfall plus the margin', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  t.is(FORCE_MARGIN, 8)
  const client = clientFor(seeder, { wallet: BLOB_STAMP_WALLET, walletLow: BLOB_STAMP_WALLET_LOW })
  const sealed = sealBlob(png(2 * coreBlob.BLOB_CHUNK_BYTES + 10))
  t.is(sealed.descriptor.chunks, 3)
  await client.send(sealed, identity)
  t.is(seeder.blobIssues, 3 + FORCE_MARGIN, 'not a full wallet before the first put')
  t.is(seeder.puts.length, 3)
  t.is(await client.walletSize(), FORCE_MARGIN)
  t.is(await client.topUp(identity), 0, 'the background top-up waits its interval')
  t.is(await client.topUp(identity, { force: true }), BLOB_STAMP_WALLET - FORCE_MARGIN, 'a top-up with no send waiting still fills the wallet')
})

test('a maximum blob downloads under the seeder bucket with the default pacing', async (t) => {
  t.timeout(120000)
  const plain = png(8 * 1024 * 1024 - 45)
  const sealed = sealBlob(plain)
  t.is(sealed.descriptor.chunks, coreBlob.BLOB_MAX_CHUNKS)
  const route = fakeRoute(sealed, { burst: 128, perSecond: 64 })
  const got = await fetchBlob(sealed.descriptor, 'http://127.0.0.1:1', { mime: 'image/png', fetch: route.fetch })
  t.ok(b4a.equals(got.bytes, plain), 'every chunk arrived')
  t.is(route.gets.length, coreBlob.BLOB_MAX_CHUNKS, 'one GET per chunk')
  t.ok(route.statuses.every((s) => s === 200), 'no 503 from the bucket')
})

test('a 503 or 429 read honours Retry-After and retries at most 3 times; a 404 is not retried', async (t) => {
  t.timeout(120000)
  const plain = png(coreBlob.BLOB_CHUNK_BYTES + 10)
  const sealed = sealBlob(plain)
  const d = sealed.descriptor
  const origin = 'http://127.0.0.1:1'
  const bad = (p) => p.then(() => null, (e) => e)

  let route = fakeRoute(sealed, { answer: (index, n) => (index === 1 && n === 1 ? { status: 503, retryAfter: 1 } : null) })
  const started = Date.now()
  const got = await fetchBlob(d, origin, { mime: 'image/png', fetch: route.fetch })
  t.ok(Date.now() - started >= 900, 'the Retry-After second was waited')
  t.ok(b4a.equals(got.bytes, plain), 'the retried chunk then succeeds')
  t.alike(route.gets, [0, 1, 1])

  route = fakeRoute(sealed, { answer: (index, n) => (index === 0 && n <= 3 ? { status: 429 } : null) })
  t.ok(b4a.equals((await fetchBlob(d, origin, { mime: 'image/png', fetch: route.fetch, limits: { retryDefaultMs: 5 } })).bytes, plain), 'three 429s and then a frame succeed')
  t.alike(route.gets, [0, 0, 0, 0, 1])

  route = fakeRoute(sealed, { answer: (index) => (index === 0 ? { status: 503, retryAfter: 3600 } : null) })
  let err = await bad(fetchBlob(d, origin, { fetch: route.fetch, limits: { retryAfterMaxMs: 5 } }))
  t.is(err && err.message, 'sem conexão com o semeador', 'a 503 on every try is the normal error')
  t.alike(route.gets, [0, 0, 0, 0], 'the first GET and 3 retries, no more')

  route = fakeRoute(sealed, { answer: (index) => (index === 0 ? { status: 404 } : null) })
  err = await bad(fetchBlob(d, origin, { fetch: route.fetch, limits: { retryDefaultMs: 5 } }))
  t.is(err && err.message, 'mídia indisponível')
  t.alike(route.gets, [0], 'a 404 fails at once')
})

test('a retry puts every frame again: a swept partial blob is refused, a live one completes with repeats', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc, partialMs: 1 })
  const identity = crypto.keyPair()
  const client = clientFor(seeder, { wallet: 6, walletLow: 2 })
  t.is(await client.topUp(identity), 6)
  const bad = (p) => p.then(() => null, (e) => e)

  // Chunk 0 acked, chunk 1 refused 'cheio'; the pool then sweeps the partial blob.
  const a = sealBlob(png(coreBlob.BLOB_CHUNK_BYTES + 10))
  t.is(a.descriptor.chunks, 2)
  await client.stamp(a, identity)
  seeder.refuse = (index) => (index === 1 ? 'cheio' : undefined)
  let err = await bad(client.put(a))
  t.is(err && err.message, 'o semeador está cheio: tente mais tarde')
  t.alike(a.acked, [true, false])
  seeder.refuse = null
  await new Promise((resolve) => setTimeout(resolve, 10))
  t.is(seeder.pool.sweep(), 1, 'the partial blob is swept')
  const frame0 = a.frames[0]
  seeder.puts.length = 0
  err = await bad(client.put(a))
  t.is(err && err.message, 'mídia recusada pelo semeador', 'the retry is refused, never a success')
  t.absent(err && err.uncertain)
  t.is(seeder.puts.length, 2, 'the retry sends both frames')
  t.ok(b4a.equals(seeder.puts[0], frame0), 'frame 0 is sent again')
  t.is(seeder.acks[seeder.acks.length - 2], null, 'its spent token is refused')
  t.is(a.frames[0], null, 'the refused frame is cleared for a new stamp')
  t.alike(a.acked, [false, true])
  const info = seeder.pool.info(a.id)
  t.ok(info && !info.complete, 'the blob is not complete')
  // The next send stamps frame 0 again and completes the blob.
  await client.send(a, identity)
  t.ok(seeder.pool.info(a.id).complete, 'a new stamp completes the blob')

  // A retry while the partial blob is still held completes it with repeats.
  const b = sealBlob(png(coreBlob.BLOB_CHUNK_BYTES + 10))
  await client.stamp(b, identity)
  const issues = seeder.blobIssues
  const size = await client.walletSize()
  seeder.refuse = (index) => (index === 1 ? 'cheio' : undefined)
  await bad(client.put(b))
  seeder.refuse = null
  const at = seeder.acks.length
  await client.put(b)
  t.is(seeder.acks.length - at, 2, 'both frames are sent')
  t.ok(seeder.acks[at].ok && seeder.acks[at].repeated === true, 'frame 0 is answered as a repeat')
  t.ok(seeder.acks[at + 1].ok && seeder.acks[at + 1].repeated !== true, 'frame 1 is stored')
  t.alike(b.acked, [true, true])
  t.ok(seeder.pool.info(b.id).complete)
  t.is(seeder.blobIssues, issues, 'no stamp is issued')
  t.is(await client.walletSize(), size, 'no wallet stamp is spent')
  t.ok(b4a.equals((await fetchBlob(b.descriptor, seeder.origin)).bytes.subarray(0, 8), png(1).subarray(0, 8)))
})

test('a full wallet checks the seeder key after the interval and adopts a rotated kid', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const client = clientFor(seeder, { wallet: 4, walletLow: 2, keyCheckMs: 200 })
  const fake = (kid, i) => ({ kid, ...client.local.seal({ token: (i + 1).toString(16).padStart(64, '0'), sig: postage.toBase64(5n) }) })
  const kid = seeder.blobPub.kid
  await store.writeBlobStamps(client.storage, { items: [0, 1, 2, 3].map((i) => fake(kid, i)), kids: [kid] })

  t.is(await client.topUp(identity), 0, 'the key is current: nothing is bought')
  t.is(seeder.connections, 1, 'the full wallet asked the key')
  t.is(await client.topUp(identity), 0)
  t.is(seeder.connections, 1, 'not again within the interval')

  // The seeder rotated: the wallet's pair is two older keys.
  const cur = 'a1'.repeat(8)
  const prev = 'b2'.repeat(8)
  await store.writeBlobStamps(client.storage, { items: [...[0, 1, 2, 3].map((i) => fake(cur, i)), fake(prev, 9)], kids: [cur, prev] })
  t.is(await client.walletSize(), 5)
  await new Promise((resolve) => setTimeout(resolve, 250))
  t.is(await client.topUp(identity), 1, 'one stamp under the new kid')
  t.is(seeder.connections, 2)
  t.is(seeder.blobIssues, 1)
  const w = await store.readBlobStamps(client.storage)
  t.alike(w.kids, [kid, cur], 'the verified key became current')
  t.is(w.items.filter((s) => s.kid === prev).length, 0, 'the stamp outside the pair was dropped')
  t.is(await client.walletSize(), 5)
})

test('a frame refused invalido is stamped again by the next send; acked frames are kept', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const client = clientFor(seeder, { wallet: 6, walletLow: 2 })
  t.is(await client.topUp(identity), 6)
  const sealed = sealBlob(png(coreBlob.BLOB_CHUNK_BYTES + 10))
  await client.stamp(sealed, identity)
  const [f0, f1] = sealed.frames
  seeder.refuse = (index) => (index === 1 ? null : undefined)
  const err = await client.put(sealed).then(() => null, (e) => e)
  seeder.refuse = null
  t.is(err && err.message, 'mídia recusada pelo semeador')
  t.ok(sealed.frames[0] === f0, 'the acked frame is kept')
  t.is(sealed.frames[1], null, 'the refused frame is cleared')
  t.is(await client.walletSize(), 4)

  await client.send(sealed, identity)
  t.is(await client.walletSize(), 3, 'one fresh stamp for the refused frame')
  t.ok(sealed.frames[0] === f0)
  t.not(tokensOf([sealed.frames[1]])[0], tokensOf([f1])[0], 'the frame carries a new stamp')
  t.ok(seeder.acks[seeder.acks.length - 2].repeated === true, 'frame 0 is a repeat')
  t.ok(seeder.pool.info(sealed.id).complete)
})

test('an image is checked by its bytes whatever the mime says, compared case-insensitively', async (t) => {
  const origin = 'http://127.0.0.1:1'
  const bad = (p) => p.then(() => null, (e) => e)
  const huge = png(100)
  huge.writeUInt32BE(10000, 16)
  huge.writeUInt32BE(10000, 20)
  const big = sealBlob(huge)
  for (const mime of ['Image/png', 'IMAGE/PNG', 'audio/ogg', 'video/mp4', undefined]) {
    const err = await bad(fetchBlob(big.descriptor, origin, { mime, fetch: fakeRoute(big).fetch }))
    t.is(err && err.message, 'mídia inválida', 'an over-limit image is refused as ' + mime)
  }
  const small = sealBlob(png(100))
  const got = await fetchBlob(small.descriptor, origin, { mime: 'IMAGE/PNG', fetch: fakeRoute(small).fetch })
  t.alike([got.bounds.width, got.bounds.height], [64, 48], 'an upper-case image mime is checked and accepted')
  const labelled = await fetchBlob(small.descriptor, origin, { mime: 'audio/ogg', fetch: fakeRoute(small).fetch })
  t.ok(labelled.bounds !== null, 'image bytes under another label are still bounded')
  const voice = sealBlob(b4a.from('OggS' + 'x'.repeat(200)))
  const v = await fetchBlob(voice.descriptor, origin, { mime: 'audio/ogg', fetch: fakeRoute(voice).fetch })
  t.is(v.bounds, null, 'non-image bytes under an audio mime pass with no bounds')
  const err = await bad(fetchBlob(voice.descriptor, origin, { mime: 'Image/PNG', fetch: fakeRoute(voice).fetch }))
  t.is(err && err.message, 'mídia inválida', 'an image mime still requires an image')
})

test('a frame body is never buffered past the frame size', async (t) => {
  const origin = 'http://127.0.0.1:1'
  const bad = (p) => p.then(() => null, (e) => e)
  const sealed = sealBlob(png(100))
  const frame = new Uint8Array(await (await fakeRoute(sealed).fetch(origin + '/blob/x/0')).arrayBuffer())
  t.is(frame.byteLength, coreBlob.BLOB_FRAME_BYTES)
  const stats = { reads: 0, cancelled: false, arrayBuffer: 0 }
  const answer = (body) => async () => ({
    status: 200,
    redirected: false,
    headers: { get: () => null },
    body,
    arrayBuffer: async () => {
      stats.arrayBuffer++
      return new ArrayBuffer(64 * 1024 * 1024)
    }
  })
  // An endless body with no Content-Length.
  const endless = {
    getReader: () => ({
      read: async () => {
        stats.reads++
        return { done: false, value: new Uint8Array(65536) }
      },
      cancel: async () => { stats.cancelled = true }
    })
  }
  let err = await bad(fetchBlob(sealed.descriptor, origin, { fetch: answer(endless) }))
  t.is(err && err.message, 'mídia inválida')
  t.ok(stats.reads <= Math.ceil(coreBlob.BLOB_FRAME_BYTES / 65536) + 1, 'the read stops past the cap')
  t.ok(stats.cancelled, 'the stream is cancelled')
  t.is(stats.arrayBuffer, 0, 'the body is never read whole')

  err = await bad(fetchBlob(sealed.descriptor, origin, { fetch: answer(undefined) }))
  t.is(err && err.message, 'mídia inválida', 'no stream and no Content-Length is refused')
  t.is(stats.arrayBuffer, 0)

  // The real frame streamed in pieces with no Content-Length still opens.
  let at = 0
  const pieces = {
    getReader: () => ({
      read: async () => {
        if (at >= frame.byteLength) return { done: true, value: undefined }
        const v = frame.slice(at, at + 1000)
        at += v.byteLength
        return { done: false, value: v }
      },
      cancel: async () => {}
    })
  }
  const got = await fetchBlob(sealed.descriptor, origin, { mime: 'image/png', fetch: answer(pieces) })
  t.ok(got.bounds !== null, 'a streamed frame of the right size is accepted')
})

test('a top-up goes on over a new stamp link when one hits its deadline, and stops at teto', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const slow = { wallet: 20, walletLow: 5, issueBurst: 2, issuePaceMs: 50, link: { stampDeadlineMs: 400 } }
  const client = clientFor(seeder, slow)
  t.is(await client.topUp(identity), 20, 'the whole target is bought')
  t.ok(seeder.connections >= 2, 'over more than one stamp link')
  t.is(await client.walletSize(), 20)
  const tokens = await walletTokens(client)
  t.is(new Set(tokens).size, 20)

  const capped = await blobSeeder(t, { signer: assoc, blobBudget: 3 })
  const other = clientFor(capped, slow)
  t.is(await other.topUp(identity), 3, 'teto ends the top-up')
  t.is(capped.connections, 1, 'no new link after teto')
})

test('every frame GET bypasses the HTTP cache', async (t) => {
  t.timeout(60000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const plain = png(coreBlob.BLOB_CHUNK_BYTES + 10)
  const sealed = sealBlob(plain)
  await clientFor(seeder).send(sealed, crypto.keyPair())
  const inits = []
  const spying = (url, init) => {
    inits.push(init)
    return fetch(url, init)
  }
  const { bytes } = await fetchBlob(sealed.descriptor, seeder.origin, { fetch: spying })
  t.ok(b4a.equals(bytes, plain))
  t.is(inits.length, 2)
  for (const init of inits) {
    t.is(init.cache, 'no-store')
    t.is(init.credentials, 'omit')
  }
})

test('a rotated kid adopted after a stale key check keeps no stamp under any other kid', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const fake = (local, kid, i) => ({ kid, ...local.seal({ token: (i + 1).toString(16).padStart(64, '0'), sig: postage.toBase64(5n) }) })
  const cur = 'a1'.repeat(8)
  const prev = 'b2'.repeat(8)

  // Last check 8 days ago: the old current kid may no longer be the previous.
  const stale = clientFor(seeder, { wallet: 4, walletLow: 2 })
  await stale.storage.writeJson('blobKeyCheck', { v: 1, at: Date.now() - 8 * 24 * 3600000 })
  await store.writeBlobStamps(stale.storage, { items: [0, 1, 2].map((i) => fake(stale.local, cur, i)), kids: [cur, prev] })
  t.is(await stale.topUp(identity), 4, 'every stamp counts as gone, so the fill buys the whole wallet')
  let w = await store.readBlobStamps(stale.storage)
  t.alike(w.kids, [seeder.blobPub.kid], 'the new kid stands alone')
  t.is(w.items.filter((s) => s.kid !== seeder.blobPub.kid).length, 0, 'no stamp under another kid is kept')
  const check = await stale.storage.readJson('blobKeyCheck')
  t.ok(check.at > Date.now() - 60000, 'the key check time is stored again')

  // A recent check keeps the pair as before.
  const fresh = clientFor(seeder, { wallet: 4, walletLow: 2 })
  await fresh.storage.writeJson('blobKeyCheck', { v: 1, at: Date.now() - 3600000 })
  await store.writeBlobStamps(fresh.storage, { items: [0, 1, 2].map((i) => fake(fresh.local, cur, i)), kids: [cur, prev] })
  t.is(await fresh.topUp(identity), 1, 'three stamps stay usable under the previous kid')
  w = await store.readBlobStamps(fresh.storage)
  t.alike(w.kids, [seeder.blobPub.kid, cur])
  t.is(w.items.filter((s) => s.kid === cur).length, 3)
})

test('a frame body that ended early is a transient error; a complete frame of the wrong size is a bad blob', async (t) => {
  const origin = 'http://127.0.0.1:1'
  const bad = (p) => p.then(() => null, (e) => e)
  const sealed = sealBlob(png(100))
  const frame = new Uint8Array(await (await fakeRoute(sealed).fetch(origin + '/blob/x/0')).arrayBuffer())
  const streamOf = (bytes) => {
    let done = false
    return {
      getReader: () => ({
        read: async () => {
          if (done) return { done: true, value: undefined }
          done = true
          return { done: false, value: bytes }
        },
        cancel: async () => {}
      })
    }
  }
  const answer = (body, length) => async () => ({
    status: 200,
    redirected: false,
    headers: { get: (n) => (n === 'content-length' ? length : null) },
    body
  })
  let err = await bad(fetchBlob(sealed.descriptor, origin, { fetch: answer(streamOf(frame.slice(0, frame.byteLength - 100)), null) }))
  t.ok(err !== null)
  t.not(err && err.message, 'mídia inválida', 'a body cut short with no Content-Length is not a bad blob')
  t.not(err && err.message, 'mídia indisponível')
  err = await bad(fetchBlob(sealed.descriptor, origin, { fetch: answer(streamOf(frame.slice(0, 1000)), String(frame.byteLength)) }))
  t.not(err && err.message, 'mídia inválida', 'a body shorter than its Content-Length is not a bad blob')
  err = await bad(fetchBlob(sealed.descriptor, origin, { fetch: answer(streamOf(frame.slice(0, 1000)), '1000') }))
  t.is(err && err.message, 'mídia inválida', 'a complete frame of the wrong size is')
})

test('a failed write of the key check time is retried by the next top-up', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const base = memoryNodeStorage()
  let failWrite = true
  const storage = {
    ...base,
    async writeJson (k, v) {
      if (k === 'blobKeyCheck' && failWrite) throw new Error('disco cheio')
      return base.writeJson(k, v)
    }
  }
  const client = clientFor(seeder, { storage, wallet: 4, walletLow: 2 })
  const kid = seeder.blobPub.kid
  const fake = (i) => ({ kid, ...client.local.seal({ token: (i + 1).toString(16).padStart(64, '0'), sig: postage.toBase64(5n) }) })
  await store.writeBlobStamps(base, { items: [0, 1, 2, 3].map(fake), kids: [kid] })
  t.is(await client.topUp(identity), 0, 'the key is current')
  t.is(await base.readJson('blobKeyCheck'), null, 'its check time was not stored')
  failWrite = false
  await client.topUp(identity)
  const check = await base.readJson('blobKeyCheck')
  t.ok(check !== null && check.at > Date.now() - 60000, 'the next top-up stores it')
})

test('a failed read of the key check time is not cached: the next top-up reads it and applies the stale rule', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const base = memoryNodeStorage()
  const local = localSeal()
  let failRead = true
  let offline = true
  const storage = {
    ...base,
    async readJson (k) {
      if (k === 'blobKeyCheck' && failRead) {
        failRead = false
        throw new Error('leitura falhou')
      }
      return base.readJson(k)
    }
  }
  const client = createBlobClient({
    seederUrl: seeder.url,
    createSocket: (u) => createSocket(offline ? 'ws://127.0.0.1:1/' : u),
    association: seeder.assoc,
    storage,
    seal: local.seal,
    open: local.open,
    limits: { wallet: 4, walletLow: 2, issuePaceMs: 0 }
  })
  const cur = 'a1'.repeat(8)
  const prev = 'b2'.repeat(8)
  await base.writeJson('blobKeyCheck', { v: 1, at: Date.now() - 8 * 24 * 3600000 })
  await store.writeBlobStamps(base, { items: [0, 1, 2].map((i) => ({ kid: cur, ...local.seal({ token: (i + 1).toString(16).padStart(64, '0'), sig: postage.toBase64(5n) }) })), kids: [cur, prev] })
  t.is(await client.topUp(identity), 0, 'the seeder is unreachable')
  t.absent(failRead, 'the stored check was read once and failed')
  offline = false
  t.is(await client.topUp(identity, { force: true }), 4, 'read again: stale, so every old stamp counts as gone')
  const w = await store.readBlobStamps(base)
  t.alike(w.kids, [seeder.blobPub.kid], 'the new kid stands alone')
})

test('a top-up resolves only once the key check time is stored', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const seeder = await blobSeeder(t, { signer: assoc })
  const identity = crypto.keyPair()
  const base = memoryNodeStorage()
  const storage = {
    ...base,
    async writeJson (k, v) {
      if (k === 'blobKeyCheck') await new Promise((resolve) => setTimeout(resolve, 200))
      return base.writeJson(k, v)
    }
  }
  const client = clientFor(seeder, { storage, wallet: 4, walletLow: 2 })
  t.is(await client.topUp(identity, { force: true }), 4, 'a new key bought stamps')
  const bought = await base.readJson('blobKeyCheck')
  t.ok(bought !== null && bought.at > Date.now() - 60000, 'stored before the purchase resolved')

  // Any write still in flight lands before the slate is cleared.
  await new Promise((resolve) => setTimeout(resolve, 300))
  await base.writeJson('blobKeyCheck', null)
  t.is(await client.topUp(identity, { force: true }), 0, 'the key is current and the wallet full')
  const checked = await base.readJson('blobKeyCheck')
  t.ok(checked !== null && checked.at > Date.now() - 60000, 'stored before the key check resolved')
})
