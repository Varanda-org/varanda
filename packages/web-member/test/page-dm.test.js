'use strict'

// Página conversations held on the device (docs/rpc.md 5.114, lib/page-dm.js
// and the page passes of lib/dm.js), through lib/session.js and lib/node.js
// over an in-memory client, against the loopback seeder stand-in of
// helpers/dm-seeder.js. A page diary (its certificate, a roster naming A as
// owner and its dm-key) is copied into each node's storage as a stored
// replica, which is how dm.lookup and page.read find it here.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, signOrigin, issuerCountersign } = require('@varanda/core/lib/page')
const dmCore = require('@varanda/core/lib/dm')
const ps = require('@varanda/core/lib/page-secrets')
const gc = require('@varanda/core/lib/group-crypto')
const visitsCore = require('@varanda/core/lib/visits')
const { createBrowserNode } = require('../lib/node')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { memoryNodeStorage } = require('../lib/node-storage')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const { createPageHolder } = require('../lib/page-dm')
const store = require('../lib/node-store')
const sodium = require('../lib/sodium-browser')
const { connectClient, errorOf } = require('./helpers/session')
const { dmSeeder } = require('./helpers/dm-seeder')

const LOCKED = 'identidade bloqueada: entre com a passkey'
const NO_PAGE_KEY = 'sem chave da página'
const MISMATCH = 'chave da página não confere'
const SECRET = 'para-a-pagina-zqx'
const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)
// Below the runner's 180 s file limit (scripts/run-tests.js): a test that
// stalls fails here by name instead of the whole file being killed silently.
// Each test takes seconds; the margin is for a loaded machine.
const TEST_TIMEOUT_MS = 150000

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function until (fn, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('tempo esgotado')
}

async function wallet (storage) {
  const w = await storage.readJson('dmStamps')
  return w && Array.isArray(w.items) ? w.items.length : 0
}

// peeks: what the seeder answers for a dm-key (member -> { box, gen } or
// null); a member not in it fails, as without a seeder.
async function memberNode (t, assoc, url, { prf = crypto.randomBytes(32), ...extra } = {}) {
  const peeks = new Map()
  const peekCalls = new Map()
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const node = createBrowserNode({
    storage,
    association: hex(assoc.publicKey),
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      return ws
    },
    syncOptions: { dm: { issuePaceMs: 0 } },
    writeGate: false,
    dmKeyPeek: async (key) => {
      try {
        if (!peeks.has(key)) throw new Error('sem semeador')
        return peeks.get(key)
      } finally {
        peekCalls.set(key, (peekCalls.get(key) || 0) + 1)
      }
    },
    ...extra
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc) })
  await web.request('dm.enable')
  await until(async () => (await wallet(storage)) >= dmCore.DM_STAMP_WALLET)
  const box = await dmBoxKeyPairFromPrf(prf, 1)
  return { node, web, storage, peeks, peekCalls, key: publicKey, keyPair, prf, box: hex(box.publicKey) }
}

// A page diary: block 0 its certificate, then a roster naming `owner` and a
// dm-key with `box` and `keyGen` (none when keyGen is null).
// movedFrom: the page key a page-origin at seq 3 names (keyGen not null).
async function pageDiary (t, { assoc, issuer, pageKp, ownerKp, box, keyGen = 1, movedFrom = null }) {
  const m = await createMember({ storage: memoryStorage(), association: hex(assoc.publicKey), keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  const page = hex(pageKp.publicKey)
  await m.setCert(createCert({ member: page }, assoc))
  const fields = { page, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: AT, nonce: RNONCE, association: hex(assoc.publicKey) }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuer.kp, issuer.cert))
  if (keyGen !== null) await m.core.append({ type: 'dm-key', box, gen: keyGen, at: AT })
  if (movedFrom !== null) {
    const origin = { page, from: movedFrom, fromSeq: 2, gen: 1, owner: hex(ownerKp.publicKey), admins: [], at: AT, nonce: RNONCE, actor: hex(ownerKp.publicKey), association: hex(assoc.publicKey) }
    await m.core.append(issuerCountersign({ type: 'page-origin', ...origin, signature: signOrigin(origin, ownerKp) }, issuer.kp, issuer.cert))
  }
  return m
}

// Copies the page diary into `storage` as a stored replica, whole.
async function hold (m, storage) {
  const dst = await store.openReplica(storage, m.key)
  const a = m.core.replicate(true, { keepAlive: false })
  const b = dst.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await dst.update({ wait: true })
    await dst.download({ start: 0, end: m.core.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await dst.close()
  }
}

// Copies a member's diary into another node's storage (what a follow would
// have downloaded), so dm.lookup finds its dm-key locally.
async function copyDiary (from, to) {
  const src = await store.openDiary(from.storage)
  const dst = await store.openReplica(to.storage, from.key)
  const a = src.replicate(true)
  const b = dst.replicate(false)
  a.pipe(b).pipe(a)
  await dst.update({ wait: true })
  await dst.download({ start: 0, end: src.length }).done()
  a.destroy()
  b.destroy()
  await src.close()
  await dst.close()
}

// What the account service's dm-sign answers: the page key's signature over
// the digest and an expiry it chose.
function signed (digest, kp, expiresAt = Date.now() + dmCore.DM_V3_TTL_MS) {
  return { signature: dmCore.signDigest(digest, kp.secretKey, expiresAt), expiresAt }
}

function isZero (buf) {
  return buf.every((x) => x === 0)
}

// A dm.pull, then the published-key checks it starts in the background:
// waits until every held page was looked up and its result applied.
async function pulled (N) {
  const data = await N.storage.readJson('pageSecrets')
  const held = Object.keys(data === null ? {} : data.pages)
  const before = held.map((p) => N.peekCalls.get(p) || 0)
  const r = await N.web.request('dm.pull')
  await until(async () => held.every((p, i) => (N.peekCalls.get(p) || 0) > before[i]))
  // What follows each answer (the flag and its event, the client's delivery)
  // runs on microtasks: one macrotask turn drains them all.
  await new Promise((resolve) => setImmediate(resolve))
  return r
}

// What the service seals to the owner: the bundle JSON split in chunks of
// `size` bytes, each bundleId || uint16be index || uint16be count || bytes,
// sealed to ownBox -> { id, box, chunks: [dm.pageLegacyChunk params] }. An
// item without a filing position `n` gets one: rows first, then ops; a row
// without `fwd` gets 0.
function legacyBundle (page, ownBox, { rows = [], ops = [], box = hex(crypto.randomBytes(32)), size = 40000, extra = {} } = {}) {
  rows = rows.map((r, i) => ({ ...r, n: r.n === undefined ? i : r.n, fwd: r.fwd === undefined ? 0 : r.fwd }))
  ops = ops.map((o, i) => o.n === undefined ? { ...o, n: rows.length + i } : o)
  const id = crypto.randomBytes(32)
  const bytes = b4a.from(JSON.stringify({ v: 1, page, box, rows, ops, ...extra }), 'utf8')
  const count = Math.max(1, Math.ceil(bytes.byteLength / size))
  const chunks = []
  for (let i = 0; i < count; i++) {
    const head = b4a.alloc(36)
    head.set(id, 0)
    const view = new DataView(head.buffer, head.byteOffset, 36)
    view.setUint16(32, i)
    view.setUint16(34, count)
    const plain = b4a.concat([head, bytes.subarray(i * size, (i + 1) * size)])
    const sealed = b4a.alloc(plain.byteLength + sodium.crypto_box_SEALBYTES)
    sodium.crypto_box_seal(sealed, plain, b4a.from(ownBox, 'hex'))
    chunks.push({ page, id: hex(id), index: i, count, sealed: b4a.toString(sealed, 'base64') })
  }
  return { id: hex(id), box, chunks }
}

// A page with A as its owner and gen 1 secrets adopted by A -> its key.
async function adoptedPage (t, A, { assoc, issuer }, others = [], movedFrom = null) {
  const kp = crypto.keyPair()
  const page = hex(kp.publicKey)
  const made = await A.web.request('dm.pageGenerate', { page, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp: kp, ownerKp: A.keyPair, box: made.box, movedFrom })
  for (const n of [A, ...others]) await hold(diary, n.storage)
  const s = made.shares[0]
  await A.web.request('dm.pageSecrets', { page, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc) })
  return page
}

async function importBundle (N, bundle) {
  let r = null
  for (const c of bundle.chunks) r = await N.web.request('dm.pageLegacyChunk', c)
  return r
}

