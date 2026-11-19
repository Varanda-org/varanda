'use strict'

// apps/cli/lib/account/seen-routes.js (mounted by server.js): the signed
// read, write and delete of a member's encrypted seen blob, a
// compare-and-swap on the exact ciphertext. Loopback only: the members are
// linked in-process and Google is never reached.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { signSeen, blobHash, HASH_NONE } = require('@varanda/core/lib/seen-proof')
const { seal, seenKeyFromSeed, SEEN_BLOB_BYTES } = require('@varanda/core/lib/seen-blob')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openSeenStore } = require('../lib/account/seen-store')
const { createSeenRoutes } = require('../lib/account/seen-routes')
const { createAccountServer, keyedWindow, ERROR_STATUS } = require('../lib/account/server')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const TOKEN_RE = /^[A-Za-z0-9_-]{54}$/

const google = {
  authorizeUrl: () => { throw new Error('google called') },
  exchange: async () => { throw new Error('google called') }
}

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association }
}

function member () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

async function linkDirect (accounts, iss, m, username, sub, email) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

// A real sealed blob holding one Avisos token, so the test can look for it
// in the stored file.
const MARK = '0123456789abcdef0123456789abcdef'
function sealed (s, who, t = 1700000000) {
  const key = seenKeyFromSeed(who.kp.secretKey.subarray(0, 32), s.iss.association, who.hex)
  return seal({ gen: 1, member: who.hex, association: s.iss.association, avisos: { own: [{ token: MARK, t }], pages: {} }, dm: [], groups: [] }, key)
}

async function setup (t, { seen = true, serverOptions = {} } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const iss = issuer()
  const store = openAccountStore(dir)
  const m = member()
  const other = member()
  const stranger = member()
  await linkDirect(store, iss, m, 'ana', '1098765432109876543210', 'ana@example.test')
  await linkDirect(store, iss, other, 'bia', '2222222222222222222222', 'bia@example.test')
  const terms = openTermsStore(dir)
  const logs = []
  const seenStore = seen ? openSeenStore(dir, { log: (e) => logs.push(JSON.stringify(e)) }) : null
  const secrets = []
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    terms,
    seen: seenStore,
    log: (e) => logs.push(JSON.stringify(e)),
    ...serverOptions
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port
  secrets.push(m.hex, other.hex)

  async function post (pathname, body) {
    const res = await fetch(base + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  const start = (who, action) => post('/account/seen/start', { member: who.hex, action })
  function sign (who, nonce, action, prevHash, blob, signer = who) {
    const newHash = blob === null ? HASH_NONE : blobHash(blob)
    const signature = signSeen({ nonce, member: who.hex, association: iss.association, action, prevHash, newHash }, signer.kp)
    secrets.push(nonce, signature, newHash)
    if (prevHash !== HASH_NONE) secrets.push(prevHash)
    return signature
  }
  function finish (who, nonce, action, prevHash, blob, signature) {
    const body = { member: who.hex, nonce, action, signature, prevHash }
    if (blob !== null) body.blob = b4a.toString(blob, 'base64')
    return post('/account/seen/finish', body)
  }
  // start -> sign -> finish.
  async function run (who, action, prevHash = HASH_NONE, blob = null, { signer = who } = {}) {
    const started = await start(who, action)
    if (started.status !== 200) return started
    const nonce = started.body.nonce
    return finish(who, nonce, action, prevHash, blob, sign(who, nonce, action, prevHash, blob, signer))
  }
  const acceptTerms = (who, version = TERMS_VERSION) =>
    terms.accept({ member: who.hex, version, nonce: 'n'.repeat(43), signature: 'b'.repeat(128) })
  const file = (who) => path.join(dir, 'seen', who.hex)

  return { dir, iss, store, terms, seenStore, logs, secrets, m, other, stranger, post, start, sign, finish, run, acceptTerms, file }
}

// Only { event, reason }, and no member, nonce, hash, signature or blob.
function cleanLogs (t, s, blobs = []) {
  const all = s.logs.join('\n')
  for (const secret of s.secrets) t.absent(all.includes(secret), 'a secret in the logs')
  for (const blob of blobs) {
    t.absent(all.includes(b4a.toString(blob, 'base64').slice(0, 64)), 'a blob in the logs')
    t.absent(all.includes(blobHash(blob)), 'a blob hash in the logs')
  }
  for (const line of s.logs) {
    const e = JSON.parse(line)
    t.ok(Object.keys(e).every((k) => k === 'event' || k === 'reason'), 'only event and reason: ' + line)
  }
}

test('seen: read before any write, write then read, read with the known hash', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)

  const started = await s.start(s.m, 'read')
  t.is(started.status, 200, started.text)
  t.alike(Object.keys(started.body), ['nonce'], 'start reveals nothing about the file')
  t.ok(TOKEN_RE.test(started.body.nonce))
  const empty = await s.finish(s.m, started.body.nonce, 'read', HASH_NONE, null, s.sign(s.m, started.body.nonce, 'read', HASH_NONE, null))
  t.is(empty.status, 200, empty.text)
  t.alike(empty.body, { hash: null, blob: null, outstanding: [], asOf: empty.body.asOf })
  t.ok(Number.isSafeInteger(empty.body.asOf))

  const blob = sealed(s, s.m)
  const written = await s.run(s.m, 'write', HASH_NONE, blob)
  t.is(written.status, 200, written.text)
  t.alike(written.body, { ok: true, hash: blobHash(blob) })

  const read = await s.run(s.m, 'read')
  t.is(read.status, 200, read.text)
  t.is(read.body.hash, blobHash(blob))
  t.alike(b4a.from(read.body.blob, 'base64'), blob, 'the same bytes come back')

  const same = await s.run(s.m, 'read', blobHash(blob))
  t.alike(same.body, { hash: blobHash(blob), blob: null, unchanged: true, outstanding: [], asOf: same.body.asOf })
  cleanLogs(t, s, [blob])
})

