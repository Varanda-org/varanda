'use strict'

// Excluir conta: apps/cli/lib/account/delete-routes.js (start and finish over
// the account-link proof at phase 'delete' and a fresh assertion of a stored
// passkey, or a deletion that waits 7 days), the directory deletion
// (./store.js deleteMember), the queued block in the moderation desk (actor
// 'titular') and the purge of the other stores (./deletion.js). Loopback
// only: members are linked in-process, Google is never reached and the
// passkeys are software ones (./helpers/fake-passkey.js).

const test = require('brittle')
const path = require('node:path')
const fs = require('node:fs')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert, createModeratorCert } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openAgeStore } = require('../lib/account/age-store')
const { openPushStore } = require('../lib/account/push-store')
const { openPushDeviceStore } = require('../lib/account/push-device-store')
const { openRecoveryStore } = require('../lib/account/recovery-store')
const { openInvitesStore } = require('../lib/account/invites-store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { openSeenStore } = require('../lib/account/seen-store')
const { HASH_NONE } = require('@varanda/core/lib/seen-proof')
const { SEEN_BLOB_BYTES } = require('@varanda/core/lib/seen-blob')
const { openPasskeyStore } = require('../lib/account/passkey-store')
const { openPhoneStore } = require('../lib/account/phone-store')
const { keyFromAttestation } = require('../lib/account/webauthn')
const { createFakePasskey } = require('./helpers/fake-passkey')
const { createAccountServer } = require('../lib/account/server')
const { createDeleteRoutes, WAIT_MS } = require('../lib/account/delete-routes')
const { createDeletionSweep, createModerationRetention, MODERATION_RETENTION_MS } = require('../lib/account/deletion')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const RP = 'varanda.test'
const SUB = '1098765432109876543210'
const EMAIL = 'membro@example.test'

const google = {
  authorizeUrl: () => { throw new Error('google called') },
  exchange: async () => { throw new Error('google called') }
}

function keyPair () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association, assoc }
}

async function linkDirect (accounts, iss, m, username, sub = SUB, email = EMAIL) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

function b64u (buf) {
  return Buffer.from(buf).toString('base64url')
}

// Stores `pk`'s public key for `member`, as the enrolment at sign-up does.
async function enrol (passkeys, member, pk) {
  const key = keyFromAttestation({ attestationObject: pk.attestationObject(), credentialId: pk.credentialId, rpId: RP })
  await passkeys.add({ member, credentialId: pk.credentialId, ...key })
}

// The ceremony's answer over a deletion nonce (its 32 bytes are the challenge).
function assertion (pk, nonce, opts = {}) {
  return pk.assert({ challenge: Buffer.from(nonce, 'base64url'), origin: ORIGIN, ...opts })
}

function recoveryBlob () {
  return { v: 1, kind: 'code', nonce: b4a.toString(crypto.randomBytes(24), 'hex'), ciphertext: b4a.toString(crypto.randomBytes(82), 'hex') }
}

// A service with `m` linked as 'ana' and every store the deletion purges.
async function setup (t, { moderation: withModeration = true, enrolled = true, phones = null, phoneClient = null, extra = async () => ({}) } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const iss = issuer()
  const store = openAccountStore(dir, { now })
  const m = keyPair()
  await linkDirect(store, iss, m, 'ana')
  const terms = openTermsStore(dir, { now })
  const ages = openAgeStore(dir, { now })
  const recovery = openRecoveryStore(dir, { now })
  const invites = openInvitesStore(dir, { now, perWeek: 3, isUsed: (id) => store.inviteUsed(id) })
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: b4a.toString(modKp.publicKey, 'hex'), date: '2026-10-01T00:00:00.000Z' }, iss.assoc)
  const moderation = withModeration ? openModerationStore(dir, { now, association: iss.association }) : null
  await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  await ages.record({ member: m.hex, band: '18+', method: 'didit' })
  await recovery.put({ member: m.hex, kind: 'code', lookupId: b4a.toString(crypto.randomBytes(32), 'hex'), blob: recoveryBlob() })
  await invites.issue(m.hex)
  const passkeys = openPasskeyStore(dir, { now })
  const pk = createFakePasskey({ rpId: RP })
  if (enrolled) await enrol(passkeys, m.hex, pk)
  const logs = []
  const texts = []
  const more = await extra({ dir, now, store, iss, moderation, m })
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    terms,
    ages,
    recovery,
    invites,
    moderation,
    passkeys,
    phones,
    phoneClient,
    log: (e) => logs.push(JSON.stringify(e)),
    now,
    ...more
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function post (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) })
    const text = await res.text()
    texts.push(text)
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  async function status (who) {
    const res = await fetch(base + '/account/status?member=' + who.hex)
    const text = await res.text()
    texts.push(text)
    return JSON.parse(text)
  }

  const sign = (who, nonce, username) => signAccountLink({ phase: 'delete', nonce, member: who.hex, username, association: iss.association, sub: '' }, who.kp)
  const start = (who) => post('/account/delete/start', { member: who.hex })
  const finish = (who, nonce, signature, extra = {}) => post('/account/delete/finish', { member: who.hex, nonce, signature, ...extra })

  // start -> passkey ceremony -> sign -> finish for `who` with `withKey`.
  async function del (who, withKey = pk) {
    const started = await start(who)
    if (started.status !== 200) return started
    return finish(who, started.body.nonce, sign(who, started.body.nonce, started.body.username), { assertion: assertion(withKey, started.body.nonce) })
  }

  const signCancel = (who, nonce, username) => signAccountLink({ phase: 'cancel', nonce, member: who.hex, username, association: iss.association, sub: '' }, who.kp)

  // The operator's `mod apply`: pull, sign a list with the key, ack.
  async function apply (blocked) {
    const pulled = await moderation.pull()
    const snapshot = createSnapshot({ seq: 1, date: new Date().toISOString(), blocked }, modKp, modCert)
    await moderation.ack({ changeIds: pulled.changes.map((c) => c.id), snapshot, moderatorCert: modCert })
  }

  return { dir, clock, iss, store, terms, ages, recovery, invites, moderation, passkeys, pk, m, logs, texts, post, status, sign, signCancel, start, finish, del, apply, server }
}

test('Excluir conta: start, sign, finish; the link and every store entry go, the block is queued, status follows the list', async (t) => {
  const s = await setup(t)
  const started = await s.start(s.m)
  t.is(started.status, 200, started.text)
  t.alike(Object.keys(started.body).sort(), ['nonce', 'passkeys', 'scheduled', 'username'])
  t.is(started.body.username, 'ana')
  t.alike(started.body.passkeys, [s.pk.credentialId], 'the stored credential ids only')
  t.is(started.body.scheduled, null)
  const done = await s.finish(s.m, started.body.nonce, s.sign(s.m, started.body.nonce, 'ana'), { assertion: assertion(s.pk, started.body.nonce) })
  t.is(done.status, 200, done.text)
  t.alike(done.body, { deleted: 'pendente' })

  t.is(s.store.status(s.m.hex).linked, false)
  t.is(s.store.lookup('ana'), null)
  t.alike(s.terms.list(s.m.hex), [], 'terms acceptances gone')
  t.is(s.ages.get(s.m.hex), null, 'age band gone')
  t.alike(s.recovery.list(s.m.hex), [], 'recovery entries gone')
  t.is(s.invites.holds(s.m.hex), false, 'issued invites gone')
  t.alike(s.passkeys.keys(s.m.hex), [], 'passkey public keys gone')
  const pending = s.moderation.pending().changes
  t.is(pending.length, 1)
  t.is(pending[0].op, 'block')
  t.is(pending[0].member, s.m.hex)
  t.is(pending[0].by, 'titular')

  t.alike(await s.status(s.m), { linked: false, deleted: 'pendente' })
  await s.apply([s.m.hex])
  t.alike(await s.status(s.m), { linked: false, deleted: 'concluida' }, 'once the published list holds the key')

  const again = await s.start(s.m)
  t.is(again.status, 409)
  t.is(again.body.error, 'conta-excluida')

  const all = s.texts.join('\n') + '\n' + s.logs.join('\n')
  t.absent(all.includes(EMAIL), 'no e-mail in a response or log line')
  t.absent(all.includes(SUB), 'no sub in a response or log line')
  t.absent(s.logs.join('\n').includes(s.m.hex), 'no key in a log line')
  t.ok(s.logs.some((l) => l.includes('"exclusao"') && l.includes('"pedido"')))
})

