'use strict'

// The passkey enrolment of Excluir conta (apps/cli/lib/account/passkey-routes.js):
// right after the link, the app sends the creation's attestation object,
// signed by the diary key at account-link phase 'passkey'; the service keeps
// the public key only while the member has none and the link is fresh. Then
// a deletion with that passkey runs at once. Loopback only, software
// passkeys (./helpers/fake-passkey.js), Google never reached.

const test = require('brittle')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signAccountLink } = require('@varanda/core/lib/account-link')
const { openAccountStore } = require('../lib/account/store')
const { openModerationStore } = require('../lib/account/moderation-store')
const { openPasskeyStore } = require('../lib/account/passkey-store')
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

async function setup (t) {
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
  const logs = []
  const server = createAccountServer({ association, origin: ORIGIN, google, store, issuer: { keyPair: issKp, cert }, passkeys, moderation, log: (e) => logs.push(JSON.stringify(e)), now })
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

  return { clock, store, passkeys, moderation, association, logs, link, post, enrol, signPasskey }
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