test('seen: a stale prevHash conflicts with the current blob and writes nothing', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const first = sealed(s, s.m, 1)
  const second = sealed(s, s.m, 2)
  t.is((await s.run(s.m, 'write', HASH_NONE, first)).status, 200)
  // A second device that never saw the first write.
  const stale = await s.run(s.m, 'write', HASH_NONE, second)
  t.is(stale.status, 409, stale.text)
  t.is(stale.body.error, 'conflito')
  t.is(stale.body.hash, blobHash(first))
  t.alike(b4a.from(stale.body.blob, 'base64'), first)
  t.alike(fs.readFileSync(s.file(s.m)), first, 'nothing written')

  // The device merges and signs a new write against the current hash.
  const merged = await s.run(s.m, 'write', blobHash(first), second)
  t.alike(merged.body, { ok: true, hash: blobHash(second) })
  cleanLogs(t, s, [first, second])
})

test('seen: another member\'s signature, nonce reuse and a read nonce for a write are refused', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  await s.acceptTerms(s.other)
  const blob = sealed(s, s.m)

  const forged = await s.run(s.m, 'write', HASH_NONE, blob, { signer: s.other })
  t.is(forged.status, 400, forged.text)
  t.alike(forged.body, { error: 'assinatura-invalida' })
  t.absent(fs.existsSync(s.file(s.m)))

  const started = await s.start(s.m, 'write')
  const sig = s.sign(s.m, started.body.nonce, 'write', HASH_NONE, blob)
  t.is((await s.finish(s.m, started.body.nonce, 'write', HASH_NONE, blob, sig)).status, 200)
  const reused = await s.finish(s.m, started.body.nonce, 'write', HASH_NONE, blob, sig)
  t.is(reused.status, 404)
  t.alike(reused.body, { error: 'expirado' })

  const readNonce = await s.start(s.m, 'read')
  const asWrite = await s.finish(s.m, readNonce.body.nonce, 'write', blobHash(blob), blob, s.sign(s.m, readNonce.body.nonce, 'write', blobHash(blob), blob))
  t.alike(asWrite.body, { error: 'expirado' })

  // A nonce started for A cannot carry B's request.
  const forA = await s.start(s.m, 'delete')
  const asB = await s.finish(s.other, forA.body.nonce, 'delete', HASH_NONE, null, s.sign(s.other, forA.body.nonce, 'delete', HASH_NONE, null))
  t.alike(asB.body, { error: 'expirado' })
  cleanLogs(t, s, [blob])
})

test('seen: member A\'s requests never change B\'s file', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  await s.acceptTerms(s.other)
  const a = sealed(s, s.m)
  const b = sealed(s, s.other)
  t.is((await s.run(s.other, 'write', HASH_NONE, b)).status, 200)
  t.is((await s.run(s.m, 'write', HASH_NONE, a)).status, 200)
  const a2 = sealed(s, s.m, 5)
  t.is((await s.run(s.m, 'write', blobHash(a), a2)).status, 200)
  t.alike((await s.run(s.m, 'delete', blobHash(a2))).body, { ok: true, changed: true })
  t.alike(fs.readFileSync(s.file(s.other)), b)
  const read = await s.run(s.other, 'read')
  t.alike(b4a.from(read.body.blob, 'base64'), b)
})

