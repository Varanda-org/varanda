'use strict'

// Excluir conta: apps/cli/lib/account/delete-routes.js (start and finish over
// the account-link proof at phase 'delete'), the directory deletion
// (./store.js deleteMember), the queued block in the moderation desk (actor
// 'titular') and the purge of the other stores (./deletion.js). Loopback
// only: members are linked in-process and Google is never reached.

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
const { createAccountServer } = require('../lib/account/server')
const { createDeleteRoutes } = require('../lib/account/delete-routes')
const { createDeletionSweep } = require('../lib/account/deletion')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
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

function recoveryBlob () {
  return { v: 1, kind: 'code', nonce: b4a.toString(crypto.randomBytes(24), 'hex'), ciphertext: b4a.toString(crypto.randomBytes(82), 'hex') }
}

// A service with `m` linked as 'ana' and every store the deletion purges.
async function setup (t, { moderation: withModeration = true } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const now = () => Date.now()
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
  const finish = (who, nonce, signature) => post('/account/delete/finish', { member: who.hex, nonce, signature })

  // start -> sign -> finish for `who`.
  async function del (who) {
    const started = await start(who)
    if (started.status !== 200) return started
    return finish(who, started.body.nonce, sign(who, started.body.nonce, started.body.username))
  }

  // The operator's `mod apply`: pull, sign a list with the key, ack.
  async function apply (blocked) {
    const pulled = await moderation.pull()
    const snapshot = createSnapshot({ seq: 1, date: new Date().toISOString(), blocked }, modKp, modCert)
    await moderation.ack({ changeIds: pulled.changes.map((c) => c.id), snapshot, moderatorCert: modCert })
  }

  return { dir, iss, store, terms, ages, recovery, invites, moderation, m, logs, texts, post, status, sign, start, finish, del, apply }
}

test('Excluir conta: start, sign, finish; the link and every store entry go, the block is queued, status follows the list', async (t) => {
  const s = await setup(t)
  const started = await s.start(s.m)
  t.is(started.status, 200, started.text)
  t.alike(Object.keys(started.body).sort(), ['nonce', 'username'])
  t.is(started.body.username, 'ana')
  const done = await s.finish(s.m, started.body.nonce, s.sign(s.m, started.body.nonce, 'ana'))
  t.is(done.status, 200, done.text)
  t.alike(done.body, { deleted: 'pendente' })

  t.is(s.store.status(s.m.hex).linked, false)
  t.is(s.store.lookup('ana'), null)
  t.alike(s.terms.list(s.m.hex), [], 'terms acceptances gone')
  t.is(s.ages.get(s.m.hex), null, 'age band gone')
  t.alike(s.recovery.list(s.m.hex), [], 'recovery entries gone')
  t.is(s.invites.holds(s.m.hex), false, 'issued invites gone')
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

// The routes alone, with the server's helpers stubbed.
function routes ({ accounts, pagesStore = null, moderation = { requestDeletion: async () => ({}) }, association }) {
  const refuse = (token) => Object.assign(new Error(token), { token })
  return createDeleteRoutes({
    accounts,
    moderation,
    pagesStore,
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
  const r = routes({ accounts, pagesStore, association: iss.association })
  owned.push({ page: 'p'.repeat(64), closed: false, movedTo: null })
  t.alike(await call(r, '/account/delete/start', { member: m.hex }), { error: 'paginas-ativas' })
  owned[0] = { page: 'p'.repeat(64), closed: true, movedTo: null }
  const ok = await call(r, '/account/delete/start', { member: m.hex })
  t.is(ok.status, 200, 'a closed page does not hold the deletion')
  owned.push({ page: 'q'.repeat(64), closed: false, movedTo: null })
  const done = await call(r, '/account/delete/finish', { member: m.hex, nonce: ok.body.nonce, signature: signAccountLink({ phase: 'delete', nonce: ok.body.nonce, member: m.hex, username: 'ana', association: iss.association, sub: '' }, m.kp) })
  t.alike(done, { error: 'paginas-ativas' }, 'checked again at finish')
  t.is(accounts.status(m.hex).linked, true)
  const broken = routes({ accounts, pagesStore: { listFor: () => { throw new Error('x') } }, association: iss.association })
  t.alike(await call(broken, '/account/delete/start', { member: m.hex }), { error: 'indisponivel' }, 'a pages store that cannot answer refuses')
})

test('Excluir conta: a failed queue deletes nothing; a failed directory write is resultado-incerto', async (t) => {
  const iss = issuer()
  const dir = path.join(tmpDir(t), 'account')
  const accounts = openAccountStore(dir)
  const m = keyPair()
  await linkDirect(accounts, iss, m, 'ana')
  const sig = (nonce) => signAccountLink({ phase: 'delete', nonce, member: m.hex, username: 'ana', association: iss.association, sub: '' }, m.kp)
  const full = routes({ accounts, moderation: { requestDeletion: async () => { throw Object.assign(new Error('lotado'), { code: 'lotado' }) } }, association: iss.association })
  let st = await call(full, '/account/delete/start', { member: m.hex })
  t.alike(await call(full, '/account/delete/finish', { member: m.hex, nonce: st.body.nonce, signature: sig(st.body.nonce) }), { error: 'lotado' })
  t.is(accounts.status(m.hex).linked, true, 'nothing deleted')

  const queued = []
  const flaky = routes({ accounts: { ...accounts, deleteMember: async () => { throw new Error('disk') } }, moderation: { requestDeletion: async (k) => { queued.push(k) } }, association: iss.association })
  st = await call(flaky, '/account/delete/start', { member: m.hex })
  t.alike(await call(flaky, '/account/delete/finish', { member: m.hex, nonce: st.body.nonce, signature: sig(st.body.nonce) }), { error: 'resultado-incerto' })
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
  for (const who of [m, keep]) {
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
  const logs = []
  const sweep = createDeletionSweep({ accounts, terms, ages, pushStore, recovery, invites, drops, log: (e) => logs.push(e) })
  t.alike(await sweep.sweep(), { members: 0, pending: 0 }, 'nothing deleted yet')
  await accounts.deleteMember(m.hex)
  const first = await sweep.sweep()
  t.alike(first, { members: 1, pending: 1 }, 'the drops ledger could not answer')
  t.alike(terms.list(m.hex), [])
  t.is(ages.get(m.hex), null)
  t.is(pushStore.devices(m.hex), 0)
  t.alike(recovery.list(m.hex), [])
  t.is(invites.holds(m.hex), false)
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
  t.ok(dropsHeld.has(keep.hex))
  const reopened = openTermsStore(dir)
  t.alike(reopened.list(m.hex), [], 'gone from disk too')
})
