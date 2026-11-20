'use strict'

// Shared by page-dm.test.js and page-dm-buckets.test.js: member nodes over
// an in-memory client against helpers/dm-seeder.js, and page diaries copied
// into their storage as stored replicas.
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createCert } = require('@varanda/core/lib/cert')
const { signRoster, signOrigin, issuerCountersign } = require('@varanda/core/lib/page')
const dmCore = require('@varanda/core/lib/dm')
const { createBrowserNode } = require('../../lib/node')
const { createMember } = require('../../lib/member')
const { memoryStorage } = require('../../lib/storage')
const { memoryNodeStorage } = require('../../lib/node-storage')
const { dmBoxKeyPairFromPrf } = require('../../lib/passkey')
const store = require('../../lib/node-store')
const { connectClient } = require('./session')

const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function until (fn, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('tempo esgotado')
}

async function wallet (storage) {
  const w = await storage.readJson('dmStamps')
  return w && Array.isArray(w.items) ? w.items.length : 0
}

// peeks: what the seeder answers for a dm-key (member -> { box, gen } or
// null); a member not in it fails, as without a seeder.
async function memberNode (t, assoc, url, { prf = crypto.randomBytes(32), ...extra } = {}) {
  const peeks = new Map()
  const peekCalls = new Map()
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const node = createBrowserNode({
    storage,
    association: hex(assoc.publicKey),
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { dm: { issuePaceMs: 0 } },
    writeGate: false,
    dmKeyPeek: async (key) => {
      try {
        if (!peeks.has(key)) throw new Error('sem semeador')
        return peeks.get(key)
      } finally {
        peekCalls.set(key, (peekCalls.get(key) || 0) + 1)
      }
    },
    ...extra
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc) })
  await web.request('dm.enable')
  await until(async () => (await wallet(storage)) >= dmCore.DM_STAMP_WALLET)
  const box = await dmBoxKeyPairFromPrf(prf, 1)
  return { node, web, storage, peeks, peekCalls, key: publicKey, keyPair, prf, box: hex(box.publicKey) }
}

// A page diary: block 0 its certificate, then a roster naming `owner` and a
// dm-key with `box` and `keyGen` (none when keyGen is null).
// movedFrom: the page key a page-origin at seq 3 names (keyGen not null).
async function pageDiary (t, { assoc, issuer, pageKp, ownerKp, box, keyGen = 1, movedFrom = null }) {
  const m = await createMember({ storage: memoryStorage(), association: hex(assoc.publicKey), keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  const page = hex(pageKp.publicKey)
  await m.setCert(createCert({ member: page }, assoc))
  const fields = { page, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: AT, nonce: RNONCE, association: hex(assoc.publicKey) }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuer.kp, issuer.cert))
  if (keyGen !== null) await m.core.append({ type: 'dm-key', box, gen: keyGen, at: AT })
  if (movedFrom !== null) {
    const origin = { page, from: movedFrom, fromSeq: 2, gen: 1, owner: hex(ownerKp.publicKey), admins: [], at: AT, nonce: RNONCE, actor: hex(ownerKp.publicKey), association: hex(assoc.publicKey) }
    await m.core.append(issuerCountersign({ type: 'page-origin', ...origin, signature: signOrigin(origin, ownerKp) }, issuer.kp, issuer.cert))
  }
  return m
}

// Copies the page diary into `storage` as a stored replica, whole.
async function hold (m, storage) {
  const dst = await store.openReplica(storage, m.key)
  const a = m.core.replicate(true, { keepAlive: false })
  const b = dst.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await dst.update({ wait: true })
    await dst.download({ start: 0, end: m.core.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await dst.close()
  }
}

// Copies a member's diary into another node's storage (what a follow would
// have downloaded), so dm.lookup finds its dm-key locally.
async function copyDiary (from, to) {
  const src = await store.openDiary(from.storage)
  const dst = await store.openReplica(to.storage, from.key)
  const a = src.replicate(true)
  const b = dst.replicate(false)
  a.pipe(b).pipe(a)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: src.length }).done()
  a.destroy()
  b.destroy()
  await src.close()
  await dst.close()
}

// What the account service's dm-sign answers: the page key's signature over
// the digest and an expiry it chose.
function signed (digest, kp, expiresAt = Date.now() + dmCore.DM_V3_TTL_MS) {
  return { signature: dmCore.signDigest(digest, kp.secretKey, expiresAt), expiresAt }
}

module.exports = { AT, RNONCE, noop, hex, until, wallet, memberNode, pageDiary, hold, copyDiary, signed }
