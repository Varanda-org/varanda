'use strict'

// apps/cli/lib/account/recovery-routes.js, mounted by server.js: a linked
// member stores, lists and removes its recovery entries with one diary-key
// proof over a single-use nonce (@varanda/core/lib/recovery-proof,
// apps/cli/lib/account/recovery-store.js), and anyone holding a lookupId
// fetches its wrapped blob. Loopback only: the members are linked in-process
// and Google is never reached.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signRecovery, blobHashOf } = require('@varanda/core/lib/recovery-proof')
const { signTerms, TERMS_VERSION } = require('@varanda/core/lib/terms')
const { openAccountStore } = require('../lib/account/store')
const { openRecoveryStore, FILE } = require('../lib/account/recovery-store')
const { createAccountServer } = require('../lib/account/server')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const SUB = '1098765432109876543210'
const EMAIL = 'membro@example.test'
const TOKEN_RE = /^[A-Za-z0-9_-]{54}$/
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

// The same 40 bytes spelled differently: the last of 54 characters carries 4
// spare bits, so flipping its lowest bit leaves the decoded bytes alone.
function respell (nonce) {
  const last = B64URL[B64URL.indexOf(nonce[nonce.length - 1]) ^ 1]
  return nonce.slice(0, -1) + last
}

// Never called: the recovery routes never reach Google.
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

function hex (bytes) {
  return nodeCrypto.randomBytes(bytes).toString('hex')
}

function blobOf (kind) {
  return { v: 1, kind, nonce: hex(24), ciphertext: hex(82) }
}

