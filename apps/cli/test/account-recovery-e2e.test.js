'use strict'

// End to end continuity: a linked member wraps its root under a second
// passkey's PRF and under a recovery code (packages/web-member/lib/recovery),
// stores both with signed puts (@varanda/core/lib/recovery-proof) on a
// loopback account service with the recovery store, and a fresh device that
// holds only the second PRF or only the code text gets the same member key
// back (packages/web-member/lib/passkey keyPairFromPrf). Loopback only: the
// member is linked in-process, Google and the DHT are never reached.

const test = require('brittle')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createIssuerCert } = require('@varanda/core/lib/cert')
const { signRecovery, blobHashOf } = require('@varanda/core/lib/recovery-proof')
const { openAccountStore } = require('../lib/account/store')
const { openRecoveryStore, MAX_PASSKEYS } = require('../lib/account/recovery-store')
const { createAccountServer } = require('../lib/account/server')
const { tmpDir } = require('./helpers/net')
// apps/cli does not depend on packages/web-member (see account-e2e.test.js).
const { keyPairFromPrf } = require('../../../packages/web-member/lib/passkey')
const {
  deriveRecoveryKeys, wrapRoot, openRoot, encodeCode, decodeCode, CODE_ALPHABET, CODE_BYTES
} = require('../../../packages/web-member/lib/recovery')

const ORIGIN = 'https://varanda.test'
const SUB = '1098765432109876543210'
const EMAIL = 'membro@example.test'
// Past the per-member put/remove/list window (10 per 10 minutes).
const WINDOW_MS = 601 * 1000

const google = {
  authorizeUrl: () => { throw new Error('google called') },
  exchange: async () => { throw new Error('google called') }
}

const hexOf = (u8) => b4a.toString(b4a.from(u8.buffer, u8.byteOffset, u8.byteLength), 'hex')
const fixed = (seed) => new Uint8Array(32).map((_, i) => (i * 7 + seed) & 0xff)

function issuer () {
  const assoc = crypto.keyPair()
  const kp = crypto.keyPair()
  const cert = createIssuerCert({ issuer: b4a.toString(kp.publicKey, 'hex') }, assoc)
  return { keyPair: kp, cert, association: cert.association }
}

// A member whose diary key comes from its root, as the browser node derives it.
async function memberFromRoot (root) {
  const kp = await keyPairFromPrf(root)
  return { kp, hex: hexOf(kp.publicKey) }
}

async function linkDirect (accounts, iss, m, username, sub) {
  const row = accounts.start({ member: m.hex, username })
  accounts.reserve(row.id)
  accounts.putGoogle(row.id, { sub, email: EMAIL })
  await accounts.finish(row.id, { signature: 'a'.repeat(128) }, iss.keyPair, iss.cert, iss.association)
}

async function setup (t) {
  const dir = path.join(tmpDir(t), 'account')
  const c = { offset: 0 }
  c.now = () => Date.now() + c.offset
  const iss = issuer()
  const accounts = openAccountStore(dir, { now: c.now })
  const recovery = openRecoveryStore(dir, { now: c.now })
  const logs = []
  const server = createAccountServer({
    association: iss.association,
    origin: ORIGIN,
    google,
    store: accounts,
    issuer: { keyPair: iss.keyPair, cert: iss.cert },
    recovery,
    log: (e) => logs.push(JSON.stringify(e)),
    now: c.now
  })
  const listener = await server.listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => listener.close(), { force: true })
  const base = 'http://127.0.0.1:' + listener.port
  const net = { requests: 0 }

  async function post (pathname, body) {
    net.requests++
    const res = await fetch(base + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify(body)
    })
    const text = await res.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch {}
    return { status: res.status, body: parsed, text }
  }

  const sign = (who, fields) => signRecovery({ member: who.hex, association: iss.association, kind: '', lookupId: '', blobHash: '', ...fields }, who.kp)

  async function nonce (who) {
    const r = await post('/account/recovery/start', { member: who.hex })
    if (r.status !== 200) throw new Error('start ' + r.status + ' ' + r.text)
    return r.body.nonce
  }

  async function put (who, kind, lookupId, blob, { signer = who } = {}) {
    const n = await nonce(who)
    const signature = sign(signer, { member: who.hex, action: 'put', nonce: n, kind, lookupId, blobHash: blobHashOf({ kind, lookupId, blob }) })
    return post('/account/recovery/put', { member: who.hex, nonce: n, signature, kind, lookupId, blob })
  }

  async function remove (who, kind, lookupId, { signer = who } = {}) {
    const n = await nonce(who)
    const signature = sign(signer, { member: who.hex, action: 'remove', nonce: n, kind, lookupId })
    return post('/account/recovery/remove', { member: who.hex, nonce: n, signature, kind, lookupId })
  }

  async function list (who) {
    const n = await nonce(who)
    return post('/account/recovery/list', { member: who.hex, nonce: n, signature: sign(who, { action: 'list', nonce: n }) })
  }

  const fetchId = (lookupId) => post('/account/recovery/fetch', { lookupId })
  const nextWindow = () => { c.offset += WINDOW_MS }

  // The fresh-device side: only the secret is known, never the member. ->
  // { member, root } or null when the secret is malformed (nothing is sent),
  // the entry is gone or the blob does not open.
  async function recover (kind, secret) {
    const { lookupId, wrapKey } = await deriveRecoveryKeys(secret, kind)
    try {
      const r = await fetchId(lookupId)
      if (r.status !== 200) return { status: r.status, body: r.body }
      const opened = openRoot(r.body.blob, wrapKey, { member: r.body.member })
      if (opened === null) return { status: r.status, opened: null }
      return { status: r.status, member: r.body.member, kind: r.body.kind, root: opened.root }
    } finally {
      wrapKey.fill(0)
    }
  }

  async function recoverWithCode (text) {
    const secret = decodeCode(text)
    if (secret === null) return null
    try {
      return await recover('code', secret)
    } finally {
      secret.fill(0)
    }
  }

  return { dir, c, iss, accounts, logs, net, post, put, remove, list, fetchId, nextWindow, recover, recoverWithCode }
}

