'use strict'

// lib/sig-store.js (verified signature digests kept in the node's storage)
// and lib/warm-sigs.js (WebCrypto ahead of the synchronous checks).

const test = require('brittle')
const b4a = require('b4a')
const path = require('node:path')
const verified = require('@varanda/core/lib/verified')
const cert = require('@varanda/core/lib/cert')
const { memberCertRecord } = require('@varanda/core/lib/records')
const { memoryNodeStorage } = require('../lib/node-storage')
const { keepVerified, KEY } = require('../lib/sig-store')
const { warmBlock0, warmLogs } = require('../lib/warm-sigs')

// The copy @varanda/core lib/verified.js checks signatures with.
const crypto = require(require.resolve('hypercore-crypto', { paths: [path.dirname(require.resolve('@varanda/core/lib/verified'))] }))

const DATE = '2026-10-19T00:00:00.000Z'

function countChecks (t) {
  const real = crypto.verify
  const counter = { n: 0 }
  crypto.verify = function (...args) {
    counter.n++
    return real.apply(this, args)
  }
  t.teardown(() => { crypto.verify = real })
  verified.clearMemo()
  t.teardown(verified.clearMemo)
  return counter
}

function signed (text) {
  const kp = crypto.keyPair()
  const message = b4a.from(text)
  return { kp, message, signature: crypto.sign(message, kp.secretKey) }
}

async function until (fn) {
  for (let i = 0; i < 200 && !(await fn()); i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

test('the digests of verified signatures survive a restart, saved on close', async (t) => {
  const checks = countChecks(t)
  const storage = memoryNodeStorage()
  const first = keepVerified(storage, { delayMs: 60 * 60 * 1000 })
  await first.loaded
  const s = signed('varanda')
  t.is(verified.verify(s.message, s.signature, s.kp.publicKey), true)
  t.is(await storage.readJson(KEY), null, 'not written before the delay')
  await first.close()
  const data = await storage.readJson(KEY)
  t.is(data.v, 1)
  t.is(data.digests.length, 64, 'written on close')
  t.is(verified.exportDigests(), '', 'dropped from memory when the last node closed')

  verified.clearMemo()
  checks.n = 0
  const second = keepVerified(storage)
  await second.loaded
  t.is(verified.verify(s.message, s.signature, s.kp.publicKey), true)
  t.is(checks.n, 0, 'answered from the stored digest')
  const other = b4a.from(s.message)
  other[0] ^= 1
  t.is(verified.verify(other, s.signature, s.kp.publicKey), false, 'another message is still checked')
  await second.close()
})

test('a new digest is written a moment later, without waiting for close', async (t) => {
  countChecks(t)
  const storage = memoryNodeStorage()
  const kept = keepVerified(storage, { delayMs: 10 })
  t.teardown(() => kept.close())
  await kept.loaded
  const s = signed('varanda')
  verified.verify(s.message, s.signature, s.kp.publicKey)
  await until(async () => (await storage.readJson(KEY)) !== null)
  t.is((await storage.readJson(KEY)).digests.length, 64)
})

test('a torn or foreign stored value reads as none', async (t) => {
  countChecks(t)
  for (const value of [{ v: 2, digests: 'ab'.repeat(32) }, { v: 1, digests: 'zz'.repeat(32) }, { v: 1, digests: 7 }, 'texto']) {
    const storage = memoryNodeStorage()
    await storage.writeJson(KEY, value)
    const kept = keepVerified(storage)
    await kept.loaded
    t.is(verified.exportDigests(), '', JSON.stringify(value))
    await kept.close()
  }
})

test('two nodes in one process: the digests stay until the last one closes', async (t) => {
  countChecks(t)
  const a = keepVerified(memoryNodeStorage(), { delayMs: 60 * 60 * 1000 })
  const b = keepVerified(memoryNodeStorage(), { delayMs: 60 * 60 * 1000 })
  await Promise.all([a.loaded, b.loaded])
  const s = signed('varanda')
  verified.verify(s.message, s.signature, s.kp.publicKey)
  await a.close()
  t.is(verified.exportDigests().length, 64, 'kept while a node is open')
  await b.close()
  t.is(verified.exportDigests(), '', 'dropped when the last one closed')
})

test('a check made while the stored list loads is kept, and the save waits for that list', async (t) => {
  countChecks(t)
  const storage = memoryNodeStorage()
  const earlier = signed('antes')
  const stored = keepVerified(storage)
  await stored.loaded
  verified.verify(earlier.message, earlier.signature, earlier.kp.publicKey)
  await stored.close()
  const saved = (await storage.readJson(KEY)).digests

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const readJson = storage.readJson.bind(storage)
  storage.readJson = async (key) => { await gate; return readJson(key) }
  const kept = keepVerified(storage, { delayMs: 1 })
  const s = signed('durante')
  verified.verify(s.message, s.signature, s.kp.publicKey)
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is((await readJson(KEY)).digests, saved, 'nothing written before the stored list is in')
  release()
  await kept.close()
  const data = await readJson(KEY)
  t.is(data.digests.length, 128, 'both the stored digest and the new one')
  t.ok(data.digests.startsWith(saved))
})

function issued () {
  const assocKp = crypto.keyPair()
  const assocHex = b4a.toString(assocKp.publicKey, 'hex')
  const issuerKp = crypto.keyPair()
  const issuerCert = cert.createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex'), date: DATE }, assocKp)
  const member = b4a.toString(crypto.keyPair().publicKey, 'hex')
  const c = cert.createIssuedCert({ member, date: DATE }, issuerKp, issuerCert)
  const old = cert.createUsernameRecord({ member, username: 'ana', date: DATE }, issuerKp, issuerCert)
  const newest = cert.createUsernameRecord({ member, username: 'bia', date: DATE }, issuerKp, issuerCert)
  return { assocHex, member, c, old, newest }
}

test('warm: a log\'s certificate and newest own username record are checked ahead', async (t) => {
  if (await verified.useSubtle(globalThis.crypto ? globalThis.crypto.subtle : null) === null) {
    t.pass('no WebCrypto Ed25519 on this platform')
    return
  }
  const checks = countChecks(t)
  const { assocHex, member, c, old, newest } = issued()
  verified.clearMemo()
  checks.n = 0
  const someoneElse = { ...newest, member: 'cd'.repeat(32) }
  const entries = [{ seq: 0, record: memberCertRecord(c) }, { seq: 1, record: old }, { seq: 2, record: newest }, { seq: 3, record: someoneElse }]
  t.is(await warmLogs([{ key: member, entries }], assocHex), 4, 'the certificate and the newest own record')
  t.alike(cert.certForKey(c, member, assocHex), { ok: true })
  t.alike(cert.verifyUsernameRecord(newest, member, assocHex), { ok: true })
  t.is(checks.n, 0, 'answered from the memo')
  t.alike(cert.verifyUsernameRecord(old, member, assocHex), { ok: true })
  t.is(checks.n, 1, 'an older record was not warmed')

  verified.clearMemo()
  checks.n = 0
  t.is(await warmBlock0(b4a.from(JSON.stringify(memberCertRecord(c))), assocHex), 2)
  t.alike(cert.certForKey(c, member, assocHex), { ok: true })
  t.is(checks.n, 0, 'block 0 answered from the memo')
  t.is(await warmBlock0(b4a.from('não é json'), assocHex), 0)
  t.is(await warmBlock0(null, assocHex), 0)
  t.is(await warmLogs([{ key: member, entries }], 'zz'), 0, 'no association, nothing warmed')
})