// A service with `m` linked (as 'ana') and a recovery store on the same dir.
// `recovery: false` passes null; `corrupt: true` writes a recovery.json the
// store refuses before opening it.
async function setup (t, { recovery = true, corrupt = false, guard, bucket = {} } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const c = { offset: 0 }
  c.now = () => Date.now() + c.offset
  const iss = issuer()
  const store = openAccountStore(dir, { now: c.now })
  const m = member()
  await linkDirect(store, iss, m, 'ana')
  if (corrupt) fs.writeFileSync(path.join(dir, FILE), '{"not":"a recovery file"}', { mode: 0o600 })
  const rec = recovery ? openRecoveryStore(dir, { now: c.now, ...(guard ? { guard } : {}) }) : null
  const logs = []
  const texts = []
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    recovery: rec,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now,
    ...bucket
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

  async function get (pathname) {
    const res = await fetch(base + pathname)
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  const start = (who) => post('/account/recovery/start', { member: who.hex })
  const sign = (who, fields) => signRecovery({ member: who.hex, association: iss.association, kind: '', lookupId: '', blobHash: '', ...fields }, who.kp)

  async function nonce (who) {
    const r = await start(who)
    if (r.status !== 200) throw new Error('start ' + r.status + ' ' + r.text)
    return r.body.nonce
  }

  async function put (who, kind, lookupId, blob, { signer = who } = {}) {
    const n = await nonce(who)
    const signature = sign(signer, { action: 'put', nonce: n, kind, lookupId, blobHash: blobHashOf({ kind, lookupId, blob }) })
    return post('/account/recovery/put', { member: who.hex, nonce: n, signature, kind, lookupId, blob })
  }

  async function remove (who, kind, lookupId) {
    const n = await nonce(who)
    const signature = sign(who, { action: 'remove', nonce: n, kind, lookupId })
    return post('/account/recovery/remove', { member: who.hex, nonce: n, signature, kind, lookupId })
  }

  async function list (who) {
    const n = await nonce(who)
    return post('/account/recovery/list', { member: who.hex, nonce: n, signature: sign(who, { action: 'list', nonce: n }) })
  }

  const fetchId = (lookupId) => post('/account/recovery/fetch', { lookupId })

  return { dir, c, iss, store, recovery: rec, server, m, logs, texts, post, get, start, sign, nonce, put, remove, list, fetchId }
}

function noSecrets (t, s, secrets) {
  const all = s.logs.join('\n')
  for (const x of secrets) t.absent(all.includes(x), 'not in a log line')
  t.absent(all.includes(s.m.hex), 'no member key in a log line')
  t.absent(all.includes(EMAIL) || s.texts.join('\n').includes(EMAIL), 'no e-mail anywhere')
  for (const line of s.logs) {
    const e = JSON.parse(line)
    if (e.event !== 'recovery') continue
    t.alike(Object.keys(e).sort(), ['event', 'reason'], 'recovery log lines carry only event and reason')
  }
}

test('recovery: put, fetch, list and remove; a repeat put is idempotent; logs carry no id or blob', async (t) => {
  const s = await setup(t)
  const lookupId = hex(32)
  const blob = blobOf('passkey')

  const started = await s.start(s.m)
  t.is(started.status, 200, started.text)
  t.alike(Object.keys(started.body), ['nonce'])
  t.ok(TOKEN_RE.test(started.body.nonce))

  const put = await s.put(s.m, 'passkey', lookupId, blob)
  t.is(put.status, 200, put.text)
  t.alike(Object.keys(put.body), ['createdAt', 'changed'])
  t.is(put.body.changed, true, 'a write')
  t.is(new Date(put.body.createdAt).toISOString(), put.body.createdAt)
  const again = await s.put(s.m, 'passkey', lookupId, blob)
  t.is(again.status, 200, again.text)
  t.is(again.body.createdAt, put.body.createdAt, 'the first date is kept')
  t.is(again.body.changed, false, 'a repeat put is a no-op')

  const fetched = await s.fetchId(lookupId)
  t.is(fetched.status, 200, fetched.text)
  t.alike(fetched.body, { member: s.m.hex, kind: 'passkey', blob })

  const listed = await s.list(s.m)
  t.is(listed.status, 200, listed.text)
  t.alike(listed.body, { entries: [{ lookupId, kind: 'passkey', createdAt: put.body.createdAt }] })

  const removed = await s.remove(s.m, 'passkey', lookupId)
  t.is(removed.status, 200, removed.text)
  t.alike(removed.body, { changed: true })
  const removedAgain = await s.remove(s.m, 'passkey', lookupId)
  t.is(removedAgain.status, 200, removedAgain.text)
  t.alike(removedAgain.body, { changed: false }, 'a repeat remove is a no-op')
  const gone = await s.fetchId(lookupId)
  t.is(gone.status, 404)
  t.alike(gone.body, { error: 'nao-encontrado', recovery: true }, 'the miss is marked as this route\'s')
  t.alike((await s.list(s.m)).body, { entries: [] })

  t.is(fs.statSync(path.join(s.dir, FILE)).mode & 0o777, 0o600)
  for (const reason of ['put', 'remove', 'list', 'fetch']) {
    t.ok(s.logs.includes(JSON.stringify({ event: 'recovery', reason })), 'logged ' + reason)
  }
  noSecrets(t, s, [lookupId, blob.nonce, blob.ciphertext])
})

test('recovery: an unlinked member is refused at start and at put', async (t) => {
  const s = await setup(t)
  const stranger = member()
  const r = await s.start(stranger)
  t.is(r.status, 403)
  t.alike(r.body, { error: 'nao-vinculado' })

  // A nonce issued to the linked member cannot be borrowed by a stranger.
  const n = await s.nonce(s.m)
  const lookupId = hex(32)
  const blob = blobOf('code')
  const signature = s.sign(stranger, { action: 'put', nonce: n, kind: 'code', lookupId, blobHash: blobHashOf({ kind: 'code', lookupId, blob }) })
  const borrowed = await s.post('/account/recovery/put', { member: stranger.hex, nonce: n, signature, kind: 'code', lookupId, blob })
  t.is(borrowed.status, 404)
  t.alike(borrowed.body, { error: 'expirado' })
  t.is((await s.fetchId(lookupId)).status, 404, 'nothing stored')

  for (const bad of ['', s.m.hex.toUpperCase(), s.m.hex.slice(1), 42]) {
    const x = await s.post('/account/recovery/start', { member: bad })
    t.is(x.status, 400)
    t.alike(x.body, { error: 'pedido-invalido' })
  }
})

test('recovery: put after the link is gone from the directory view is nao-vinculado', async (t) => {
  // Links are never removed by the store, so the check after the proof is
  // shown with a status that turns false between start and put.
  const s = await setup(t)
  const n = await s.nonce(s.m)
  const realStatus = s.store.status
  s.store.status = (who) => (who === s.m.hex ? { ...realStatus.call(s.store, who), linked: false } : realStatus.call(s.store, who))
  t.teardown(() => { s.store.status = realStatus })
  const lookupId = hex(32)
  const blob = blobOf('passkey')
  const signature = s.sign(s.m, { action: 'put', nonce: n, kind: 'passkey', lookupId, blobHash: blobHashOf({ kind: 'passkey', lookupId, blob }) })
  const r = await s.post('/account/recovery/put', { member: s.m.hex, nonce: n, signature, kind: 'passkey', lookupId, blob })
  t.is(r.status, 403)
  t.alike(r.body, { error: 'nao-vinculado' })
  s.store.status = realStatus
  t.is((await s.fetchId(lookupId)).status, 404, 'nothing stored')
})

test('recovery: the nonce is single-use, bound to its member, and only a recovery signature for this action and blob counts', async (t) => {
  const s = await setup(t)
  const other = member()
  await linkDirect(s.store, s.iss, other, 'bia', '2222222222222222222222', 'bia@example.test')
  const lookupId = hex(32)
  const blob = blobOf('passkey')
  const blobHash = blobHashOf({ kind: 'passkey', lookupId, blob })

  // Replay of a spent nonce.
  const a = await s.nonce(s.m)
  const sigA = s.sign(s.m, { action: 'put', nonce: a, kind: 'passkey', lookupId, blobHash })
  const body = { member: s.m.hex, nonce: a, signature: sigA, kind: 'passkey', lookupId, blob }
  t.is((await s.post('/account/recovery/put', body)).status, 200)
  const replay = await s.post('/account/recovery/put', body)
  t.is(replay.status, 404)
  t.alike(replay.body, { error: 'expirado' })
  t.ok(Buffer.from(respell(a), 'base64url').equals(Buffer.from(a, 'base64url')), 'the respelling decodes to the same bytes')
  const respelled = await s.post('/account/recovery/put', { ...body, nonce: respell(a) })
  t.is(respelled.status, 404, 'another spelling of a spent nonce')
  t.alike(respelled.body, { error: 'expirado' })

  // Wrong member: minted for `m`, presented by `other` with its own
  // signature. Refused, and it spends nothing: `m` still uses it.
  const b = await s.nonce(s.m)
  const stolen = await s.post('/account/recovery/list', { member: other.hex, nonce: b, signature: s.sign(other, { action: 'list', nonce: b }) })
  t.is(stolen.status, 404)
  t.alike(stolen.body, { error: 'expirado' })
  const late = await s.post('/account/recovery/list', { member: s.m.hex, nonce: b, signature: s.sign(s.m, { action: 'list', nonce: b }) })
  t.is(late.status, 200, 'the other member\'s attempt spent nothing: ' + late.text)

  // A tampered nonce (one MAC byte changed) and a made-up one.
  const tamperedFrom = await s.nonce(s.m)
  const raw = Buffer.from(tamperedFrom, 'base64url')
  raw[raw.length - 1] ^= 0x01
  const tampered = raw.toString('base64url')
  for (const forged of [tampered, nodeCrypto.randomBytes(40).toString('base64url')]) {
    const r = await s.post('/account/recovery/list', { member: s.m.hex, nonce: forged, signature: s.sign(s.m, { action: 'list', nonce: forged }) })
    t.is(r.status, 404, 'a nonce this server never minted')
    t.alike(r.body, { error: 'expirado' })
  }

  // Bad signatures: another key, another action, another blob, a terms proof.
  const lookup2 = hex(32)
  const blob2 = blobOf('passkey')
  const c = await s.nonce(s.m)
  const byOther = await s.post('/account/recovery/put', { member: s.m.hex, nonce: c, signature: s.sign({ ...s.m, kp: other.kp }, { action: 'put', nonce: c, kind: 'passkey', lookupId: lookup2, blobHash: blobHashOf({ kind: 'passkey', lookupId: lookup2, blob: blob2 }) }), kind: 'passkey', lookupId: lookup2, blob: blob2 })
  t.is(byOther.status, 400)
  t.alike(byOther.body, { error: 'assinatura-invalida' })
  const afterRefusal = await s.post('/account/recovery/list', { member: s.m.hex, nonce: c, signature: s.sign(s.m, { action: 'list', nonce: c }) })
  t.is(afterRefusal.status, 200, 'a refused proof spent nothing: ' + afterRefusal.text)

  const d = await s.nonce(s.m)
  const asRemove = await s.post('/account/recovery/put', { member: s.m.hex, nonce: d, signature: s.sign(s.m, { action: 'remove', nonce: d, kind: 'passkey', lookupId: lookup2 }), kind: 'passkey', lookupId: lookup2, blob: blob2 })
  t.is(asRemove.status, 400)
  t.alike(asRemove.body, { error: 'assinatura-invalida' })

  const e = await s.nonce(s.m)
  const swapped = await s.post('/account/recovery/put', { member: s.m.hex, nonce: e, signature: s.sign(s.m, { action: 'put', nonce: e, kind: 'passkey', lookupId: lookup2, blobHash: blobHashOf({ kind: 'passkey', lookupId: lookup2, blob: blobOf('passkey') }) }), kind: 'passkey', lookupId: lookup2, blob: blob2 })
  t.is(swapped.status, 400, 'the hash is recomputed from the blob sent')
  t.alike(swapped.body, { error: 'assinatura-invalida' })

  const f = await s.nonce(s.m)
  const terms = signTerms({ nonce: f, member: s.m.hex, association: s.iss.association, version: TERMS_VERSION }, s.m.kp)
  const asTerms = await s.post('/account/recovery/list', { member: s.m.hex, nonce: f, signature: terms })
  t.is(asTerms.status, 400)
  t.alike(asTerms.body, { error: 'assinatura-invalida' })

  const g = await s.nonce(s.m)
  const malformed = await s.post('/account/recovery/list', { member: s.m.hex, nonce: g, signature: 'zz' })
  t.is(malformed.status, 400)
  t.alike(malformed.body, { error: 'assinatura-invalida' })

  // TTL: 600 s.
  const h = await s.nonce(s.m)
  s.c.offset += 600 * 1000
  const expired = await s.post('/account/recovery/list', { member: s.m.hex, nonce: h, signature: s.sign(s.m, { action: 'list', nonce: h }) })
  t.is(expired.status, 404)
  t.alike(expired.body, { error: 'expirado' })

  t.is((await s.fetchId(lookup2)).status, 404, 'no refused put was stored')
  // A blob whose kind differs from the declared kind.
  const i = await s.nonce(s.m)
  const mixed = await s.post('/account/recovery/put', { member: s.m.hex, nonce: i, signature: 'a'.repeat(128), kind: 'passkey', lookupId: lookup2, blob: blobOf('code') })
  t.is(mixed.status, 400)
  t.alike(mixed.body, { error: 'pedido-invalido' })
})

test('recovery: another member\'s lookupId is refused on put and remove', async (t) => {
  const s = await setup(t)
  const other = member()
  await linkDirect(s.store, s.iss, other, 'bia', '2222222222222222222222', 'bia@example.test')
  const lookupId = hex(32)
  const blob = blobOf('passkey')
  t.is((await s.put(s.m, 'passkey', lookupId, blob)).status, 200)

  const hijack = await s.put(other, 'passkey', lookupId, blobOf('passkey'))
  t.is(hijack.status, 400)
  t.alike(hijack.body, { error: 'pedido-invalido' })
  const drop = await s.remove(other, 'passkey', lookupId)
  t.is(drop.status, 400)
  t.alike(drop.body, { error: 'pedido-invalido' })
  t.alike((await s.fetchId(lookupId)).body, { member: s.m.hex, kind: 'passkey', blob }, 'untouched')
})

test('recovery: the 5th passkey is limite-recuperacao; a new code replaces the old one', async (t) => {
  const s = await setup(t)
  for (let i = 0; i < 4; i++) t.is((await s.put(s.m, 'passkey', hex(32), blobOf('passkey'))).status, 200, 'passkey ' + (i + 1))
  const fifthId = hex(32)
  const fifth = await s.put(s.m, 'passkey', fifthId, blobOf('passkey'))
  t.is(fifth.status, 409)
  t.alike(fifth.body, { error: 'limite-recuperacao' })
  t.is((await s.fetchId(fifthId)).status, 404)

  const code1 = hex(32)
  const code2 = hex(32)
  t.is((await s.put(s.m, 'code', code1, blobOf('code'))).status, 200)
  // The window: 4 passkeys + 1 refused + 1 code = 6 verified so far.
  s.c.offset += 600 * 1000
  t.is((await s.put(s.m, 'code', code2, blobOf('code'))).status, 200)
  t.is((await s.fetchId(code1)).status, 404, 'the old code opens nothing')
  t.is((await s.fetchId(code2)).status, 200)
  const entries = (await s.list(s.m)).body.entries
  t.is(entries.filter((e) => e.kind === 'code').length, 1)
  t.is(entries.filter((e) => e.kind === 'passkey').length, 4)
})

test('recovery: fetch of a malformed id is pedido-invalido and touches nothing; unknown ids grow no state', async (t) => {
  const s = await setup(t)
  let calls = 0
  const realFetch = s.recovery.fetch
  s.recovery.fetch = (id) => { calls++; return realFetch(id) }
  for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 42, null, ['a'.repeat(64)]]) {
    const r = await s.post('/account/recovery/fetch', { lookupId: bad })
    t.is(r.status, 400, 'id ' + JSON.stringify(bad))
    t.alike(r.body, { error: 'pedido-invalido' })
  }
  t.is(calls, 0, 'the store was never asked')
  for (let i = 0; i < 20; i++) t.is((await s.fetchId(hex(32))).status, 404)
  t.is(calls, 20)
  t.alike(s.server.recoveryStats(), { spent: 0 }, 'no nonce or entry kept for an unknown id')
  t.absent(fs.existsSync(path.join(s.dir, FILE)), 'nothing written')
})

