'use strict'

// A page's media in a private group, through the page `media` route of
// apps/cli/lib/account/pages-routes.js, loopback only: a local seeder and
// seed-ws on a local DHT, the account service with pages on and a real
// pages-groups client. The device seals the item; the service takes the
// ciphertext only for a private group where the page has a live writer, and
// files it apart from the page's own items, where nothing public resolves it.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const nodeCrypto = require('crypto')
const { testnet, tmpDir, until } = require('./helpers/net')
const { createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signAccept } = require('@varanda/core/lib/page')
const { signPage, opHash } = require('@varanda/core/lib/page-proof')
const { TERMS_VERSION } = require('@varanda/core/lib/terms')
const { sealMedia, SEALED_MEDIA_MIME } = require('@varanda/core/lib/group-media')
const member = require('@varanda/core/lib/member')
const groupLib = require('@varanda/core/lib/group')
const groupCrypto = require('@varanda/core/lib/group-crypto')
const { person, startSeeder, syncOnce } = require('../../../packages/core/test/helpers/sync-groups')
const { startSeedWs } = require('../lib/seed-ws')
const { openAccountStore } = require('../lib/account/store')
const { openTermsStore } = require('../lib/account/terms-store')
const { openPageKeys } = require('../lib/account/page-keys')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { createPagesGroups } = require('../lib/account/pages-groups')
const { createAccountServer } = require('../lib/account/server')

