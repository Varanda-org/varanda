'use strict'

// Shared by the history copy end-to-end tests that follow dm-copy-e2e.test.js
// (which keeps its own copies of these): helpers over the real Seeder and
// real browser nodes of ./dm-e2e.js. Local DHT and tmp dirs only.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const { createCert, createIssuerCert } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { createMember } = require('../../lib/member')
const { memoryStorage } = require('../../lib/storage')
const { dmBoxKeyPairFromPrf } = require('../../lib/passkey')
const store = require('../../lib/node-store')
const { hex } = require('./dm-e2e')

const BLOB = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Copies `from`'s diary into `to`'s storage as a stored replica.
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

// The seeder restarts with its dm pool emptied, as after the retention sweep.
async function sweepPool (host) {
  await host.current.close()
  host.current = null
  const dir = path.join(host.dataDir, 'dm-pool')
  for (const name of fs.readdirSync(dir)) if (name !== 'seq.json') fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  await host.start()
}

// The copy stamps the seeder counted in all (copy-stamps.json).
function copyUsed (host) {
  const file = path.join(host.dataDir, 'copy-stamps.json')
  if (!fs.existsSync(file)) return 0
  const days = JSON.parse(fs.readFileSync(file, 'utf8')).days
  let n = 0
  for (const row of Object.values(days)) for (const c of Object.values(row)) n += c
  return n
}

function textsOf (thread) {
  return thread.messages.map((m) => m.text).sort()
}

// A Página owned by `owner` (a node), adopted on it: its diary (certificate,
// a roster naming the owner and a dm-key) replicated into `nodes`, then the
// secrets generated and adopted. -> the page key (hex).
async function adoptPage (t, assoc, owner, nodes) {
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp) }
  const boxOwner = hex((await dmBoxKeyPairFromPrf(owner.prf, 1)).publicKey)
  const pageKp = crypto.keyPair()
  const page = hex(pageKp.publicKey)
  const made = await owner.web.request('dm.pageGenerate', { page, gen: 1, recipients: [{ member: owner.key, box: boxOwner }] })
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex, keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: page }, assoc.kp))
  const fields = { page, gen: 1, owner: hex(owner.keyPair.publicKey), admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, owner.keyPair) }, issuer.kp, issuer.cert))
  await m.core.append({ type: 'dm-key', box: made.box, gen: 1, at: AT })
  for (const n of nodes) {
    const dst = await store.openReplica(n.storage, m.key)
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
  const s = made.shares[0]
  const r = await owner.web.request('dm.pageSecrets', { page, gen: 1, sealed: s.sealed, by: owner.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc.kp) })
  if (!r || r.ok !== true) throw new Error('página não adotada')
  return page
}

module.exports = { BLOB, sleep, copyDiary, sweepPool, copyUsed, textsOf, adoptPage }