test('recovery: the 11th verified request in 10 minutes is refused; invalid signatures charge nothing', async (t) => {
  const s = await setup(t)
  for (let i = 0; i < 12; i++) {
    const n = await s.nonce(s.m)
    const bad = await s.post('/account/recovery/list', { member: s.m.hex, nonce: n, signature: 'a'.repeat(128) })
    t.is(bad.status, 400, 'invalid signature ' + i)
  }
  for (let i = 0; i < 10; i++) t.is((await s.list(s.m)).status, 200, 'verified ' + (i + 1))
  const eleventh = await s.list(s.m)
  t.is(eleventh.status, 429)
  t.alike(eleventh.body, { error: 'pedido-invalido' })
  t.is((await s.fetchId(hex(32))).status, 404, 'fetch is not charged on the member window')
  s.c.offset += 600 * 1000
  t.is((await s.list(s.m)).status, 200, 'the window restarts')
})

test('recovery: start stores nothing, so a start flood for a member locks out neither that member nor another', async (t) => {
  // The global bucket is lifted so the test measures this route alone, not
  // the shared residual documented in server.js.
  const s = await setup(t, { bucket: { ratePerSecond: 1e6, burst: 1e6 } })
  const y = member()
  await linkDirect(s.store, s.iss, y, 'bia', '2098765432109876543210', 'bia@example.test')
  const yNonce = await s.nonce(y)
  const xEarly = await s.nonce(s.m)

  // Anyone may name X's public key at start: far past the old caps.
  for (let i = 0; i < 300; i++) {
    const r = await s.start(s.m)
    if (r.status !== 200) t.fail('start ' + r.status + ' ' + r.text)
  }
  t.alike(s.server.recoveryStats(), { spent: 0 }, 'the flood stored nothing')

  const xList = await s.post('/account/recovery/list', { member: s.m.hex, nonce: xEarly, signature: s.sign(s.m, { action: 'list', nonce: xEarly }) })
  t.is(xList.status, 200, 'X\'s nonce from before the flood still works: ' + xList.text)
  const yList = await s.post('/account/recovery/list', { member: y.hex, nonce: yNonce, signature: s.sign(y, { action: 'list', nonce: yNonce }) })
  t.is(yList.status, 200, 'Y\'s nonce from before the flood still works: ' + yList.text)
  t.is((await s.list(s.m)).status, 200, 'X still starts and lists')
  t.alike(s.server.recoveryStats(), { spent: 3 }, 'only verified requests are recorded')

  // Spent nonces are kept only until their own expiry.
  s.c.offset += 600 * 1000
  t.is((await s.list(y)).status, 200)
  t.alike(s.server.recoveryStats(), { spent: 1 }, 'expired entries pruned on the next spend')
})