test('Excluir conta: a wrong phase, another @nome, a spent nonce or another key is refused and deletes nothing', async (t) => {
  const s = await setup(t)
  const other = keyPair()
  let st = await s.start(s.m)
  const renameSig = signAccountLink({ phase: 'rename', nonce: st.body.nonce, member: s.m.hex, username: 'ana', association: s.iss.association, sub: '' }, s.m.kp)
  let r = await s.finish(s.m, st.body.nonce, renameSig)
  t.is(r.body.error, 'assinatura-invalida', 'a rename proof is no delete')
  r = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'))
  t.is(r.body.error, 'expirado', 'the nonce was spent by the first finish')

  st = await s.start(s.m)
  r = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'outra'))
  t.is(r.body.error, 'assinatura-invalida', 'the typed @nome must be the current one')

  st = await s.start(s.m)
  r = await s.finish(s.m, st.body.nonce, s.sign(other, st.body.nonce, 'ana'))
  t.is(r.body.error, 'assinatura-invalida', 'signed by another key')

  r = await s.start(other)
  t.is(r.body.error, 'nao-vinculado', 'an unlinked key')
  r = await s.post('/account/delete/start', { member: 'zz' })
  t.is(r.body.error, 'pedido-invalido')

  t.is(s.store.status(s.m.hex).linked, true, 'still linked')
  t.is(s.moderation.pending().changes.length, 0, 'nothing queued')
  t.is(s.ages.get(s.m.hex) !== null, true, 'nothing purged')
})

test('Excluir conta: without a moderation desk nothing is deleted', async (t) => {
  const s = await setup(t, { moderation: false })
  const r = await s.del(s.m)
  t.is(r.status, 503)
  t.is(r.body.error, 'indisponivel')
  t.is(s.store.status(s.m.hex).linked, true)
})

test('Excluir conta: a key already deleted answers finish with its state, so a retry ends well', async (t) => {
  const s = await setup(t)
  const st = await s.start(s.m)
  const sig = s.sign(s.m, st.body.nonce, 'ana')
  await s.store.deleteMember(s.m.hex)
  const r = await s.finish(s.m, st.body.nonce, sig)
  t.is(r.status, 200, r.text)
  t.alike(r.body, { deleted: 'pendente' })
})

test('Excluir conta: a missing or forged assertion deletes nothing', async (t) => {
  const s = await setup(t)
  const forged = createFakePasskey({ rpId: RP, credentialId: Buffer.from(s.pk.credentialId, 'base64url') })
  const cases = [
    ['no assertion and no wait', () => ({})],
    ['a forged authenticator answering with the stored credential id', (n) => ({ assertion: assertion(forged, n) })],
    ['the stored passkey over another challenge', () => ({ assertion: assertion(s.pk, crypto.randomBytes(32).toString('base64url')) })],
    ['another origin', (n) => ({ assertion: assertion(s.pk, n, { origin: 'https://evil.test' }) })],
    ['another rp', (n) => ({ assertion: assertion(s.pk, n, { rp: 'evil.test' }) })],
    ['no user verification', (n) => ({ assertion: assertion(s.pk, n, { flags: 0x01 }) })],
    ['an unknown credential, no wait', (n) => ({ assertion: assertion(createFakePasskey({ rpId: RP }), n) })]
  ]
  for (const [label, extra] of cases) {
    // Past the per-member window (5 verified proofs per 10 minutes).
    s.clock.offset += 601 * 1000
    const st = await s.start(s.m)
    const r = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'), extra(st.body.nonce))
    t.is(r.status, 403, label)
    t.is(r.body.error, 'passkey-invalida', label)
  }
  s.clock.offset += 601 * 1000
  let st = await s.start(s.m)
  let r = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'), { assertion: { credentialId: 'x' } })
  t.is(r.body.error, 'pedido-invalido', 'a malformed assertion')
  st = await s.start(s.m)
  r = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'), { wait: 'yes' })
  t.is(r.body.error, 'pedido-invalido', 'wait is true or absent')

  // A good assertion cannot be replayed: its nonce is spent.
  st = await s.start(s.m)
  const good = assertion(s.pk, st.body.nonce)
  const bad = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'outra'), { assertion: good })
  t.is(bad.body.error, 'assinatura-invalida')
  r = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'), { assertion: good })
  t.is(r.body.error, 'expirado', 'the replayed nonce was spent')

  t.is(s.store.status(s.m.hex).linked, true, 'still linked')
  t.is(s.moderation.pending().changes.length, 0, 'nothing queued')
  t.is(s.passkeys.hold(s.m.hex), null, 'nothing scheduled')
  t.ok(s.logs.some((l) => l.includes('"passkey-assinatura"')), 'the refusal reason is logged as a token')
  t.absent(s.logs.join('\n').includes(s.pk.credentialId), 'no credential id in a log line')
})

test('Excluir conta: without a usable passkey the deletion waits 7 days, shows on status, and can be cancelled', async (t) => {
  const s = await setup(t, { enrolled: false })
  const st = await s.start(s.m)
  t.alike(st.body.passkeys, [], 'no key stored (an account from before enrolment)')
  const r = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'), { wait: true, assertion: assertion(s.pk, st.body.nonce) })
  t.is(r.status, 200, r.text)
  const runAt = r.body.scheduled
  t.ok(Math.abs(Date.parse(runAt) - Date.now() - WAIT_MS) < 60000, 'seven days ahead')
  t.is(s.store.status(s.m.hex).linked, true, 'nothing deleted yet')
  t.is(s.moderation.pending().changes.length, 0, 'nothing queued yet')
  const linked = await s.status(s.m)
  t.is(linked.scheduledDeletion, runAt, 'every device learns the date from /account/status')
  t.ok(s.logs.some((l) => l.includes('"agendada"')))

  // Asking again keeps the first date.
  s.clock.offset = 3600 * 1000
  const again = await s.start(s.m)
  t.is(again.body.scheduled, runAt)
  const r2 = await s.finish(s.m, again.body.nonce, s.sign(s.m, again.body.nonce, 'ana'), { wait: true })
  t.is(r2.body.scheduled, runAt)

  // Cancel: a delete proof is no cancel; the cancel proof is.
  let cs = await s.post('/account/delete/cancel/start', { member: s.m.hex })
  t.is(cs.status, 200, cs.text)
  t.alike(Object.keys(cs.body).sort(), ['nonce', 'scheduled', 'username'])
  t.is(cs.body.scheduled, runAt)
  t.is(cs.body.username, 'ana')
  let cf = await s.post('/account/delete/cancel/finish', { member: s.m.hex, nonce: cs.body.nonce, signature: s.sign(s.m, cs.body.nonce, 'ana') })
  t.is(cf.body.error, 'assinatura-invalida', 'a delete proof does not cancel')
  cs = await s.post('/account/delete/cancel/start', { member: s.m.hex })
  const delNonce = (await s.start(s.m)).body.nonce
  cf = await s.post('/account/delete/cancel/finish', { member: s.m.hex, nonce: delNonce, signature: s.signCancel(s.m, delNonce, 'ana') })
  t.is(cf.body.error, 'expirado', 'a delete nonce is no cancel nonce')
  cf = await s.post('/account/delete/cancel/finish', { member: s.m.hex, nonce: cs.body.nonce, signature: s.signCancel(s.m, cs.body.nonce, 'ana') })
  t.alike(cf.body, { cancelled: true })
  t.is((await s.status(s.m)).scheduledDeletion, undefined)
  cs = await s.post('/account/delete/cancel/start', { member: s.m.hex })
  cf = await s.post('/account/delete/cancel/finish', { member: s.m.hex, nonce: cs.body.nonce, signature: s.signCancel(s.m, cs.body.nonce, 'ana') })
  t.alike(cf.body, { cancelled: false }, 'nothing left to cancel')

  // A cancelled deletion never runs, even past its date.
  s.clock.offset = WAIT_MS + 3600 * 1000
  t.alike(await s.server.deletionSweep(), { members: 0, pending: 0 })
  t.is(s.store.status(s.m.hex).linked, true)
})

test('Excluir conta: a waiting deletion runs at its date through the sweep', async (t) => {
  const s = await setup(t, { enrolled: false })
  const st = await s.start(s.m)
  await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'), { wait: true })
  s.clock.offset = WAIT_MS - 60000
  await s.server.deletionSweep()
  t.is(s.store.status(s.m.hex).linked, true, 'not before its date')
  s.clock.offset = WAIT_MS + 60000
  const swept = await s.server.deletionSweep()
  t.is(swept.members, 1, 'deleted and purged in the same sweep')
  t.is(s.store.status(s.m.hex).linked, false)
  t.is(s.moderation.pending().changes[0].by, 'titular')
  t.is(s.passkeys.holds(s.m.hex), false, 'the schedule went with the purge')
  t.alike(s.recovery.list(s.m.hex), [])
  t.ok(s.logs.some((l) => l.includes('"agendada-executada"')))
  t.alike(await s.status(s.m), { linked: false, deleted: 'pendente' })
})

test('Excluir conta: a stored passkey still deletes at once while a wait is pending', async (t) => {
  const s = await setup(t)
  const st = await s.start(s.m)
  await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'), { wait: true })
  t.ok(s.passkeys.hold(s.m.hex))
  const r = await s.del(s.m)
  t.alike(r.body, { deleted: 'pendente' })
  t.is(s.passkeys.holds(s.m.hex), false)
})