test('page secrets: generate, adopt, share, late key catch-up, draft and send as the page, mismatch, lock', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })

  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const pageCert = createCert({ member: P }, assoc)

  t.is((await errorOf(A.web.request('dm.list', { page: P }))).message, NO_PAGE_KEY, 'no secrets held: no page inbox')
  t.is((await errorOf(A.web.request('dm.pageShare', { page: P, member: B.key, box: B.box }))).message, NO_PAGE_KEY)
  t.is((await errorOf(A.web.request('group.seal', { group: P, page: P, text: 'oi' }))).message, NO_PAGE_KEY)
  const unheld = await errorOf(A.web.request('group.read', { group: P, page: P }))
  t.alike([unheld.code, unheld.message], ['NOT_FOUND', 'grupo não encontrado'], 'never the own groups: an unheld root is not found')

  const refused = await errorOf(A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: B.key, box: B.box }] }))
  t.is(refused.message, 'destinatários inválidos', 'the caller must be a recipient')
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  t.is(made.shares.length, 1)
  t.ok(ps.verifyShare({ page: P, gen: 1, member: A.key, sealed: made.shares[0].sealed }, made.shares[0].sig, A.key), 'signed by the caller identity')

  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made.box })
  await hold(diary, A.storage)
  await hold(diary, B.storage)
  await hold(diary, C.storage)

  // C writes to the page before A holds its secrets; A's own pass moves
  // past that drop.
  t.alike(await C.web.request('dm.lookup', { member: P }), { box: made.box, gen: 1 })
  await C.web.request('dm.send', { to: P, text: SECRET })
  t.is((await A.web.request('dm.pull')).added, 0, 'the own box opens nothing')
  t.ok((await A.storage.readJson('dmCursor')).after > 0, 'the own cursor moved past the drop')

  const self = made.shares[0]
  t.alike(await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: self.sealed, by: A.key, sig: self.sig, box: made.box, groupBox: made.groupBox, cert: pageCert }), { ok: true })
  t.ok((await A.storage.readJson('pageSecrets')).pages[P], 'kept sealed in kv')
  t.absent(JSON.stringify(await A.storage.readJson('pageSecrets')).includes(made.box), 'no key in kv')

  await A.web.request('dm.pull')
  t.ok(A.web.events.some((e) => e.name === 'dm.changed' && e.data.page === P && e.data.added === 1), 'dm.changed names the page')
  const req = await A.web.request('dm.list', { page: P, folder: 'request' })
  t.is(req.conversations.length, 1, 'the earlier drop opened after adoption')
  t.is(req.conversations[0].peer, C.key)
  const th = await A.web.request('dm.thread', { page: P, peer: C.key })
  t.alike(th.messages.map((m) => [m.text, m.from, m.mine]), [[SECRET, C.key, false]])

  // Rows stay under the page prefix, apart from A's own inbox.
  t.is((await A.web.request('dm.list', { folder: 'request' })).conversations.length, 0, 'not in the own requests')
  t.is((await A.web.request('dm.list', {})).conversations.length, 0, 'not in the own inbox')
  t.ok(await A.storage.hasCore(store.pageDmPrefix(P) + store.DM_LOCAL), 'a store of its own')

  // Dedup: a second pull and an import of the same message file nothing.
  const changedBefore = A.web.events.filter((e) => e.name === 'dm.changed' && e.data.page === P).length
  await A.web.request('dm.pull')
  t.is(A.web.events.filter((e) => e.name === 'dm.changed' && e.data.page === P).length, changedBefore, 'nothing new for the page')
  const row = { id: th.messages[0].id, from: C.key, to: P, text: SECRET, at: th.messages[0].at, replyTo: null, media: null, card: null }
  const old = { id: 'aa'.repeat(16), from: P, to: C.key, text: 'antiga', at: AT, replyTo: null, media: null, card: null }
  const badRows = [
    { ...old, id: 'bb'.repeat(16), text: 'a\u0007b' }, // the inner text rule
    { ...old, id: 'cc'.repeat(16), from: C.key, to: B.key }, // one side is the page
    { ...old, id: 'dd'.repeat(16), text: '' } // empty text without media
  ]
  t.alike(await importBundle(A, legacyBundle(P, A.box, { rows: [row, old, old, ...badRows] })), { complete: true, added: 1, blocked: 0, skipped: 3 }, 'a held row and a repeated one file nothing; bad rows skipped')
  t.is((await A.web.request('dm.thread', { page: P, peer: C.key })).messages.length, 2)

  t.is((await errorOf(A.web.request('dm.set', { page: P, peer: C.key, state: 'accepted' }))).message, 'use dm.pageDraft')
  t.alike(await A.web.request('dm.seen', { page: P, peer: C.key }), { ok: true })
  // The imported page reply makes it a conversation the page answered.
  const inboxP = await A.web.request('dm.list', { page: P })
  t.alike(inboxP.conversations.map((c) => [c.peer, c.unread]), [[C.key, false]], 'seen under the page')

  // Shares: an owner's share opens for B, one from outside the roster never.
  const shared = await A.web.request('dm.pageShare', { page: P, member: B.key, box: B.box })
  t.is(shared.gen, 1)
  const outsider = crypto.keyPair()
  const rogue = ps.signShare({ page: P, gen: 1, member: B.key, sealed: shared.sealed }, outsider)
  const bad = await errorOf(B.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: shared.sealed, by: hex(outsider.publicKey), sig: rogue, box: made.box, groupBox: made.groupBox, cert: pageCert }))
  t.is(bad.message, MISMATCH, 'a sharer outside the roster')
  t.is((await errorOf(B.web.request('dm.list', { page: P }))).message, NO_PAGE_KEY)
  t.alike(await B.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: shared.sealed, by: A.key, sig: shared.sig, box: made.box, groupBox: made.groupBox, cert: pageCert }), { ok: true })
  await B.web.request('dm.pull')
  t.is((await B.web.request('dm.thread', { page: P, peer: C.key })).messages[0].text, SECRET, 'B reads the page inbox too')

  // A drafts as the page; the page key signs the digest elsewhere.
  await copyDiary(C, A)

  // Same keys, a replacement certificate: the next draft carries it.
  const cert2 = createCert({ member: P, date: '2026-11-08T00:00:00.000Z' }, assoc)
  t.alike(await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: self.sealed, by: A.key, sig: self.sig, box: made.box, groupBox: made.groupBox, cert: cert2 }), { ok: true })
  t.alike((await A.storage.readJson('pageSecrets')).pages[P].cert, cert2, 'stored')
  const certDraft = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'com o certificado novo' })
  const expected = dmCore.innerDigest({ kind: 'msg', id: certDraft.id, at: certDraft.at, from: P, to: C.key, text: 'com o certificado novo', replyTo: null, fwd: 0, cert: cert2 })
  t.is(certDraft.digest, expected.digest, 'the draft uses the new certificate')
  const draft = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'resposta da página' })
  t.ok(/^[0-9a-f]{64}$/.test(draft.digest))
  const wrong = signed(draft.digest, crypto.keyPair())
  t.is((await errorOf(A.web.request('dm.pageSend', { page: P, id: draft.id, ...wrong }))).message, 'assinatura inválida')
  const right = signed(draft.digest, pageKp)
  t.is((await errorOf(A.web.request('dm.pageSend', { page: P, id: draft.id, signature: right.signature, expiresAt: right.expiresAt + 1 }))).message, 'assinatura inválida', 'signed over another expiry')
  t.ok(await errorOf(A.web.request('dm.pageSend', { page: P, id: draft.id, signature: right.signature })), 'no expiry')
  const putsBefore = seeder.puts.length
  const sent = await A.web.request('dm.pageSend', { page: P, id: draft.id, ...signed(draft.digest, pageKp) })
  t.is(sent.id, draft.id)
  t.is(seeder.puts.length, putsBefore + 2, 'to the recipient and to the page box')
  t.is((await errorOf(A.web.request('dm.pageSend', { page: P, id: draft.id, ...signed(draft.digest, pageKp) }))).message, 'rascunho expirado', 'a draft goes once')
  await C.web.request('dm.pull')
  const atC = await C.web.request('dm.thread', { peer: P })
  t.alike(atC.messages.map((m) => [m.text, m.from, m.mine]), [[SECRET, C.key, true], ['resposta da página', P, false]], 'C opens it as from the page')
  t.is((await A.web.request('dm.thread', { page: P, peer: C.key })).messages.filter((m) => m.mine && m.text === 'resposta da página').length, 1, 'filed once in the page store')

  // A page whose published dm-key is not the held box.
  const qKp = crypto.keyPair()
  const Q = hex(qKp.publicKey)
  const madeQ = await A.web.request('dm.pageGenerate', { page: Q, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  const rogueBox = hex(gc.boxKeyPairFromSeed(crypto.randomBytes(32)).publicKey)
  await hold(await pageDiary(t, { assoc, issuer, pageKp: qKp, ownerKp: A.keyPair, box: rogueBox }), A.storage)
  const sq = madeQ.shares[0]
  await A.web.request('dm.pageSecrets', { page: Q, gen: 1, sealed: sq.sealed, by: A.key, sig: sq.sig, box: madeQ.box, groupBox: madeQ.groupBox, cert: createCert({ member: Q }, assoc) })
  const draftQ = await A.web.request('dm.pageDraft', { page: Q, kind: 'ctl', op: 'accepted', peer: C.key })
  await pulled(A)
  await pulled(A)
  t.is(A.web.events.filter((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === Q).length, 2, 'on every pull while it lasts')
  t.absent(A.web.events.some((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === P), 'not for a matching page')
  t.is((await errorOf(A.web.request('dm.pageDraft', { page: Q, kind: 'msg', to: C.key, text: 'oi' }))).message, MISMATCH, 'no draft')
  t.is((await errorOf(A.web.request('dm.pageSend', { page: Q, id: draftQ.id, ...signed(draftQ.digest, qKp) }))).message, MISMATCH, 'no send')

  // A legacy box added after the current gen: the page scans the pool again,
  // so a drop sealed to the legacy box before still opens.
  const rKp = crypto.keyPair()
  const R = hex(rKp.publicKey)
  const legacySecret = crypto.randomBytes(32)
  const legacyPub = b4a.alloc(32)
  sodium.crypto_scalarmult_base(legacyPub, legacySecret)
  const rDiary = await pageDiary(t, { assoc, issuer, pageKp: rKp, ownerKp: A.keyPair, box: hex(legacyPub) })
  await hold(rDiary, A.storage)
  await hold(rDiary, C.storage)
  await C.web.request('dm.send', { to: R, text: 'para a caixa antiga' })
  await A.web.request('dm.pull')
  const madeR = await A.web.request('dm.pageGenerate', { page: R, gen: 2, recipients: [{ member: A.key, box: A.box }] })
  const sr = madeR.shares[0]
  const rParams = { page: R, gen: 2, sealed: sr.sealed, by: A.key, sig: sr.sig, box: madeR.box, groupBox: madeR.groupBox, cert: createCert({ member: R }, assoc) }
  await A.web.request('dm.pageSecrets', rParams)
  await A.web.request('dm.pull')
  t.is((await A.web.request('dm.thread', { page: R, peer: C.key })).messages.length, 0, 'the current box does not open it')
  // The cursor reset of this adoption fails once: the next pull still
  // starts the page over, since its cursor names the older box set.
  const writeKv = A.storage.writeJson
  let failCursor = true
  A.storage.writeJson = async function (k, v) {
    if (k === store.pageDmPrefix(R) + 'dmCursor' && failCursor) {
      failCursor = false
      throw new Error('falha de escrita')
    }
    return writeKv.call(this, k, v)
  }
  t.ok(await errorOf(importBundle(A, legacyBundle(R, A.box, { box: hex(legacySecret) }))), 'the cursor reset failed')
  A.storage.writeJson = writeKv
  await A.web.request('dm.pull')
  t.alike((await A.web.request('dm.thread', { page: R, peer: C.key })).messages.map((m) => m.text), ['para a caixa antiga'], 'opens once the legacy box is added')

  // A page op whose queue write fails: the retry files it once and queues it.
  const prefixP = store.pageDmPrefix(P)
  const write = A.storage.writeJson
  let failOnce = true
  A.storage.writeJson = async function (k, v) {
    if (k === prefixP + 'dmCtlQueue' && failOnce) {
      failOnce = false
      throw new Error('falha de escrita')
    }
    return write.call(this, k, v)
  }
  const op = await A.web.request('dm.pageDraft', { page: P, kind: 'ctl', op: 'accepted', peer: C.key })
  const opSig = signed(op.digest, pageKp)
  t.ok(await errorOf(A.web.request('dm.pageSend', { page: P, id: op.id, ...opSig })), 'the queue write failed')
  A.storage.writeJson = write
  const putsOp = seeder.puts.length
  t.alike(await A.web.request('dm.pageSend', { page: P, id: op.id, ...opSig }), { id: op.id, at: op.at })
  t.is(seeder.puts.length, putsOp + 1, 'the retry queued and put the op')

  // Ops stranded in the page queue (no stamps) go out before the next page
  // message and after an unlock.
  const queued = async () => (await store.readDmCtlQueue(A.storage, prefixP)).length
  const walletKv = await A.storage.readJson('dmStamps')
  const strand = async (state) => {
    await A.storage.writeJson('dmStamps', { v: 2, items: [], kids: walletKv.kids })
    const d = await A.web.request('dm.pageDraft', { page: P, kind: 'ctl', op: state, peer: C.key })
    await A.web.request('dm.pageSend', { page: P, id: d.id, ...signed(d.digest, pageKp) })
    t.is(await queued(), 1, 'stranded without stamps')
    await A.storage.writeJson('dmStamps', walletKv)
  }
  await strand('declined')
  const msg2 = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'depois da fila' })
  const putsMsg = seeder.puts.length
  await A.web.request('dm.pageSend', { page: P, id: msg2.id, ...signed(msg2.digest, pageKp) })
  t.is(await queued(), 0, 'the queued op went before the message')
  t.is(seeder.puts.length, putsMsg + 3)
  await strand('accepted')
  await A.node.clearKeyPair()
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await until(async () => (await queued()) === 0)
  t.pass('flushed after unlock')

  t.alike(await A.web.request('dm.pageForget', { page: Q }), { ok: true })
  t.is((await errorOf(A.web.request('dm.list', { page: Q }))).message, NO_PAGE_KEY)
  t.absent((await A.storage.readJson('pageSecrets')).pages[Q], 'gone from kv')

  // A draft made before the page blocked its recipient is never sent.
  const late = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'antes do bloqueio' })
  const blockOp = await A.web.request('dm.pageDraft', { page: P, kind: 'ctl', op: 'blocked', peer: C.key })
  await A.web.request('dm.pageSend', { page: P, id: blockOp.id, ...signed(blockOp.digest, pageKp) })
  const putsBlocked = seeder.puts.length
  t.is((await errorOf(A.web.request('dm.pageSend', { page: P, id: late.id, ...signed(late.digest, pageKp) }))).message, 'você bloqueou esta pessoa')
  t.is(seeder.puts.length, putsBlocked, 'nothing put')

  await A.node.clearKeyPair()
  t.is((await errorOf(A.web.request('dm.list', { page: P }))).message, LOCKED, 'locked: nothing readable')
})