test('recovery: a clock that jumps forward and back never revives a pruned nonce', async (t) => {
  // Back by less than one TTL: the clock holds.
  // Back by more: every outstanding nonce is voided.
  for (const back of [300, 601]) {
    const s = await setup(t)
    const n = await s.nonce(s.m)
    const body = { member: s.m.hex, nonce: n, signature: s.sign(s.m, { action: 'list', nonce: n }) }
    t.is((await s.post('/account/recovery/list', body)).status, 200)
    // Forward past the nonce's expiry: the next verified request prunes it.
    s.c.offset += 601 * 1000
    t.is((await s.list(s.m)).status, 200)
    t.alike(s.server.recoveryStats(), { spent: 1 }, 'the first nonce was pruned')
    // Corrected back: the captured request stays dead.
    s.c.offset -= back * 1000
    const replay = await s.post('/account/recovery/list', body)
    t.is(replay.status, 404, 'replay after the clock stepped back ' + back + ' s: ' + replay.text)
    t.alike(replay.body, { error: 'expirado' })
    t.is((await s.list(s.m)).status, 200, 'fresh nonces still work after a step back of ' + back + ' s')
  }
})

test('recovery: a wall clock more than one TTL behind voids old nonces and keeps TTLs at 10 minutes', async (t) => {
  const s = await setup(t)
  const early = await s.nonce(s.m)
  t.is((await s.list(s.m)).status, 200)
  t.alike(s.server.recoveryStats(), { spent: 1 })
  // An hour back: nothing minted before survives, the spent set starts over.
  s.c.offset -= 3600 * 1000
  const old = await s.post('/account/recovery/list', { member: s.m.hex, nonce: early, signature: s.sign(s.m, { action: 'list', nonce: early }) })
  t.is(old.status, 404, 'a nonce minted before the step is void: ' + old.text)
  t.alike(old.body, { error: 'expirado' })
  t.alike(s.server.recoveryStats(), { spent: 0 }, 'the spent set was cleared with the old secret')
  // A nonce minted now lives 10 wall-clock minutes, not until the old time.
  const fresh = await s.nonce(s.m)
  s.c.offset += 600 * 1000
  const late = await s.post('/account/recovery/list', { member: s.m.hex, nonce: fresh, signature: s.sign(s.m, { action: 'list', nonce: fresh }) })
  t.is(late.status, 404, 'TTL follows the wall clock again')
  t.alike(late.body, { error: 'expirado' })
})

