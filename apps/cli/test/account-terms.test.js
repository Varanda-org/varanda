'use strict'

// apps/cli/lib/account/server.js /account/terms/start and /finish: a linked
// member records its acceptance of the Termos de Uso and the Política de
// Privacidade with one diary-key proof over a single-use nonce
// (@varanda/core/lib/terms, apps/cli/lib/account/terms-store.js). Loopback
// only: the members are linked in-process and Google is never reached.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { TERMS_VERSION, signTerms } = require('@varanda/core/lib/terms')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { createAccountServer } = require('../lib/account/server')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const SUB = '1098765432109876543210'
const EMAIL = 'membro@example.test'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/

// Never called: the terms routes never reach Google.
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

async function linkDirect (accounts, iss, m, username, sub = SUB, email = EMAIL) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

// The directory's own files, byte for byte.
function directoryBytes (dir) {
  const out = {}
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === 'directory.json' || name === 'directory.hwm' || name.startsWith('directory.journal.')) {
      out[name] = fs.readFileSync(path.join(dir, name)).toString('base64')
    }
  }
  return out
}

// A service with `m` linked (as 'ana') and a terms store on the same dir.
// `terms: false` passes terms = null; `configured: false` passes issuer null.
async function setup (t, { configured = true, terms = true, guard, storeOpts = {} } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = { offset: 0 }
  c.now = () => Date.now() + c.offset
  const iss = issuer()
  const store = openAccountStore(dir, { now: c.now, ...storeOpts })
  const m = member()
  await linkDirect(store, iss, m, 'ana')
  const termsStore = terms ? openTermsStore(dir, { now: c.now, ...(guard ? { guard } : {}) }) : null
  const logs = []
  const texts = []
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: configured ? { keyPair: iss.keyPair, cert: iss.cert } : null,
    terms: termsStore,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function post (pathname, body, { origin = ORIGIN, type = 'application/json' } = {}) {
    const headers = { 'content-type': type }
    if (origin !== null) headers.origin = origin
    const res = await fetch(base + pathname, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await res.text()
    texts.push(text)
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  const start = (who, version = TERMS_VERSION) => post('/account/terms/start', { member: who.hex, version })
  const sign = (who, nonce, version = TERMS_VERSION) => signTerms({ nonce, member: who.hex, association: iss.association, version }, who.kp)
  const finish = (who, nonce, signature) => post('/account/terms/finish', { member: who.hex, nonce, signature })

  // start -> sign -> finish for `who`.
  async function accept (who, version = TERMS_VERSION) {
    const started = await start(who, version)
    if (started.status !== 200) return started
    return finish(who, started.body.nonce, sign(who, started.body.nonce, version))
  }

  return { dir, c, iss, store, terms: termsStore, m, logs, texts, listener, post, start, sign, finish, accept }
}

function noPersonalData (t, s) {
  const all = s.texts.join('\n') + '\n' + s.logs.join('\n')
  t.absent(all.includes(EMAIL), 'no e-mail in a response or log line')
  t.absent(all.includes(SUB), 'no sub in a response or log line')
}

test('terms: start, sign, finish; a repeat keeps the first date; nothing touches the directory', async (t) => {
  const s = await setup(t)
  const before = directoryBytes(s.dir)
  t.ok(Object.keys(before).includes('directory.json'), 'the directory exists')

  const started = await s.start(s.m)
  t.is(started.status, 200, started.text)
  t.alike(Object.keys(started.body), ['nonce'])
  t.ok(TOKEN_RE.test(started.body.nonce), 'nonce is 32 bytes base64url')
  const signature = s.sign(s.m, started.body.nonce)
  const done = await s.finish(s.m, started.body.nonce, signature)
  t.is(done.status, 200, done.text)
  t.alike(Object.keys(done.body).sort(), ['acceptedAt', 'version'])
  t.is(done.body.version, TERMS_VERSION)
  t.is(new Date(done.body.acceptedAt).toISOString(), done.body.acceptedAt, 'canonical ISO date')
  t.absent(done.text.includes(signature), 'the signature is never echoed')

  s.c.offset += 60 * 1000
  const again = await s.accept(s.m)
  t.is(again.status, 200, again.text)
  t.is(again.body.acceptedAt, done.body.acceptedAt, 'the first acceptance date is kept')
  t.alike(s.terms.list(s.m.hex), [{ version: TERMS_VERSION, acceptedAt: done.body.acceptedAt }])
  t.ok(s.logs.includes(JSON.stringify({ event: 'terms', reason: 'novo' })))
  t.ok(s.logs.includes(JSON.stringify({ event: 'terms', reason: 'repetido' })))
  t.absent(s.logs.join('\n').includes(signature), 'no signature in the logs')

  t.alike(directoryBytes(s.dir), before, 'directory files byte-identical while open')
  await s.listener.close()
  t.alike(directoryBytes(s.dir), before, 'and after the service closed')
  t.is(fs.statSync(path.join(s.dir, 'terms.json')).mode & 0o777, 0o600)
  noPersonalData(t, s)
})

test('terms: an unlinked member, bad versions and bad member keys are refused', async (t) => {
  const s = await setup(t)
  const stranger = member()
  const unlinked = await s.start(stranger)
  t.is(unlinked.status, 403)
  t.alike(unlinked.body, { error: 'nao-vinculado' })

  for (const version of [0, TERMS_VERSION + 1, '1', 1.5, null, -1]) {
    const r = await s.start(s.m, version)
    t.is(r.status, 400, 'version ' + JSON.stringify(version))
    t.alike(r.body, { error: 'pedido-invalido' })
  }
  for (const bad of ['', s.m.hex.toUpperCase(), s.m.hex.slice(1), 42]) {
    const r = await s.post('/account/terms/start', { member: bad, version: TERMS_VERSION })
    t.is(r.status, 400)
    t.alike(r.body, { error: 'pedido-invalido' })
  }
  noPersonalData(t, s)
})

test('terms: the nonce is single-use, bound to its member, expires, and only a terms signature counts', async (t) => {
  const s = await setup(t)
  const other = member()
  await linkDirect(s.store, s.iss, other, 'bia', '2222222222222222222222', 'bia@example.test')

  // Spent on its first finish, whatever the outcome.
  const a = await s.start(s.m)
  const sig = s.sign(s.m, a.body.nonce)
  t.is((await s.finish(s.m, a.body.nonce, sig)).status, 200)
  const replay = await s.finish(s.m, a.body.nonce, sig)
  t.is(replay.status, 404)
  t.alike(replay.body, { error: 'expirado' })

  // Issued to `m`, presented by `other` with its own valid signature.
  const b = await s.start(s.m)
  const stolen = await s.finish(other, b.body.nonce, s.sign(other, b.body.nonce))
  t.is(stolen.status, 404)
  t.alike(stolen.body, { error: 'expirado' })
  const late = await s.finish(s.m, b.body.nonce, s.sign(s.m, b.body.nonce))
  t.is(late.status, 404, 'spent by the other member\'s attempt')

  // An account-link rename signature over the same nonce is not a terms proof.
  const c = await s.start(s.m)
  const rename = signAccountLink({ phase: 'rename', nonce: c.body.nonce, member: s.m.hex, username: 'ana', association: s.iss.association, sub: '' }, s.m.kp)
  const wrong = await s.finish(s.m, c.body.nonce, rename)
  t.is(wrong.status, 400)
  t.alike(wrong.body, { error: 'assinatura-invalida' })

  // Malformed signature.
  const d = await s.start(s.m)
  const malformed = await s.finish(s.m, d.body.nonce, 'zz')
  t.is(malformed.status, 400)
  t.alike(malformed.body, { error: 'assinatura-invalida' })

  // A signature over another version than the one started.
  const e = await s.start(s.m)
  const otherVersion = await s.finish(s.m, e.body.nonce, s.sign(s.m, e.body.nonce, TERMS_VERSION + 1))
  t.is(otherVersion.status, 400)
  t.alike(otherVersion.body, { error: 'assinatura-invalida' })

  // TTL: 600 s.
  const f = await s.start(s.m)
  s.c.offset += 600 * 1000
  const expired = await s.finish(s.m, f.body.nonce, s.sign(s.m, f.body.nonce))
  t.is(expired.status, 404)
  t.alike(expired.body, { error: 'expirado' })

  // An unknown nonce.
  const unknown = await s.finish(s.m, 'x'.repeat(43), 'a'.repeat(128))
  t.is(unknown.status, 404)
  noPersonalData(t, s)
})

test('terms: exact Origin and a JSON body are required', async (t) => {
  const s = await setup(t)
  for (const pathname of ['/account/terms/start', '/account/terms/finish']) {
    const noOrigin = await s.post(pathname, { member: s.m.hex, version: TERMS_VERSION }, { origin: null })
    t.is(noOrigin.status, 403, pathname + ' without Origin')
    t.alike(noOrigin.body, { error: 'pedido-invalido' })
    const foreign = await s.post(pathname, { member: s.m.hex, version: TERMS_VERSION }, { origin: 'https://evil.test' })
    t.is(foreign.status, 403, pathname + ' from another origin')
    const form = await s.post(pathname, { member: s.m.hex, version: TERMS_VERSION }, { type: 'text/plain' })
    t.is(form.status, 400, pathname + ' as text/plain')
    t.alike(form.body, { error: 'pedido-invalido' })
  }
})

test('terms: the 6th verified finish in 10 minutes is refused; invalid signatures charge nothing', async (t) => {
  const s = await setup(t)
  for (let i = 0; i < 8; i++) {
    const r = await s.start(s.m)
    const bad = await s.finish(s.m, r.body.nonce, 'a'.repeat(128))
    t.is(bad.status, 400, 'invalid signature ' + i)
  }
  for (let i = 0; i < 5; i++) {
    const ok = await s.accept(s.m)
    t.is(ok.status, 200, 'verified finish ' + (i + 1))
  }
  const sixth = await s.accept(s.m)
  t.is(sixth.status, 429)
  t.alike(sixth.body, { error: 'pedido-invalido' })
  s.c.offset += 600 * 1000
  t.is((await s.accept(s.m)).status, 200, 'the window restarts')
})

test('terms: no member cap and no issuer are required', async (t) => {
  const full = await setup(t, { storeOpts: { maxMembers: 1 } })
  t.ok(full.store.isFull(), 'the member cap is reached')
  const ok = await full.accept(full.m)
  t.is(ok.status, 200, 'a linked member accepts with the cap full: ' + ok.text)
  const stranger = await full.start(member())
  t.is(stranger.status, 403, 'an unlinked key is not linked, never waitlisted')
  t.alike(stranger.body, { error: 'nao-vinculado' })

  const unconfigured = await setup(t, { configured: false })
  const r = await unconfigured.accept(unconfigured.m)
  t.is(r.status, 200, 'issuer null still records: ' + r.text)
})

test('terms: no terms store, an unavailable one, or a guard lost after the write answer 503', async (t) => {
  const none = await setup(t, { terms: false })
  const r = await none.start(none.m)
  t.is(r.status, 503)
  t.alike(r.body, { error: 'indisponivel' })

  // A store that marked itself unavailable (a malformed terms.json, a
  // failed write).
  const bad = await setup(t)
  bad.terms.fail()
  const refused = await bad.start(bad.m)
  t.is(refused.status, 503)
  t.alike(refused.body, { error: 'indisponivel' })

  // The lock read fails while the first acceptance is written: the guard
  // passes before the write and fails after it. That write is never
  // acknowledged; the refusal is for that request only (a lost lock is
  // confirmed by the heartbeat, which calls terms.fail()), so the next finish
  // and start go through.
  const answers = []
  const s = await setup(t, { guard: () => answers.length === 0 || answers.shift() })
  const n1 = await s.start(s.m)
  const n2 = await s.start(s.m)
  t.is(n2.status, 200)
  answers.push(true, false)
  const lost = await s.finish(s.m, n1.body.nonce, s.sign(s.m, n1.body.nonce))
  t.is(lost.status, 503, lost.text)
  t.alike(lost.body, { error: 'indisponivel' })
  t.absent(s.logs.includes(JSON.stringify({ event: 'terms', reason: 'novo' })), 'not logged as accepted')
  const later = await s.finish(s.m, n2.body.nonce, s.sign(s.m, n2.body.nonce))
  t.is(later.status, 200, later.text)
  t.is(later.body.version, TERMS_VERSION)
  const restart = await s.start(s.m)
  t.is(restart.status, 200, 'a new nonce again')
})
