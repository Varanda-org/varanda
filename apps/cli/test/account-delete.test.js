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
const { openRecoveryStore } = require('../lib/account/recovery-store')
const { openInvitesStore } = require('../lib/account/invites-store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { openSeenStore } = require('../lib/account/seen-store')
const { HASH_NONE } = require('@varanda/core/lib/seen-proof')
const { SEEN_BLOB_BYTES } = require('@varanda/core/lib/seen-blob')
const { openPasskeyStore } = require('../lib/account/passkey-store')
const { keyFromAttestation } = require('../lib/account/webauthn')
const { createFakePasskey } = require('./helpers/fake-passkey')
const { createAccountServer } = require('../lib/account/server')
const { createDeleteRoutes, WAIT_MS } = require('../lib/account/delete-routes')
const { createDeletionSweep } = require('../lib/account/deletion')
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
async function setup (t, { moderation: withModeration = true, enrolled = true } = {}) {
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
    log: (e) => logs.push(JSON.stringify(e)),
    now
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
  const recovery = openRecoveryStore(dir)
  const invites = openInvitesStore(dir, { perWeek: 3 })
  const seen = openSeenStore(dir)
  for (const who of [m, keep]) {
    await seen.put({ member: who.hex, blob: crypto.randomBytes(SEEN_BLOB_BYTES), expectedHash: HASH_NONE })
    await terms.accept({ member: who.hex, version: TERMS_VERSION, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
    await ages.record({ member: who.hex, band: '18+', method: 'didit' })
    await pushStore.put({ member: who.hex, endpoint: 'https://fcm.googleapis.com/fcm/send/' + who.hex.slice(0, 8), p256dh: b64u(Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)])), auth: b64u(crypto.randomBytes(16)) })
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
  const logs = []
  const sweep = createDeletionSweep({ accounts, terms, ages, pushStore, recovery, invites, drops, seen, passkeys, log: (e) => logs.push(e) })
  t.alike(await sweep.sweep(), { members: 0, pending: 0 }, 'nothing deleted yet')
  await accounts.deleteMember(m.hex)
  const first = await sweep.sweep()
  t.alike(first, { members: 1, pending: 1 }, 'the drops ledger could not answer')
  t.alike(terms.list(m.hex), [])
  t.is(ages.get(m.hex), null)
  t.is(pushStore.devices(m.hex), 0)
  t.alike(recovery.list(m.hex), [])
  t.is(invites.holds(m.hex), false)
  t.is(seen.get(m.hex), null, 'the seen blob is gone')
  t.is(passkeys.holds(m.hex), false)
  t.ok(dropsHeld.has(m.hex))
  t.alike(logs, [{ event: 'exclusao', reason: 'purga-pendente', count: 1 }])
  dropsUp = true
  t.alike(await sweep.sweep(), { members: 1, pending: 0 })
  t.absent(dropsHeld.has(m.hex), 'purged on the next sweep')
  t.is(terms.list(keep.hex).length, 1, 'another member keeps everything')
  t.ok(ages.get(keep.hex) !== null)
  t.is(pushStore.devices(keep.hex), 1)
  t.is(recovery.list(keep.hex).length, 1)
  t.ok(invites.holds(keep.hex))
  t.ok(seen.get(keep.hex) !== null)
  t.is(passkeys.keys(keep.hex).length, 1)
  t.ok(dropsHeld.has(keep.hex))
  const reopened = openTermsStore(dir)
  t.alike(reopened.list(m.hex), [], 'gone from disk too')
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