test('recovery: exact Origin and a JSON body are required', async (t) => {
  const s = await setup(t)
  for (const pathname of ['/account/recovery/start', '/account/recovery/put', '/account/recovery/remove', '/account/recovery/list', '/account/recovery/fetch']) {
    const noOrigin = await s.post(pathname, { member: s.m.hex }, { origin: null })
    t.is(noOrigin.status, 403, pathname + ' without Origin')
    t.alike(noOrigin.body, { error: 'pedido-invalido' })
    const foreign = await s.post(pathname, { member: s.m.hex }, { origin: 'https://evil.test' })
    t.is(foreign.status, 403, pathname + ' from another origin')
    const form = await s.post(pathname, { member: s.m.hex }, { type: 'text/plain' })
    t.is(form.status, 400, pathname + ' as text/plain')
  }
  const big = await s.post('/account/recovery/fetch', { lookupId: hex(32), pad: 'x'.repeat(5000) })
  t.is(big.status, 413)
  const notRoute = await s.get('/account/recovery/fetch')
  t.is(notRoute.status, 404, 'GET is not a route')
  t.alike(notRoute.body, { error: 'nao-encontrado' }, 'an unknown route carries no recovery mark')
})

test('recovery: no store or a corrupt one answers 503 on these routes only', async (t) => {
  for (const opts of [{ recovery: false }, { corrupt: true }]) {
    const s = await setup(t, opts)
    for (const [pathname, body] of [['/account/recovery/start', { member: s.m.hex }], ['/account/recovery/fetch', { lookupId: hex(32) }]]) {
      const r = await s.post(pathname, body)
      t.is(r.status, 503, JSON.stringify(opts) + ' ' + pathname)
      t.alike(r.body, { error: 'indisponivel' })
    }
    const status = await s.get('/account/status?member=' + s.m.hex)
    t.is(status.status, 200, 'the rest of the service still answers')
    t.is(status.body.linked, true)
    t.ok(s.logs.includes(JSON.stringify({ event: 'recovery', reason: 'indisponivel' })))
    if (opts.corrupt) t.is(fs.readFileSync(path.join(s.dir, FILE), 'utf8'), '{"not":"a recovery file"}', 'the corrupt file is never rewritten')
  }
})

