'use strict'

// The automatic history copy end to end (lib/dm-copy.js over the real Seeder
// of ./dm-e2e.js): an account whose own diary already names its devices, the
// other devices of the same passkey, and the own drops (claims and copy
// pointers) in the pool. Local DHT and tmp dirs only.

const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert } = require('@varanda/core/lib/cert')
const devices = require('@varanda/core/lib/devices')
const dmCore = require('@varanda/core/lib/dm')
const { memoryNodeStorage } = require('../../lib/node-storage')
const gc = require('@varanda/core/lib/group-crypto')
const { dmBoxKeyPairFromPrf, dmLocalKeyFromPrf } = require('../../lib/passkey')
const { fetchBlob } = require('../../lib/blob')
const store = require('../../lib/node-store')
const ops = require('../../lib/member-ops')
const { until } = require('./net')
const { hex, memberNode, rawDm } = require('./dm-e2e')

const DAY = 86400000

// The own diary of a new account, built before any node opens it: the
// certificate, then one device record per id, the `old` ones registered 20
// days ago (outside the copy window) and the `fresh` ones a moment ago.
async function accountStorage (assoc, keyPair, cert, old, fresh) {
  const storage = memoryNodeStorage()
  const ctx = { storage, association: assoc.hex, keyPair }
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, cert)
  const diary = await store.openDiary(storage, keyPair)
  const key = devices.deviceKey(keyPair.secretKey, diary.key)
  try {
    const now = Date.now()
    let i = 0
    for (const id of old) {
      i++
      await store.appendRecord(diary, devices.sealedRecord({ v: 1, id, name: 'Antigo ' + i, on: true, writers: [] }, key, new Date(now - 20 * DAY + i * 1000).toISOString()))
    }
    for (const id of fresh) {
      i++
      await store.appendRecord(diary, devices.sealedRecord({ v: 1, id, name: 'Novo ' + i, on: true, writers: [] }, key, new Date(now - 60000 + i * 1000).toISOString()))
    }
  } finally {
    devices.wipeKey(key)
    await diary.close()
  }
  return storage
}

// -> { keyPair, prf, cert, own, old, fresh, first }: `old` and `fresh` the
// device ids, `first` the node of old[0] (its diary pushed, dm enabled).
async function account (t, assoc, host, { old = 1, fresh = 1, blob = {} } = {}) {
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const own = hex(keyPair.publicKey)
  const cert = createCert({ member: own }, assoc.kp)
  const oldIds = Array.from({ length: old }, () => devices.newDeviceId())
  const freshIds = Array.from({ length: fresh }, () => devices.newDeviceId())
  const storage = await accountStorage(assoc, keyPair, cert, oldIds, freshIds)
  await store.writeDeviceId(storage, own, oldIds[0])
  const first = await memberNode(t, assoc, host, { keyPair, prf, cert, storage, blob })
  first.id = oldIds[0]
  return { keyPair, prf, cert, own, old: oldIds, fresh: freshIds, first }
}

// Another device of the account, with id `id`: it reads the own diary from
// the seeder and writes nothing there; dm.enable finds the key current.
async function sibling (t, assoc, host, acct, id, { blob = {}, enable = true, factory } = {}) {
  const storage = memoryNodeStorage()
  await ops.idCreate({ storage, association: assoc.hex, keyPair: acct.keyPair })
  await store.writeDeviceId(storage, acct.own, id)
  const n = await memberNode(t, assoc, host, { keyPair: acct.keyPair, prf: acct.prf, cert: acct.cert, addCert: false, storage, blob, enable, factory })
  n.id = id
  return n
}

// The own drops in the pool, opened, in pool order: [{ seq, body }]. A link
// of its own, closed before it returns.
async function ownDrops (t, host, acct) {
  const box = await dmBoxKeyPairFromPrf(acct.prf, 1)
  const ends = []
  const ch = await rawDm({ is: () => {}, teardown: (fn) => ends.push(fn) }, host.url)
  const out = []
  try {
    let after = 0
    for (;;) {
      const page = await ch.requestPage({ after })
      for (const it of page.items) {
        const inner = dmCore.openSealed(dmCore.decodeDrop(it.bytes).sealed, box)
        const body = inner === null ? null : dmCore.openInner(inner, acct.own)
        if (body !== null && (body.kind === 'copy' || body.kind === dmCore.DM_CLAIM_KIND)) out.push({ seq: it.seq, body })
      }
      if (page.next === null || page.items.length === 0) break
      after = page.items[page.items.length - 1].seq
    }
  } finally {
    for (const fn of ends) await fn()
  }
  return out
}

const claimsOf = (drops) => drops.filter((d) => d.body.kind === dmCore.DM_CLAIM_KIND)
const copiesOf = (drops) => drops.filter((d) => d.body.kind === 'copy')

// Waits for `n` copy pointers (the text and any photo batches) in the pool.
async function copied (t, host, acct, n = 1, timeoutMs = 120000) {
  let drops = []
  await until(async () => {
    drops = await ownDrops(t, host, acct)
    return copiesOf(drops).length >= n
  }, { name: 'copy pointers', timeoutMs, intervalMs: 500 })
  return drops
}

// Starts the continuous run whose dm tick kicks the automatic copy. A
// complete dm.pull right before makes that tick kick without pulling.
async function kick (n) {
  await n.web.request('dm.pull')
  await n.web.request('sync.start', {})
}

// The copier's own record (kv dmAutoCopy, sealed under the local key of its
// PRF), or null.
async function autoOf (n) {
  const sealed = await store.readDmAutoCopy(n.storage)
  if (sealed === null) return null
  return gc.openRecord(sealed, await dmLocalKeyFromPrf(n.prf))
}

// Waits until the copier has no job left and counts a target as done: the
// text and every photo batch it could pay went.
async function idle (t, n, timeoutMs = 120000) {
  await until(async () => {
    const a = await autoOf(n)
    return a !== null && a.job === null && a.done.length > 0
  }, { name: 'copy job ended', timeoutMs, intervalMs: 500 })
}

// The manifest a copy pointer names, fetched from the seeder and parsed.
async function manifestOf (host, drop) {
  const d = drop.body.copy
  const u = new URL(host.url)
  const r = await fetchBlob({ id: d.id, key: d.key, nonce: d.nonce, chunks: d.chunks, bytes: d.bytes, sha256: d.sha256 }, 'http://' + u.host, { mime: 'application/json' })
  return JSON.parse(b4a.toString(r.bytes, 'utf8'))
}

// One more copy from the same device to the same targets: the copier forgets
// what it copied (its record) and its run starts again, so the next tick
// claims anew. What a test needs to send several copies to one receiver.
async function kickAgain (n) {
  await n.web.request('sync.stop')
  await store.writeDmAutoCopy(n.storage, null)
  await kick(n)
}

module.exports = { account, sibling, ownDrops, claimsOf, copiesOf, copied, kick, autoOf, idle, manifestOf, kickAgain }