test('seen: unlinked is refused; pending terms refuse write but allow read and delete', async (t) => {
  const s = await setup(t)
  const unlinked = await s.start(s.stranger, 'read')
  t.is(unlinked.status, 403)
  t.alike(unlinked.body, { error: 'nao-vinculado' })

  const blob = sealed(s, s.m)
  // An older version does not count.
  await s.acceptTerms(s.m, 1)
  const pending = await s.run(s.m, 'write', HASH_NONE, blob)
  t.is(pending.status, 409, pending.text)
  t.alike(pending.body, { error: 'termos-pendentes' })
  t.absent(fs.existsSync(s.file(s.m)))
  const empty = await s.run(s.m, 'read')
  t.alike(empty.body, { hash: null, blob: null, outstanding: [], asOf: empty.body.asOf })

  await s.acceptTerms(s.m)
  t.is((await s.run(s.m, 'write', HASH_NONE, blob)).status, 200)
  // Terms are only checked on write: a delete still goes through with any
  // acceptance on record, as it would without one.
  const s2 = await setup(t)
  const fresh = sealed(s2, s2.m)
  await s2.seenStore.put({ member: s2.m.hex, blob: fresh, expectedHash: HASH_NONE })
  const read = await s2.run(s2.m, 'read')
  t.is(read.status, 200, 'read without any terms')
  const del = await s2.run(s2.m, 'delete', blobHash(fresh))
  t.alike(del.body, { ok: true, changed: true }, 'delete without any terms')
  t.absent(fs.existsSync(s2.file(s2.m)))
})

test('seen: a blob of the wrong size is refused and no file is written', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const long = b4a.alloc(SEEN_BLOB_BYTES + 1, 7)
  const started = await s.start(s.m, 'write')
  const nonce = started.body.nonce
  const signature = signSeen({ nonce, member: s.m.hex, association: s.iss.association, action: 'write', prevHash: HASH_NONE, newHash: blobHash(long) }, s.m.kp)
  const r = await s.post('/account/seen/finish', { member: s.m.hex, nonce, action: 'write', signature, prevHash: HASH_NONE, blob: b4a.toString(long, 'base64') })
  t.is(r.status, 400, r.text)
  t.alike(r.body, { error: 'pedido-invalido' })
  t.absent(fs.existsSync(s.file(s.m)))

  // A non-canonical spelling of a right-sized blob is refused too.
  const blob = sealed(s, s.m)
  const again = await s.start(s.m, 'write')
  const sig = s.sign(s.m, again.body.nonce, 'write', HASH_NONE, blob)
  const spaced = await s.post('/account/seen/finish', { member: s.m.hex, nonce: again.body.nonce, action: 'write', signature: sig, prevHash: HASH_NONE, blob: b4a.toString(blob, 'base64url') })
  t.alike(spaced.body, { error: 'pedido-invalido' })
  t.absent(fs.existsSync(s.file(s.m)))
})

// A frozen clock, so the global bucket never refills: its burst covers every
// request of these tests.
function clocked () {
  const c = { t: Date.now() }
  return { c, serverOptions: { now: () => c.t, ratePerSecond: 1000, burst: 1000 } }
}

test('seen: the 121st read in 600 s is 429 and spends nothing', async (t) => {
  const { c, serverOptions } = clocked()
  const s = await setup(t, { serverOptions })
  for (let i = 0; i < 120; i++) {
    const r = await s.run(s.m, 'read')
    t.is(r.status, 200, 'read ' + (i + 1))
  }
  c.t += 300 * 1000
  const started = await s.start(s.m, 'read')
  const nonce = started.body.nonce
  const signature = s.sign(s.m, nonce, 'read', HASH_NONE, null)
  const over = await s.finish(s.m, nonce, 'read', HASH_NONE, null, signature)
  t.is(over.status, 429)
  t.alike(over.body, { error: 'pedido-invalido' })
  t.is((await s.run(s.other, 'read')).status, 200, 'another member keeps its window')
  c.t += 300 * 1000
  const later = await s.finish(s.m, nonce, 'read', HASH_NONE, null, signature)
  t.is(later.status, 200, 'the refused nonce was not spent: ' + later.text)
})