test('recovery: a guard lost after the write is resultado-incerto, never a definite refusal', async (t) => {
  const answers = []
  const s = await setup(t, { guard: () => answers.length === 0 || answers.shift() })
  const lookupId = hex(32)
  const blob = blobOf('passkey')
  // reread() asks the guard before the write, persist() after it.
  answers.push(true, false)
  const lost = await s.put(s.m, 'passkey', lookupId, blob)
  t.is(lost.status, 503, lost.text)
  t.alike(lost.body, { error: 'resultado-incerto' })
  t.absent(s.logs.includes(JSON.stringify({ event: 'recovery', reason: 'put' })), 'not logged as stored')
  // The refusal was for that request only: the next put goes through and
  // the entry is there.
  const retry = await s.put(s.m, 'passkey', lookupId, blob)
  t.is(retry.status, 200, retry.text)
  t.is((await s.fetchId(lookupId)).status, 200)

  answers.push(true, false)
  const lostRemove = await s.remove(s.m, 'passkey', lookupId)
  t.is(lostRemove.status, 503, lostRemove.text)
  t.alike(lostRemove.body, { error: 'resultado-incerto' })
})

test('recovery: list and fetch after a guard lost past the rename show the file, not stale memory', async (t) => {
  const answers = []
  const s = await setup(t, { guard: () => answers.length === 0 || answers.shift() })
  const lookupId = hex(32)
  const blob = blobOf('passkey')
  // reread() asks the guard before the write, persist() after the rename.
  answers.push(true, false)
  const lost = await s.put(s.m, 'passkey', lookupId, blob)
  t.is(lost.status, 503, lost.text)
  t.alike(lost.body, { error: 'resultado-incerto' })
  const fetched = await s.fetchId(lookupId)
  t.is(fetched.status, 200, fetched.text)
  t.alike(fetched.body, { member: s.m.hex, kind: 'passkey', blob }, 'fetch shows the row the file holds')
  const listed = await s.list(s.m)
  t.is(listed.status, 200, listed.text)
  t.alike(listed.body.entries.map((e) => e.lookupId), [lookupId], 'list shows it too')

  answers.push(true, false)
  const lostRemove = await s.remove(s.m, 'passkey', lookupId)
  t.is(lostRemove.status, 503, lostRemove.text)
  t.alike(lostRemove.body, { error: 'resultado-incerto' })
  t.is((await s.fetchId(lookupId)).status, 404, 'fetch shows the removal the file holds')
  t.alike((await s.list(s.m)).body, { entries: [] })
})

test('recovery: list and fetch after an uncertain write answer indisponivel when the file turned malformed', async (t) => {
  const answers = []
  const s = await setup(t, { guard: () => answers.length === 0 || answers.shift() })
  const lookupId = hex(32)
  answers.push(true, false)
  t.is((await s.put(s.m, 'passkey', lookupId, blobOf('passkey'))).status, 503)
  fs.writeFileSync(path.join(s.dir, FILE), 'not json')
  const fetched = await s.fetchId(lookupId)
  t.is(fetched.status, 503)
  t.alike(fetched.body, { error: 'indisponivel' })
})