test('Excluir conta: an extra passkey vouched for by the stored one is listed and deletes at once, not after the wait', async (t) => {
  const s = await setup(t)
  const lookupId = b4a.toString(crypto.randomBytes(32), 'hex')
  await s.recovery.put({ member: s.m.hex, kind: 'passkey', lookupId, blob: { ...recoveryBlob(), kind: 'passkey' } })
  const extra = createFakePasskey({ rpId: RP })
  const ps = await s.post('/account/passkey/start', { member: s.m.hex })
  const att = extra.attestationObject()
  const sub = nodeCrypto.createHash('sha256').update(Buffer.from(att, 'base64url')).digest('hex')
  const added = await s.post('/account/passkey/add', {
    member: s.m.hex,
    nonce: ps.body.nonce,
    signature: signAccountLink({ phase: 'passkey', nonce: ps.body.nonce, member: s.m.hex, username: 'ana', association: s.iss.association, sub }, s.m.kp),
    credentialId: extra.credentialId,
    attestationObject: att,
    assertion: assertion(s.pk, ps.body.nonce),
    lookupId
  })
  t.alike(added.body, { added: true }, added.text)

  const started = await s.start(s.m)
  t.alike(started.body.passkeys, [s.pk.credentialId, extra.credentialId], 'the extra credential is listed')
  const r = await s.finish(s.m, started.body.nonce, s.sign(s.m, started.body.nonce, 'ana'), { assertion: assertion(extra, started.body.nonce) })
  t.is(r.status, 200, r.text)
  t.alike(r.body, { deleted: 'pendente' })
  t.is(s.passkeys.hold(s.m.hex), null, 'nothing scheduled')
  t.is(s.store.status(s.m.hex).linked, false, 'deleted now')
  t.alike(s.passkeys.keys(s.m.hex), [], 'every key of the member went')
})

// Play's app signing certificate and the EAS keystore's at once: the Android
// app installed from either deletes at once, an unlisted certificate does
// not. The stored fixture passkey signs; only the reported origin changes.
test('Excluir conta: with a certificate list, each listed Android origin deletes at once and an unlisted one is refused', async (t) => {
  const fingerprint = (byte) => Array(32).fill(byte).join(':')
  const apk = (byte) => 'android:apk-key-hash:' + Buffer.alloc(32, parseInt(byte, 16)).toString('base64url')
  const androidCertSha256 = fingerprint('0A') + ',' + fingerprint('0B')
  for (const byte of ['0A', '0B']) {
    const s = await setup(t, { extra: async () => ({ androidCertSha256 }) })
    let st = await s.start(s.m)
    const refused = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'), { assertion: assertion(s.pk, st.body.nonce, { origin: apk('0C') }) })
    t.is(refused.status, 403, refused.text)
    t.is(refused.body.error, 'passkey-invalida', 'an unlisted certificate')
    t.ok(s.logs.some((l) => l.includes('"passkey-origem"')), 'logged as the origin')
    t.is(s.store.status(s.m.hex).linked, true, 'still linked')
    t.is(s.moderation.pending().changes.length, 0, 'nothing queued')

    st = await s.start(s.m)
    const r = await s.finish(s.m, st.body.nonce, s.sign(s.m, st.body.nonce, 'ana'), { assertion: assertion(s.pk, st.body.nonce, { origin: apk(byte) }) })
    t.is(r.status, 200, byte + ': ' + r.text)
    t.alike(r.body, { deleted: 'pendente' }, 'the certificate ' + byte + ' deletes at once')
    t.is(s.store.status(s.m.hex).linked, false)
  }
})

// The routes alone, with the server's helpers stubbed.
function routes ({ accounts, pagesStore = null, moderation = { requestDeletion: async () => ({}) }, association, passkeys, notify, now }) {
  const refuse = (token) => Object.assign(new Error(token), { token })
  return createDeleteRoutes({
    accounts,
    moderation,
    pagesStore,
    passkeys,
    notify,
    now,
    rpId: RP,
    origins: [ORIGIN],
    association,
    memberLimit: () => true,
    send: (res, status, body) => { res.status = status; res.body = body },
    refuse,
    fromStore: (err) => refuse(err.code || 'indisponivel'),
    checkPost: () => {},
    readJsonBody: async (req) => req.body,
    over: () => refuse('over')
  })
}

async function call (r, pathname, body) {
  const res = {}
  try {
    await r.handle({ method: 'POST', body }, res, new URL('http://x' + pathname))
  } catch (err) {
    return { error: err.token }
  }
  return res
}

test('Excluir conta: a member who owns a live page is asked to close or hand it over first', async (t) => {
  const iss = issuer()
  const dir = path.join(tmpDir(t), 'account')
  const accounts = openAccountStore(dir)
  const m = keyPair()
  await linkDirect(accounts, iss, m, 'ana')
  const owned = []
  const pagesStore = { listFor: () => ({ owned, admin: [], invites: [], offers: [] }) }
  const passkeys = openPasskeyStore(dir)
  const pk = createFakePasskey({ rpId: RP })
  await enrol(passkeys, m.hex, pk)
  const r = routes({ accounts, pagesStore, association: iss.association, passkeys })
  owned.push({ page: 'p'.repeat(64), closed: false, movedTo: null })
  t.alike(await call(r, '/account/delete/start', { member: m.hex }), { error: 'paginas-ativas' })
  owned[0] = { page: 'p'.repeat(64), closed: true, movedTo: null }
  const ok = await call(r, '/account/delete/start', { member: m.hex })
  t.is(ok.status, 200, 'a closed page does not hold the deletion')
  owned.push({ page: 'q'.repeat(64), closed: false, movedTo: null })
  const done = await call(r, '/account/delete/finish', { member: m.hex, nonce: ok.body.nonce, signature: signAccountLink({ phase: 'delete', nonce: ok.body.nonce, member: m.hex, username: 'ana', association: iss.association, sub: '' }, m.kp), assertion: assertion(pk, ok.body.nonce) })
  t.alike(done, { error: 'paginas-ativas' }, 'checked again at finish')
  t.is(accounts.status(m.hex).linked, true)
  const broken = routes({ accounts, pagesStore: { listFor: () => { throw new Error('x') } }, association: iss.association, passkeys })
  t.alike(await call(broken, '/account/delete/start', { member: m.hex }), { error: 'indisponivel' }, 'a pages store that cannot answer refuses')
})

test('Excluir conta: a failed queue deletes nothing; a failed directory write is resultado-incerto', async (t) => {
  const iss = issuer()
  const dir = path.join(tmpDir(t), 'account')
  const accounts = openAccountStore(dir)
  const m = keyPair()
  await linkDirect(accounts, iss, m, 'ana')
  const sig = (nonce) => signAccountLink({ phase: 'delete', nonce, member: m.hex, username: 'ana', association: iss.association, sub: '' }, m.kp)
  const passkeys = openPasskeyStore(dir)
  const pk = createFakePasskey({ rpId: RP })
  await enrol(passkeys, m.hex, pk)
  const full = routes({ accounts, moderation: { requestDeletion: async () => { throw Object.assign(new Error('lotado'), { code: 'lotado' }) } }, association: iss.association, passkeys })
  let st = await call(full, '/account/delete/start', { member: m.hex })
  t.alike(await call(full, '/account/delete/finish', { member: m.hex, nonce: st.body.nonce, signature: sig(st.body.nonce), assertion: assertion(pk, st.body.nonce) }), { error: 'lotado' })
  t.is(accounts.status(m.hex).linked, true, 'nothing deleted')

  const queued = []
  const flaky = routes({ accounts: { ...accounts, deleteMember: async () => { throw new Error('disk') } }, moderation: { requestDeletion: async (k) => { queued.push(k) } }, association: iss.association, passkeys })
  st = await call(flaky, '/account/delete/start', { member: m.hex })
  t.alike(await call(flaky, '/account/delete/finish', { member: m.hex, nonce: st.body.nonce, signature: sig(st.body.nonce), assertion: assertion(pk, st.body.nonce) }), { error: 'resultado-incerto' })
  t.alike(queued, [m.hex], 'the block stays queued')
})