test('seen: the 65th write in 600 s is 429 and spends nothing', async (t) => {
  const { c, serverOptions } = clocked()
  const s = await setup(t, { serverOptions })
  await s.acceptTerms(s.m)
  let prev = HASH_NONE
  for (let i = 0; i < 64; i++) {
    const blob = sealed(s, s.m, i + 1)
    const r = await s.run(s.m, 'write', prev, blob)
    t.is(r.status, 200, 'write ' + (i + 1) + ': ' + r.text)
    prev = blobHash(blob)
  }
  const before = fs.readFileSync(s.file(s.m))
  c.t += 300 * 1000
  const blob = sealed(s, s.m, 1000)
  const started = await s.start(s.m, 'write')
  const nonce = started.body.nonce
  const signature = s.sign(s.m, nonce, 'write', prev, blob)
  const over = await s.finish(s.m, nonce, 'write', prev, blob, signature)
  t.is(over.status, 429)
  t.alike(over.body, { error: 'pedido-invalido' })
  t.alike(fs.readFileSync(s.file(s.m)), before, 'the stored file is unchanged')
  c.t += 300 * 1000
  const later = await s.finish(s.m, nonce, 'write', prev, blob, signature)
  t.is(later.status, 200, 'the refused nonce was not spent: ' + later.text)
  t.alike(later.body, { ok: true, hash: blobHash(blob) })
  const again = await s.finish(s.m, nonce, 'write', blobHash(blob), blob, s.sign(s.m, nonce, 'write', blobHash(blob), blob))
  t.is(again.body && again.body.error, 'expirado', 'now it is spent')
})

test('seen: delete needs the current hash (HASH_NONE only when absent), a stale hash conflicts', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const blob = sealed(s, s.m)
  t.is((await s.run(s.m, 'write', HASH_NONE, blob)).status, 200)
  const stale = await s.run(s.m, 'delete', 'f'.repeat(64))
  t.is(stale.status, 409, stale.text)
  t.alike(stale.body, { error: 'conflito', hash: blobHash(blob) })
  t.ok(fs.existsSync(s.file(s.m)))
  const gone = await s.run(s.m, 'delete', blobHash(blob))
  t.alike(gone.body, { ok: true, changed: true })
  t.absent(fs.existsSync(s.file(s.m)))
  const none = await s.run(s.m, 'delete', HASH_NONE)
  t.alike(none.body, { ok: true, changed: false })

  // HASH_NONE on an existing file is a stale hash too.
  t.is((await s.run(s.m, 'write', HASH_NONE, blob)).status, 200)
  t.is((await s.run(s.m, 'delete', HASH_NONE)).status, 409)
})

test('seen: the stored file is 0600, constant length and holds no plaintext token', async (t) => {
  const s = await setup(t)
  await s.acceptTerms(s.m)
  const blob = sealed(s, s.m)
  t.is((await s.run(s.m, 'write', HASH_NONE, blob)).status, 200)
  const st = fs.statSync(s.file(s.m))
  t.is(st.mode & 0o777, 0o600)
  t.is(st.size, SEEN_BLOB_BYTES)
  const bytes = fs.readFileSync(s.file(s.m))
  t.absent(bytes.includes(b4a.from(MARK, 'hex')), 'no raw token')
  t.absent(bytes.includes(b4a.from(MARK, 'utf8')), 'no token text')
  t.absent(bytes.includes(b4a.from(s.m.hex, 'hex')), 'no member key')
  cleanLogs(t, s, [blob])
})

test('seen: without a store every route is 503; an unavailable store too', async (t) => {
  const none = await setup(t, { seen: false })
  const r = await none.start(none.m, 'read')
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })

  const s = await setup(t)
  const started = await s.start(s.m, 'read')
  s.seenStore.fail()
  const late = await s.finish(s.m, started.body.nonce, 'read', HASH_NONE, null, s.sign(s.m, started.body.nonce, 'read', HASH_NONE, null))
  t.is(late.status, 503)
  t.alike(late.body, { error: 'indisponivel' })
  t.is((await s.post('/account/seen/list', { member: s.m.hex })).status, 404, 'no list route')
  cleanLogs(t, s)
})