test('a page message put after its signature expired is never filed, by the member nor by the page', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const B = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const pageCert = createCert({ member: P }, assoc)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made.box })
  for (const n of [A, B, C]) await hold(diary, n.storage)
  const self = made.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: self.sealed, by: A.key, sig: self.sig, box: made.box, groupBox: made.groupBox, cert: pageCert })
  const shared = await A.web.request('dm.pageShare', { page: P, member: B.key, box: B.box })
  await B.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: shared.sealed, by: A.key, sig: shared.sig, box: made.box, groupBox: made.groupBox, cert: pageCert })
  await copyDiary(C, A)

  const all = async (n, opts = {}) => {
    const out = []
    for (const folder of ['inbox', 'request']) out.push(...(await n.web.request('dm.list', { ...opts, folder })).conversations)
    return out
  }
  const old = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'assinada há muito' })
  await A.web.request('dm.pageSend', { page: P, id: old.id, ...signed(old.digest, pageKp, Date.now() - dmCore.DM_V3_STALE_MS - 60000) })
  await C.web.request('dm.pull')
  await B.web.request('dm.pull')
  t.is((await all(C)).length, 0, 'not filed in the member inbox')
  t.is((await all(B, { page: P })).length, 0, 'not filed in the page inbox')

  const fresh = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'assinada agora' })
  await A.web.request('dm.pageSend', { page: P, id: fresh.id, ...signed(fresh.digest, pageKp) })
  await C.web.request('dm.pull')
  await B.web.request('dm.pull')
  t.alike((await C.web.request('dm.thread', { peer: P })).messages.map((m) => m.text), ['assinada agora'], 'a fresh one is filed by the member')
  t.alike((await B.web.request('dm.thread', { page: P, peer: C.key })).messages.map((m) => m.text), ['assinada agora'], 'and by the page')
})

test('the published dm-key check compares the gen too; a replica behind the held gen does not flag', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  await copyDiary(C, A)

  // The held box under a gen the device never adopted.
  const gKp = crypto.keyPair()
  const G = hex(gKp.publicKey)
  const madeG = await A.web.request('dm.pageGenerate', { page: G, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  await hold(await pageDiary(t, { assoc, issuer, pageKp: gKp, ownerKp: A.keyPair, box: madeG.box, keyGen: 2 }), A.storage)
  const sg = madeG.shares[0]
  await A.web.request('dm.pageSecrets', { page: G, gen: 1, sealed: sg.sealed, by: A.key, sig: sg.sig, box: madeG.box, groupBox: madeG.groupBox, cert: createCert({ member: G }, assoc) })
  const draftG = await A.web.request('dm.pageDraft', { page: G, kind: 'ctl', op: 'accepted', peer: C.key })
  await pulled(A)
  t.ok(A.web.events.some((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === G), 'the same box under another gen is flagged')
  t.is((await errorOf(A.web.request('dm.pageSend', { page: G, id: draftG.id, ...signed(draftG.digest, gKp) }))).message, MISMATCH, 'no send')

  // The local replica still shows gen 1 while gen 2 is held: the seeder
  // decides, never the stale replica, and without it the flag stays as is.
  const sKp = crypto.keyPair()
  const S = hex(sKp.publicKey)
  const oldBox = hex(gc.boxKeyPairFromSeed(crypto.randomBytes(32)).publicKey)
  await hold(await pageDiary(t, { assoc, issuer, pageKp: sKp, ownerKp: A.keyPair, box: oldBox, keyGen: 1 }), A.storage)
  const madeS = await A.web.request('dm.pageGenerate', { page: S, gen: 2, recipients: [{ member: A.key, box: A.box }] })
  const ss = madeS.shares[0]
  await A.web.request('dm.pageSecrets', { page: S, gen: 2, sealed: ss.sealed, by: A.key, sig: ss.sig, box: madeS.box, groupBox: madeS.groupBox, cert: createCert({ member: S }, assoc) })
  await pulled(A)
  t.absent(A.web.events.some((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === S), 'an older local dm-key and no seeder: no mismatch')
  A.peeks.set(S, { box: madeS.box, gen: 2 })
  await pulled(A)
  t.absent(A.web.events.some((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === S), 'the seeder shows the held key')
  const draftS = await A.web.request('dm.pageDraft', { page: S, kind: 'ctl', op: 'accepted', peer: C.key })
  t.alike(await A.web.request('dm.pageSend', { page: S, id: draftS.id, ...signed(draftS.digest, sKp) }), { id: draftS.id, at: draftS.at }, 'sends')

  // A replica at the held gen that stopped syncing: the seeder shows a newer
  // dm-key, so the page is flagged.
  const hKp = crypto.keyPair()
  const H = hex(hKp.publicKey)
  const madeH = await A.web.request('dm.pageGenerate', { page: H, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  await hold(await pageDiary(t, { assoc, issuer, pageKp: hKp, ownerKp: A.keyPair, box: madeH.box }), A.storage)
  const sh = madeH.shares[0]
  await A.web.request('dm.pageSecrets', { page: H, gen: 1, sealed: sh.sealed, by: A.key, sig: sh.sig, box: madeH.box, groupBox: madeH.groupBox, cert: createCert({ member: H }, assoc) })
  A.peeks.set(H, { box: madeH.box, gen: 1 })
  const draftH = await A.web.request('dm.pageDraft', { page: H, kind: 'ctl', op: 'accepted', peer: C.key })
  await pulled(A)
  t.absent(A.web.events.some((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === H), 'held key published')
  A.peeks.set(H, { box: oldBox, gen: 2 })
  await pulled(A)
  t.ok(A.web.events.some((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === H), 'a newer gen on the seeder is flagged')
  t.is((await errorOf(A.web.request('dm.pageSend', { page: H, id: draftH.id, ...signed(draftH.digest, hKp) }))).message, MISMATCH, 'no send')

  // No dm-key found at all: a mismatch, and no lookup like it clears a flag.
  A.peeks.set(H, null)
  const nKp = crypto.keyPair()
  const N = hex(nKp.publicKey)
  const madeN = await A.web.request('dm.pageGenerate', { page: N, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  await hold(await pageDiary(t, { assoc, issuer, pageKp: nKp, ownerKp: A.keyPair, box: madeN.box, keyGen: null }), A.storage)
  const sn = madeN.shares[0]
  A.peeks.set(N, { box: madeN.box, gen: 1 })
  await A.web.request('dm.pageSecrets', { page: N, gen: 1, sealed: sn.sealed, by: A.key, sig: sn.sig, box: madeN.box, groupBox: madeN.groupBox, cert: createCert({ member: N }, assoc) })
  const draftN = await A.web.request('dm.pageDraft', { page: N, kind: 'ctl', op: 'accepted', peer: C.key })
  A.peeks.set(N, null)
  await pulled(A)
  t.ok(A.web.events.some((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === N), 'no dm-key published is flagged')
  t.is((await errorOf(A.web.request('dm.pageSend', { page: N, id: draftN.id, ...signed(draftN.digest, nKp) }))).message, MISMATCH, 'no send')
  t.is((await errorOf(A.web.request('dm.pageDraft', { page: H, kind: 'ctl', op: 'accepted', peer: C.key }))).message, MISMATCH, 'an earlier flag is not cleared by a lookup finding nothing')
  A.peeks.delete(N)
  await pulled(A)
  t.is((await errorOf(A.web.request('dm.pageDraft', { page: N, kind: 'ctl', op: 'accepted', peer: C.key }))).message, MISMATCH, 'nor by a failed one')
})

test('a drop sealed to the previous gen still opens after a new gen; a bundle whose seen write failed is seen on retry', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const pageCert = createCert({ member: P }, assoc)
  const made1 = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made1.box })
  await hold(diary, A.storage)
  await hold(diary, C.storage)
  const s1 = made1.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s1.sealed, by: A.key, sig: s1.sig, box: made1.box, groupBox: made1.groupBox, cert: pageCert })
  await A.web.request('dm.pull')

  // C still sees gen 1; A adopts gen 2 before pulling.
  await C.web.request('dm.send', { to: P, text: 'para a geração 1' })
  const made2 = await A.web.request('dm.pageGenerate', { page: P, gen: 2, recipients: [{ member: A.key, box: A.box }] })
  const s2 = made2.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 2, sealed: s2.sealed, by: A.key, sig: s2.sig, box: made2.box, groupBox: made2.groupBox, cert: pageCert })
  t.is((await A.storage.readJson('pageSecrets')).pages[P].previous.length, 1, 'the gen 1 box kept sealed')
  await A.web.request('dm.pull')
  const texts = async () => (await A.web.request('dm.thread', { page: P, peer: C.key })).messages.map((m) => m.text)
  t.alike(await texts(), ['para a geração 1'], 'the drop sealed to gen 1 opens')

  // The previous box comes back after lock and unlock.
  await C.web.request('dm.send', { to: P, text: 'ainda para a 1' })
  await A.node.clearKeyPair()
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await A.web.request('dm.pull')
  t.alike(await texts(), ['para a geração 1', 'ainda para a 1'], 'opens after unlock too')

  // Import: the rows land, the seen write fails once, the retry marks them.
  await A.web.request('dm.seen', { page: P, peer: C.key })
  const row = { id: 'ee'.repeat(16), from: C.key, to: P, text: 'importada', at: AT, replyTo: null, media: null, card: null }
  const write = A.storage.writeJson
  let fail = true
  A.storage.writeJson = async function (k, v) {
    if (k === store.pageDmPrefix(P) + 'dmSeen' && fail) {
      fail = false
      throw new Error('falha de escrita')
    }
    return write.call(this, k, v)
  }
  const bundle = legacyBundle(P, A.box, { rows: [row] })
  t.ok(await errorOf(importBundle(A, bundle)), 'the seen write failed')
  A.storage.writeJson = write
  t.alike(await importBundle(A, bundle), { complete: true, added: 0, blocked: 0, skipped: 0 }, 'already filed')
  const list = await A.web.request('dm.list', { page: P, folder: 'request' })
  const inbox = await A.web.request('dm.list', { page: P })
  t.absent([...list.conversations, ...inbox.conversations].some((c) => c.unread), 'nothing imported is unread')
})

test('dm.pageSecrets and a reset right after it both settle', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  await hold(await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made.box }), A.storage)
  const s = made.shares[0]
  const adopting = errorOf(A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: P }, assoc) }))
  await new Promise((resolve) => setImmediate(resolve))
  const resetting = errorOf(A.node.reset())
  const settled = await Promise.race([
    Promise.all([adopting, resetting]).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 30000))
  ])
  t.ok(settled, 'neither hangs')
  t.ok(await errorOf(A.web.request('node.info')) === null, 'later requests answer')
})