test('deletion sweep: purges every store for each deleted key, retries a store that could not answer, logs counts only', async (t) => {
  const iss = issuer()
  const dir = path.join(tmpDir(t), 'account')
  const accounts = openAccountStore(dir)
  const m = keyPair()
  const keep = keyPair()
  await linkDirect(accounts, iss, m, 'ana')
  await linkDirect(accounts, iss, keep, 'bia', 'sub-bia', 'bia@example.test')
  const terms = openTermsStore(dir)
  const ages = openAgeStore(dir)
  const pushStore = openPushStore(dir)
  const pushDeviceStore = openPushDeviceStore(dir)
  const recovery = openRecoveryStore(dir)
  const invites = openInvitesStore(dir, { perWeek: 3 })
  const seen = openSeenStore(dir)
  for (const who of [m, keep]) {
    await seen.put({ member: who.hex, blob: crypto.randomBytes(SEEN_BLOB_BYTES), expectedHash: HASH_NONE })
    await terms.accept({ member: who.hex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
    await ages.record({ member: who.hex, band: '18+', method: 'didit' })
    await pushStore.put({ member: who.hex, endpoint: 'https://fcm.googleapis.com/fcm/send/' + who.hex.slice(0, 8), p256dh: b64u(Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)])), auth: b64u(crypto.randomBytes(16)) })
    await pushDeviceStore.add(who.hex, { transport: 'apns', token: b4a.toString(crypto.randomBytes(32), 'hex'), key: b64u(crypto.randomBytes(16)), createdAt: Date.now() })
    await recovery.put({ member: who.hex, kind: 'code', lookupId: b4a.toString(crypto.randomBytes(32), 'hex'), blob: recoveryBlob() })
    await invites.issue(who.hex)
  }
  let dropsUp = false
  const dropsHeld = new Set([m.hex, keep.hex])
  const drops = {
    available: () => dropsUp,
    holds: (k) => dropsHeld.has(k),
    forget: async (k) => { dropsHeld.delete(k) }
  }
  const passkeys = openPasskeyStore(dir)
  await enrol(passkeys, m.hex, createFakePasskey({ rpId: RP }))
  await enrol(passkeys, keep.hex, createFakePasskey({ rpId: RP }))
  const phoneKey = Buffer.alloc(32, 7)
  const phones = openPhoneStore(dir, { key: phoneKey, disclose: true })
  const phoneCbs = { linked: () => true, burnable: () => false, deleted: () => false }
  await phones.record({ member: m.hex, phone: '+5511987654321' }, phoneCbs)
  await phones.record({ member: keep.hex, phone: '+5521998765432' }, phoneCbs)
  const logs = []
  const sweep = createDeletionSweep({ accounts, terms, ages, pushStore, pushDeviceStore, recovery, invites, drops, seen, passkeys, phones, log: (e) => logs.push(e) })
  t.alike(await sweep.sweep(), { members: 0, pending: 0 }, 'nothing deleted yet')
  await accounts.deleteMember(m.hex)
  const first = await sweep.sweep()
  t.alike(first, { members: 1, pending: 1 }, 'the drops ledger could not answer')
  t.alike(terms.list(m.hex), [])
  t.is(ages.get(m.hex), null)
  t.is(pushStore.devices(m.hex), 0)
  t.is(pushDeviceStore.devices(m.hex), 0)
  t.is(openPushDeviceStore(dir).devices(m.hex), 0)
  t.alike(recovery.list(m.hex), [])
  t.is(invites.holds(m.hex), false)
  t.is(seen.get(m.hex), null, 'the seen blob is gone')
  t.is(passkeys.holds(m.hex), false)
  t.is(phones.live(m.hex), null, 'the phone row is ended')
  t.alike(phones.reveal(m.hex).map((r) => [r.phone, r.end, r.burned]), [['+5511987654321', 'excluida', false]], 'the seal stays for the retention period')
  t.ok(dropsHeld.has(m.hex))
  t.alike(logs.filter((e) => e.reason === 'purga-pendente'), [{ event: 'exclusao', reason: 'purga-pendente', count: 1 }])
  dropsUp = true
  t.alike(await sweep.sweep(), { members: 1, pending: 0 })
  t.absent(dropsHeld.has(m.hex), 'purged on the next sweep')
  t.is(terms.list(keep.hex).length, 1, 'another member keeps everything')
  t.ok(ages.get(keep.hex) !== null)
  t.is(pushStore.devices(keep.hex), 1)
  t.is(pushDeviceStore.devices(keep.hex), 1)
  t.is(recovery.list(keep.hex).length, 1)
  t.ok(invites.holds(keep.hex))
  t.ok(seen.get(keep.hex) !== null)
  t.is(passkeys.keys(keep.hex).length, 1)
  t.ok(dropsHeld.has(keep.hex))
  t.ok(phones.live(keep.hex) !== null, 'another member keeps the number')
  const reopened = openTermsStore(dir)
  t.alike(reopened.list(m.hex), [], 'gone from disk too')
  const phonesAgain = openPhoneStore(dir, { key: phoneKey, disclose: true })
  t.is(phonesAgain.live(m.hex), null, 'ended on disk too')
  t.is(phonesAgain.reveal(m.hex)[0].end, 'excluida')
  t.alike(await sweep.purge(m.hex), { pending: 0 }, 'a second purge has nothing left')

  const brokenDir = path.join(tmpDir(t), 'broken')
  fs.mkdirSync(brokenDir)
  fs.writeFileSync(path.join(brokenDir, 'phone.json'), '{', { mode: 0o600 })
  const brokenPhones = openPhoneStore(brokenDir, { key: phoneKey })
  t.is(brokenPhones.available(), false)
  const brokenLogs = []
  const brokenSweep = createDeletionSweep({ accounts, phones: brokenPhones, log: (e) => brokenLogs.push(e) })
  t.alike(await brokenSweep.sweep(), { members: 1, pending: 1 }, 'an unavailable phone store is pending, never done')
  t.alike(await brokenSweep.purge(m.hex), { pending: 1 })
  t.alike(brokenLogs.filter((e) => e.reason === 'purga-pendente'), [{ event: 'exclusao', reason: 'purga-pendente', count: 1 }, { event: 'exclusao', reason: 'purga-pendente', count: 1 }])
  t.alike(brokenLogs.filter((e) => e.reason === 'arquivo-invalido').map((e) => [e.file, /pendente/.test(e.aviso)]), [['telefone', true]], 'the broken file is named once, with the pending reason')
})

test('Excluir conta: a new wait sends one push notice; a member who came to own a live page is skipped at the date', async (t) => {
  const iss = issuer()
  const dir = path.join(tmpDir(t), 'account')
  const clock = { t: Date.now() }
  const now = () => clock.t
  const accounts = openAccountStore(dir, { now })
  const m = keyPair()
  await linkDirect(accounts, iss, m, 'ana')
  const passkeys = openPasskeyStore(dir, { now })
  const owned = []
  const notified = []
  const queued = []
  const r = routes({
    accounts,
    pagesStore: { listFor: () => ({ owned, admin: [], invites: [], offers: [] }) },
    moderation: { requestDeletion: async (k) => { queued.push(k) } },
    association: iss.association,
    passkeys,
    notify: (k) => notified.push(k),
    now
  })
  const sig = (nonce) => signAccountLink({ phase: 'delete', nonce, member: m.hex, username: 'ana', association: iss.association, sub: '' }, m.kp)
  for (let i = 0; i < 2; i++) {
    const st = await call(r, '/account/delete/start', { member: m.hex })
    const done = await call(r, '/account/delete/finish', { member: m.hex, nonce: st.body.nonce, signature: sig(st.body.nonce), wait: true })
    t.ok(done.body.scheduled)
  }
  t.alike(notified, [m.hex], 'one notice for one schedule')

  owned.push({ page: 'p'.repeat(64), closed: false, movedTo: null })
  clock.t += WAIT_MS + 1000
  t.alike(await r.runScheduled(), { ran: 0, skipped: 1 }, 'a live page holds it')
  t.is(accounts.status(m.hex).linked, true)
  t.ok(passkeys.hold(m.hex), 'still waiting, retried at the next sweep')
  owned[0] = { page: 'p'.repeat(64), closed: true, movedTo: null }
  t.alike(await r.runScheduled(), { ran: 1, skipped: 0 })
  t.alike(queued, [m.hex])
  t.is(accounts.status(m.hex).linked, false)
  t.alike(await r.runScheduled(), { ran: 0, skipped: 0 }, 'nothing left')
})

test('Excluir conta: a schedule write that fails is resultado-incerto, never a definite refusal', async (t) => {
  const iss = issuer()
  const dir = path.join(tmpDir(t), 'account')
  const accounts = openAccountStore(dir)
  const m = keyPair()
  await linkDirect(accounts, iss, m, 'ana')
  const real = openPasskeyStore(dir)
  const passkeys = { ...real, available: () => true, keys: real.keys, hold: real.hold, schedule: async () => { throw Object.assign(new Error('indisponivel'), { code: 'indisponivel' }) } }
  const r = routes({ accounts, association: iss.association, passkeys })
  const st = await call(r, '/account/delete/start', { member: m.hex })
  const sig = signAccountLink({ phase: 'delete', nonce: st.body.nonce, member: m.hex, username: 'ana', association: iss.association, sub: '' }, m.kp)
  t.alike(await call(r, '/account/delete/finish', { member: m.hex, nonce: st.body.nonce, signature: sig, wait: true }), { error: 'resultado-incerto' })
})