test('seen: a flood of anonymous starts never expires an honest nonce', async (t) => {
  const s = await setup(t, { serverOptions: { ratePerSecond: 1000000, burst: 1000000 } })
  const started = await s.start(s.m, 'read')
  t.is(started.status, 200, started.text)
  // More starts than the old shared table held (1000 rows, oldest evicted).
  let refused = 0
  for (let i = 0; i < 1100; i++) {
    const r = await s.start(s.other, 'read')
    if (r.status !== 200) refused++
  }
  t.is(refused, 0, 'every start answered')
  const nonce = started.body.nonce
  const res = await s.finish(s.m, nonce, 'read', HASH_NONE, null, s.sign(s.m, nonce, 'read', HASH_NONE, null))
  t.is(res.status, 200, res.text)
})

test('seen: a nonce this process did not mint is refused', async (t) => {
  const s = await setup(t)
  const forged = b4a.toString(b4a.alloc(40, 7), 'base64url')
  t.ok(TOKEN_RE.test(forged), 'same shape as a real nonce')
  const res = await s.finish(s.m, forged, 'read', HASH_NONE, null, s.sign(s.m, forged, 'read', HASH_NONE, null))
  t.is(res.body && res.body.error, 'expirado', res.text)
  const other = await s.start(s.other, 'read')
  const theirs = other.body.nonce
  const crossed = await s.finish(s.m, theirs, 'read', HASH_NONE, null, s.sign(s.m, theirs, 'read', HASH_NONE, null))
  t.is(crossed.body && crossed.body.error, 'expirado', 'a nonce minted for another member')
})

test('seen: a bad signature does not spend the nonce; a good one does', async (t) => {
  const s = await setup(t)
  const started = await s.start(s.m, 'read')
  const nonce = started.body.nonce
  const bad = await s.finish(s.m, nonce, 'read', HASH_NONE, null, 'a'.repeat(128))
  t.is(bad.body && bad.body.error, 'assinatura-invalida', bad.text)
  const good = await s.finish(s.m, nonce, 'read', HASH_NONE, null, s.sign(s.m, nonce, 'read', HASH_NONE, null))
  t.is(good.status, 200, 'anonymous garbage left the nonce usable: ' + good.text)
  const again = await s.finish(s.m, nonce, 'read', HASH_NONE, null, s.sign(s.m, nonce, 'read', HASH_NONE, null))
  t.is(again.body && again.body.error, 'expirado', 'a verified nonce is single use')
})

async function signalSeen (t) {
  const iss = issuer()
  const m = member()
  const other = member()
  const clock = { t: 1800000000000 }
  const flags = { linked: true, terms: true, phone: true, limit: true }
  const seenStore = openSeenStore(tmpDir(t))
  const calls = []
  const logs = []
  const tags = ['varanda-dm', 'varanda-dm-page']
  const refuse = (token, extra = {}) => Object.assign(new Error(token), { token, status: ERROR_STATUS[token], ...extra })
  const routes = createSeenRoutes({
    association: iss.association,
    accounts: { status: () => ({ linked: flags.linked }) },
    terms: { available: () => true, list: () => flags.terms ? [{ version: TERMS_VERSION }] : [] },
    seenStore,
    pushRoutes: { outstanding: () => tags.slice(), seenWritten: (...args) => calls.push(args) },
    phoneChecked: () => { if (!flags.phone) throw refuse('telefone-pendente') },
    limits: { read: keyedWindow(120, 600000, () => clock.t), write: () => flags.limit, delete: () => true },
    log: (e) => logs.push(JSON.stringify(e)),
    now: () => clock.t,
    http: {
      send: (res, status, body) => Object.assign(res, { status, body }),
      readJsonBody: async (req) => req.body,
      checkPost: () => {},
      RouteError: class extends Error { constructor (token, status) { super(token); this.token = token; this.status = status } },
      refuse,
      fromStore: (err) => refuse(err.code)
    }
  })
  async function post (path, body) {
    const res = {}
    try { await routes.handle({ method: 'POST', body }, res, { pathname: '/account/seen/' + path }) } catch (err) {
      res.status = err.status
      res.body = { error: err.token }
    }
    return res
  }
  async function request (action, blob = null, prevHash = HASH_NONE, extra = {}, signer = m) {
    const started = await post('start', { member: m.hex, action })
    const nonce = started.body.nonce
    const signature = signSeen({ member: m.hex, association: iss.association, nonce, action, prevHash, newHash: blob === null ? HASH_NONE : blobHash(blob) }, signer.kp)
    return { member: m.hex, nonce, action, prevHash, signature, ...(blob === null ? {} : { blob: b4a.toString(blob, 'base64') }), ...extra }
  }
  return { iss, m, other, clock, flags, seenStore, calls, logs, tags, post, request }
}