test('dm.pull for a held page and a reset right after it both settle', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  // A published key other than the held one, so the check after the pull
  // has a lookup to make.
  const rogue = hex(gc.boxKeyPairFromSeed(crypto.randomBytes(32)).publicKey)
  await hold(await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: rogue }), A.storage)
  const s = made.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: P }, assoc) })
  await pulled(A)
  t.ok(A.web.events.some((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === P), 'the check runs after the pull')
  const pulling = errorOf(A.web.request('dm.pull'))
  const resetting = errorOf(A.node.reset())
  const settled = await Promise.race([
    Promise.all([pulling, resetting]).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 30000))
  ])
  t.ok(settled, 'neither hangs')
  t.ok(await errorOf(A.web.request('node.info')) === null, 'later requests answer')
})

// The engine with `link` as every dm link (dm.test.js engineWithDmLink).
function engineWithDmLink (link) {
  const transport = require('../lib/dm-link')
  const original = transport.openDmLink
  const id = require.resolve('../lib/dm')
  const cached = require.cache[id]
  try {
    transport.openDmLink = async () => link
    delete require.cache[id]
    return require('../lib/dm').createDmEngine
  } finally {
    transport.openDmLink = original
    require.cache[id] = cached
  }
}

test('a pull under way never overwrites the cursor restart of an adoption', async (t) => {
  const assoc = generateAssociationKeyPair()
  const storage = memoryNodeStorage()
  const items = Array.from({ length: 11 }, (_, i) => ({ seq: i + 1, bytes: b4a.alloc(16) }))
  let gate = null
  let reached = null
  const reachedP = new Promise((resolve) => { reached = resolve })
  const link = {
    async page ({ after }) {
      // The page's catch-up from 0 waits while the adoption runs.
      if (after === 0 && gate !== null) {
        reached()
        await gate
      }
      const rest = items.filter((x) => x.seq > after)
      return { items: rest, next: null }
    },
    close: noop
  }
  const createEngine = engineWithDmLink(link)
  const engine = createEngine({ storage, association: hex(assoc.publicKey), seederUrl: 'ws://127.0.0.1:1/seeder', createSocket: () => { throw new Error('sem rede') } })
  t.teardown(() => engine.close(), { force: true })
  const idKp = crypto.keyPair()
  const own = hex(idKp.publicKey)
  const prf = crypto.randomBytes(32)
  await engine.unlock(prf)
  await engine.loaded()
  const ownBox = hex((await dmBoxKeyPairFromPrf(prf, 1)).publicKey)
  const page = hex(crypto.keyPair().publicKey)
  const made = engine.pageGenerate(own, idKp, { page, gen: 2, recipients: [{ member: own, box: ownBox }] })
  const sh = made.shares[0]
  const params = { page, gen: 2, sealed: sh.sealed, by: own, sig: sh.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc) }
  const roster = { owner: own, admins: [] }
  await engine.pageSecrets(own, roster, params)
  await store.writeDmCursor(storage, 11)

  let release = null
  gate = new Promise((resolve) => { release = resolve })
  const pulling = engine.pull(own)
  await reachedP
  const legacySecret = crypto.randomBytes(32)
  t.is((await engine.pageLegacyChunk(legacyBundle(page, ownBox, { box: hex(legacySecret) }).chunks[0])).complete, true, 'a legacy box added')
  const cursorOf = async () => {
    const c = await store.readPageCursor(storage, store.pageDmPrefix(page))
    return { after: c.after, gen: c.gen }
  }
  t.alike(await cursorOf(), { after: 0, gen: 2 }, 'restarted by the adoption')
  gate = null
  release()
  await pulling
  t.alike(await cursorOf(), { after: 0, gen: 2 }, 'the older pull dropped its cursor write')
  await engine.pull(own)
  t.alike(await cursorOf(), { after: 11, gen: 2 }, 'the next pull scans again from 0')
})

test('a second bundle with the same legacy box during a pull is refused and leaves its keys in place', async (t) => {
  const assoc = generateAssociationKeyPair()
  const storage = memoryNodeStorage()
  const idKp = crypto.keyPair()
  const own = hex(idKp.publicKey)
  const prf = crypto.randomBytes(32)
  const page = hex(crypto.keyPair().publicKey)
  const legacySecret = crypto.randomBytes(32)
  const legacyPub = b4a.alloc(32)
  sodium.crypto_scalarmult_base(legacyPub, legacySecret)
  const senderKp = crypto.keyPair()
  const sender = hex(senderKp.publicKey)
  const inner = dmCore.buildInner({ kind: 'msg', to: page, text: 'na caixa antiga', cert: createCert({ member: sender }, assoc) }, senderKp)
  const drop = dmCore.encodeDrop({ dropId: dmCore.newDropId(), kid: crypto.randomBytes(8), rsaSig: crypto.randomBytes(256), token: crypto.randomBytes(32), sealed: dmCore.sealInner(inner, hex(legacyPub)) })
  let gate = null
  let reached = null
  const reachedP = new Promise((resolve) => { reached = resolve })
  const link = {
    async page ({ after }) {
      if (after === 0 && gate !== null) {
        reached()
        await gate
      }
      return { items: after < 1 ? [{ seq: 1, bytes: drop }] : [], next: null }
    },
    close: noop
  }
  const engine = engineWithDmLink(link)({ storage, association: hex(assoc.publicKey), seederUrl: 'ws://127.0.0.1:1/seeder', createSocket: () => { throw new Error('sem rede') } })
  t.teardown(() => engine.close(), { force: true })
  await engine.unlock(prf)
  await engine.loaded()
  const ownBox = hex((await dmBoxKeyPairFromPrf(prf, 1)).publicKey)
  const made = engine.pageGenerate(own, idKp, { page, gen: 2, recipients: [{ member: own, box: ownBox }] })
  const sh = made.shares[0]
  const params = { page, gen: 2, sealed: sh.sealed, by: own, sig: sh.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc) }
  const roster = { owner: own, admins: [] }
  await engine.pageSecrets(own, roster, params)
  await engine.pageLegacyChunk(legacyBundle(page, ownBox, { box: hex(legacySecret) }).chunks[0])
  await store.writeDmCursor(storage, 1)

  let release = null
  gate = new Promise((resolve) => { release = resolve })
  const pulling = engine.pull(own)
  await reachedP
  await t.exception(engine.pageLegacyChunk(legacyBundle(page, ownBox, { box: hex(legacySecret) }).chunks[0]), /linha inválida/, 'one legacy history per page')
  gate = null
  release()
  await pulling
  t.alike((await engine.thread(own, { page, peer: sender })).messages.map((m) => m.text), ['na caixa antiga'], 'the drop still opens')
})

test('a page history whose forget failed half way is gone after a reset', async (t) => {
  t.timeout(120000)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  await hold(await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made.box }), A.storage)
  const s = made.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: P }, assoc) })
  const other = hex(crypto.keyPair().publicKey)
  await importBundle(A, legacyBundle(P, A.box, { rows: [{ id: 'ab'.repeat(16), from: other, to: P, text: 'histórico', at: AT, replyTo: null, media: null, card: null }] }))
  const core = store.pageDmPrefix(P) + store.DM_LOCAL
  t.ok(await A.storage.hasCore(core))

  const del = A.storage.deleteCore
  A.storage.deleteCore = async function (name) {
    if (name === core) throw new Error('falha ao apagar')
    return del.call(this, name)
  }
  t.ok(await errorOf(A.web.request('dm.pageForget', { page: P })), 'the forget failed')
  A.storage.deleteCore = del
  t.ok(await A.storage.hasCore(core), 'the history is still there')
  await A.node.reset()
  t.absent(await A.storage.hasCore(core), 'no page history after the reset')
  t.is(await A.storage.readJson('pageSecrets'), null)
  t.is(await A.storage.readJson('pageStores'), null)
})