test('Excluir conta: without a usable passkeys.json every route answers indisponivel', async (t) => {
  const iss = issuer()
  const dir = path.join(tmpDir(t), 'account')
  const accounts = openAccountStore(dir)
  const m = keyPair()
  await linkDirect(accounts, iss, m, 'ana')
  const none = routes({ accounts, association: iss.association, passkeys: null })
  t.alike(await call(none, '/account/delete/start', { member: m.hex }), { error: 'indisponivel' })
  t.alike(await call(none, '/account/delete/cancel/start', { member: m.hex }), { error: 'indisponivel' })
  t.alike(await none.runScheduled(), { ran: 0, skipped: 0 })
  t.is(none.scheduled(m.hex), null)
})

test('a corrupt feira-invites.json keeps the purge pending and says so once, without contents', async (t) => {
  const { openInvitesStore } = require('../lib/account/invites-store')
  const { pairInvites } = require('../lib/account/invites-pair')
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const secret = 'SEGREDO-NO-ARQUIVO'
  fs.writeFileSync(path.join(dir, 'feira-invites.json'), '{' + secret, { mode: 0o600 })
  const primary = openInvitesStore(dir, { perWeek: 3 })
  const feira = openInvitesStore(dir, { perWeek: 2, file: 'feira-invites.json', capOn: 'use' })
  const pair = pairInvites(primary, feira)
  t.is(feira.available(), false, 'a corrupt file is not read as empty')
  const m = keyPair()
  const logs = []
  const sweep = createDeletionSweep({ accounts: { deleted: () => [], purged: async () => {} }, invites: pair, log: (e) => logs.push(e) })
  t.alike(await sweep.purge(m.hex), { pending: 1 }, 'pending, never done')
  t.alike(await sweep.purge(m.hex), { pending: 1 })
  const warns = logs.filter((e) => e.reason === 'arquivo-invalido')
  t.is(warns.length, 1, 'logged once')
  t.is(warns[0].file, 'feira-invites.json')
  t.ok(/pendente/.test(warns[0].aviso) && /operador/.test(warns[0].aviso))
  t.absent(JSON.stringify(logs).includes(secret) || JSON.stringify(logs).includes(m.hex), 'no contents, no member')
})

// A sealed key share of the size pages-store accepts.
function sealed () {
  return b4a.toString(crypto.randomBytes(213), 'base64')
}

function hex64 () {
  return b4a.toString(crypto.randomBytes(64), 'hex')
}

test('Excluir conta: an admin of another member\'s page loses their pending page state, invite rosters and AI copies; the owner\'s page stays', async (t) => {
  const { openPagesStore } = require('../lib/account/pages-store')
  const { openLedger } = require('../lib/account/ai/ledger')
  const { openExemplarStore } = require('../lib/account/ai/exemplar-store')
  const { createWorker } = require('../lib/account/ai/worker')
  const { quantize } = require('../lib/account/ai/triage')
  const { fakeEmbed, makeEmbed } = require('./helpers/fake-embed')
  const owner = keyPair().hex
  const other = keyPair().hex
  const p1 = keyPair().hex
  const p2 = keyPair().hex
  const env = {}
  const s = await setup(t, {
    extra: async ({ dir, now, moderation, m }) => {
      const pagesStore = openPagesStore(dir, { now })
      await pagesStore.create({ page: p1, owner })
      await pagesStore.create({ page: p2, owner })
      await pagesStore.invite(p1, m.hex, { gen: 2, rosterSignature: hex64() })
      const next = pagesStore.accept(p1, m.hex)
      await pagesStore.setRoster(p1, { gen: next.gen, seq: 3, owner, admins: next.admins })
      const share = (gen) => ({ gen, sealed: sealed(), by: owner, sig: hex64(), at: new Date(now()).toISOString() })
      await pagesStore.setDm(p1, {
        gen: 1,
        box: keyPair().hex,
        groupBox: keyPair().hex,
        shares: { [owner]: share(1), [m.hex]: share(1) },
        pending: {},
        reboxPending: false,
        legacyBundle: null,
        rotatePending: { kind: 'box', idem: owner + ':' + 'n'.repeat(43), gen: 2, box: keyPair().hex, groupBox: keyPair().hex, shares: { [owner]: share(2), [m.hex]: share(2) } }
      })
      await pagesStore.offer(p1, m.hex, new Date(now() + 24 * 3600 * 1000).toISOString())
      await pagesStore.setDm(p2, { gen: 1, box: keyPair().hex, groupBox: keyPair().hex, shares: { [owner]: share(1) }, pending: {}, reboxPending: false, legacyBundle: null, rotatePending: null })
      for (const who of [m.hex, other]) await pagesStore.invite(p2, who, { gen: 2, rosterSignature: hex64(), share: { sealed: sealed(), sig: hex64() } })
      const exp = new Date(now() + 24 * 3600 * 1000).toISOString()
      fs.writeFileSync(path.join(dir, 'page-invite-rosters.json'), JSON.stringify({
        v: 1,
        rows: {
          [p2 + ':' + m.hex]: { record: { owner, admins: [m.hex] }, expiresAt: exp },
          [p2 + ':' + other]: { record: { owner, admins: [other] }, expiresAt: exp },
          [p1 + ':' + other]: { record: { owner, admins: [m.hex, other] }, expiresAt: new Date(now() - 1000).toISOString() }
        }
      }), { mode: 0o600 })

      const ledger = openLedger(dir, { now })
      const exemplars = openExemplarStore(dir, { now, model: 'fake-bow-1' })
      const text = 'compre agora bitcoin gratis clique aqui no link promocao imperdivel'
      const reports = {}
      for (const target of [m.hex, other]) {
        const { report } = await moderation.add({ reporter: owner, target, seq: 1, reason: 'spam', signature: 'ab'.repeat(64), nonce: b4a.toString(crypto.randomBytes(32), 'base64url') })
        reports[target] = report.id
        ledger.putRead(report.id, { target, seq: 1, contentHash: 'cd'.repeat(32), text, hasMedia: false, hasQuote: false, hasPoll: false, textCp: Array.from(text).length, truncated: false, embedding: quantize(fakeEmbed(text)) })
        ledger.mark(report.id, { code: 'frio' })
        exemplars.add({ reportId: b4a.toString(crypto.randomBytes(16), 'base64url'), target, seq: 2, reason: 'spam', decision: 'descartar', contentHash: 'ef'.repeat(32), text, hasMedia: false, embedding: quantize(fakeEmbed(text)) })
      }
      const worker = createWorker({ moderation, exemplars, ledger, readPost: async () => ({ ok: false, code: 'ausente' }), embed: makeEmbed(), modelId: 'fake-bow-1', gapMs: 0, stopWaitMs: 200 })
      t.teardown(() => worker.stop(), { force: true })
      Object.assign(env, { pagesStore, ledger, exemplars, worker, reports, dir })
      return { pages: { pagesStore, dir }, triage: worker }
    }
  })
  const before = env.pagesStore.get(p1)
  const done = await s.del(s.m)
  t.is(done.status, 200, done.text)
  await env.worker.idle()

  const r1 = env.pagesStore.get(p1)
  t.is(r1.owner, owner, 'the owner\'s page is unchanged')
  t.alike(r1.admins, [s.m.hex], 'the admins list waits for the owner\'s Remover')
  t.is(r1.rosterSeq, before.rosterSeq, 'the roster is unchanged')
  t.alike(r1.dm.shares, before.dm.shares, 'the current key shares stay')
  t.is(r1.offer, null, 'the transfer offer to them is gone')
  t.alike(Object.keys(r1.dm.rotatePending.shares), [owner], 'their pending share is gone')
  const r2 = env.pagesStore.get(p2)
  t.alike(Object.keys(r2.invites), [other], 'their pending invite is gone')
  t.alike(Object.keys(r2.dm.pending), [other], 'the key share sealed for them is gone')
  t.absent(env.pagesStore.holdsMember(s.m.hex))
  const rosters = JSON.parse(fs.readFileSync(path.join(env.dir, 'page-invite-rosters.json'), 'utf8')).rows
  t.alike(Object.keys(rosters), [p2 + ':' + other], 'their invite roster is gone, and the expired one with it')

  const mine = env.reports[s.m.hex]
  const theirs = env.reports[other]
  t.is(env.ledger.read(mine), null, 'the cached read with text and embedding is gone')
  t.is(env.ledger.get(mine), null, 'the mark is gone')
  t.absent(env.exemplars.list().some((e) => e.target === s.m.hex), 'their precedents are gone')
  t.ok(env.ledger.read(theirs), 'another member keeps theirs')
  t.ok(env.ledger.get(theirs))
  t.ok(env.exemplars.list().some((e) => e.target === other))
  t.absent(env.worker.holdsMember(s.m.hex))
  const reopened = openLedger(env.dir)
  t.is(reopened.get(mine), null, 'the mark does not come back from the marks log')
  t.is(reopened.read(mine), null)
  t.ok(s.moderation.get(mine), 'the report itself stays (moderation retention is decided elsewhere)')
  t.absent(s.logs.join('\n').includes('purga-pendente'), 'nothing left pending')
})