test('seen signal: authenticated read shapes include outstanding and asOf for empty, changed and unchanged blobs', async (t) => {
  const s = await signalSeen(t)
  const start = await s.post('start', { member: s.m.hex, action: 'read' })
  t.alike(Object.keys(start.body), ['nonce'])
  const empty = await s.post('finish', await s.request('read'))
  t.alike(empty, { status: 200, body: { hash: null, blob: null, outstanding: s.tags, asOf: s.clock.t } })
  const blob = sealed(s, s.m)
  await s.seenStore.put({ member: s.m.hex, blob, expectedHash: HASH_NONE })
  const read = await s.post('finish', await s.request('read'))
  t.alike(read.body, { hash: blobHash(blob), blob: b4a.toString(blob, 'base64'), outstanding: s.tags, asOf: s.clock.t })
  const same = await s.post('finish', await s.request('read', null, blobHash(blob)))
  t.alike(same.body, { hash: blobHash(blob), blob: null, unchanged: true, outstanding: s.tags, asOf: s.clock.t })
  t.alike(s.calls, [])
})

test('seen signal: only a successful single-use write calls seenWritten, with fields outside the statement', async (t) => {
  const s = await signalSeen(t)
  const blob = sealed(s, s.m)
  const extra = { close: s.tags, asOf: s.clock.t }
  const good = await s.request('write', blob, HASH_NONE, extra)
  t.is((await s.post('finish', good)).status, 200)
  t.alike(s.calls, [[s.m.hex, s.tags, s.clock.t]])
  t.is((await s.post('finish', good)).body.error, 'expirado')
  const conflict = await s.post('finish', await s.request('write', sealed(s, s.m, 2), HASH_NONE, extra))
  t.is(conflict.status, 409)
  t.is(conflict.body.error, 'conflito')
  t.is((await s.post('finish', await s.request('write', blob, blobHash(blob), extra, s.other))).body.error, 'assinatura-invalida')
  for (const [flag, error] of [['terms', 'termos-pendentes'], ['phone', 'telefone-pendente'], ['limit', 'pedido-invalido'], ['linked', 'nao-vinculado']]) {
    const request = await s.request('write', blob, blobHash(blob), extra)
    s.flags[flag] = false
    t.is((await s.post('finish', request)).body.error, error)
    s.flags[flag] = true
  }
  const expired = await s.request('write', blob, blobHash(blob), extra)
  s.clock.t += 600000
  t.is((await s.post('finish', expired)).body.error, 'expirado')
  const unavailable = await s.request('write', blob, blobHash(blob), { ...extra, asOf: s.clock.t })
  s.seenStore.fail()
  t.is((await s.post('finish', unavailable)).body.error, 'indisponivel')
  t.is(s.calls.length, 1, 'every refusal left recall and signal untouched')
  const all = s.logs.join('\n')
  for (const tag of s.tags) t.absent(all.includes(tag), 'no tag in logs')
  t.absent(all.includes(s.m.hex), 'no member in logs')
})

test('seen signal: malformed close and asOf are refused without consuming the valid nonce', async (t) => {
  const s = await signalSeen(t)
  const blob = sealed(s, s.m)
  const request = await s.request('write', blob)
  const invalid = [null, {}, 'varanda-dm', [null], ['unknown'], ['varanda-dm\n'], Array(17).fill('varanda-dm')]
  for (const close of invalid) {
    t.alike(await s.post('finish', { ...request, close, asOf: s.clock.t }), { status: 400, body: { error: 'pedido-invalido' } })
  }
  for (const asOf of [undefined, null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, s.clock.t + 1]) {
    t.alike(await s.post('finish', { ...request, close: [], asOf }), { status: 400, body: { error: 'pedido-invalido' } })
  }
  t.alike(s.calls, [])
  t.is(s.seenStore.get(s.m.hex), null)
  t.is((await s.post('finish', { ...request, close: Array(16).fill('varanda-dm'), asOf: s.clock.t })).status, 200)
  t.is(s.calls.length, 1)
  for (const action of ['read', 'delete']) {
    t.alike(await s.post('finish', await s.request(action, null, blobHash(blob), { close: [], asOf: s.clock.t })), { status: 400, body: { error: 'pedido-invalido' } })
  }
  const old = await s.post('finish', await s.request('write', blob, blobHash(blob)))
  t.is(old.status, 200, 'old clients can omit both fields')
  t.is(s.calls.length, 1)
})