// Wraps `root` for `m` under `kind`'s secret. -> { lookupId, blob }.
async function wrapFor (m, root, kind, secret) {
  const { lookupId, wrapKey } = await deriveRecoveryKeys(secret, kind)
  try {
    return { lookupId, blob: wrapRoot({ root, member: m.hex, kind, wrapKey }) }
  } finally {
    wrapKey.fill(0)
  }
}

function codeSecret (seed) {
  return new Uint8Array(CODE_BYTES).map((_, i) => (i * 13 + seed) & 0xff)
}

// A code with one symbol swapped for another valid one, so only the
// checksum can catch it.
function corrupt (text) {
  const chars = text.split('')
  const i = chars.findIndex((ch) => ch !== '-')
  const at = CODE_ALPHABET.indexOf(chars[i].toUpperCase())
  chars[i] = CODE_ALPHABET[(at + 1) % CODE_ALPHABET.length]
  return chars.join('')
}

function noLeaks (t, s, secrets) {
  const all = s.logs.join('\n')
  for (const x of secrets) t.absent(all.includes(x), 'not in a log line')
  for (const line of s.logs) {
    const e = JSON.parse(line)
    if (e.event !== 'recovery') continue
    t.alike(Object.keys(e).sort(), ['event', 'reason'], 'recovery log lines carry only event and reason')
  }
}

test('recovery e2e: a second passkey and a recovery code bring the same member key back on a fresh device', async (t) => {
  const s = await setup(t)
  const root = fixed(1)
  const secondPrf = fixed(91)
  const m = await memberFromRoot(root)
  await linkDirect(s.accounts, s.iss, m, 'ana', SUB)

  const pk = await wrapFor(m, root, 'passkey', secondPrf)
  const codeText = encodeCode(codeSecret(3))
  t.is(codeText.replace(/-/g, '').length, 36, 'code has 36 symbols')
  t.is(codeText.split('-').length, 9, 'code has 9 groups')
  const cs = decodeCode(codeText)
  t.ok(cs !== null, 'the generated code decodes')
  const code = await wrapFor(m, root, 'code', cs)
  cs.fill(0)

  const putPk = await s.put(m, 'passkey', pk.lookupId, pk.blob)
  t.is(putPk.status, 200, putPk.text)
  const putCode = await s.put(m, 'code', code.lookupId, code.blob)
  t.is(putCode.status, 200, putCode.text)
  const listed = await s.list(m)
  t.is(listed.status, 200, listed.text)
  t.alike(listed.body.entries.map((e) => e.lookupId).sort(), [pk.lookupId, code.lookupId].sort())

  // Fresh device: no stored member, only the second PRF.
  const viaPk = await s.recover('passkey', secondPrf)
  t.is(viaPk.status, 200)
  t.is(viaPk.member, m.hex)
  t.is(viaPk.kind, 'passkey')
  const back = await keyPairFromPrf(viaPk.root)
  t.ok(b4a.equals(back.publicKey, m.kp.publicKey), 'the recovered root gives the original member key')
  const other = await keyPairFromPrf(secondPrf)
  t.absent(b4a.equals(other.publicKey, m.kp.publicKey), 'the second passkey alone is another key')

  // Fresh device: only the code text, typed in lower case.
  const viaCode = await s.recoverWithCode(codeText.toLowerCase())
  t.is(viaCode.status, 200)
  t.is(viaCode.member, m.hex)
  t.is(viaCode.kind, 'code')
  t.ok(b4a.equals((await keyPairFromPrf(viaCode.root)).publicKey, m.kp.publicKey), 'the code gives the original member key')

  // The blob of one secret never opens with the other's wrap key.
  const wrong = await deriveRecoveryKeys(secondPrf, 'passkey')
  t.is(openRoot(code.blob, wrong.wrapKey), null)
  wrong.wrapKey.fill(0)

  // A code with a bad checksum stops before the network.
  const before = s.net.requests
  const logsBefore = s.logs.length
  t.is(await s.recoverWithCode(corrupt(codeText)), null)
  t.is(await s.recoverWithCode('not-a-code'), null)
  t.is(s.net.requests, before, 'nothing was sent')
  t.is(s.logs.length, logsBefore, 'the service saw nothing')

  // Removal: fetch answers 404 and the device gets nothing back.
  s.nextWindow()
  const rmPk = await s.remove(m, 'passkey', pk.lookupId)
  t.is(rmPk.status, 200, rmPk.text)
  const rmCode = await s.remove(m, 'code', code.lookupId)
  t.is(rmCode.status, 200, rmCode.text)
  const gone = await s.fetchId(pk.lookupId)
  t.is(gone.status, 404)
  t.alike(gone.body, { error: 'nao-encontrado', recovery: true })
  t.alike(await s.recoverWithCode(codeText), { status: 404, body: { error: 'nao-encontrado', recovery: true } })
  t.alike((await s.list(m)).body, { entries: [] })

  noLeaks(t, s, [m.hex, pk.lookupId, code.lookupId, pk.blob.nonce, pk.blob.ciphertext, code.blob.nonce, code.blob.ciphertext, codeText])
})