test('the legacy bundle: chunks in any order file once, ops stay local, blocks wait for a signed ctl', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const prefix = store.pageDmPrefix(P)
  // The gen 1 box the service held, published before the page went end to end.
  const legacySecret = crypto.randomBytes(32)
  const legacyPub = b4a.alloc(32)
  sodium.crypto_scalarmult_base(legacyPub, legacySecret)
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: hex(legacyPub) })
  await hold(diary, A.storage)
  await hold(diary, C.storage)
  await C.web.request('dm.send', { to: P, text: 'para a caixa antiga' })
  await A.web.request('dm.pull')

  const ownChunk = legacyBundle(P, A.box, { rows: [] })
  t.is((await errorOf(A.web.request('dm.pageLegacyChunk', ownChunk.chunks[0]))).message, NO_PAGE_KEY, 'only after adoption')
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 2, recipients: [{ member: A.key, box: A.box }] })
  const s = made.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 2, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: P }, assoc) })

  const key = () => hex(crypto.keyPair().publicKey)
  const pA = key()
  const pD = key()
  const pB = key()
  const pU = key()
  const pM = key()
  const photo = { id: 'a1'.repeat(32), key: 'b2'.repeat(32), nonce: 'c3'.repeat(24), chunks: 1, bytes: 1000, sha256: 'd4'.repeat(32), mime: 'image/jpeg', w: 10, h: 10, ms: 0 }
  const row = (from, to, text, i, extra = {}) => ({ id: i.toString(16).padStart(32, '0'), from, to, text, at: AT, replyTo: null, media: null, card: null, ...extra })
  const rows = [
    row(pA, P, 'aceita', 1),
    row(P, pA, 'resposta antiga', 2),
    row(pD, P, 'recusada', 3),
    row(pM, P, 'foto antiga', 6, { media: [photo] }),
    row(pB, P, 'bloqueada', 4),
    row(C.key, P, 'apagada', 5)
  ]
  for (let i = 0; i < 30; i++) rows.push(row(key(), P, 'pedido ' + i, 100 + i))
  const ops = [
    { op: 'accepted', peer: pA },
    { op: 'declined', peer: pD },
    { op: 'blocked', peer: pB },
    { op: 'blocked', peer: pU },
    { op: 'unblocked', peer: pU },
    { op: 'deleted', peer: C.key }
  ]
  const size = Math.ceil(b4a.byteLength(JSON.stringify({ v: 1, page: P, box: hex(legacySecret), rows, ops })) / 3) + 200
  const bundle = legacyBundle(P, A.box, { rows, ops, box: hex(legacySecret), size })
  t.is(bundle.chunks.length, 3)
  const putsBefore = seeder.puts.length
  const half = { complete: false, added: 0, blocked: 0, skipped: 0 }
  t.alike(await A.web.request('dm.pageLegacyChunk', bundle.chunks[2]), half, 'the last chunk first')
  t.alike(await A.web.request('dm.pageLegacyChunk', bundle.chunks[0]), half)
  t.alike(await A.web.request('dm.pageLegacyChunk', bundle.chunks[0]), half, 'a repeated chunk')
  t.is(await A.storage.readJson(prefix + 'dmLegacy/0').then((v) => JSON.stringify(v).includes('aceita')), false, 'chunks kept sealed')
  t.alike(await A.web.request('dm.pageLegacyChunk', bundle.chunks[1]), { complete: true, added: rows.length, blocked: 1, skipped: 0 }, 'filed once all are here')
  t.is(seeder.puts.length, putsBefore, 'the ops are local only')
  t.is(await A.storage.readJson(prefix + 'dmLegacy'), null, 'the chunks are gone')
  t.is(await A.storage.readJson(prefix + 'dmLegacy/0'), null)

  t.alike((await A.web.request('dm.thread', { page: P, peer: pA })).messages.map((m) => [m.text, m.mine]), [['aceita', false], ['resposta antiga', true]])
  t.ok((await A.web.request('dm.list', { page: P })).conversations.some((c) => c.peer === pA && c.unread === false), 'accepted: in the inbox, read')
  t.alike((await A.web.request('dm.thread', { page: P, peer: pM })).messages.map((m) => [m.text, m.media.length]), [['foto antiga', 1]], 'the media row')
  t.alike((await A.web.request('dm.thread', { page: P, peer: C.key })).messages, [], 'deleted')
  A.peeks.set(pB, null)
  A.peeks.set(pU, null)
  t.is((await errorOf(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: pB, text: 'oi' }))).message, 'você bloqueou esta pessoa', 'blocked here at once')
  t.is((await errorOf(A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: pU, text: 'oi' }))).message, 'esta pessoa ainda não recebe mensagens', 'unblocked later')
  t.alike(await A.web.request('dm.pageLegacyBlocks', { page: P }), { pending: [pB] }, 'the newest block op decides')

  // The legacy box is the page's now: the drop sealed to it opens, after the
  // deleted op, so it shows.
  await A.web.request('dm.pull')
  t.alike((await A.web.request('dm.thread', { page: P, peer: C.key })).messages.map((m) => m.text), ['para a caixa antiga'], 'the legacy box opens the old drop')

  // A chunk sealed to another identity (the owner after a transfer).
  const foreign = legacyBundle(P, C.box, { rows })
  t.is((await errorOf(A.web.request('dm.pageLegacyChunk', foreign.chunks[0]))).message, MISMATCH, 'not this identity\'s box')
  const draft = await A.web.request('dm.pageDraft', { page: P, kind: 'ctl', op: 'accepted', peer: pD })
  t.ok(/^[0-9a-f]{64}$/.test(draft.digest), 'the held page keys still work')

  // A second bundle for the page is refused, nothing of it filed.
  const pG = key()
  t.is((await errorOf(importBundle(A, legacyBundle(P, A.box, { rows: [row(pG, P, 'outra', 40)], box: hex(legacySecret) })))).message, 'linha inválida', 'one bundle per page')
  t.alike((await A.web.request('dm.thread', { page: P, peer: pG })).messages, [], 'nothing of the second bundle filed')

  // One bad row and one bad op are skipped and counted; the rest is filed.
  const ctx = { assoc, issuer }
  const PE = await adoptedPage(t, A, ctx)
  const pE = key()
  const mixed = [row(pE, P, 'boa', 7), row(pE, P, 'a\u0007b', 8)]
  for (let i = 0; i < 20; i++) mixed.push(row(pE, P, 'mais ' + i, 200 + i))
  const mixedOps = [{ op: 'accepted', peer: pE }, { op: 'blocked', peer: PE }]
  const part = legacyBundle(PE, A.box, { rows: mixed.map((r) => ({ ...r, to: PE })), ops: mixedOps, size: 600 })
  t.ok(part.chunks.length > 2)
  t.alike(await importBundle(A, part), { complete: true, added: 21, blocked: 0, skipped: 2 }, 'skipped 2')
  t.is((await A.web.request('dm.thread', { page: PE, peer: pE })).messages.length, 21, 'the good rows filed')
  t.ok((await A.web.request('dm.list', { page: PE })).conversations.some((c) => c.peer === pE), 'the good op applied')
  t.alike(await A.web.request('dm.pageLegacyBlocks', { page: PE }), { pending: [] }, 'the bad block op not pending')
  // Filed in n order: a deleted op hides only the rows filed before it; a
  // repeated n skips the later item.
  const PZ = await adoptedPage(t, A, ctx)
  const pZ = key()
  // A bad frame still refuses the whole bundle, and leaves the page open
  // to a good one.
  const pF = key()
  t.is((await errorOf(importBundle(A, legacyBundle(PZ, A.box, { rows: [row(pF, PZ, 'x', 9)], extra: { more: 1 } })))).message, 'linha inválida', 'exact keys')
  t.is((await errorOf(importBundle(A, legacyBundle(PZ, A.box, { rows: [row(pF, PZ, 'x', 9)], box: 'zz' })))).message, 'linha inválida', 'box not hex64')
  t.is((await errorOf(importBundle(A, legacyBundle(PZ, A.box, { rows: [row(pF, PZ, 'x', 9)], extra: { page: hex(crypto.randomBytes(32)) } })))).message, 'linha inválida', 'another page')
  t.alike((await A.web.request('dm.thread', { page: PZ, peer: pF })).messages, [], 'nothing of a refused bundle filed')
  const ordered = legacyBundle(PZ, A.box, {
    rows: [row(pZ, PZ, 'antes', 30, { n: 3 }), row(pZ, PZ, 'depois', 31, { n: 9 }), row(pZ, PZ, 'repetida', 32, { n: 9 })],
    ops: [{ op: 'accepted', peer: pZ, n: 1 }, { op: 'deleted', peer: pZ, n: 5 }]
  })
  t.alike(await importBundle(A, ordered), { complete: true, added: 2, blocked: 0, skipped: 1 }, 'the repeated n skipped')
  t.alike((await A.web.request('dm.thread', { page: PZ, peer: pZ })).messages.map((m) => m.text), ['depois'], 'the row after the delete stays')

  // Re-applying the block: no stamps, the ctl stays queued and the peer pending.
  const walletKv = await A.storage.readJson('dmStamps')
  await A.storage.writeJson('dmStamps', { v: 2, items: [], kids: walletKv.kids })
  const b1 = await A.web.request('dm.pageDraft', { page: P, kind: 'ctl', op: 'blocked', peer: pB })
  await A.web.request('dm.pageSend', { page: P, id: b1.id, ...signed(b1.digest, pageKp) })
  t.alike(await A.web.request('dm.pageLegacyBlocks', { page: P }), { pending: [pB] }, 'still pending while unsent')
  await A.storage.writeJson('dmStamps', walletKv)
  const b2 = await A.web.request('dm.pageDraft', { page: P, kind: 'ctl', op: 'blocked', peer: pB })
  await A.web.request('dm.pageSend', { page: P, id: b2.id, ...signed(b2.digest, pageKp) })
  t.alike(await A.web.request('dm.pageLegacyBlocks', { page: P }), { pending: [] }, 'gone once put')

  // The same bundle fed again (an uncertain 'dm-legacy-done'): nothing filed,
  // so its old deleted op never hides what came after.
  for (const c of bundle.chunks) t.alike(await A.web.request('dm.pageLegacyChunk', c), { complete: true, added: 0, blocked: 0, skipped: 0 }, 'a completed bundle')
  t.alike((await A.web.request('dm.thread', { page: P, peer: C.key })).messages.map((m) => m.text), ['para a caixa antiga'], 'not deleted again')
  t.absent(JSON.stringify(await A.storage.readJson(prefix + 'dmLegacyDone')).includes(bundle.id), 'the done list is sealed')

  await A.web.request('dm.pageForget', { page: P })
  t.is(await A.storage.readJson(prefix + 'dmLegacyDone'), null, 'wiped with the page')
  t.is(await A.storage.readJson(prefix + 'dmLegacyBlocks'), null)
})

test('a forget during a pull: the pull stops writing for the page and never opens its store again', async (t) => {
  const assoc = generateAssociationKeyPair()
  const storage = memoryNodeStorage()
  const items = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, bytes: b4a.alloc(16) }))
  let gate = null
  let reached = null
  const reachedP = new Promise((resolve) => { reached = resolve })
  const link = {
    async page ({ after }) {
      if (after === 0 && gate !== null) {
        reached()
        await gate
      }
      return { items: items.filter((x) => x.seq > after), next: null }
    },
    close: noop
  }
  const engine = engineWithDmLink(link)({ storage, association: hex(assoc.publicKey), seederUrl: 'ws://127.0.0.1:1/seeder', createSocket: () => { throw new Error('sem rede') } })
  t.teardown(() => engine.close(), { force: true })
  const idKp = crypto.keyPair()
  const own = hex(idKp.publicKey)
  const prf = crypto.randomBytes(32)
  await engine.unlock(prf)
  await engine.loaded()
  const ownBox = hex((await dmBoxKeyPairFromPrf(prf, 1)).publicKey)
  const page = hex(crypto.keyPair().publicKey)
  const made = engine.pageGenerate(own, idKp, { page, gen: 1, recipients: [{ member: own, box: ownBox }] })
  const sh = made.shares[0]
  await engine.pageSecrets(own, { owner: own, admins: [] }, { page, gen: 1, sealed: sh.sealed, by: own, sig: sh.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc) })
  await store.writeDmCursor(storage, 5)

  let release = null
  gate = new Promise((resolve) => { release = resolve })
  const pulling = engine.pull(own)
  await reachedP
  t.alike(await engine.pageForget({ page }), { ok: true })
  gate = null
  release()
  t.is((await pulling).incomplete, false, 'the pull ends without an error')
  const prefix = store.pageDmPrefix(page)
  t.is(await storage.readJson(prefix + 'dmCursor'), null, 'no cursor written for the forgotten page')
  t.absent(await storage.hasCore(prefix + store.DM_LOCAL), 'its store not opened again')
  t.alike(await store.readPageStores(storage), [], 'not listed')
  await engine.pull(own)
  t.absent(await storage.hasCore(prefix + store.DM_LOCAL), 'nor by the next pull')
})