test('Excluir conta: with the AI triage off, the reads, marks and precedents an earlier run left about the member go at once', async (t) => {
  const { openLedger } = require('../lib/account/ai/ledger')
  const { openExemplarStore } = require('../lib/account/ai/exemplar-store')
  const { createTriageForget } = require('../lib/account/ai/forget')
  const { quantize } = require('../lib/account/ai/triage')
  const { fakeEmbed } = require('./helpers/fake-embed')
  const reporter = keyPair().hex
  const other = keyPair().hex
  const env = {}
  const s = await setup(t, {
    extra: async ({ dir, now, moderation, m }) => {
      const ledger = openLedger(dir, { now })
      const exemplars = openExemplarStore(dir, { now, model: 'fake-bow-1' })
      const text = 'compre agora bitcoin gratis clique aqui no link promocao imperdivel'
      const reports = {}
      for (const target of [m.hex, other]) {
        const { report } = await moderation.add({ reporter, target, seq: 1, reason: 'spam', signature: 'ab'.repeat(64), nonce: b4a.toString(crypto.randomBytes(32), 'base64url') })
        reports[target] = report.id
        ledger.putRead(report.id, { target, seq: 1, contentHash: 'cd'.repeat(32), text, hasMedia: false, hasQuote: false, hasPoll: false, textCp: Array.from(text).length, truncated: false, embedding: quantize(fakeEmbed(text)) })
        ledger.mark(report.id, { code: 'frio' })
        exemplars.add({ reportId: b4a.toString(crypto.randomBytes(16), 'base64url'), target, seq: 2, reason: 'spam', decision: 'descartar', contentHash: 'ef'.repeat(32), text, hasMedia: false, embedding: quantize(fakeEmbed(text)) })
      }
      Object.assign(env, { reports, dir })
      return { triage: null, triageForget: createTriageForget({ dataDir: dir, moderation }) }
    }
  })
  const done = await s.del(s.m)
  t.is(done.status, 200, done.text)

  const ledger = openLedger(env.dir)
  const exemplars = openExemplarStore(env.dir, { model: 'fake-bow-1' })
  const mine = env.reports[s.m.hex]
  const theirs = env.reports[other]
  t.is(ledger.read(mine), null, 'the cached read with text and embedding is gone')
  t.is(ledger.get(mine), null, 'the mark is gone')
  t.absent(exemplars.list().some((e) => e.target === s.m.hex), 'their precedents are gone')
  t.ok(ledger.read(theirs), 'another member keeps theirs')
  t.ok(ledger.get(theirs))
  t.ok(exemplars.list().some((e) => e.target === other))
  t.absent(s.logs.join('\n').includes('purga-pendente'), 'nothing left pending')
  t.absent(s.logs.join('\n').includes(s.m.hex), 'no log names the member')
})

test('Excluir conta: with the AI triage off and no triage files, the deletion creates none', async (t) => {
  const { createTriageForget } = require('../lib/account/ai/forget')
  const env = {}
  const s = await setup(t, {
    extra: async ({ dir, moderation }) => {
      env.dir = dir
      return { triageForget: createTriageForget({ dataDir: dir, moderation }) }
    }
  })
  const done = await s.del(s.m)
  t.is(done.status, 200, done.text)
  for (const f of ['exemplars.json', 'triage.json', 'triage-marks.jsonl']) t.absent(fs.existsSync(path.join(env.dir, f)), f + ' not created')
})

test('deletion sweep: a page store that failed once is finished by the next sweep', async (t) => {
  const { openPagesStore } = require('../lib/account/pages-store')
  const iss = issuer()
  const dir = path.join(tmpDir(t), 'account')
  const accounts = openAccountStore(dir)
  const m = keyPair()
  await linkDirect(accounts, iss, m, 'ana')
  let up = true
  const pagesStore = openPagesStore(dir, { guard: () => up })
  const owner = keyPair().hex
  const page = keyPair().hex
  await pagesStore.create({ page, owner })
  await pagesStore.invite(page, m.hex, { gen: 2, rosterSignature: hex64() })
  await accounts.deleteMember(m.hex)
  up = false
  const sweep = createDeletionSweep({ accounts, pages: pagesStore })
  t.alike(await sweep.sweep(), { members: 1, pending: 1 }, 'the write failed: pending')
  t.ok(pagesStore.holdsMember(m.hex))
  up = true
  t.alike(await sweep.sweep(), { members: 1, pending: 0 })
  t.absent(pagesStore.holdsMember(m.hex), 'finished by the next sweep')
  t.alike(await sweep.purge(m.hex), { pending: 0 })
})

test('Excluir conta: a corrupt page-invite-rosters.json keeps the purge pending, names the file and is left as it was', async (t) => {
  const { openPagesStore } = require('../lib/account/pages-store')
  const env = {}
  const s = await setup(t, {
    extra: async ({ dir, now, m }) => {
      const pagesStore = openPagesStore(dir, { now })
      // The member's own row is in there, so reading the file as empty
      // would wrongly finish their purge.
      const file = path.join(dir, 'page-invite-rosters.json')
      const bytes = '{"v":1,"rows":{"' + keyPair().hex + ':' + m.hex + '":{"record":{}'
      fs.writeFileSync(file, bytes, { mode: 0o600 })
      Object.assign(env, { file, bytes })
      return { pages: { pagesStore, dir } }
    }
  })
  const done = await s.del(s.m)
  t.is(done.status, 200, done.text)
  t.alike(await s.server.deletionSweep(), { members: 1, pending: 1 }, 'pending, never done')
  const logs = s.logs.map((l) => JSON.parse(l))
  const warns = logs.filter((e) => e.reason === 'arquivo-invalido')
  t.alike(warns.map((e) => e.file), ['page-invite-rosters.json'], 'the warning names the file, once')
  t.ok(logs.some((e) => e.reason === 'purga-pendente'))
  t.is(fs.readFileSync(env.file, 'utf8'), env.bytes, 'the file is unchanged byte for byte')
  t.absent(s.logs.join('\n').includes(s.m.hex), 'no member in the logs')
})

const DAY_MS = 86400000

// A directory, a moderation desk and a moderator on one movable clock.
async function retentionSetup (t) {
  const dir = path.join(tmpDir(t), 'account')
  const clock = { t: Date.parse('2026-11-01T12:00:00.000Z') }
  const now = () => clock.t
  const iss = issuer()
  const accounts = openAccountStore(dir, { now })
  const moderation = openModerationStore(dir, { now, association: iss.association })
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: b4a.toString(modKp.publicKey, 'hex'), date: '2026-10-01T00:00:00.000Z' }, iss.assoc)
  let seq = 0
  async function apply (blocked) {
    const pulled = await moderation.pull()
    const snapshot = createSnapshot({ seq: ++seq, date: new Date(now()).toISOString(), blocked }, modKp, modCert)
    await moderation.ack({ changeIds: pulled.changes.map((c) => c.id), snapshot, moderatorCert: modCert })
  }
  const m = keyPair()
  await linkDirect(accounts, iss, m, 'ana')
  const report = (target, reporter) => moderation.add({ reporter, target, seq: 2, reason: 'assedio', text: 'comentário', quote: 'ofensa', signature: 'ab'.repeat(64), nonce: 'n'.repeat(43) })
  return { dir, clock, now, iss, accounts, moderation, apply, m, report }
}

test('deletion sweep: the moderation data of a deleted key goes 180 days after the deletion, not a day sooner', async (t) => {
  const { clock, now, accounts, moderation, apply, m, report } = await retentionSetup(t)
  const other = keyPair().hex
  const about = (await report(m.hex, keyPair().hex)).report
  const filed = (await report(other, m.hex)).report
  await moderation.decide(about.id, { decision: 'bloquear', by: 'mod@example.test' })
  await moderation.decide(filed.id, { decision: 'bloquear', by: 'mod@example.test' })
  await apply([m.hex, other])
  await accounts.deleteMember(m.hex)
  t.is(MODERATION_RETENTION_MS, 180 * DAY_MS)
  const logs = []
  let phoneSweeps = 0
  const retention = createModerationRetention({ accounts, moderation, beforeForget: async () => { phoneSweeps++ }, now, log: (e) => logs.push(e) })
  const sweep = createDeletionSweep({ accounts, retention, log: (e) => logs.push(e) })
  clock.t += 179 * DAY_MS
  t.alike(await sweep.sweep(), { members: 1, pending: 0 })
  t.ok(moderation.get(about.id) !== null, 'kept at 179 days')
  t.is(moderation.get(filed.id).reporter, m.hex)
  t.is(phoneSweeps, 0, 'no phone sweep without a purge')
  clock.t += DAY_MS
  t.alike(await sweep.sweep(), { members: 1, pending: 0 }, 'the result keeps its shape')
  t.is(moderation.get(about.id), null, 'the report about the member is gone at 180 days')
  t.is(moderation.get(filed.id).reporter, null, 'the report it filed against a blocked key is stripped')
  t.is(phoneSweeps, 1, 'the phone sweep ran first')
  t.alike(moderation.blocked().map((b) => b.member).sort(), [m.hex, other].sort(), 'both blocks stay')
  const purged = logs.filter((e) => e.reason === 'moderacao-expurgada')
  t.alike(purged, [{ event: 'exclusao', reason: 'moderacao-expurgada', members: 1, reports: 1, stripped: 1, records: 0, kept: 0, deferred: 0 }])
  t.absent(JSON.stringify(logs).includes(m.hex), 'logs carry no key')
  await sweep.sweep()
  t.is(phoneSweeps, 1, 'nothing left: no second purge')
  t.is(logs.filter((e) => e.reason === 'moderacao-expurgada').length, 1)
})

