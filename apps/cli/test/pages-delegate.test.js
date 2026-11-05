'use strict'

// apps/cli/lib/account/pages-delegate.js: a core member's page-delegate
// confirmed over a short-lived loopback link to a real Seeder (local DHT
// only), the diary a Corestore diary whose key is a manifest hash.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const Corestore = require('corestore')
const crypto = require('hypercore-crypto')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSeederCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { createSwarm, attachAdmission } = require('@varanda/core/lib/net')
const { memberCertRecord, postRecord, deleteRecord } = require('@varanda/core/lib/records')
const { startSeedWs } = require('../lib/seed-ws')
const { createPagesDelegate } = require('../lib/account/pages-delegate')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

const AT = new Date(Date.now() - 3600000).toISOString()

function delegate (actor) {
  return { type: 'page-delegate', actor, at: AT }
}

function setup () {
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  return { assocKp, association, issuerKp, issuerCert }
}

async function startSeeder (t, bootstrap, ctx) {
  const dataDir = tmpDir(t, 'varanda-seed-')
  Seeder.ensureConfig(dataDir, ctx.association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, ctx.assocKp)))
  Seeder.addCert(dataDir, certFile, ctx.association)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: ctx.association, log: noop })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return { seeder, publicKey }
}

// Counts the WebSocket links seed-ws hands to the seeder, so a test sees
// whether a verify opened a socket at all.
function countLinks (seeder) {
  const counter = { connections: 0 }
  const accept = seeder.acceptStream.bind(seeder)
  seeder.acceptStream = (...args) => {
    counter.connections++
    return accept(...args)
  }
  return counter
}