test('dm.pull answers while the published-key checks still wait; the event follows', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  let release = null
  const hang = new Promise((resolve) => { release = resolve })
  const rogue = hex(gc.boxKeyPairFromSeed(crypto.randomBytes(32)).publicKey)
  const asked = []
  const A = await memberNode(t, assoc, seeder.url, {
    dmKeyPeek: async (k) => {
      asked.push(k)
      await hang
      return { box: rogue, gen: 1 }
    }
  })
  t.teardown(() => release())
  const pages = []
  for (let i = 0; i < 2; i++) {
    const kp = crypto.keyPair()
    const page = hex(kp.publicKey)
    const made = await A.web.request('dm.pageGenerate', { page, gen: 1, recipients: [{ member: A.key, box: A.box }] })
    await hold(await pageDiary(t, { assoc, issuer, pageKp: kp, ownerKp: A.keyPair, box: made.box }), A.storage)
    const s = made.shares[0]
    await A.web.request('dm.pageSecrets', { page, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc) })
    pages.push(page)
  }
  const started = Date.now()
  await A.web.request('dm.pull')
  t.ok(Date.now() - started < 5000, 'the pull did not wait for the lookups')
  await until(async () => pages.every((p) => asked.includes(p)))
  t.pass('both pages looked up at once')
  t.absent(A.web.events.some((e) => e.name === 'dm.pageKeyMismatch'), 'nothing yet')
  release()
  await until(async () => pages.every((p) => A.web.events.some((e) => e.name === 'dm.pageKeyMismatch' && e.data.page === p)))
  t.pass('the event once the checks finish')
})

test('page holder: pairs and pending secrets zeroed at lock, reopened from kv under the same key only', async (t) => {
  const assoc = generateAssociationKeyPair()
  const storage = memoryNodeStorage()
  const holder = createPageHolder({ storage, association: hex(assoc.publicKey) })
  const idKp = crypto.keyPair()
  const own = hex(idKp.publicKey)
  const ownBox = gc.boxKeyPairFromSeed(crypto.randomBytes(32))
  const page = hex(crypto.keyPair().publicKey)
  const localKey = crypto.randomBytes(32)
  await holder.unlock(localKey)

  const made = holder.generate(own, idKp, { page, gen: 3, recipients: [{ member: own, box: hex(ownBox.publicKey) }] })
  t.is(holder.pendingCount, 1)
  const share = made.shares[0]
  t.ok(ps.openSecrets(share.sealed, ownBox, { page, gen: 3, member: own }), 'sealed with the gen given')
  const roster = { owner: own, admins: [] }
  const params = { page, gen: 3, sealed: share.sealed, by: own, sig: share.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc) }
  t.alike(await holder.adopt(own, ownBox, roster, params), { changed: true })
  t.is(holder.pendingCount, 0, 'adopted from the pending secrets')
  t.alike(await holder.adopt(own, ownBox, roster, params), { changed: false }, 'idempotent')

  const e = holder.get(page)
  t.is(hex(e.dmBox.publicKey), made.box)
  t.is(hex(holder.groupBoxOf(page).publicKey), made.groupBox)
  const bufs = [e.dmBox.publicKey, e.dmBox.secretKey, e.groupBox.publicKey, e.groupBox.secretKey, e.secrets.dmSeed, e.secrets.groupSeed]
  holder.generate(own, idKp, { page, gen: 4, recipients: [{ member: own, box: hex(ownBox.publicKey) }] })
  holder.lock()
  t.ok(bufs.every(isZero), 'every pair and seed zeroed')
  t.is(holder.pendingCount, 0, 'pending secrets dropped')
  t.is(holder.get(page), null)

  await holder.unlock(localKey)
  t.is(hex(holder.get(page).dmBox.publicKey), made.box, 'reopened under the same key')
  holder.lock()
  await holder.unlock(crypto.randomBytes(32))
  t.is(holder.get(page), null, 'another key opens nothing')
  holder.lock()
})

test('page holder: a share below the highest gen held is refused, after forget and lock too, until a reset', async (t) => {
  const assoc = generateAssociationKeyPair()
  const storage = memoryNodeStorage()
  const holder = createPageHolder({ storage, association: hex(assoc.publicKey) })
  const idKp = crypto.keyPair()
  const own = hex(idKp.publicKey)
  const ownBox = gc.boxKeyPairFromSeed(crypto.randomBytes(32))
  const page = hex(crypto.keyPair().publicKey)
  const localKey = crypto.randomBytes(32)
  const roster = { owner: own, admins: [] }
  const cert = createCert({ member: page }, assoc)
  await holder.unlock(localKey)
  const shareOf = (gen) => {
    const m = holder.generate(own, idKp, { page, gen, recipients: [{ member: own, box: hex(ownBox.publicKey) }] })
    const s = m.shares[0]
    return { page, gen, sealed: s.sealed, by: own, sig: s.sig, box: m.box, groupBox: m.groupBox, cert }
  }
  const p2 = shareOf(2)
  t.alike(await holder.adopt(own, ownBox, roster, p2), { changed: true })
  const p3 = shareOf(3)
  t.alike(await holder.adopt(own, ownBox, roster, p3), { changed: true })
  await t.exception(holder.adopt(own, ownBox, roster, p2), new RegExp(MISMATCH), 'an older share replayed')
  t.is(holder.get(page).gen, 3, 'the held gen stays')
  t.alike(await store.readPageMaxGen(storage), { [page]: 3 })

  await holder.forget(page)
  t.is(holder.get(page), null)
  await t.exception(holder.adopt(own, ownBox, roster, p2), new RegExp(MISMATCH), 'after a forget')
  t.alike(await holder.adopt(own, ownBox, roster, p3), { changed: true }, 'the same gen comes back')

  holder.lock()
  await holder.unlock(localKey)
  await t.exception(holder.adopt(own, ownBox, roster, p2), new RegExp(MISMATCH), 'after lock and unlock')
  await holder.forget(page)
  holder.lock()
  const again = createPageHolder({ storage, association: hex(assoc.publicKey) })
  await again.unlock(localKey)
  await t.exception(again.adopt(own, ownBox, roster, p2), new RegExp(MISMATCH), 'a forgotten page on a fresh holder')
  again.lock()

  await store.deleteDmData(storage)
  t.alike(await store.readPageMaxGen(storage), {}, 'only the reset clears it')
})

test('legacy import: filed below what the page already holds, its box written before memory, one history per page', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  const ctx = { assoc, issuer }
  const row = (from, to, text, i) => ({ id: i.toString(16).padStart(32, '0'), from, to, text, at: AT, replyTo: null, media: null, card: null })
  const failing = (key, times = 1) => {
    const write = A.storage.writeJson
    let left = times
    A.storage.writeJson = async function (k, v) {
      if (k === key && left > 0) {
        left--
        throw new Error('falha de escrita')
      }
      return write.call(this, k, v)
    }
    return () => { A.storage.writeJson = write }
  }

  // A message pulled after adoption stays after an import whose legacy
  // ops name its sender.
  const P1 = await adoptedPage(t, A, ctx, [C])
  await C.web.request('dm.send', { to: P1, text: 'depois da adoção' })
  await A.web.request('dm.pull')
  t.alike((await A.web.request('dm.thread', { page: P1, peer: C.key })).messages.map((m) => m.text), ['depois da adoção'])
  const b1 = legacyBundle(P1, A.box, { rows: [row(C.key, P1, 'antiga', 1)], ops: [{ op: 'declined', peer: C.key }, { op: 'deleted', peer: C.key }] })
  t.alike(await importBundle(A, b1), { complete: true, added: 1, blocked: 0, skipped: 0 })
  t.alike((await A.web.request('dm.thread', { page: P1, peer: C.key })).messages.map((m) => m.text), ['depois da adoção'], 'the legacy delete hides only the legacy row')
  t.ok((await A.web.request('dm.list', { page: P1, folder: 'request' })).conversations.some((c) => c.peer === C.key), 'the legacy decline leaves the new message in requests')

  // The legacy box write fails once: nothing is done, the retry writes it and
  // it is there after a lock.
  const P2 = await adoptedPage(t, A, ctx)
  const legacyOf = async (page) => (await A.storage.readJson('pageSecrets')).pages[page].legacy
  const b2 = legacyBundle(P2, A.box, { rows: [row(C.key, P2, 'histórico', 2)] })
  let restore = failing('pageSecrets')
  t.ok(await errorOf(importBundle(A, b2)), 'the legacy box write failed')
  restore()
  t.is(await legacyOf(P2), null, 'not written')
  t.is(await A.storage.readJson(store.pageDmPrefix(P2) + 'dmLegacyDone'), null, 'not done')
  t.alike(await importBundle(A, b2), { complete: true, added: 0, blocked: 0, skipped: 0 }, 'the retry')
  t.ok(await legacyOf(P2), 'the retry wrote the legacy box')
  await A.node.clearKeyPair()
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  t.ok(await legacyOf(P2), 'still there after a lock')
  t.is((await errorOf(importBundle(A, legacyBundle(P2, A.box, { rows: [row(C.key, P2, 'outra', 3)], box: b2.box })))).message, 'linha inválida', 'a second bundle after one completed')
  t.alike((await A.web.request('dm.thread', { page: P2, peer: C.key })).messages.map((m) => m.text), ['histórico'], 'nothing of it filed')

  // A page holding another legacy box (its done write failed): a bundle
  // with a different box is refused and the box stays.
  const P3 = await adoptedPage(t, A, ctx)
  const b3 = legacyBundle(P3, A.box, { rows: [row(C.key, P3, 'primeira', 4)] })
  restore = failing(store.pageDmPrefix(P3) + 'dmLegacyDone')
  t.ok(await errorOf(importBundle(A, b3)), 'the done write failed')
  restore()
  const held = await legacyOf(P3)
  t.ok(held, 'the first box is held')
  const peer = hex(crypto.keyPair().publicKey)
  t.is((await errorOf(importBundle(A, legacyBundle(P3, A.box, { rows: [row(peer, P3, 'outra caixa', 5)] })))).message, 'linha inválida', 'another legacy box')
  t.alike((await A.web.request('dm.thread', { page: P3, peer })).messages, [], 'nothing filed')
  t.alike(await legacyOf(P3), held, 'the held box untouched')
  t.alike(await importBundle(A, b3), { complete: true, added: 0, blocked: 0, skipped: 0 }, 'the first bundle completes on retry')
})

test('a legacy bundle carried over on a move: filed for the new page when its verified origin names the old one', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const ctx = { assoc, issuer }
  const K1 = hex(crypto.keyPair().publicKey)
  const peer = hex(crypto.keyPair().publicKey)
  const row = (from, to, text, i) => ({ id: i.toString(16).padStart(32, '0'), from, to, text, at: AT, replyTo: null, media: null, card: null })
  const carried = () => legacyBundle(K1, A.box, {
    rows: [row(peer, K1, 'para a página antiga', 1), row(K1, peer, 'resposta antiga', 2)],
    ops: [{ op: 'accepted', peer }, { op: 'blocked', peer: K1 }]
  })

  // Without a page-origin the bundle names another page.
  const K3 = await adoptedPage(t, A, ctx)
  t.is((await errorOf(importBundle(A, { chunks: carried().chunks.map((c) => ({ ...c, page: K3 })) }))).message, 'linha inválida', 'no origin: refused')
  t.alike((await A.web.request('dm.thread', { page: K3, peer })).messages, [], 'nothing filed')

  const K2 = await adoptedPage(t, A, ctx, [], K1)
  t.is((await A.web.request('page.read', { key: K2 })).movedFrom.from, K1, 'the origin verifies')
  const other = legacyBundle(hex(crypto.keyPair().publicKey), A.box, { rows: [row(peer, K2, 'x', 3)] })
  t.is((await errorOf(importBundle(A, { chunks: other.chunks.map((c) => ({ ...c, page: K2 })) }))).message, 'linha inválida', 'any other page: refused')
  const b = carried()
  t.alike(await importBundle(A, { chunks: b.chunks.map((c) => ({ ...c, page: K2 })) }), { complete: true, added: 2, blocked: 0, skipped: 1 }, 'the op naming the old page skipped')
  t.alike((await A.web.request('dm.thread', { page: K2, peer })).messages.map((m) => [m.text, m.mine]), [['para a página antiga', false], ['resposta antiga', true]], 'filed in the new page store')
  t.ok((await A.web.request('dm.list', { page: K2 })).conversations.some((c) => c.peer === peer && !c.unread), 'the accepted op applied, seen')
  t.ok((await A.storage.readJson('pageSecrets')).pages[K2].legacy, 'its box adopted: none was held')
})