const ORIGIN = 'https://varanda.test'
const PAGE_KEYS = 'cd'.repeat(32)

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function newKey () {
  const kp = crypto.keyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function sha (bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex')
}

function boxPair () {
  for (;;) {
    const kp = groupCrypto.newBoxKeyPair()
    if (!groupLib.isWeakBoxKey(hex(kp.publicKey))) return kp
  }
}

// PNG signature, a 1x1 IHDR chunk, then one IDAT chunk filling `size`
// bytes: one whole media block can go up both as a picture and sealed.
function pngFile (size) {
  const u32 = (n) => b4a.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
  const chunk = (type, data) => b4a.concat([u32(data.byteLength), b4a.from(type), data, u32(0)])
  return b4a.concat([
    b4a.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', b4a.concat([u32(1), u32(1), b4a.from([8, 2, 0, 0, 0])])),
    chunk('IDAT', b4a.alloc(size - 45, 1))
  ])
}

function googleStub () {
  return { authorizeUrl: () => 'http://127.0.0.1:1/auth', exchange: async () => { throw new Error('unused') } }
}

test('pages groups private: sealed media only for a private group with a live writer, never resolved for public use', async (t) => {
  t.timeout(600000)
  const { bootstrap } = await testnet(t)
  const assocKp = generateAssociationKeyPair()
  const association = hex(assocKp.publicKey)
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assocKp)
  const seeder = await startSeeder(t, bootstrap, assocKp)
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + ws.port

  const a = await person(t, assocKp, 'Ana')
  const { community: C } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group: G } = await member.groupCreate(a, { name: 'Praça', join: 'open', community: C })
  const { group: GP } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private', community: C })
  await syncOnce(bootstrap, a)

  const dir = tmpDir(t, 'varanda-account-')
  const store = openAccountStore(dir)
  const terms = openTermsStore(dir)
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const pagesStore = openPagesStore(dir)
  const logs = []
  const log = (e) => logs.push(e)
  const writer = createPagesWriter({ dir, keys, association, seederWs, log })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  const pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs, log })
  t.teardown(() => pg.close(), { force: true })
  await pg.ready()
  await until(() => writer.connected() && pg.connected(), { name: 'links up', timeoutMs: 20000 })
  // The upload cap, open or shut by the test, so polling spends none of it.
  let mediaOpen = true
  const accountOpts = {
    association,
    origin: ORIGIN,
    google: googleStub(),
    store,
    issuer: { keyPair: issuerKp, cert: issuerCert },
    terms,
    log,
    pages: { keys, writer, pagesStore, dir, pagesGroups: pg, blocklist: { has: () => false }, limits: { reboxEveryMs: 0, media: () => mediaOpen } }
  }
  const server = await createAccountServer(accountOpts).listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => server.close(), { force: true })
  const base = 'http://127.0.0.1:' + server.port

  async function api (pathname, body) {
    const res = await fetch(base + pathname, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  let subSeq = 100
  let termsCount = 0
  async function linked (username) {
    const m = newKey()
    const row = store.start({ member: m.hex, username })
    store.reserve(row.id)
    store.putGoogle(row.id, { sub: '61000000000000000' + String(subSeq++).padStart(5, '0'), email: 'p@example.test' })
    await store.finish(row.id, { signature: 'a'.repeat(128) }, issuerKp, issuerCert, association)
    termsCount++
    await terms.accept({ member: m.hex, version: TERMS_VERSION, nonce: (String(termsCount) + 'P'.repeat(43)).slice(0, 43), signature: 'a'.repeat(128) })
    return m
  }

  async function start (m, action) {
    const r = await api('/account/pages/start', { member: m.hex, action })
    if (r.status !== 200) throw new Error('start ' + action + ' ' + r.status)
    return r.body
  }

  function sign (m, action, nonce, page, op) {
    return signPage({ action, nonce, member: m.hex, page, association, opHash: opHash(op) }, m.kp)
  }

  async function act (m, action, page, op) {
    const { nonce } = await start(m, action)
    return api('/account/pages/' + action, { member: m.hex, nonce, page, op, signature: sign(m, action, nonce, page, op) })
  }

  function settled (m, action, page, op, name) {
    return until(async () => {
      const r = await act(m, action, page, op)
      return r.body && r.body.error === 'indisponivel' ? null : r
    }, { name, timeoutMs: 120000, intervalMs: 500 })
  }

  // The raw upload as the app sends it (apps/app/src/pages.js upload()).
  async function send (url, m, page, op, bytes, nonce) {
    const res = await fetch(url + '/account/pages/media', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/octet-stream',
        'x-varanda-page-member': m.hex,
        'x-varanda-page-nonce': nonce,
        'x-varanda-page-page': page,
        'x-varanda-page-signature': sign(m, 'media', nonce, page, op),
        'x-varanda-page-op': JSON.stringify(op)
      },
      body: bytes
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }

  async function upload (m, page, op, bytes) {
    const { nonce } = await start(m, 'media')
    return send(base, m, page, op, bytes, nonce)
  }

  function uploadSettled (m, page, op, bytes, name) {
    return until(async () => {
      const r = await upload(m, page, op, bytes)
      return r.body && r.body.error === 'indisponivel' ? null : r
    }, { name, timeoutMs: 120000, intervalMs: 500 })
  }

  function roster (m, page, fields, nonce) {
    const f = { page, ...fields, at: new Date().toISOString(), nonce, association }
    return { type: 'page-roster', ...f, signature: signRoster(f, m.kp) }
  }

  const ana = await linked('ana')
  const bia = await linked('bia')
  const cid = await linked('cid')

  const created = await start(ana, 'create')
  const P = created.page
  const genesis = roster(ana, P, { gen: 1, owner: ana.hex, admins: [], prev: null }, created.nonce)
  const createOp = { username: 'padaria', name: 'Padaria', bio: '', roster: { gen: 1, admins: [], prev: null, at: genesis.at, nonce: created.nonce } }
  t.is((await api('/account/pages/create', { member: ana.hex, nonce: created.nonce, page: P, op: createOp, signature: sign(ana, 'create', created.nonce, P, createOp), record: genesis })).status, 200)
  {
    const { nonce } = await start(ana, 'invite')
    const row = pagesStore.get(P)
    const record = roster(ana, P, { gen: row.gen + 1, owner: ana.hex, admins: [bia.hex], prev: row.rosterSeq }, nonce)
    const op = { member: bia.hex, gen: row.gen + 1, rosterSignature: record.signature, roster: { owner: ana.hex, admins: [bia.hex], prev: row.rosterSeq, at: record.at, nonce } }
    t.is((await api('/account/pages/invite', { member: ana.hex, nonce, page: P, op, signature: sign(ana, 'invite', nonce, P, op), record })).status, 200)
    const acc = await start(bia, 'accept')
    const f = { page: P, gen: row.gen + 1, rosterSignature: pagesStore.get(P).invites[bia.hex].rosterSignature, at: new Date().toISOString(), nonce: acc.nonce, actor: bia.hex }
    t.is((await api('/account/pages/accept', { member: bia.hex, nonce: acc.nonce, page: P, record: { type: 'page-accept', ...f, signature: signAccept(f, bia.kp) } })).status, 200)
  }

  t.is((await settled(ana, 'community-join', P, { community: C }, 'community join')).body.role, 'member')
  t.is((await settled(ana, 'group-join', P, { group: G, community: C }, 'group join')).body.state, 'member')
  const boxA = boxPair()
  await pagesStore.setDm(P, { gen: 1, box: hex(nodeCrypto.randomBytes(32)), groupBox: hex(boxA.publicKey), shares: {}, pending: {}, reboxPending: false, legacyBundle: null, rotatePending: null })
  t.is((await settled(ana, 'group-join', P, { group: GP }, 'private join')).body.state, 'requested', 'a private group waits for the admit')

  const { cipher } = sealMedia(b4a.from('foto da padaria'), { plainMime: 'image/png', w: 1, h: 1 })
  const op = { group: GP, sha256: sha(cipher), mime: SEALED_MEDIA_MIME, bytes: cipher.byteLength }

  // Before the admit the page holds no live writer there: nothing is stored.
  t.is((await uploadSettled(bia, P, op, cipher, 'upload before the admit')).body.error, 'sem-permissao', 'no sealed item before the admit')
  t.is((await uploadSettled(ana, P, { ...op, group: G }, cipher, 'upload to a public group')).body.error, 'pedido-invalido', 'no sealed item for a public group')

  await until(async () => {
    await syncOnce(bootstrap, a)
    try {
      await member.groupAdmit(a, { group: GP, member: P, on: true })
      return true
    } catch {
      return false
    }
  }, { name: 'admin admits the page in private', timeoutMs: 180000, intervalMs: 500 })
  await syncOnce(bootstrap, a)
  await until(async () => {
    const r = await act(bia, 'group-read', P, { group: GP })
    return r.status === 200 && r.body.role === 'member' ? true : null
  }, { name: 'page folds the admit', timeoutMs: 120000, intervalMs: 500 })

  // Admitted: an admin's sealed upload is stored, as whole opaque blocks.
  let nonce1
  const first = await until(async () => {
    nonce1 = (await start(bia, 'media')).nonce
    const r = await send(base, bia, P, op, cipher, nonce1)
    return r.body && ['indisponivel', 'limite', 'sem-permissao', 'aguardando-chave'].includes(r.body.error) ? null : r
  }, { name: 'sealed upload', timeoutMs: 120000, intervalMs: 500 })
  t.is(first.status, 200, JSON.stringify(first.body))
  const d = first.body.descriptor
  t.alike(Object.keys(d).sort(), ['blocks', 'bytes', 'core', 'mime', 'sha256', 'start'], 'the descriptor names no picture size, no plain type and no key')
  t.is(d.mime, SEALED_MEDIA_MIME)
  t.is(d.blocks, 1)
  t.is(d.bytes, cipher.byteLength)
  t.is(d.sha256, op.sha256)
  t.absent(writer.items(P).some((it) => it.core === d.core && it.start === d.start), 'the page items table never lists it')

  // The same signed upload, resent, answers the same descriptor and stores
  // nothing more; so does a fresh routes instance over the same stores.
  const again = await send(base, bia, P, op, cipher, nonce1)
  t.alike(again.body, first.body, 'a resend answers the same descriptor')
  const second = await createAccountServer(accountOpts).listen({ host: '127.0.0.1', port: 0 })
  t.teardown(() => second.close(), { force: true })
  const restarted = await send('http://127.0.0.1:' + second.port, bia, P, op, cipher, nonce1)
  t.alike(restarted.body, first.body, 'and so does a resend after a restart')

  const next = await upload(ana, P, op, cipher)
  t.is(next.status, 200, JSON.stringify(next.body))
  t.is(next.body.descriptor.start, d.start + d.blocks, 'the resends appended no block')

  // After a restart the writer's record keeps no body hash: on a used nonce
  // the same bytes sent plain instead of sealed (or the reverse), or other
  // bytes, never get the stored descriptor.
  const base2 = 'http://127.0.0.1:' + second.port
  const asPlain = { sha256: op.sha256, mime: 'image/png', width: 1, height: 1, bytes: op.bytes }
  t.is((await send(base2, bia, P, asPlain, cipher, nonce1)).body.error, 'expirado', 'a sealed nonce resent plain after a restart')
  const other = sealMedia(b4a.from('outra foto'), { plainMime: 'image/png', w: 1, h: 1 }).cipher
  t.is((await send(base2, bia, P, { ...op, sha256: sha(other), bytes: other.byteLength }, other, nonce1)).body.error, 'expirado', 'a sealed nonce resent with another sum after a restart')
  const png = pngFile(32768)
  const plainOp = { sha256: sha(png), mime: 'image/png', width: 1, height: 1, bytes: png.byteLength }
  const plainNonce = (await start(bia, 'media')).nonce
  const plain = await send(base, bia, P, plainOp, png, plainNonce)
  t.is(plain.status, 200, JSON.stringify(plain.body))
  t.is((await send(base2, bia, P, { ...op, sha256: plainOp.sha256, bytes: png.byteLength }, png, plainNonce)).body.error, 'expirado', 'a plain nonce resent sealed after a restart')
  t.alike((await send(base2, bia, P, plainOp, png, plainNonce)).body, plain.body, 'while the same plain body still gets its descriptor')

  // Refusals: shape, sum, role, cap.
  t.is((await upload(bia, P, { ...op, mime: 'image/png' }, cipher)).body.error, 'midia-invalida', 'a plain type with a group')
  const short = b4a.alloc(100, 1)
  t.is((await upload(bia, P, { ...op, sha256: sha(short), bytes: short.byteLength }, short)).body.error, 'midia-invalida', 'not whole blocks')
  t.is((await upload(bia, P, { ...op, width: 1 }, cipher)).body.error, 'pedido-invalido', 'a key beyond the sealed op')
  t.is((await upload(bia, P, { ...op, sha256: sha(short) }, cipher)).body.error, 'midia-invalida', 'a sum that does not match')
  t.is((await upload(cid, P, op, cipher)).body.error, 'sem-permissao', 'someone off the roster')
  mediaOpen = false
  t.is((await upload(bia, P, op, cipher)).body.error, 'limite', 'over the upload cap')
  mediaOpen = true

  // Nothing public resolves it: not as a public group post's media, not as
  // a page post's, not even relabelled as a picture.
  const relabelled = { ...d, mime: 'image/png', width: 1, height: 1 }
  t.is((await settled(bia, 'group-post', P, { group: G, text: 'foto', media: [d] }, 'sealed in public')).body.error, 'midia-invalida', 'a public group post never carries it')
  t.is((await settled(bia, 'group-post', P, { group: G, text: 'foto', media: [relabelled] }, 'relabelled in public')).body.error, 'midia-invalida', 'nor relabelled')
  t.is((await act(bia, 'post', P, { text: 'foto', media: [relabelled] })).body.error, 'midia-invalida', 'nor a page post')
  t.is((await act(bia, 'post', P, { text: 'foto', preview: { url: 'https://example.com/', image: { ...relabelled, mime: 'image/jpeg' } } })).body.error, 'midia-invalida', 'nor a link card thumbnail')

  const logged = JSON.stringify(logs)
  t.absent(logged.includes(d.sha256) || logged.includes(d.core) || logged.includes(GP), 'logs carry no item and no group key')

  // A restarted writer reads its state back with the sealed row: the page
  // opens unpaused.
  await pg.close()
  await writer.close()
  const writer2 = createPagesWriter({ dir, keys, association, seederWs, log })
  t.teardown(() => writer2.close(), { force: true })
  await writer2.ready()
  t.is(writer2.info(P).paused, false, 'the sealed row survives a restart without pausing the page')
  t.absent(writer2.items(P).some((it) => it.core === d.core && it.start === d.start), 'and still stays out of the items table')
})