// A core member: a Corestore diary (key = manifest hash) whose block 0 is
// a v2 member-cert, dialing the seeder directly and announcing itself.
async function member (t, bootstrap, ctx, seederKey) {
  const store = new Corestore(tmpDir(t, 'varanda-member-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  const key = hex(diary.key)
  const issued = createIssuedCert({ member: key }, ctx.issuerKp, ctx.issuerCert)
  await diary.append(memberCertRecord(issued))
  const swarm = createSwarm(localSwarmOptions(bootstrap))
  t.teardown(() => swarm.destroy(), { force: true })
  const messages = []
  const peers = []
  swarm.on('connection', (socket) => {
    socket.on('error', noop)
    store.replicate(socket)
    peers.push(attachAdmission(socket, { role: 'member', have: [{ key, length: diary.length }], onmessage: (msg) => messages.push(msg) }))
  })
  swarm.joinPeer(b4a.from(seederKey, 'hex'))
  const peer = await until(() => peers.find((p) => p.remoteRole === 'seeder'), { name: 'hello do semeador' })
  peer.send({ type: 'announce', key, cert: issued })
  return {
    key,
    async add (record) {
      await diary.append(record)
      return diary.length - 1
    },
    // The seeder holds every block (its own admission 'have').
    synced: () => until(() => messages.find((x) => (x.type === 'have' || x.type === 'admitted') && x.key === key && x.length >= diary.length), { name: 'have ' + diary.length, timeoutMs: 30000 })
  }
}

// A diary with no member-cert that an honest seeder never admits, copied
// straight into the seeder's store: a seeder that serves it anyway.
async function planted (t, seeder, records) {
  const store = new Corestore(tmpDir(t, 'varanda-planted-'))
  await store.ready()
  t.teardown(() => store.close(), { force: true })
  const diary = store.get({ name: 'diary', valueEncoding: 'json' })
  await diary.ready()
  for (const r of records) await diary.append(r)
  const a = store.replicate(true)
  const b = seeder.store.replicate(false)
  a.on('error', noop)
  b.on('error', noop)
  a.pipe(b).pipe(a)
  t.teardown(() => { a.destroy(); b.destroy() }, { force: true })
  const copy = seeder.store.get({ key: diary.key })
  await copy.ready()
  t.teardown(() => copy.close(), { force: true })
  await copy.download({ start: 0, end: diary.length }).done()
  return { key: hex(diary.key) }
}

test('pages-delegate: a core diary names its delegate; missing record, missing cert, blocked and self refused; cached until the length moves', async (t) => {
  t.timeout(300000)
  const { bootstrap } = await testnet(t)
  const ctx = setup()
  const { seeder, publicKey: seederKey } = await startSeeder(t, bootstrap, ctx)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const links = countLinks(seeder)
  const seederWs = 'http://127.0.0.1:' + server.port

  const actor = hex(crypto.keyPair().publicKey)
  const other = hex(crypto.keyPair().publicKey)
  const A = await member(t, bootstrap, ctx, seederKey)
  await A.add(postRecord({ text: 'oi', at: AT }))
  await A.add(delegate(actor))
  await A.synced()
  const B = await member(t, bootstrap, ctx, seederKey)
  await B.add(postRecord({ text: 'sem delegado', at: AT }))
  await B.synced()
  const C = await planted(t, seeder, [postRecord({ text: 'sem certificado', at: AT }), delegate(actor)])
  t.not(A.key, actor, 'the diary key is a manifest hash, not the delegate key')

  const logs = []
  const blocked = new Set()
  const tmpRoot = tmpDir(t, 'varanda-delegate-tmp-')
  const d = createPagesDelegate({ seederWs, association: ctx.association, blocklist: blocked, revokedIssuers: () => [], tmpRoot, log: (e) => logs.push(e) })
  t.teardown(() => d.close(), { force: true })

  t.alike(await d.verify({ actor, diary: A.key }), { ok: true, length: 3 }, 'the newest page-delegate names the actor')
  t.is(links.connections, 1, 'one link for the read')
  t.alike(fs.readdirSync(tmpRoot), [], 'the temporary store is removed')
  t.alike(await d.verify({ actor, diary: A.key }), { ok: true, length: 3 }, 'cached answer')
  t.is(links.connections, 1, 'the cache answers without a socket')
  t.alike(await d.verify({ actor: other, diary: A.key }), { ok: false, reason: 'delegado-desconhecido' }, 'another actor is not the delegate')
  t.is(links.connections, 1, 'the cache answers any actor of a known diary')

  t.alike(await d.verify({ actor, diary: B.key }), { ok: false, reason: 'delegado-desconhecido' }, 'no page-delegate record')
  t.alike(await d.verify({ actor, diary: C.key }), { ok: false, reason: 'nao-certificado' }, 'no member-cert in block 0')
  t.alike(await d.verify({ actor: A.key, diary: A.key }), { ok: false, reason: 'delegado-desconhecido' }, 'actor equal to the diary refused')

  blocked.add(actor)
  t.alike(await d.verify({ actor, diary: A.key }), { ok: false, reason: 'bloqueado' }, 'a blocked actor refused')
  blocked.delete(actor)
  blocked.add(A.key)
  t.alike(await d.verify({ actor, diary: A.key }), { ok: false, reason: 'bloqueado' }, 'a blocked diary refused')
  blocked.delete(A.key)

  const revoked = createPagesDelegate({ seederWs, association: ctx.association, revokedIssuers: () => [hex(ctx.issuerKp.publicKey)], tmpRoot })
  t.teardown(() => revoked.close(), { force: true })
  t.alike(await revoked.verify({ actor, diary: A.key }), { ok: false, reason: 'nao-certificado' }, 'a revoked issuer refused')
  const unreadable = createPagesDelegate({ seederWs, association: ctx.association, revokedIssuers: () => { throw new Error('moderation unreadable') }, tmpRoot })
  t.teardown(() => unreadable.close(), { force: true })
  t.alike(await unreadable.verify({ actor, diary: A.key }), { ok: false, reason: 'indisponivel' }, 'an unreadable revocation list refuses, never accepts')

  t.ok(logs.length > 0 && logs.every((e) => Object.keys(e).length === 2 && e.event === 'page-delegate' && typeof e.reason === 'string'), 'logs carry event and reason only')
  t.ok(logs.every((e) => !JSON.stringify(e).includes(A.key) && !JSON.stringify(e).includes(actor)), 'no key in the logs')

  // Past the recheck window: an unchanged length answers from the cache
  // over a link, a moved length reads the blocks again.
  const fresh = createPagesDelegate({ seederWs, association: ctx.association, tmpRoot, limits: { recheckMs: 0 } })
  t.teardown(() => fresh.close(), { force: true })
  t.alike(await fresh.verify({ actor, diary: A.key }), { ok: true, length: 3 })
  const opened = links.connections
  t.alike(await fresh.verify({ actor, diary: A.key }), { ok: true, length: 3 }, 'same length, same answer')
  t.is(links.connections, opened + 1, 'past the recheck window a link checks the length')
  const seqDelegate = 2
  await A.add(deleteRecord({ seq: seqDelegate, at: AT }))
  await A.synced()
  t.alike(await fresh.verify({ actor, diary: A.key }), { ok: false, reason: 'delegado-desconhecido' }, 'a deleted page-delegate no longer names the actor')
  await A.add(delegate(other))
  await A.synced()
  t.alike(await fresh.verify({ actor: other, diary: A.key }), { ok: true, length: 5 }, 'the newest delegate after the length moved')
  t.alike(await d.verify({ actor, diary: A.key }), { ok: true, length: 3 }, 'within the recheck window the old answer stands')

  // Probes of diaries the seeder does not serve hold at most one read slot,
  // so a known delegate past its recheck still gets a read; a failed probe
  // is answered from the negative cache without a read.
  const probed = createPagesDelegate({ seederWs, association: ctx.association, tmpRoot, limits: { recheckMs: 0, blockTimeoutMs: 3000, deadlineMs: 4000 } })
  t.teardown(() => probed.close(), { force: true })
  const unknown = Array.from({ length: 6 }, () => hex(crypto.keyPair().publicKey))
  const flood = unknown.map((diary) => probed.verify({ actor, diary, probe: true }))
  const t0 = Date.now()
  t.alike(await probed.verify({ actor: other, diary: A.key }), { ok: true, length: 5 }, 'a known delegate is not starved by probes')
  t.ok(Date.now() - t0 < 3000, 'without waiting for the probes')
  await Promise.all(flood)
  const t1 = Date.now()
  t.alike(await probed.verify({ actor, diary: unknown[0], probe: true }), { ok: false, reason: 'indisponivel' })
  t.ok(Date.now() - t1 < 500, 'a failed probe is answered from the negative cache')

  await server.close()
  const gone = createPagesDelegate({ seederWs, association: ctx.association, tmpRoot, limits: { connectTimeoutMs: 2000 } })
  t.teardown(() => gone.close(), { force: true })
  t.alike(await gone.verify({ actor, diary: A.key }), { ok: false, reason: 'indisponivel' }, 'no seeder')
  t.alike(fs.readdirSync(tmpRoot), [], 'every temporary store removed')
})