test('a legacy bundle carried over two moves files for the newest page; a forwarded legacy row keeps fwd', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const K1 = hex(crypto.keyPair().publicKey)
  // K2 moved from K1, K3 from K2: a diary for K2 is held for its origin.
  const k2Kp = crypto.keyPair()
  const K2 = hex(k2Kp.publicKey)
  await hold(await pageDiary(t, { assoc, issuer, pageKp: k2Kp, ownerKp: A.keyPair, box: hex(crypto.randomBytes(32)), movedFrom: K1 }), A.storage)
  const K3 = await adoptedPage(t, A, { assoc, issuer }, [], K2)
  const peer = hex(crypto.keyPair().publicKey)
  const row = (text, i, extra = {}) => ({ id: i.toString(16).padStart(32, '0'), from: peer, to: K1, text, at: AT, replyTo: null, media: null, card: null, ...extra })
  const b = legacyBundle(K1, A.box, { rows: [row('encaminhada', 1, { fwd: 1 }), row('comum', 2), row('fwd ruim', 3, { fwd: 2 })] })
  t.alike(await importBundle(A, { chunks: b.chunks.map((c) => ({ ...c, page: K3 })) }), { complete: true, added: 2, blocked: 0, skipped: 1 }, 'a bad fwd skipped')
  t.alike((await A.web.request('dm.thread', { page: K3, peer })).messages.map((m) => [m.text, m.fwd]), [['encaminhada', 1], ['comum', 0]], 'filed for K3 with its fwd')
})

test('a carried legacy box opens drops to the old page key and files them for the new page', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  // K1's gen 1 box was the service's; C writes to K1 before the move.
  const k1Kp = crypto.keyPair()
  const K1 = hex(k1Kp.publicKey)
  const legacySecret = crypto.randomBytes(32)
  const legacyPub = b4a.alloc(32)
  sodium.crypto_scalarmult_base(legacyPub, legacySecret)
  await hold(await pageDiary(t, { assoc, issuer, pageKp: k1Kp, ownerKp: A.keyPair, box: hex(legacyPub) }), C.storage)
  await C.web.request('dm.send', { to: K1, text: 'para a chave antiga' })

  const K2 = await adoptedPage(t, A, { assoc, issuer }, [], K1)
  await A.web.request('dm.pull')
  t.alike((await A.web.request('dm.thread', { page: K2, peer: C.key })).messages, [], 'not opened before the bundle')
  const b = legacyBundle(K1, A.box, { box: hex(legacySecret) })
  t.alike(await importBundle(A, { chunks: b.chunks.map((c) => ({ ...c, page: K2 })) }), { complete: true, added: 0, blocked: 0, skipped: 0 })
  await A.web.request('dm.pull')
  t.alike((await A.web.request('dm.thread', { page: K2, peer: C.key })).messages.map((m) => [m.text, m.mine]), [['para a chave antiga', false]], 'filed for the new page')

  // Still the old key's box after a lock.
  await A.node.clearKeyPair()
  await A.node.setKeyPair(A.keyPair, { prf: A.prf })
  await C.web.request('dm.send', { to: K1, text: 'depois do bloqueio' })
  await A.web.request('dm.pull')
  t.alike((await A.web.request('dm.thread', { page: K2, peer: C.key })).messages.map((m) => m.text), ['para a chave antiga', 'depois do bloqueio'], 'after unlock too')
})

test('dm.react tells a Página only from a diary held here: a held one is refused, an unheld peer never waits for a seeder peek', async (t) => {
  t.timeout(300000)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc })
  const A = await memberNode(t, assoc, seeder.url)
  // A peek the stand-in seeder never answers would hold the call for this long.
  const C = await memberNode(t, assoc, seeder.url, { peekTimeoutMs: 120000 })
  const P = await adoptedPage(t, A, { assoc, issuer }, [C])
  const target = { from: P, id: dmCore.newMessageId() }

  const refused = await errorOf(C.web.request('dm.react', { to: P, target, emoji: '\u{1f44d}' }))
  t.is(refused && refused.message, 'conversas com uma Página não têm reações', 'a held Página is refused')

  const X = hex(crypto.keyPair().publicKey)
  C.peeks.set(X, { box: hex(crypto.randomBytes(32)), gen: 1 })
  let timer
  const waited = new Promise((resolve) => { timer = setTimeout(() => resolve('waited'), 20000) })
  const answer = await Promise.race([errorOf(C.web.request('dm.react', { to: X, target: { from: X, id: dmCore.newMessageId() }, emoji: '\u{1f44d}' })), waited])
  clearTimeout(timer)
  t.not(answer, 'waited', 'answered without waiting for a peek of the unheld diary')
  t.is(answer && answer.message, 'mensagem não encontrada', 'past the Página check: the engine answers for the missing message')
})

// ---- buckets (docs/protocol.md section 11, "Buckets") ----

test('buckets: a member that holds a Página asks every bucket; one that holds none asks only its own', async (t) => {
  t.timeout(TEST_TIMEOUT_MS * 2)
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc, bits: 6 })
  const A = await memberNode(t, assoc, seeder.url)
  const C = await memberNode(t, assoc, seeder.url)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const pageCert = createCert({ member: P }, assoc)

  // No Página held yet: only the own bucket is asked.
  await A.web.request('dm.pull')
  t.ok(seeder.pageQueries.length > 0)
  t.ok(seeder.pageQueries.every((q) => q.buckets.length === 1), 'a device with no Página asks one bucket')

  const made1 = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made1.box })
  await hold(diary, A.storage)
  await hold(diary, C.storage)
  const s1 = made1.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s1.sealed, by: A.key, sig: s1.sig, box: made1.box, groupBox: made1.groupBox, cert: pageCert })
  await C.web.request('dm.send', { to: P, text: 'para a 1' })
  await copyDiary(A, C)
  await C.web.request('dm.send', { to: A.key, text: 'para voce' })

  const everyBucket = (qs) => qs.every((q) => q.buckets.length === 64)
  const texts = async () => (await A.web.request('dm.thread', { page: P, peer: C.key })).messages.map((m) => m.text)
  const own = async () => (await A.web.request('dm.thread', { peer: C.key })).messages.map((m) => m.text)

  seeder.pageQueries.length = 0
  await A.web.request('dm.pull')
  t.is(seeder.pageQueries.length, 1, 'one pass')
  t.ok(everyBucket(seeder.pageQueries), 'every bucket, no filter')
  t.alike(await texts(), ['para a 1'])
  t.alike(await own(), ['para voce'])

  // A new gen resets the page cursor behind the own one: the own pass goes
  // first, then the page catches up from 0, every bucket in both, nothing
  // filed twice.
  const made2 = await A.web.request('dm.pageGenerate', { page: P, gen: 2, recipients: [{ member: A.key, box: A.box }] })
  const s2 = made2.shares[0]
  await A.web.request('dm.pageSecrets', { page: P, gen: 2, sealed: s2.sealed, by: A.key, sig: s2.sig, box: made2.box, groupBox: made2.groupBox, cert: pageCert })
  await C.web.request('dm.send', { to: P, text: 'ainda para a 1' })
  seeder.pageQueries.length = 0
  const trafficAt = seeder.traffic.length
  await A.web.request('dm.pull')
  t.is(seeder.pageQueries.length, 2, 'the own pass, then the catch-up')
  t.ok(everyBucket(seeder.pageQueries))
  const afters = seeder.traffic.slice(trafficAt).filter((x) => x.startsWith('{')).map((x) => JSON.parse(x).after)
  t.ok(afters[0] > 0, 'the own pass starts at the own cursor')
  t.is(afters[1], 0, 'the catch-up starts at the reset page cursor')
  t.alike(await texts(), ['para a 1', 'ainda para a 1'])
  t.alike(await own(), ['para voce'], 'the own scan filed nothing twice')

  // The next pulls: the cursors stay together, so no page costs an extra request.
  for (const text of ['de carona', 'e outra']) {
    await C.web.request('dm.send', { to: P, text })
    seeder.pageQueries.length = 0
    seeder.served = 0
    await A.web.request('dm.pull')
    t.is(seeder.pageQueries.length, 1, 'one request per pull')
    t.ok(everyBucket(seeder.pageQueries))
    t.is(seeder.served, 2, 'the new drop and its self copy, downloaded once')
  }
  t.alike(await texts(), ['para a 1', 'ainda para a 1', 'de carona', 'e outra'])
  t.alike(await own(), ['para voce'])
})

// A prf whose box prefix is not among `taken` (dm.test.js prfWithPrefix):
// the nodes then sit in different buckets at 6 bits, whatever the keys.
async function prfWithPrefix (taken) {
  for (;;) {
    const prf = crypto.randomBytes(32)
    const p = dmCore.bucketPrefix(hex((await dmBoxKeyPairFromPrf(prf, 1)).publicKey))
    if (!taken.includes(p)) return { prf, p }
  }
}

// A and C in two buckets at 6 bits, and a Página P owned by A, its diary
// held by both; adopt() gives A its gen 1 secrets.
async function bucketPage (t) {
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc) }
  const seeder = await dmSeeder(t, { signer: assoc, bits: 6 })
  const a = await prfWithPrefix([])
  const c = await prfWithPrefix([a.p])
  const A = await memberNode(t, assoc, seeder.url, { prf: a.prf })
  const C = await memberNode(t, assoc, seeder.url, { prf: c.prf })
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await A.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: A.key, box: A.box }] })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: A.keyPair, box: made.box })
  await hold(diary, A.storage)
  await hold(diary, C.storage)
  const s = made.shares[0]
  const adopt = () => A.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: s.sealed, by: A.key, sig: s.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: P }, assoc) })
  return { seeder, A, C, a: a.p, c: c.p, P, pageKp, adopt }
}

