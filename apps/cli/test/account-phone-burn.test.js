'use strict'

// Issue #534: which blocks burn a number through Excluir conta. server.js
// wires the phone store's burnable and cleared rules to a real moderation
// store; snapshots are signed here with a local moderator certificate and
// acked as the operator's `mod apply` would. Loopback only: the Didit fake
// of helpers/fake-didit.js, real stores in a tmp dir, a fake passkey.

const test = require('brittle')
const fs = require('node:fs')
const nodeCrypto = require('node:crypto')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert, createModeratorCert } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { signPhone } = require('@varanda/core/lib/phone')
const { openAccountStore } = require('../lib/account/store')
const { openPhoneStore, FILE } = require('../lib/account/phone-store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { createPhoneClient } = require('../lib/account/phone-client')
const { openPasskeyStore } = require('../lib/account/passkey-store')
const { keyFromAttestation } = require('../lib/account/webauthn')
const { createFakePasskey } = require('./helpers/fake-passkey')
const { createAccountServer } = require('../lib/account/server')
const { startFakeDidit, loopbackFetch, PHONE_CODE } = require('./helpers/fake-didit')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const API_KEY = 'test-phone-key-123'
const EMAIL = 'membro@example.test'
const PHONE_A = '+5511987654321'
const MOD = 'mod@example.test'
const SIG = 'ab'.repeat(64)
const NONCE = 'n'.repeat(43)

function googleStub () {
  return {
    authorizeUrl: () => 'https://accounts.google.test/auth?state=x',
    exchange: async () => { throw new Error('google called') }
  }
}

function member () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

let subSeq = 100
async function linkDirect (store, iss, m, username) {
  const row = store.start({ member: m.hex, username })
  store.reserve(row.id)
  store.putGoogle(row.id, { sub: '40000000000000000' + String(subSeq++).padStart(5, '0'), email: EMAIL })
  await store.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

async function setup (t) {
  const dir = path.join(tmpDir(t), 'account')
  // Every step moves the clock on, so report decisions and sweep stamps
  // never share a millisecond.
  const c = { offset: 0 }
  c.now = () => Date.now() + c.offset
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const iss = { keyPair: kp, cert: createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc) }
  iss.association = iss.cert.association
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: b4a.toString(modKp.publicKey, 'hex'), date: '2026-10-01T00:00:00.000Z' }, assoc)
  const store = openAccountStore(dir, { now: c.now })
  const fake = await startFakeDidit()
  t.teardown(() => fake.close(), { force: true })
  const phones = openPhoneStore(dir, { key: nodeCrypto.randomBytes(32), now: c.now })
  const moderation = openModerationStore(dir, { now: c.now, association: iss.association })
  const passkeys = openPasskeyStore(dir, { now: c.now })
  const client = () => createPhoneClient({ apiKey: API_KEY, endpoints: { base: fake.base }, fetch: loopbackFetch(fake.base) })
  const opts = {
    association: iss.association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    moderation,
    passkeys,
    phoneClient: client(),
    phones,
    log: () => {},
    now: c.now
  }
  const server = createAccountServer(opts)
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function post (pathname, body) {
    const res = await fetch(base + pathname, {
      method: 'POST',
      redirect: 'manual',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  async function step (who, action, extra = {}) {
    const started = await post('/account/phone/start', { member: who.hex })
    if (started.status !== 200) return started
    const nonce = started.body.nonce
    const signature = signPhone({ action, nonce, member: who.hex, association: iss.association }, who.kp)
    return post('/account/phone/' + action, { member: who.hex, nonce, signature, ...extra })
  }

  async function verify (who, number) {
    tick()
    const sent = await step(who, 'send', { phone: number })
    if (sent.status !== 200 || sent.body.state !== 'enviado') return sent
    return step(who, 'check', { code: PHONE_CODE })
  }

  // A linked member with a verified number and a passkey, so Excluir conta
  // can run.
  async function holder (username) {
    const who = member()
    await linkDirect(store, iss, who, username)
    t.is((await verify(who, PHONE_A)).body.state, 'verificado', username + ' verifies')
    const pk = createFakePasskey({ rpId: 'varanda.test' })
    const key = keyFromAttestation({ attestationObject: pk.attestationObject(), credentialId: pk.credentialId, rpId: 'varanda.test' })
    await passkeys.add({ member: who.hex, credentialId: pk.credentialId, ...key })
    who.pk = pk
    return who
  }

  async function remove (who) {
    tick()
    const st = await post('/account/delete/start', { member: who.hex })
    t.is(st.status, 200, st.text)
    const done = await post('/account/delete/finish', {
      member: who.hex,
      nonce: st.body.nonce,
      signature: signAccountLink({ phase: 'delete', nonce: st.body.nonce, member: who.hex, username: st.body.username, association: iss.association, sub: '' }, who.kp),
      assertion: who.pk.assert({ challenge: Buffer.from(st.body.nonce, 'base64url'), origin: ORIGIN })
    })
    t.is(done.status, 200, done.text)
    t.ok(store.deletedAt(who.hex) !== null, 'deleted')
  }

  async function reportBlock (who) {
    tick()
    const { report } = await moderation.add({ reporter: member().hex, target: who.hex, seq: 3, reason: 'spam', text: 'propaganda', quote: 'compre já', signature: SIG, nonce: NONCE })
    tick()
    await moderation.decide(report.id, { decision: 'bloquear', by: MOD })
  }

  // The operator's `mod apply`: every pending change into the next snapshot.
  let seq = 0
  async function publish () {
    tick()
    const { changes, published } = await moderation.pull()
    const list = new Set(published.snapshot ? published.snapshot.blocked : [])
    for (const ch of changes) {
      if (ch.op === 'block') list.add(ch.member)
      else list.delete(ch.member)
    }
    const snapshot = createSnapshot({ seq: ++seq, date: new Date(c.now()).toISOString(), blocked: [...list].sort() }, modKp, modCert)
    await moderation.ack({ changeIds: changes.map((ch) => ch.id), snapshot, moderatorCert: modCert })
  }

  async function unblock (who) {
    tick()
    return moderation.unblock(who.hex, { by: MOD })
  }

  // A second service on the same stores runs the start sweep with the
  // server's own callbacks; resolves once that sweep is done.
  async function sweep (who) {
    tick()
    createAccountServer({ ...opts, google: googleStub(), phoneClient: client() })
    await phones.settled(who.hex)
  }

  function tick () {
    c.offset += 61 * 1000
  }

  const burned = () => phones.counts().burned
  const cleared = () => JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')).cleared
  return { c, store, phones, moderation, verify, holder, remove, reportBlock, publish, unblock, sweep, burned, cleared }
}

test('burn: a member unblocked before Excluir conta keeps no burn once the deletion block publishes', async (t) => {
  const s = await setup(t)
  const ana = await s.holder('ana')
  await s.reportBlock(ana)
  await s.publish()
  await s.sweep(ana)
  t.is(s.burned(), 1, 'burned while blocked')

  await s.unblock(ana)
  await s.publish()
  await s.sweep(ana)
  t.is(s.burned(), 0, 'the unblock gives it back')

  await s.remove(ana)
  t.ok(s.moderation.pending().changes.some((ch) => ch.member === ana.hex && ch.op === 'block'), 'Excluir conta queues its own block')
  await s.publish()
  t.ok(s.moderation.blocked().some((b) => b.member === ana.hex && b.reportIds.length === 1), 'listed again with the old report')
  await s.sweep(ana)
  t.is(s.burned(), 0, 'the old report no longer burns the number')
  t.is((await s.verify(member(), PHONE_A)).body.state, 'verificado', 'another member records it')
})

test('burn: a member deleting while the block is in force keeps the burn', async (t) => {
  const s = await setup(t)
  const bia = await s.holder('bia')
  await s.reportBlock(bia)
  await s.publish()
  await s.sweep(bia)
  t.is(s.burned(), 1)
  await s.remove(bia)
  await s.publish()
  await s.sweep(bia)
  t.is(s.burned(), 1, 'burn kept after the deletion')
  t.alike((await s.verify(member(), PHONE_A)).body, { error: 'telefone-em-uso' })
})

test('burn: a block decided but not published at Excluir conta burns once both blocks publish', async (t) => {
  const s = await setup(t)
  const caio = await s.holder('caio')
  await s.reportBlock(caio)
  await s.remove(caio)
  t.is(s.burned(), 0, 'not yet: nothing published')
  await s.sweep(caio)
  t.is(s.burned(), 0)
  await s.publish()
  await s.sweep(caio)
  t.is(s.burned(), 1, 'burned once published')
  t.alike((await s.verify(member(), PHONE_A)).body, { error: 'telefone-em-uso' })
})

test('burn: a report decided after Excluir conta burns, even with a sweep before the operator publishes', async (t) => {
  const s = await setup(t)
  const zeca = await s.holder('zeca')
  await s.remove(zeca)
  await s.reportBlock(zeca)
  t.ok(s.moderation.pending().changes.some((ch) => ch.member === zeca.hex && ch.op === 'block' && ch.reportIds.length === 1), 'the report joins the deletion block')
  await s.sweep(zeca)
  t.alike(s.cleared(), {}, 'a report after the deletion clears nothing')
  await s.publish()
  await s.sweep(zeca)
  t.is(s.burned(), 1, 'burned once published')
  t.alike((await s.verify(member(), PHONE_A)).body, { error: 'telefone-em-uso' })
})

test('burn: a report decided while a failed deletion waits burns once the account goes', async (t) => {
  const s = await setup(t)
  const fabio = await s.holder('fabio')
  // Excluir conta queued its block, then the account store failed
  // (resultado-incerto): the account is still there.
  await s.moderation.requestDeletion(fabio.hex)
  t.is(s.store.deletedAt(fabio.hex), null, 'not deleted')
  await s.reportBlock(fabio)
  await s.sweep(fabio)
  t.alike(s.cleared(), {}, 'a report joining the waiting deletion block clears nothing')
  await s.remove(fabio)
  await s.publish()
  await s.sweep(fabio)
  t.is(s.burned(), 1, 'burned once published')
  t.alike((await s.verify(member(), PHONE_A)).body, { error: 'telefone-em-uso' })
})

test('burn: an unblock published with no sweep before Excluir conta is cleared by the deletion\'s own sweep', async (t) => {
  const s = await setup(t)
  const gil = await s.holder('gil')
  await s.reportBlock(gil)
  await s.publish()
  await s.sweep(gil)
  t.is(s.burned(), 1)
  await s.unblock(gil)
  await s.publish()
  t.alike(s.cleared(), {}, 'no sweep yet')
  await s.remove(gil)
  t.ok(s.cleared()[gil.hex], 'the sweep before the deletion block clears it')
  await s.publish()
  await s.sweep(gil)
  t.is(s.burned(), 0, 'the old report no longer burns the number')
  t.is((await s.verify(member(), PHONE_A)).body.state, 'verificado', 'another member records it')
})

test('burn: a lift of a claimed block, cancelled before the operator publishes, clears nothing', async (t) => {
  const s = await setup(t)
  const hugo = await s.holder('hugo')
  await s.reportBlock(hugo)
  await s.moderation.pull()
  const { change } = await s.unblock(hugo)
  t.is(change.op, 'unblock', 'appended next to the claimed block')
  await s.sweep(hugo)
  t.alike(s.cleared(), {}, 'nothing cleared while both wait')
  await s.moderation.cancel(change.id, { by: MOD })
  await s.remove(hugo)
  await s.publish()
  await s.sweep(hugo)
  t.is(s.burned(), 1, 'burned once the block publishes')
  t.alike((await s.verify(member(), PHONE_A)).body, { error: 'telefone-em-uso' })
})

test('burn: a report decided after the unblock burns again, through the deletion', async (t) => {
  const s = await setup(t)
  const davi = await s.holder('davi')
  await s.reportBlock(davi)
  await s.publish()
  await s.sweep(davi)
  await s.unblock(davi)
  await s.publish()
  await s.sweep(davi)
  t.is(s.burned(), 0, 'unblocked and cleared')

  await s.reportBlock(davi)
  await s.publish()
  await s.sweep(davi)
  t.is(s.burned(), 1, 'a new block burns while the account exists')
  await s.remove(davi)
  await s.publish()
  await s.sweep(davi)
  t.is(s.burned(), 1, 'and the deletion keeps it')
  t.alike((await s.verify(member(), PHONE_A)).body, { error: 'telefone-em-uso' })
})

test('burn: an unblock still waiting for the operator clears nothing; cancelled, the deletion keeps the burn', async (t) => {
  const s = await setup(t)
  const eva = await s.holder('eva')
  await s.reportBlock(eva)
  await s.publish()
  await s.sweep(eva)
  t.is(s.burned(), 1)

  const { change } = await s.unblock(eva)
  t.is(change.op, 'unblock', 'queued, not applied')
  await s.sweep(eva)
  t.alike(s.cleared(), {}, 'a pending unblock does not clear')
  t.is(s.burned(), 1, 'nor lift the burn')

  await s.moderation.cancel(change.id, { by: MOD })
  await s.remove(eva)
  await s.publish()
  await s.sweep(eva)
  t.alike(s.cleared(), {}, 'still nothing cleared')
  t.is(s.burned(), 1, 'the number stays burned after the deletion')
  t.alike((await s.verify(member(), PHONE_A)).body, { error: 'telefone-em-uso' })
})