test('moderation retention: a failing phone sweep skips the pass; a failing desk is counted as pending', async (t) => {
  const { clock, now, accounts, moderation, m, report } = await retentionSetup(t)
  const about = (await report(m.hex, keyPair().hex)).report
  await accounts.deleteMember(m.hex)
  clock.t += 180 * DAY_MS
  const logs = []
  const failing = createModerationRetention({ accounts, moderation, beforeForget: async () => { throw new Error('telefone') }, now, log: (e) => logs.push(e) })
  await failing()
  t.ok(moderation.get(about.id) !== null, 'nothing purged before the burn is written')
  t.alike(logs, [{ event: 'exclusao', reason: 'moderacao-telefone-pendente' }], 'its own code, apart from a stale purge')
  const broken = { holdsDeleted: () => { throw new Error('indisponivel') }, forgetDeleted: async () => { throw new Error('no call') } }
  const brokenLogs = []
  await createModerationRetention({ accounts, moderation: broken, now, log: (e) => brokenLogs.push(e) })()
  t.alike(brokenLogs, [{ event: 'exclusao', reason: 'moderacao-pendente', count: 1 }])
  t.is(createModerationRetention({ accounts, moderation: null }), null, 'no desk, no pass')
  const noDirectory = { deletedMembers: () => { throw new Error('diretorio') }, deletedAt: () => null }
  const dirLogs = []
  await createModerationRetention({ accounts: noDirectory, moderation, now, log: (e) => dirLogs.push(e) })()
  t.alike(dirLogs, [{ event: 'exclusao', reason: 'moderacao-pendente' }], 'a directory that throws is logged, not thrown')
})

test('moderation retention: an anexo whose unlink keeps failing is logged with its count every pass', async (t) => {
  const { dir, clock, now, accounts, moderation, m } = await retentionSetup(t)
  const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3])
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex')
  const r = (await moderation.add({ reporter: keyPair().hex, target: m.hex, seq: 2, reason: 'assedio', text: 'comentário', quote: '', writer: keyPair().hex, group: keyPair().hex, anexo: { bytes, mime: 'image/gif', sha256 }, signature: 'ab'.repeat(64), nonce: 'n'.repeat(43) })).report
  await accounts.deleteMember(m.hex)
  clock.t += 180 * DAY_MS
  const file = path.join(dir, 'report-media', r.id)
  const real = fs.unlinkSync
  fs.unlinkSync = function (target) {
    if (target === file) {
      const err = new Error('EACCES')
      err.code = 'EACCES'
      throw err
    }
    return real.apply(this, arguments)
  }
  t.teardown(() => { fs.unlinkSync = real })
  const logs = []
  const retain = createModerationRetention({ accounts, moderation, now, log: (e) => logs.push(e) })
  await retain()
  t.is(moderation.get(r.id), null, 'the row goes')
  t.ok(fs.existsSync(file), 'the file stays')
  t.alike(logs.filter((e) => e.reason === 'moderacao-anexo-pendente'), [{ event: 'exclusao', reason: 'moderacao-anexo-pendente', count: 1 }])
  logs.length = 0
  await retain()
  t.alike(logs, [{ event: 'exclusao', reason: 'moderacao-anexo-pendente', count: 1 }], 'a later pass with only the failing file says so too')
  t.absent(JSON.stringify(logs).includes(r.id), 'no id in the log')
  fs.unlinkSync = real
  logs.length = 0
  await retain()
  t.absent(fs.existsSync(file), 'the file goes once the unlink works')
  t.absent(logs.some((e) => e.reason === 'moderacao-anexo-pendente'), 'and the line stops')
})

test('deletion sweep: a retention pass that throws never fails the sweep', async (t) => {
  const { accounts } = await retentionSetup(t)
  let calls = 0
  const sweep = createDeletionSweep({ accounts, retention: async () => { calls++; throw new Error('retencao') } })
  t.alike(await sweep.sweep(), { members: 0, pending: 0 })
  t.is(calls, 1)
})

test('moderation retention: a block acked late burns the number before its report goes', async (t) => {
  const { dir, clock, now, accounts, moderation, apply, m, report } = await retentionSetup(t)
  const phones = openPhoneStore(dir, { key: Buffer.alloc(32, 7), now })
  // As server.js wires them.
  const cbs = {
    linked: (k) => accounts.status(k).linked,
    deleted: (k) => accounts.deletedAt(k) !== null,
    burnable: (k, since) => moderation.blocked().some((x) => x.member === k) &&
      (accounts.deletedAt(k) === null || moderation.blockReportsAfter(k, since) > 0),
    cleared: (k, since) => {
      if (moderation.held(k) || moderation.blockReportsAfter(k, since) === 0) return false
      const at = accounts.deletedAt(k)
      return at === null || moderation.blockReportsAfter(k, at) === 0
    },
    blocked: (k) => moderation.blocked().some((x) => x.member === k)
  }
  const PHONE = '+5511987654321'
  await phones.record({ member: m.hex, phone: PHONE }, cbs)
  const about = (await report(m.hex, keyPair().hex)).report
  await moderation.decide(about.id, { decision: 'bloquear', by: 'mod@example.test' })
  // The block is still pending at the deletion: nothing burns yet.
  await accounts.deleteMember(m.hex)
  await phones.sweep(cbs)
  t.is(phones.counts().burned, 0)
  clock.t += 180 * DAY_MS - 3600 * 1000
  await apply([m.hex])
  clock.t += 3600 * 1000
  // The purge comes before the hourly phone sweep.
  const retention = createModerationRetention({ accounts, moderation, beforeForget: () => phones.sweep(cbs), now })
  await retention()
  t.is(moderation.get(about.id), null, 'the report is gone')
  t.is(phones.counts().burned, 1, 'the number was burned first')
  await phones.sweep(cbs)
  t.is(phones.counts().burned, 1, 'the burn holds after the purge: the key stays on the list')
  const next = keyPair().hex
  try {
    await phones.record({ member: next, phone: PHONE }, cbs)
    t.fail('recorded a burned number')
  } catch (err) {
    t.is(err.code, 'telefone-em-uso', 'nobody else can take it')
  }
})

test('moderation retention: an ack between the phone sweep and the purge makes it sweep again first', async (t) => {
  const { dir, clock, now, accounts, moderation, apply, m, report } = await retentionSetup(t)
  const phones = openPhoneStore(dir, { key: Buffer.alloc(32, 7), now })
  const cbs = {
    linked: (k) => accounts.status(k).linked,
    deleted: (k) => accounts.deletedAt(k) !== null,
    burnable: (k, since) => moderation.blocked().some((x) => x.member === k) &&
      (accounts.deletedAt(k) === null || moderation.blockReportsAfter(k, since) > 0),
    cleared: (k, since) => {
      if (moderation.held(k) || moderation.blockReportsAfter(k, since) === 0) return false
      const at = accounts.deletedAt(k)
      return at === null || moderation.blockReportsAfter(k, at) === 0
    },
    blocked: (k) => moderation.blocked().some((x) => x.member === k)
  }
  const PHONE = '+5511987654321'
  await phones.record({ member: m.hex, phone: PHONE }, cbs)
  const about = (await report(m.hex, keyPair().hex)).report
  await moderation.decide(about.id, { decision: 'bloquear', by: 'mod@example.test' })
  // An open report the member filed: the pass has work while the block
  // waits (rows about the member wait with the named one).
  const open = (await report(keyPair().hex, m.hex)).report
  await accounts.deleteMember(m.hex)
  clock.t += 180 * DAY_MS
  let sweeps = 0
  let acked = false
  // The operator's ack lands after the phone sweep read the list and before
  // the purge runs: the row the block rests on is no longer named.
  const desk = {
    holdsDeleted: (members) => moderation.holdsDeleted(members),
    revision: () => moderation.revision(),
    forgetDeleted: async (members, opts) => {
      if (!acked) {
        acked = true
        await apply([m.hex])
      }
      return moderation.forgetDeleted(members, opts)
    }
  }
  const logs = []
  const retention = createModerationRetention({ accounts, moderation: desk, beforeForget: async () => { sweeps++; await phones.sweep(cbs) }, now, log: (e) => logs.push(e) })
  await retention()
  t.is(sweeps, 2, 'the phone sweep ran again after the stale answer')
  t.is(phones.counts().burned, 1, 'the number burned before the report went')
  t.is(moderation.get(about.id), null)
  t.is(moderation.get(open.id), null)
  t.is(logs.filter((e) => e.reason === 'moderacao-expurgada').length, 1)
})