test('buckets: drops sealed to a Página box go untagged; the own self copy and the own ctl keep the own bucket', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const { seeder, A, C, a, c, P, pageKp, adopt } = await bucketPage(t)
  await adopt()
  await copyDiary(C, A)
  let at = seeder.putInfos.length
  const tags = () => {
    const out = seeder.putInfos.slice(at).map((i) => i.bucket)
    at = seeder.putInfos.length
    return out
  }

  const op = await A.web.request('dm.pageDraft', { page: P, kind: 'ctl', op: 'accepted', peer: C.key })
  await A.web.request('dm.pageSend', { page: P, id: op.id, ...signed(op.digest, pageKp) })
  t.alike(tags(), [null], 'a Página ctl goes untagged')
  const reply = await A.web.request('dm.pageDraft', { page: P, kind: 'msg', to: C.key, text: 'da página' })
  await A.web.request('dm.pageSend', { page: P, id: reply.id, ...signed(reply.digest, pageKp) })
  t.alike(tags(), [c, null], 'a Página reply: the recipient bucket, then its self copy untagged')
  await A.web.request('dm.send', { to: C.key, text: 'minha' })
  t.alike(tags(), [c, a], 'an own message: its self copy keeps the own bucket')
  await A.web.request('dm.set', { peer: C.key, state: 'accepted' })
  t.alike(tags(), [a], 'an own ctl keeps the own bucket')
  t.ok(seeder.putInfos.every((i) => i.bits === 6), 'all on the v2 lane')

  await C.web.request('dm.pull')
  t.alike((await C.web.request('dm.thread', { peer: P })).messages.map((m) => m.text), ['da página'], 'the recipient still gets the Página reply')
})

test('buckets: a Página adopted after the own cursor passed its drop files that drop on the next pull', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const { seeder, A, C, P, adopt } = await bucketPage(t)
  await copyDiary(A, C)
  await C.web.request('dm.send', { to: P, text: 'antes da adoção' })
  const dropSeq = seeder.pool.entries[seeder.pool.entries.length - 2].seq
  await C.web.request('dm.send', { to: A.key, text: 'para voce' })
  await A.web.request('dm.pull')
  t.ok(seeder.pageQueries.every((q) => q.buckets.length === 1), 'no Página held yet: one bucket')
  t.ok((await A.storage.readJson('dmCursor')).after > dropSeq, 'the own cursor passed the drop to the Página')

  await adopt()
  seeder.pageQueries.length = 0
  await A.web.request('dm.pull')
  t.ok(seeder.pageQueries.length > 0 && seeder.pageQueries.every((q) => q.buckets.length === 64), 'every bucket')
  t.alike((await A.web.request('dm.thread', { page: P, peer: C.key })).messages.map((m) => m.text), ['antes da adoção'])
  t.alike((await A.web.request('dm.thread', { peer: C.key })).messages.map((m) => m.text), ['para voce'], 'the own thread as before')
})

// ---- a holder's pull passes, over a fake pool (engine level) ----

// A fake pool for the dm and visit links of an engine: items { seq, bytes }
// on the dm lane (the visit lane is empty); each page request is recorded
// as { lane, after, prefixes } (prefixes null: every bucket).
function fakePool () {
  const pool = {
    items: [],
    pages: [],
    add (bytes) {
      pool.items.push({ seq: pool.items.length + 1, bytes })
    },
    link (lane) {
      return {
        async page ({ after, limit, prefixes }) {
          pool.pages.push({ lane, after, prefixes: prefixes === undefined ? null : prefixes })
          const rest = lane === 'dm' ? pool.items.filter((x) => x.seq > after) : []
          const items = rest.slice(0, limit)
          return { items, next: rest.length > items.length ? items[items.length - 1].seq : null }
        },
        async put () {
          return { ok: true, reason: null }
        },
        close: noop
      }
    }
  }
  return pool
}

// An unlocked engine over `pool`, holding no Página yet; adopt() makes it
// hold a new one at gen 1, its cursor at 0 -> { page, box }.
async function poolEngine (t, pool, assoc, limits = {}) {
  const transport = require('../lib/dm-link')
  const originalDm = transport.openDmLink
  const originalVisit = transport.openVisitLink
  const id = require.resolve('../lib/dm')
  const cached = require.cache[id]
  let createEngine
  try {
    transport.openDmLink = async () => pool.link('dm')
    transport.openVisitLink = async () => pool.link('visit')
    delete require.cache[id]
    createEngine = require('../lib/dm').createDmEngine
  } finally {
    transport.openDmLink = originalDm
    transport.openVisitLink = originalVisit
    require.cache[id] = cached
  }
  const storage = memoryNodeStorage()
  const engine = createEngine({ storage, association: hex(assoc.publicKey), seederUrl: 'ws://127.0.0.1:1/seeder', createSocket: () => { throw new Error('sem rede') }, limits })
  t.teardown(() => engine.close(), { force: true })
  const idKp = crypto.keyPair()
  const own = hex(idKp.publicKey)
  const prf = crypto.randomBytes(32)
  await engine.unlock(prf)
  await engine.loaded()
  const ownBox = hex((await dmBoxKeyPairFromPrf(prf, 1)).publicKey)
  async function adopt () {
    const page = hex(crypto.keyPair().publicKey)
    const made = engine.pageGenerate(own, idKp, { page, gen: 1, recipients: [{ member: own, box: ownBox }] })
    const sh = made.shares[0]
    await engine.pageSecrets(own, { owner: own, admins: [] }, { page, gen: 1, sealed: sh.sealed, by: own, sig: sh.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: page }, assoc) })
    return { page, box: made.box }
  }
  return { engine, storage, idKp, own, ownBox, adopt }
}

// A drop from senderKp to `to`, sealed to boxHex.
function dropTo (assoc, senderKp, to, boxHex, text) {
  const inner = dmCore.buildInner({ kind: 'msg', to, text, cert: createCert({ member: hex(senderKp.publicKey) }, assoc) }, senderKp)
  return dmCore.encodeDrop({ dropId: dmCore.newDropId(), kid: crypto.randomBytes(8), rsaSig: crypto.randomBytes(dmCore.DROP.SIG_BYTES), token: crypto.randomBytes(32), sealed: dmCore.sealInner(inner, boxHex) })
}

// A drop that no box of the engine opens.
function strayDrop (assoc, senderKp) {
  return dropTo(assoc, senderKp, hex(crypto.keyPair().publicKey), hex(gc.boxKeyPairFromSeed(crypto.randomBytes(32)).publicKey), 'de fora')
}

// Two drops per page and a budget of two drops: a pull reads one page past
// the budget, then stops (incomplete).
const SMALL_BUDGET = { pageMax: 2, budgetBytes: 2 * dmCore.DM_DROP_BYTES }

test('buckets: the visit pull of a device that holds a Página asks every bucket; one that holds none asks its own', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc)
  const since = visitsCore.visitDay(Date.now())
  const visitAsks = () => pool.pages.filter((q) => q.lane === 'visit').map((q) => q.prefixes)
  await E.engine.pullVisits(E.own, { since })
  t.alike(visitAsks(), [[dmCore.bucketPrefix(E.ownBox)]], 'no Página: the own bucket')
  await E.adopt()
  pool.pages.length = 0
  await E.engine.pullVisits(E.own, { since })
  t.alike(visitAsks(), [null], 'a holder: every bucket')
  await E.engine.pull(E.own)
  const dmAsks = pool.pages.filter((q) => q.lane === 'dm')
  t.ok(dmAsks.length > 0 && dmAsks.every((q) => q.prefixes === null), 'as on its dm pull')
})

test('buckets: a new own message is filed on the first pull while a Página catches up from 0', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc, SMALL_BUDGET)
  const C = crypto.keyPair()
  for (let i = 0; i < 10; i++) pool.add(strayDrop(assoc, C))
  await store.writeDmCursor(E.storage, 10)
  await E.adopt()
  pool.add(dropTo(assoc, C, E.own, E.ownBox, 'nova'))
  const r = await E.engine.pull(E.own)
  t.is(r.added, 1, 'the new own message, on the first pull')
  t.is(r.cursor, 11)
  t.is(r.incomplete, true, 'the Página catch-up ran out of budget')
  t.alike(pool.pages.map((q) => q.after), [10, 0], 'the own pass first, then the catch-up from 0')
  t.ok(pool.pages.every((q) => q.prefixes === null), 'every request asks every bucket')
  t.alike((await E.engine.thread(E.own, { peer: hex(C.publicKey) })).messages.map((m) => m.text), ['nova'])
})

test('buckets: where the budget stops a holder pull, each cursor stays at the last item its scan saw and the next pull goes on from there', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc, SMALL_BUDGET)
  const C = crypto.keyPair()
  const P = await E.adopt()
  pool.add(strayDrop(assoc, C))
  pool.add(strayDrop(assoc, C))
  pool.add(dropTo(assoc, C, P.page, P.box, 'para a página'))
  for (let i = 0; i < 6; i++) pool.add(strayDrop(assoc, C))
  await store.writeDmCursor(E.storage, 9)
  pool.add(dropTo(assoc, C, E.own, E.ownBox, 'nova'))
  const starts = []
  const ownCursors = []
  const pageCursors = []
  const incomplete = []
  for (let i = 0; i < 6; i++) {
    pool.pages.length = 0
    incomplete.push((await E.engine.pull(E.own)).incomplete)
    starts.push(pool.pages.map((q) => q.after))
    ownCursors.push(await store.readDmCursor(E.storage))
    pageCursors.push((await store.readPageCursor(E.storage, store.pageDmPrefix(P.page))).after)
  }
  t.alike(starts, [[9, 0], [10, 2], [10, 4], [10, 6], [10, 8], [10]], 'each catch-up goes on where the last stopped; then the Página rides along')
  t.alike(ownCursors, [10, 10, 10, 10, 10, 10], 'the own cursor never moves backwards')
  t.alike(pageCursors, [2, 4, 6, 8, 10, 10], 'the Página cursor at the last item its scan saw')
  t.alike(incomplete, [true, true, true, true, false, false])
  const peer = hex(C.publicKey)
  t.alike((await E.engine.thread(E.own, { peer, page: P.page })).messages.map((m) => m.text), ['para a página'])
  t.alike((await E.engine.thread(E.own, { peer })).messages.map((m) => m.text), ['nova'])
})

test('buckets: a message the own scan skipped stays unfiled when a Página catch-up reads it again', async (t) => {
  const assoc = generateAssociationKeyPair()
  const pool = fakePool()
  const E = await poolEngine(t, pool, assoc)
  const C = crypto.keyPair()
  const peer = hex(C.publicKey)
  const P = await E.adopt()
  await E.engine.set(E.own, E.idKp, { peer, state: 'blocked' })
  pool.add(dropTo(assoc, C, E.own, E.ownBox, 'enquanto bloqueado'))
  t.is((await E.engine.pull(E.own)).added, 0, 'skipped while blocked')
  await E.engine.set(E.own, E.idKp, { peer, state: 'unblocked' })
  // The Página's cursor starts over, as a new gen or a legacy box makes it.
  const prefix = store.pageDmPrefix(P.page)
  const before = await store.readPageCursor(E.storage, prefix)
  t.is(before.after, 1)
  await store.writePageCursor(E.storage, prefix, { ...before, after: 0 })
  pool.pages.length = 0
  t.is((await E.engine.pull(E.own)).added, 0, 'not filed after the unblock')
  t.alike(pool.pages.map((q) => q.after), [1, 0], 'the catch-up read it again')
  t.alike((await E.engine.thread(E.own, { peer })).messages, [])
})
