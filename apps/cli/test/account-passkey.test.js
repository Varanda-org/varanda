'use strict'

// The passkey enrolment of Excluir conta (apps/cli/lib/account/passkey-routes.js):
// right after the link, the app sends the creation's attestation object,
// signed by the diary key at account-link phase 'passkey'; the service keeps
// the public key only while the member has none and the link is fresh. Then
// a deletion with that passkey runs at once. An extra passkey (a 'passkey'
// recovery entry) gets a key only with a fresh assertion of a stored one.
// Loopback only, software passkeys (./helpers/fake-passkey.js), Google never
// reached.

const test = require('brittle')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { openAccountStore } = require('../lib/account/store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { openPasskeyStore, MAX_KEYS } = require('../lib/account/passkey-store')
const { openRecoveryStore } = require('../lib/account/recovery-store')
const { createAccountServer } = require('../lib/account/server')
const { LINK_WINDOW_MS } = require('../lib/account/passkey-routes')
const { createFakePasskey } = require('./helpers/fake-passkey')
const { tmpDir } = require('./helpers/net')

const ORIGIN = 'https://varanda.test'
const RP = 'varanda.test'

const google = {
  authorizeUrl: () => { throw new Error('google called') },
  exchange: async () => { throw new Error('google called') }
}

function keyPair () {
  const kp = crypto.keyPair()
  return { kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

function sha256hex (b64url) {
  return nodeCrypto.createHash('sha256').update(Buffer.from(b64url, 'base64url')).digest('hex')
}

function hex (bytes) {
  return nodeCrypto.randomBytes(bytes).toString('hex')
}

// `recovery: false` mounts no recovery store; `wrap(store)` replaces the one
// the routes see.
async function setup (t, { recovery: withRecovery = true, wrap = (r) => r, androidCertSha256 = '' } = {}) {
  const dir = path.join(tmpDir(t), 'account')
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const assoc = crypto.keyPair()
  const issKp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(issKp.publicKey, 'hex') }, assoc)
  const association = cert.association
  const store = openAccountStore(dir, { now })
  const passkeys = openPasskeyStore(dir, { now })
  const moderation = openModerationStore(dir, { now, association })
  const recovery = withRecovery ? openRecoveryStore(dir, { now }) : null
  const logs = []
  const server = createAccountServer({ association, origin: ORIGIN, google, store, issuer: { keyPair: issKp, cert }, passkeys, moderation, recovery: recovery === null ? null : wrap(recovery), androidCertSha256, log: (e) => logs.push(JSON.stringify(e)), now })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port

  async function link (who, username) {
    const row = store.start({ member: who.hex, username })
    store.reserve(row.id)
    store.putGoogle(row.id, { sub: 'sub-' + username, email: username + '@example.test' })
    await store.finish(row.id, { signature: 'a'.repeat(128) }, issKp, cert, association)
  }

  async function post (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  const signPasskey = (who, nonce, username, hash) => signAccountLink({ phase: 'passkey', nonce, member: who.hex, username, association, sub: hash }, who.kp)

  // start -> sign -> add of pk's creation for `who` (named `username`).
  async function enrol (who, username, pk, { attestationObject = pk.attestationObject(), credentialId = pk.credentialId, hash } = {}) {
    const st = await post('/account/passkey/start', { member: who.hex })
    if (st.status !== 200) return st
    return post('/account/passkey/add', { member: who.hex, nonce: st.body.nonce, signature: signPasskey(who, st.body.nonce, username, hash || sha256hex(attestationObject)), credentialId, attestationObject })
  }

  // An extra passkey's enrolment: pk's creation, vouched for by `signer`'s
  // assertion over the same nonce (`assert` alters it) and naming the entry
  // `lookupId`. Each call starts a new member window, so the per-member
  // limit never decides a test.
  async function enrolExtra (who, username, pk, { signer = null, lookupId, assert = {} } = {}) {
    clock.offset += 600 * 1000 + 1
    const st = await post('/account/passkey/start', { member: who.hex })
    if (st.status !== 200) return st
    const att = pk.attestationObject()
    const body = { member: who.hex, nonce: st.body.nonce, signature: signPasskey(who, st.body.nonce, username, sha256hex(att)), credentialId: pk.credentialId, attestationObject: att }
    if (signer !== null) body.assertion = signer.assert({ challenge: Buffer.from(st.body.nonce, 'base64url'), origin: ORIGIN, ...assert })
    if (lookupId !== undefined) body.lookupId = lookupId
    return post('/account/passkey/add', body)
  }

  // A recovery entry of `who`, as /account/recovery/put stores it.
  async function entry (who, kind = 'passkey') {
    const lookupId = hex(32)
    await recovery.put({ member: who.hex, kind, lookupId, blob: { v: 1, kind, nonce: hex(24), ciphertext: hex(82) } })
    return lookupId
  }

  return { clock, store, passkeys, moderation, recovery, association, logs, link, post, enrol, enrolExtra, entry, signPasskey }
}

// `m` linked as 'ana' with `pk` enrolled at sign-up.
async function enrolled (t, opts) {
  const s = await setup(t, opts)
  const m = keyPair()
  await s.link(m, 'ana')
  const pk = createFakePasskey({ rpId: RP })
  t.alike((await s.enrol(m, 'ana', pk)).body, { added: true })
  return { s, m, pk }
}

test('passkey enrolment: right after the link the key is stored; the same passkey again is a no-op', async (t) => {
  const s = await setup(t)
  const m = keyPair()
  await s.link(m, 'ana')
  const pk = createFakePasskey({ rpId: RP })
  const r = await s.enrol(m, 'ana', pk)
  t.is(r.status, 200, r.text)
  t.alike(r.body, { added: true })
  const keys = s.passkeys.keys(m.hex)
  t.is(keys.length, 1)
  t.is(keys[0].credentialId, pk.credentialId)
  t.is(keys[0].alg, -7)
  t.alike(await s.enrol(m, 'ana', pk).then((x) => x.body), { added: false }, 'a retry after an unknown outcome ends well')
  s.clock.offset = LINK_WINDOW_MS + 60000
  t.alike(await s.enrol(m, 'ana', pk).then((x) => x.body), { added: false }, 'even after the window')
  t.ok(s.logs.some((l) => l.includes('"registrada"')))
  t.absent(s.logs.join('\n').includes(pk.credentialId), 'no credential id in a log line')
  t.absent(s.logs.join('\n').includes(m.hex), 'no key in a log line')

  // That passkey then deletes at once.
  const st = await s.post('/account/delete/start', { member: m.hex })
  t.alike(st.body.passkeys, [pk.credentialId])
  const del = await s.post('/account/delete/finish', {
    member: m.hex,
    nonce: st.body.nonce,
    signature: signAccountLink({ phase: 'delete', nonce: st.body.nonce, member: m.hex, username: 'ana', association: s.association, sub: '' }, m.kp),
    assertion: pk.assert({ challenge: Buffer.from(st.body.nonce, 'base64url'), origin: ORIGIN })
  })
  t.alike(del.body, { deleted: 'pendente' })
})

test('passkey enrolment: an unlocked session later cannot add or replace a key', async (t) => {
  const s = await setup(t)
  const m = keyPair()
  await s.link(m, 'ana')
  const forged = createFakePasskey({ rpId: RP })

  // An account linked more than an hour ago (every account older than this
  // feature) has no key and can no longer get one.
  s.clock.offset = LINK_WINDOW_MS + 60000
  let r = await s.enrol(m, 'ana', forged)
  t.is(r.status, 409)
  t.is(r.body.error, 'vinculo-antigo')
  t.alike(s.passkeys.keys(m.hex), [])

  // A fresh account with a key: a second, different passkey is refused.
  const b = keyPair()
  await s.link(b, 'bia')
  const real = createFakePasskey({ rpId: RP })
  t.alike((await s.enrol(b, 'bia', real)).body, { added: true })
  r = await s.enrol(b, 'bia', forged)
  t.is(r.body.error, 'passkey-registrada')
  r = await s.enrol(b, 'bia', createFakePasskey({ rpId: RP, credentialId: Buffer.from(real.credentialId, 'base64url') }))
  t.is(r.body.error, 'passkey-registrada', 'the same credential id with another key')
  t.alike(s.passkeys.keys(b.hex).map((k) => k.credentialId), [real.credentialId])
})

test('passkey enrolment: a bad proof, attestation, nonce or member is refused and stores nothing', async (t) => {
  const s = await setup(t)
  const m = keyPair()
  const other = keyPair()
  await s.link(m, 'ana')
  const pk = createFakePasskey({ rpId: RP })
  let r = await s.enrol(m, 'ana', pk, { hash: 'cd'.repeat(32) })
  t.is(r.body.error, 'assinatura-invalida', 'the proof names another attestation')
  r = await s.enrol(m, 'outra', pk)
  t.is(r.body.error, 'assinatura-invalida', 'another @nome')
  r = await s.enrol(m, 'ana', pk, { attestationObject: pk.attestationObject({ rp: 'evil.test' }) })
  t.is(r.status, 403)
  t.is(r.body.error, 'passkey-invalida', 'created for another rp')
  r = await s.enrol(m, 'ana', pk, { credentialId: nodeCrypto.randomBytes(16).toString('base64url') })
  t.is(r.body.error, 'passkey-invalida', 'another credential id than the attestation names')
  r = await s.enrol(m, 'ana', pk, { attestationObject: '!!' })
  t.is(r.body.error, 'passkey-invalida', 'not base64url')

  const st = await s.post('/account/passkey/start', { member: m.hex })
  const att = pk.attestationObject()
  const body = { member: m.hex, nonce: st.body.nonce, signature: s.signPasskey(m, st.body.nonce, 'ana', sha256hex(att)), credentialId: pk.credentialId, attestationObject: att }
  r = await s.post('/account/passkey/add', { ...body, member: other.hex })
  t.is(r.body.error, 'expirado', 'a nonce minted for another member (and now spent)')
  r = await s.post('/account/passkey/add', body)
  t.is(r.body.error, 'expirado', 'single use')

  t.is((await s.post('/account/passkey/start', { member: other.hex })).body.error, 'nao-vinculado')
  t.is((await s.post('/account/passkey/start', { member: 'zz' })).body.error, 'pedido-invalido')
  t.alike(s.passkeys.keys(m.hex), [])

  await s.store.deleteMember(m.hex)
  t.is((await s.post('/account/passkey/start', { member: m.hex })).body.error, 'conta-excluida')
})

test('extra passkey: a stored passkey\'s assertion vouches for it; then it deletes at once', async (t) => {
  const { s, m, pk } = await enrolled(t)
  const extra = createFakePasskey({ rpId: RP })
  const lookupId = await s.entry(m)
  t.alike((await s.post('/account/passkey/start', { member: m.hex, list: true })).body.passkeys, [pk.credentialId], 'start lists the credentials that can vouch')
  const r = await s.enrolExtra(m, 'ana', extra, { signer: pk, lookupId, assert: { step: 1 } })
  t.is(r.status, 200, r.text)
  t.alike(r.body, { added: true })
  const keys = s.passkeys.keys(m.hex)
  t.alike(keys.map((k) => [k.credentialId, k.lookupId]), [[pk.credentialId, null], [extra.credentialId, lookupId]])
  t.is(keys[0].signCount, 1, 'the vouching key\'s counter moved')
  t.ok(s.logs.includes(JSON.stringify({ event: 'passkey', reason: 'registrada-extra' })))

  t.alike((await s.enrolExtra(m, 'ana', extra, { signer: pk, lookupId })).body, { added: false }, 'the same credential again ends well')
  t.alike((await s.enrolExtra(m, 'ana', extra)).body, { added: false }, 'also without the assertion')

  // An extra key vouches for the next one too.
  const third = createFakePasskey({ rpId: RP })
  const thirdId = await s.entry(m)
  t.alike((await s.enrolExtra(m, 'ana', third, { signer: extra, lookupId: thirdId })).body, { added: true })
  t.alike((await s.post('/account/passkey/start', { member: m.hex, list: true })).body.passkeys, [pk.credentialId, extra.credentialId, third.credentialId], 'the extra keys are listed too')

  const all = s.logs.join('\n')
  for (const x of [pk.credentialId, extra.credentialId, third.credentialId, lookupId, thirdId, m.hex]) t.absent(all.includes(x), 'no id or key in a log line')
  for (const line of s.logs) {
    const e = JSON.parse(line)
    if (e.event === 'passkey') t.alike(Object.keys(e).sort(), ['event', 'reason'])
  }

  const st = await s.post('/account/delete/start', { member: m.hex })
  t.alike(st.body.passkeys, [pk.credentialId, extra.credentialId, third.credentialId], 'delete start lists the extra keys')
  const del = await s.post('/account/delete/finish', {
    member: m.hex,
    nonce: st.body.nonce,
    signature: signAccountLink({ phase: 'delete', nonce: st.body.nonce, member: m.hex, username: 'ana', association: s.association, sub: '' }, m.kp),
    assertion: extra.assert({ challenge: Buffer.from(st.body.nonce, 'base64url'), origin: ORIGIN })
  })
  t.alike(del.body, { deleted: 'pendente' }, 'not the 7-day wait')
})

test('passkey start: the list only on request, so older apps keep reading exactly { nonce }', async (t) => {
  const { s, m, pk } = await enrolled(t)
  const plain = await s.post('/account/passkey/start', { member: m.hex })
  t.is(plain.status, 200, plain.text)
  t.alike(Object.keys(plain.body), ['nonce'], 'the old-client contract')
  const listed = await s.post('/account/passkey/start', { member: m.hex, list: true })
  t.is(listed.status, 200, listed.text)
  t.alike(Object.keys(listed.body).sort(), ['nonce', 'passkeys', 'username'])
  t.alike(listed.body.passkeys, [pk.credentialId])
  t.is(listed.body.username, 'ana', 'the @nome the add\'s proof names')
  for (const list of [false, 1, 'true', null, []]) {
    const r = await s.post('/account/passkey/start', { member: m.hex, list })
    t.is(r.status, 400)
    t.is(r.body.error, 'pedido-invalido', 'list ' + JSON.stringify(list))
  }
})

test('extra passkey: without a stored key\'s valid assertion nothing is stored', async (t) => {
  const { s, m, pk } = await enrolled(t)
  const other = keyPair()
  await s.link(other, 'bia')
  const extra = createFakePasskey({ rpId: RP })
  const lookupId = await s.entry(m)
  const refusals = [
    ['no assertion: as for older apps', { lookupId }, 409, 'passkey-registrada'],
    ['an assertion without lookupId', { signer: pk }, 400, 'pedido-invalido'],
    ['a malformed lookupId', { signer: pk, lookupId: 'AB'.repeat(32) }, 400, 'pedido-invalido'],
    ['an assertion of a passkey the service does not hold', { signer: createFakePasskey({ rpId: RP }), lookupId }, 403, 'passkey-invalida', 'passkey-desconhecida'],
    ['an assertion of the new passkey itself', { signer: extra, lookupId }, 403, 'passkey-invalida', 'passkey-desconhecida'],
    ['a signature under another key', { signer: pk, lookupId, assert: { signWith: createFakePasskey({ rpId: RP }).privateKey } }, 403, 'passkey-invalida'],
    ['another challenge', { signer: pk, lookupId, assert: { challenge: nodeCrypto.randomBytes(32) } }, 403, 'passkey-invalida'],
    ['another origin', { signer: pk, lookupId, assert: { origin: 'https://evil.test' } }, 403, 'passkey-invalida'],
    ['no user verification', { signer: pk, lookupId, assert: { flags: 0x01 } }, 403, 'passkey-invalida'],
    ['an unknown lookupId', { signer: pk, lookupId: hex(32) }, 403, 'passkey-invalida', 'entrada-ausente']
  ]
  for (const [label, opts, status, error, reason] of refusals) {
    const r = await s.enrolExtra(m, 'ana', extra, opts)
    t.is(r.status, status, label + ': ' + r.text)
    t.is(r.body.error, error, label)
    if (reason) t.ok(s.logs.includes(JSON.stringify({ event: 'passkey', reason })), label + ' logged')
  }
  const bad = await s.enrolExtra(m, 'ana', extra, { signer: pk, lookupId, assert: { tamper: (a) => ({ ...a, extra: 'x' }) } })
  t.is(bad.body.error, 'pedido-invalido', 'an assertion with an unknown field')

  const theirs = await s.entry(other)
  t.is((await s.enrolExtra(m, 'ana', extra, { signer: pk, lookupId: theirs })).body.error, 'passkey-invalida', 'another member\'s entry')
  const code = await s.entry(m, 'code')
  t.is((await s.enrolExtra(m, 'ana', extra, { signer: pk, lookupId: code })).body.error, 'passkey-invalida', 'a code entry')
  const removed = await s.entry(m)
  await s.recovery.remove({ member: m.hex, lookupId: removed })
  t.is((await s.enrolExtra(m, 'ana', extra, { signer: pk, lookupId: removed })).body.error, 'passkey-invalida', 'a removed entry')

  t.alike(s.passkeys.keys(m.hex).map((k) => k.credentialId), [pk.credentialId], 'nothing stored')

  // The counter goes back: a cloned authenticator.
  const stepped = createFakePasskey({ rpId: RP, signCount: 5 })
  const n = keyPair()
  await s.link(n, 'caio')
  t.alike((await s.enrol(n, 'caio', stepped)).body, { added: true })
  const nId = await s.entry(n)
  t.is((await s.enrolExtra(n, 'caio', extra, { signer: stepped, lookupId: nId, assert: { count: 3 } })).body.error, 'passkey-invalida', 'a counter that went back')
})

test('extra passkey: another member\'s stored passkey never vouches', async (t) => {
  const { s, m } = await enrolled(t)
  const other = keyPair()
  await s.link(other, 'bia')
  const theirs = createFakePasskey({ rpId: RP })
  t.alike((await s.enrol(other, 'bia', theirs)).body, { added: true })
  const extra = createFakePasskey({ rpId: RP })
  const lookupId = await s.entry(m)
  const r = await s.enrolExtra(m, 'ana', extra, { signer: theirs, lookupId })
  t.is(r.status, 403, r.text)
  t.is(r.body.error, 'passkey-invalida')
  t.ok(s.logs.includes(JSON.stringify({ event: 'passkey', reason: 'passkey-desconhecida' })))
  t.is(s.passkeys.keys(m.hex).length, 1, 'nothing stored')
  t.is(s.passkeys.keys(other.hex)[0].signCount, 0, 'the other member\'s counter did not move')
})

test('extra passkey: a key whose entry is gone neither vouches, nor is listed, nor deletes at once', async (t) => {
  const { s, m, pk } = await enrolled(t)
  const extra = createFakePasskey({ rpId: RP })
  const lookupId = await s.entry(m)
  t.alike((await s.enrolExtra(m, 'ana', extra, { signer: pk, lookupId })).body, { added: true })
  // The entry goes while passkeys.json is not written (an unusable passkey
  // store at the remove, or a remove racing the add): the key stays.
  await s.recovery.remove({ member: m.hex, lookupId })
  t.alike(s.passkeys.keys(m.hex).map((k) => k.credentialId), [pk.credentialId, extra.credentialId], 'still in the file')

  t.alike((await s.post('/account/passkey/start', { member: m.hex, list: true })).body.passkeys, [pk.credentialId], 'not listed as a voucher')
  const third = createFakePasskey({ rpId: RP })
  const thirdId = await s.entry(m)
  const r = await s.enrolExtra(m, 'ana', third, { signer: extra, lookupId: thirdId })
  t.is(r.status, 403, r.text)
  t.is(r.body.error, 'passkey-invalida', 'it vouches for nothing')

  const st = await s.post('/account/delete/start', { member: m.hex })
  t.alike(st.body.passkeys, [pk.credentialId], 'delete start does not list it')
  const del = await s.post('/account/delete/finish', {
    member: m.hex,
    nonce: st.body.nonce,
    signature: signAccountLink({ phase: 'delete', nonce: st.body.nonce, member: m.hex, username: 'ana', association: s.association, sub: '' }, m.kp),
    assertion: extra.assert({ challenge: Buffer.from(st.body.nonce, 'base64url'), origin: ORIGIN }),
    wait: true
  })
  t.is(del.status, 200, del.text)
  t.ok(typeof del.body.scheduled === 'string', 'the 7-day wait, not a deletion at once')
  t.is(s.store.deletedAt(m.hex), null)
})

test('extra passkey: an entry put again at the same lookupId does not bring back the key of the removed one', async (t) => {
  const { s, m, pk } = await enrolled(t)
  const extra = createFakePasskey({ rpId: RP })
  const lookupId = await s.entry(m)
  t.alike((await s.enrolExtra(m, 'ana', extra, { signer: pk, lookupId })).body, { added: true })
  const storedAt = s.passkeys.keys(m.hex)[1].entryAt
  // The entry goes while the key stays (a drop that did not run), and the
  // same member puts an entry at that lookupId again later.
  await s.recovery.remove({ member: m.hex, lookupId })
  s.clock.offset += 1000
  await s.recovery.put({ member: m.hex, kind: 'passkey', lookupId, blob: { v: 1, kind: 'passkey', nonce: hex(24), ciphertext: hex(82) } })
  const row = s.recovery.list(m.hex).find((r) => r.lookupId === lookupId)
  t.ok(row !== undefined && row.createdAt !== storedAt, 'a live entry at that lookupId, put later')
  t.alike(s.passkeys.keys(m.hex).map((k) => k.credentialId), [pk.credentialId, extra.credentialId], 'the key is still in the file')

  t.alike((await s.post('/account/passkey/start', { member: m.hex, list: true })).body.passkeys, [pk.credentialId], 'not listed')
  const third = createFakePasskey({ rpId: RP })
  const r = await s.enrolExtra(m, 'ana', third, { signer: extra, lookupId: await s.entry(m) })
  t.is(r.status, 403, r.text)
  t.is(r.body.error, 'passkey-invalida', 'it vouches for nothing')

  const st = await s.post('/account/delete/start', { member: m.hex })
  t.alike(st.body.passkeys, [pk.credentialId], 'delete start does not list it')
  const del = await s.post('/account/delete/finish', {
    member: m.hex,
    nonce: st.body.nonce,
    signature: signAccountLink({ phase: 'delete', nonce: st.body.nonce, member: m.hex, username: 'ana', association: s.association, sub: '' }, m.kp),
    assertion: extra.assert({ challenge: Buffer.from(st.body.nonce, 'base64url'), origin: ORIGIN }),
    wait: true
  })
  t.is(del.status, 200, del.text)
  t.ok(typeof del.body.scheduled === 'string', 'the 7-day wait, not a deletion at once')
  t.is(s.store.deletedAt(m.hex), null)
})

test('extra passkey: one key per entry; with no key stored the extra fields are refused', async (t) => {
  const { s, m, pk } = await enrolled(t)
  const lookupId = await s.entry(m)
  t.alike((await s.enrolExtra(m, 'ana', createFakePasskey({ rpId: RP }), { signer: pk, lookupId })).body, { added: true })
  const dup = await s.enrolExtra(m, 'ana', createFakePasskey({ rpId: RP }), { signer: pk, lookupId })
  t.is(dup.status, 400)
  t.is(dup.body.error, 'pedido-invalido', 'the entry already has a key')
  t.is(s.passkeys.keys(m.hex).length, 2)

  // A fresh account with no key: the first one comes only from the link.
  const b = keyPair()
  await s.link(b, 'bia')
  const bId = await s.entry(b)
  const first = createFakePasskey({ rpId: RP })
  const st = await s.post('/account/passkey/start', { member: b.hex })
  const att = first.attestationObject()
  const body = { member: b.hex, nonce: st.body.nonce, signature: s.signPasskey(b, st.body.nonce, 'bia', sha256hex(att)), credentialId: first.credentialId, attestationObject: att }
  let r = await s.post('/account/passkey/add', { ...body, lookupId: bId })
  t.is(r.status, 400)
  t.is(r.body.error, 'pedido-invalido', 'lookupId with no stored key')
  const st2 = await s.post('/account/passkey/start', { member: b.hex })
  r = await s.post('/account/passkey/add', { ...body, nonce: st2.body.nonce, signature: s.signPasskey(b, st2.body.nonce, 'bia', sha256hex(att)), assertion: first.assert({ challenge: Buffer.from(st2.body.nonce, 'base64url'), origin: ORIGIN }) })
  t.is(r.body.error, 'pedido-invalido', 'an assertion with no stored key')
  t.alike(s.passkeys.keys(b.hex), [])
  t.alike((await s.enrol(b, 'bia', first)).body, { added: true }, 'the plain enrolment still works')
})

test('extra passkey: no usable recovery store answers indisponivel and stores nothing', async (t) => {
  for (const opts of [{ recovery: false }, { wrap: (r) => ({ ...r, available: () => false }) }, { wrap: (r) => ({ ...r, list: () => { const e = new Error('indisponivel'); e.code = 'indisponivel'; throw e } }) }]) {
    const { s, m, pk } = await enrolled(t, opts)
    const r = await s.enrolExtra(m, 'ana', createFakePasskey({ rpId: RP }), { signer: pk, lookupId: hex(32) })
    t.is(r.status, 503, r.text)
    t.is(r.body.error, 'indisponivel')
    t.is(s.passkeys.keys(m.hex).length, 1)
  }
})

test('extra passkey: MAX_KEYS keys is limite-recuperacao; a key whose entry is gone frees its slot', async (t) => {
  // Entries the real store cannot hold (it caps passkey entries below
  // MAX_KEYS), as a merge of two copies may leave behind.
  const ghosts = new Map()
  const wrap = (r) => ({
    ...r,
    fetch: (id) => ghosts.has(id) ? ghosts.get(id) : r.fetch(id),
    list: (member) => [...r.list(member), ...[...ghosts].filter(([, e]) => e.member === member).map(([lookupId, e]) => ({ lookupId, kind: e.kind, createdAt: '2026-11-17T00:00:00.000Z' }))]
  })
  const { s, m, pk } = await enrolled(t, { wrap })
  const ids = []
  for (let i = 1; i < MAX_KEYS; i++) {
    const id = await s.entry(m)
    ids.push(id)
    t.alike((await s.enrolExtra(m, 'ana', createFakePasskey({ rpId: RP }), { signer: pk, lookupId: id })).body, { added: true }, 'extra ' + i)
  }
  t.is(s.passkeys.keys(m.hex).length, MAX_KEYS)
  const ghost = hex(32)
  ghosts.set(ghost, { member: m.hex, kind: 'passkey', blob: null })
  const capped = await s.enrolExtra(m, 'ana', createFakePasskey({ rpId: RP }), { signer: pk, lookupId: ghost })
  t.is(capped.status, 409, capped.text)
  t.is(capped.body.error, 'limite-recuperacao')
  t.is(s.passkeys.keys(m.hex).length, MAX_KEYS)

  // An older server removed an entry and left its key: at the cap that key
  // goes, and the new one takes its slot.
  await s.recovery.remove({ member: m.hex, lookupId: ids[0] })
  const fresh = await s.entry(m)
  const next = createFakePasskey({ rpId: RP })
  const r = await s.enrolExtra(m, 'ana', next, { signer: pk, lookupId: fresh })
  t.is(r.status, 200, r.text)
  const linked = s.passkeys.keys(m.hex).map((k) => k.lookupId)
  t.is(linked.length, MAX_KEYS)
  t.absent(linked.includes(ids[0]), 'the orphan key went')
  t.ok(linked.includes(fresh))
})

test('extra passkey: an assertion from the Android app\'s origin vouches too', async (t) => {
  const fp = Array.from({ length: 32 }, (_, i) => (i + 7).toString(16).padStart(2, '0').toUpperCase()).join(':')
  const apk = 'android:apk-key-hash:' + Buffer.from(fp.replace(/:/g, ''), 'hex').toString('base64url')
  const { s, m, pk } = await enrolled(t, { androidCertSha256: fp })
  const lookupId = await s.entry(m)
  const r = await s.enrolExtra(m, 'ana', createFakePasskey({ rpId: RP }), { signer: pk, lookupId, assert: { origin: apk } })
  t.is(r.status, 200, r.text)
  t.alike(r.body, { added: true })
})

// Play's app signing certificate and the EAS keystore's at once: the stored
// passkey vouches from either app, and only from a certificate the operator
// listed. The same fixture passkey signs every time; only the reported origin
// changes, since the Android certificate signs the app, not the assertion.
test('extra passkey: with a certificate list, each listed Android origin vouches and an unlisted one is refused', async (t) => {
  const fingerprint = (byte) => Array(32).fill(byte).join(':')
  const apk = (byte) => 'android:apk-key-hash:' + Buffer.alloc(32, parseInt(byte, 16)).toString('base64url')
  const { s, m, pk } = await enrolled(t, { androidCertSha256: fingerprint('0A') + ',' + fingerprint('0B') })

  const outsider = createFakePasskey({ rpId: RP })
  const refused = await s.enrolExtra(m, 'ana', outsider, { signer: pk, lookupId: await s.entry(m), assert: { origin: apk('0C') } })
  t.is(refused.status, 403, refused.text)
  t.is(refused.body.error, 'passkey-invalida', 'an unlisted certificate')
  t.ok(s.logs.includes(JSON.stringify({ event: 'passkey', reason: 'passkey-origem' })), 'logged as the origin')
  t.alike(s.passkeys.keys(m.hex).map((k) => k.credentialId), [pk.credentialId], 'nothing stored')

  const stored = [pk.credentialId]
  for (const byte of ['0A', '0B']) {
    const extra = createFakePasskey({ rpId: RP })
    const r = await s.enrolExtra(m, 'ana', extra, { signer: pk, lookupId: await s.entry(m), assert: { origin: apk(byte) } })
    t.is(r.status, 200, byte + ': ' + r.text)
    t.alike(r.body, { added: true }, 'the certificate ' + byte)
    stored.push(extra.credentialId)
  }
  t.alike(s.passkeys.keys(m.hex).map((k) => k.credentialId), stored)
})