test('recovery e2e: caps hold and another member can neither overwrite, remove nor sign for an entry', async (t) => {
  const s = await setup(t)
  const rootA = fixed(5)
  const rootB = fixed(6)
  const a = await memberFromRoot(rootA)
  const b = await memberFromRoot(rootB)
  await linkDirect(s.accounts, s.iss, a, 'ana', SUB)
  await linkDirect(s.accounts, s.iss, b, 'bia', '2098765432109876543210')

  // MAX_PASSKEYS extra passkeys, then one more is refused.
  const pks = []
  for (let i = 0; i <= MAX_PASSKEYS; i++) pks.push(await wrapFor(a, rootA, 'passkey', fixed(100 + i)))
  for (let i = 0; i < MAX_PASSKEYS; i++) {
    const r = await s.put(a, 'passkey', pks[i].lookupId, pks[i].blob)
    t.is(r.status, 200, r.text)
  }
  const over = await s.put(a, 'passkey', pks[MAX_PASSKEYS].lookupId, pks[MAX_PASSKEYS].blob)
  t.is(over.status, 409)
  t.alike(over.body, { error: 'limite-recuperacao' })
  t.is((await s.fetchId(pks[MAX_PASSKEYS].lookupId)).status, 404, 'the refused entry was not stored')

  // One code: a second code replaces the first.
  s.nextWindow()
  const code1 = await wrapFor(a, rootA, 'code', codeSecret(10))
  const code2 = await wrapFor(a, rootA, 'code', codeSecret(11))
  t.is((await s.put(a, 'code', code1.lookupId, code1.blob)).status, 200)
  t.is((await s.put(a, 'code', code2.lookupId, code2.blob)).status, 200)
  t.is((await s.fetchId(code1.lookupId)).status, 404, 'the replaced code is gone')
  t.is((await s.fetchId(code2.lookupId)).status, 200)
  const entries = (await s.list(a)).body.entries
  t.is(entries.filter((e) => e.kind === 'code').length, 1)
  t.is(entries.filter((e) => e.kind === 'passkey').length, MAX_PASSKEYS)

  // b cannot take over a's lookupId, remove it, nor sign a put or remove for a.
  const bWrap = await wrapFor(b, rootB, 'passkey', fixed(100))
  t.is(bWrap.lookupId, pks[0].lookupId, 'same secret, same lookupId')
  const takeover = await s.put(b, 'passkey', bWrap.lookupId, bWrap.blob)
  t.is(takeover.status, 400)
  t.alike(takeover.body, { error: 'pedido-invalido' })
  const bRemove = await s.remove(b, 'passkey', pks[0].lookupId)
  t.is(bRemove.status, 400)
  t.alike(bRemove.body, { error: 'pedido-invalido' })

  s.nextWindow()
  const forged = await s.put(a, 'passkey', bWrap.lookupId, bWrap.blob, { signer: b })
  t.is(forged.status, 400)
  t.alike(forged.body, { error: 'assinatura-invalida' })
  const forgedRm = await s.remove(a, 'passkey', pks[1].lookupId, { signer: b })
  t.is(forgedRm.status, 400)
  t.alike(forgedRm.body, { error: 'assinatura-invalida' })

  // a's entries are untouched and still open to a's root and member only.
  const viaA = await s.recover('passkey', fixed(100))
  t.is(viaA.member, a.hex)
  t.ok(b4a.equals((await keyPairFromPrf(viaA.root)).publicKey, a.kp.publicKey))
  const { wrapKey } = await deriveRecoveryKeys(fixed(101), 'passkey')
  const r = await s.fetchId(pks[1].lookupId)
  t.is(r.status, 200, 'the row survived the refused forged remove')
  t.ok(r.body.blob)
  t.is(openRoot(r.body.blob, wrapKey, { member: b.hex }), null, 'a blob naming another member does not open')
  wrapKey.fill(0)
  t.alike((await s.list(b)).body, { entries: [] })

  noLeaks(t, s, [a.hex, b.hex, ...pks.map((p) => p.lookupId), ...pks.map((p) => p.blob.ciphertext), code1.lookupId, code2.lookupId])
})