test('moderation retention: a decision during the phone sweep makes the purge stale, and the pass sweeps again', async (t) => {
  const { clock, now, accounts, moderation, m, report } = await retentionSetup(t)
  const about = (await report(m.hex, keyPair().hex)).report
  const other = (await report(keyPair().hex, keyPair().hex)).report
  await accounts.deleteMember(m.hex)
  clock.t += 180 * DAY_MS
  let sweeps = 0
  const writes = []
  const desk = {
    holdsDeleted: (members) => moderation.holdsDeleted(members),
    revision: () => moderation.revision(),
    forgetDeleted: async (members, opts) => {
      const r = await moderation.forgetDeleted(members, opts)
      writes.push(r.stale)
      return r
    }
  }
  const beforeForget = async () => {
    // A moderator decides while the phone sweep runs.
    if (sweeps++ === 0) await moderation.decide(other.id, { decision: 'bloquear', by: 'mod@example.test' })
  }
  await createModerationRetention({ accounts, moderation: desk, beforeForget, now })()
  t.alike(writes, [true, false], 'stale first, then the retry purges')
  t.is(sweeps, 2)
  t.is(moderation.get(about.id), null)
})

test('moderation retention: stale twice leaves the member to the next pass', async (t) => {
  const { clock, now, accounts, moderation, m, report } = await retentionSetup(t)
  const about = (await report(m.hex, keyPair().hex)).report
  await accounts.deleteMember(m.hex)
  clock.t += 180 * DAY_MS
  let sweeps = 0
  const desk = {
    holdsDeleted: (members) => moderation.holdsDeleted(members),
    revision: () => -1,
    forgetDeleted: (members, opts) => moderation.forgetDeleted(members, opts)
  }
  const logs = []
  await createModerationRetention({ accounts, moderation: desk, beforeForget: async () => { sweeps++ }, now, log: (e) => logs.push(e) })()
  t.is(sweeps, 2, 'one retry')
  t.ok(moderation.get(about.id) !== null, 'nothing written')
  t.alike(logs, [{ event: 'exclusao', reason: 'moderacao-adiada' }])
})

test('moderation retention: an absent, invalid or non-canonical deletion date is never due; due members go in one call', async (t) => {
  const [A, B, C, D, E] = [keyPair().hex, keyPair().hex, keyPair().hex, keyPair().hex, keyPair().hex]
  const t0 = Date.parse('2026-11-01T12:00:00.000Z')
  const dates = { [A]: null, [B]: 'ontem', [C]: new Date(t0 - 200 * DAY_MS).toISOString(), [D]: new Date(t0 - 190 * DAY_MS).toISOString(), [E]: '2025-01-01' }
  const accounts = { deletedMembers: () => [A, B, C, D, E], deletedAt: (k) => dates[k] }
  const calls = []
  const desk = {
    holdsDeleted: (members) => { calls.push(['holds', members]); return true },
    revision: () => 7,
    forgetDeleted: async (members, opts) => {
      calls.push(['forget', members, opts])
      return { stale: false, reports: 0, stripped: 0, records: 0, appeals: 0, events: 0, deferred: 0, kept: 0, files: 0, filesLeft: 0 }
    }
  }
  await createModerationRetention({ accounts, moderation: desk, now: () => t0 })()
  t.alike(calls, [['holds', [C, D]], ['forget', [C, D], { revision: 7 }]], 'a parseable but non-canonical date is not due either')
  calls.length = 0
  dates[C] = null
  dates[D] = 'x'
  await createModerationRetention({ accounts, moderation: desk, now: () => t0 })()
  t.alike(calls, [], 'nobody due: the desk is not asked')
})

test('Excluir conta: on the server, a block acked late burns the number from its reports before the 180-day pass removes them', async (t) => {
  let phones = null
  const phoneClient = { send: async () => ({ ok: false }), check: async () => ({ ok: false }) }
  const s = await setup(t, {
    phoneClient,
    extra: async ({ dir, now }) => {
      phones = openPhoneStore(dir, { key: Buffer.alloc(32, 7), now })
      return { phones }
    }
  })
  const PHONE = '+5511987654321'
  await phones.record({ member: s.m.hex, phone: PHONE }, { linked: () => true, deleted: () => false, burnable: () => false })
  const about = (await s.moderation.add({ reporter: keyPair().hex, target: s.m.hex, seq: 2, reason: 'assedio', text: 'x', quote: 'y', signature: 'ab'.repeat(64), nonce: 'n'.repeat(43) })).report
  await s.moderation.decide(about.id, { decision: 'bloquear', by: 'mod@example.test' })
  // Deleted while the block still waits for the operator: nothing burns.
  await s.store.deleteMember(s.m.hex)
  await s.server.deletionSweep()
  t.is(phones.counts().burned, 0)
  s.clock.offset = 180 * DAY_MS - 3600 * 1000
  await s.apply([s.m.hex])
  // A deleted key burns only through its 'bloquear' reports
  // (blockReportsAfter), so the phone sweep must run before they go.
  s.clock.offset = 180 * DAY_MS + 60000
  await s.server.deletionSweep()
  t.is(s.moderation.get(about.id), null, 'the report is gone')
  t.is(s.moderation.blockReportsAfter(s.m.hex, null), 0, 'no block report is left to burn from')
  t.is(phones.counts().burned, 1, 'the number was burned first')
  await s.server.deletionSweep()
  t.is(phones.counts().burned, 1, 'the burn holds after the purge: the key stays on the list')
  try {
    await phones.record({ member: keyPair().hex, phone: PHONE }, { linked: () => true, deleted: () => false, burnable: () => false })
    t.fail('recorded a burned number')
  } catch (err) {
    t.is(err.code, 'telefone-em-uso', 'nobody else can take it')
  }
})

test('Excluir conta: the server wires the retention pass into the sweep, after a phone sweep', async (t) => {
  let sweeps = 0
  const phones = {
    sweep: async () => { sweeps++ },
    live: () => null,
    end: async () => {},
    verified: () => false
  }
  const phoneClient = { send: async () => ({ ok: false }), check: async () => ({ ok: false }) }
  const s = await setup(t, { phones, phoneClient })
  const about = (await s.moderation.add({ reporter: keyPair().hex, target: s.m.hex, seq: 2, reason: 'assedio', text: 'x', quote: 'y', signature: 'ab'.repeat(64), nonce: 'n'.repeat(43) })).report
  await s.store.deleteMember(s.m.hex)
  await s.server.deletionSweep()
  t.ok(s.moderation.get(about.id) !== null, 'kept before 180 days')
  s.clock.offset = 180 * DAY_MS + 60000
  const before = sweeps
  await s.server.deletionSweep()
  t.is(s.moderation.get(about.id), null, 'purged by the sweep')
  t.is(sweeps, before + 1, 'the phone sweep ran before the purge')
})

test('deletion caps: own purge step erases caps even if subscription removal failed, preserving another member', async (t) => {
  const { openPushCapsStore } = require('../lib/account/push-caps-store')
  const dir = tmpDir(t)
  const caps = openPushCapsStore(dir)
  const m = keyPair()
  const keep = keyPair()
  const hash = 'c'.repeat(64)
  for (const who of [m, keep]) await caps.put({ member: who.hex, hash, caps: ['seen-sync'] })
  let broken = true
  const logs = []
  const sweep = createDeletionSweep({
    accounts: { deleted: () => [m.hex], purged: async () => {} },
    pushStore: { available: () => !broken, devices: () => 1, removeAll: async () => {} },
    pushCapsStore: caps,
    log: (e) => logs.push(e)
  })
  t.alike(await sweep.purge(m.hex), { pending: 1 })
  t.absent(caps.holds(m.hex))
  t.absent(openPushCapsStore(dir).holds(m.hex), 'gone from disk')
  t.ok(caps.holds(keep.hex))
  broken = false
  t.alike(await sweep.purge(m.hex), { pending: 0 })
  for (const key of [m.hex, keep.hex, hash]) t.absent(JSON.stringify(logs).includes(key))
})

test('deletion caps: an unavailable capability store keeps deletion pending until a later purge', async (t) => {
  let available = false
  let holds = true
  const sweep = createDeletionSweep({
    accounts: { deleted: () => [], purged: async () => {} },
    pushCapsStore: { available: () => available, holds: () => holds, removeAll: async () => { holds = false } }
  })
  t.alike(await sweep.purge('a'.repeat(64)), { pending: 1 })
  t.ok(holds)
  available = true
  t.alike(await sweep.purge('a'.repeat(64)), { pending: 0 })
  t.absent(holds)
})
