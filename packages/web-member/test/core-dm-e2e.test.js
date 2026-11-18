'use strict'

// Conversas of a Página on a core node (lib/core-dm.js injected into
// @varanda/core/lib/session as its `dm` factory): a core session, a real
// local seeder (Seeder with the dm and blob options, local DHT on
// 127.0.0.1, tmp dirs) and a browser node as the page owner. The owner
// shares the page secrets to the core delegate actor with the box it signed
// (dm.actorBox), the core node adopts, pulls, lists, opens a received photo
// and replies as the page, text only.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until } = require('./helpers/net')
const fs = require('node:fs')
const path = require('node:path')
const { createCert, createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const ps = require('@varanda/core/lib/page-secrets')
const coreStore = require('@varanda/core/lib/store')
const { createSession } = require('@varanda/core/lib/session')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { fileNodeStorage } = require('../lib/file-storage')
const { dmBoxKeyPairFromPrf } = require('../lib/passkey')
const { createCoreDm, seederUrlOf, scanDmKey, BAD_ORIGIN, TEXT_ONLY, DM_OFF, DM_BUSY, DM_SEED_BAD, BLOCKLIST_UNREADABLE } = require('../lib/core-dm')
const { KEY_MISMATCH } = require('../lib/dm')
const { hex, seederHost, memberNode, push, png, rejection } = require('./helpers/dm-e2e')
const { signed } = require('./helpers/page-dm')

const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)
const DM_WEB_ONLY = 'mensagens diretas disponíveis só no navegador'
const SIGN_WEB_ONLY = 'assinatura disponível só no navegador'
const NO_SEEDER = 'sem conexão com o semeador'
const TEST_TIMEOUT_MS = 170000

function noop () {}

function socketTo (url) {
  const ws = new WebSocket(url)
  ws.on('error', noop)
  return ws
}

// A core node: its session (with the dm factory unless `dm` is null) and
// a call(method, params) that answers like the dispatcher (result or the
// RpcError thrown). peeks: page key -> { box, gen } the seeder peek answers
// instead of the network; any other key is asked for for real.
function coreNode (t, { assoc, bootstrap, accountOrigin, dm = undefined, peeks = new Map() }) {
  const dataDir = tmpDir(t, 'varanda-core-dm-')
  const dmKeyPeek = async (key, real) => {
    if (!peeks.has(key)) return real()
    const v = peeks.get(key)
    return typeof v === 'function' ? v() : v
  }
  const factory = dm !== undefined ? dm : (hooks) => createCoreDm({ ...hooks, accountOrigin, createSocket: socketTo, dmKeyPeek })
  const session = createSession({ dataDir, association: assoc.hex, bootstrap, dhtHost: '127.0.0.1', dm: factory })
  const events = []
  session.attach((event, data) => events.push({ event, data }))
  t.teardown(async () => {
    await session.detach().catch(noop)
    await session.close()
  }, { force: true })
  const call = (method, params = {}) => session.handlers[method](params)
  return { dataDir, session, events, call }
}

async function stopped (C, runId) {
  await until(() => C.events.some((e) => e.event === 'sync.stopped' && e.data.runId === runId), { timeoutMs: 60000, name: 'sync.stopped' })
  return C.events.find((e) => e.event === 'sync.stopped' && e.data.runId === runId).data
}

// A page diary: block 0 its certificate, a roster naming `owner`, its
// gen 1 dm-key `box`.
async function pageDiary (t, { assoc, issuer, pageKp, ownerKp, box }) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex, keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  const page = hex(pageKp.publicKey)
  await m.setCert(createCert({ member: page }, assoc.kp))
  const fields = { page, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuer.kp, issuer.cert))
  await m.core.append({ type: 'dm-key', box, gen: 1, at: AT })
  return m
}

// The page diary copied whole into the browser node's storage.
async function holdWeb (m, storage) {
  const store = require('../lib/node-store')
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

// The page diary copied whole into the core node's store, as a replica a
// follow would have downloaded.
async function holdCore (m, dataDir) {
  const dst = await coreStore.openStore(dataDir)
  try {
    const a = m.core.replicate(true, { keepAlive: false })
    const b = dst.replicate(false)
    a.pipe(b).pipe(a)
    const replica = dst.get({ key: m.core.key, valueEncoding: 'json' })
    await replica.ready()
    await replica.download({ start: 0, end: m.core.length }).done()
    a.destroy()
    b.destroy()
  } finally {
    await dst.close()
  }
}

async function walletOf (dataDir) {
  const s = fileNodeStorage(dataDir + '/private/dm')
  try {
    const w = await s.readJson('dmStamps')
    return w && Array.isArray(w.items) ? w.items.length : 0
  } finally {
    await s.close()
  }
}

test('core dm: the account origin decides the transport', (t) => {
  t.is(seederUrlOf('https://conta.example'), 'wss://conta.example/seeder')
  t.is(seederUrlOf('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080/seeder', 'http only on loopback')
  for (const bad of ['http://conta.example', 'http://10.0.0.1:8080', 'https://u:p@conta.example', 'https://conta.example/x', 'ftp://conta.example', 'nada']) {
    t.exception(() => seederUrlOf(bad), new RegExp(BAD_ORIGIN.replace(/[()]/g, '.')), bad)
  }
  const ops = { readers: {} }
  t.exception(() => createCoreDm({ dataDir: tmpDir(t), association: 'ab'.repeat(32), accountOrigin: 'http://conta.example', createSocket: noop, ops }), /endereço da conta inválido/, 'refused before anything is built')
})

// A peeked diary for scanDmKey: `keys` maps seq -> dm-key gen (box from
// the gen), every other seq a post; `fail` seqs throw as a timed-out read.
async function messageOf (p) {
  const err = await rejection(p)
  return err === null || err === undefined ? null : err.message
}

function fakeDiary ({ length, keys, fail = [], updateFails = false, deadline = Infinity, now = () => 0 }) {
  return {
    get: async (seq) => {
      if (fail.includes(seq)) throw new Error('timeout')
      const gen = keys[seq]
      const record = gen === undefined ? { type: 'post', text: 'x', at: AT } : { type: 'dm-key', box: String(gen).repeat(64), gen, at: AT }
      return b4a.from(JSON.stringify(record))
    },
    update: async () => { if (updateFails) throw new Error('update') },
    length: () => length,
    forked: () => false,
    deadline,
    now
  }
}

test('core dm: an incomplete dm-key scan answers unknown, never an older key or none', async (t) => {
  const keys = { 1: 1, 95: 2 }
  t.alike(await scanDmKey(fakeDiary({ length: 100, keys })), { box: '2'.repeat(64), gen: 2 }, 'control: the newest dm-key')
  t.alike(await scanDmKey(fakeDiary({ length: 100, keys: {} })), { box: null, gen: null }, 'a complete scan with none: none')
  t.is(await messageOf(scanDmKey(fakeDiary({ length: 100, keys, fail: [95] }))), NO_SEEDER, 'a window block that fails: unknown')
  t.is(await messageOf(scanDmKey(fakeDiary({ length: 100, keys: {}, fail: [40] }))), NO_SEEDER, 'none read past a failed block: unknown')
  t.is(await messageOf(scanDmKey(fakeDiary({ length: 100, keys, updateFails: true }))), NO_SEEDER, 'a failed update: unknown')
  let clock = 0
  const slow = fakeDiary({ length: 200, keys: { 1: 1 }, deadline: 10, now: () => clock })
  const get = slow.get
  slow.get = (seq) => { clock++; return get(seq) }
  t.is(await messageOf(scanDmKey(slow)), NO_SEEDER, 'the deadline before the scan ends: unknown')
})

test('core dm: a blocked author answers none with no network; text only; no seed, no unlock', async (t) => {
  let sockets = 0
  const blocked = 'cd'.repeat(32)
  const calls = []
  const ops = {
    readers: {},
    own: async () => 'ef'.repeat(32),
    dmLookup: async (key) => { calls.push('lookup'); return null },
    moderation: async () => ({ blocked: new Set([blocked]), revokedIssuers: new Set() }),
    signer: async () => { calls.push('signer'); throw new Error('nunca') },
    delegate: async () => null
  }
  const dm = createCoreDm({ dataDir: tmpDir(t), association: 'ab'.repeat(32), accountOrigin: 'http://127.0.0.1:1', createSocket: () => { sockets++; return socketTo('ws://127.0.0.1:1/seeder') }, ops })
  t.teardown(() => dm.close())
  t.alike(await dm.handlers['dm.lookup']({ member: blocked.toUpperCase() }), { box: null, gen: null })
  t.is(sockets, 0, 'no peek for a blocked author')
  const err = await rejection(dm.handlers['dm.pageDraft']({ page: 'aa'.repeat(32), kind: 'msg', to: 'bb'.repeat(32), text: 'x', media: [{}] }))
  t.is(err.message, TEXT_ONLY)
  t.is((await rejection(dm.handlers['dm.pageDraft']({ page: 'aa'.repeat(32), kind: 'msg', to: 'bb'.repeat(32), text: 'x', card: {} }))).message, TEXT_ONLY)
  t.is((await rejection(dm.handlers['dm.list']({}))).message, DM_OFF, 'no seed file: refused, nothing created')
  t.alike(calls, ['lookup'], 'refused before any signer or store op')
})

// Ops for an engine that is never unlocked here: lookups and refusals only.
function lookupOps (own, revokedIssuers = []) {
  return {
    readers: {},
    own: async () => own,
    dmLookup: async () => null,
    moderation: async () => ({ blocked: new Set(), revokedIssuers: new Set(revokedIssuers) }),
    signer: async () => { throw new Error('nunca') },
    delegate: async () => null
  }
}

test('core dm: a second engine on the same data dir is refused until the first closes', async (t) => {
  const dataDir = tmpDir(t)
  const make = () => createCoreDm({ dataDir, association: 'ab'.repeat(32), accountOrigin: 'http://127.0.0.1:1', createSocket: () => socketTo('ws://127.0.0.1:1/seeder'), ops: lookupOps('ef'.repeat(32)) })
  const a = make()
  const b = make()
  t.teardown(async () => { await a.close(); await b.close() })
  t.is((await rejection(a.handlers['dm.list']({}))).message, DM_OFF, 'the first takes the lock (no seed yet)')
  const busy = await rejection(b.handlers['dm.list']({}))
  t.alike([busy.code, busy.message], ['USAGE', DM_BUSY], 'the second is refused')
  await a.close()
  t.is((await rejection(b.handlers['dm.list']({}))).message, DM_OFF, 'free once the first closed')
})

test('core dm: close during an in-flight dm.enable waits for it, then zeroes the signer; later calls refuse', async (t) => {
  const dataDir = tmpDir(t)
  const keyPair = crypto.keyPair()
  let sockets = 0
  let release = null
  let ensured = null
  const blocked = new Promise((resolve) => { release = resolve })
  const asked = new Promise((resolve) => { ensured = resolve })
  const ops = {
    ...lookupOps('ef'.repeat(32)),
    readers: { cert: async () => null, memberBlocks: async () => [], blocklist: async () => null, follows: async () => [] },
    signer: async () => ({ diary: null, keyPair }),
    dmKeyEnsure: async ({ gen }) => {
      ensured()
      await blocked
      return { box: 'x', gen, seq: 1 }
    }
  }
  const dm = createCoreDm({ dataDir, association: 'ab'.repeat(32), accountOrigin: 'http://127.0.0.1:1', createSocket: (url) => { sockets++; return socketTo(url) }, ops })
  t.teardown(() => dm.close(), { force: true })
  let settled = false
  const enabling = dm.handlers['dm.enable']({}).then((r) => ({ r }), (err) => ({ err }))
  enabling.then(() => { settled = true })
  await asked
  const closing = dm.close()
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.absent(keyPair.secretKey.every((b) => b === 0), 'the pair is not zeroed while the call is in flight')
  release()
  await closing
  t.ok(settled, 'close waited for the call in flight')
  const out = await enabling
  t.ok(out.r !== undefined || (out.err && out.err.code === 'USAGE'), 'the call completed or refused cleanly')
  t.is(sockets, 0, 'no stamp top-up after close')
  t.ok(keyPair.secretKey.every((b) => b === 0), 'the pair is zeroed after close')
  t.is(await messageOf(dm.handlers['dm.list']({})), NO_SEEDER, 'a call after close refuses')
})

test('core dm: a dm call queued while suspended refuses after close, never entering the engine', async (t) => {
  const kp = generateAssociationKeyPair()
  let entered = 0
  const fake = () => ({ handlers: { 'dm.list': async () => { entered++; return {} } }, readMedia: async () => null, close: async () => {} })
  const C = coreNode(t, { assoc: { kp, hex: hex(kp.publicKey) }, bootstrap: ['127.0.0.1:1'], dm: fake })
  await C.session.suspend()
  const queued = rejection(C.call('dm.list'))
  await C.session.close()
  const err = await queued
  t.alike([err && err.code, err && err.message], ['LOCKED', 'sessão encerrada'])
  t.is(entered, 0, 'the engine never ran it')
})

test('core dm: a corrupt seed reaches the client as USAGE with no file content; the web-only methods stay refused', async (t) => {
  const kp = generateAssociationKeyPair()
  const C = coreNode(t, { assoc: { kp, hex: hex(kp.publicKey) }, bootstrap: ['127.0.0.1:1'], accountOrigin: 'http://127.0.0.1:1' })
  fs.mkdirSync(path.join(C.dataDir, 'private'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(C.dataDir, 'private', 'dm-seed.json'), 'segredo-quebrado{', { mode: 0o600 })
  for (const method of ['dm.list', 'dm.enable']) {
    const err = await rejection(C.call(method))
    t.alike([err.code, err.message], ['USAGE', DM_SEED_BAD], method)
    t.absent(String(err.message).includes('segredo') || String(err.message).includes('dm-seed'), 'no bytes or path')
  }
  t.is(fs.readFileSync(path.join(C.dataDir, 'private', 'dm-seed.json'), 'utf8'), 'segredo-quebrado{', 'the file stays as is')
  const P = 'aa'.repeat(32)
  const refused = [
    ['dm.send', { to: P, text: 'x' }, DM_WEB_ONLY],
    ['dm.react', { peer: P, id: 'x', emoji: 'x' }, DM_WEB_ONLY],
    ['dm.set', { peer: P, state: 'archived' }, DM_WEB_ONLY],
    ['dm.reportSign', { peer: P, id: 'x' }, SIGN_WEB_ONLY],
    // A page's private groups ask the engine for the page's group box.
    ['group.seal', { group: P, page: P, text: 'x' }, DM_SEED_BAD],
    ['group.read', { group: P, page: P }, DM_SEED_BAD]
  ]
  for (const [method, params, message] of refused) {
    const err = await rejection(C.call(method, params))
    t.alike([err.code, err.message], ['USAGE', message], method)
  }
})

test('core dm: the owner shares to the core delegate, which adopts, pulls, opens a photo and replies as the page', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const blob = { wallet: 16, walletLow: 8, issuePaceMs: 0 }
  const accountOrigin = 'http://' + new URL(host.url).host

  // The owner, a browser node.
  const O = await memberNode(t, assoc, host, { blob })
  const boxO = hex((await dmBoxKeyPairFromPrf(O.prf, 1)).publicKey)
  // Its dm-key reaches the seeder, where the core node looks it up.
  await push(t, O, host)

  // The core node: identity, certificate, page delegate, pushed to the seeder.
  const peeks = new Map()
  const C = coreNode(t, { assoc, bootstrap, accountOrigin, peeks })
  const { publicKey: coreKey } = await C.call('identity.create')
  await C.call('cert.add', { cert: createCert({ member: coreKey }, kp) })
  await C.call('page.register')
  const { runId } = await C.call('sync.start', { once: true, timeoutMs: 30000 })
  t.comment('core push: ' + JSON.stringify((await stopped(C, runId)).reason))
  await until(() => host.current._served.has(coreKey) || host.current._admitted.has(coreKey), { name: 'core served', timeoutMs: 30000 })

  const enabled = await C.call('dm.enable')
  t.ok(enabled.seq > 0, 'the dm-key is appended to the core diary')
  t.alike(await C.call('dm.enable'), { box: enabled.box, gen: 1, seq: null }, 'a current key appends nothing')
  await until(async () => (await walletOf(C.dataDir)) > 0, { name: 'core stamps (v2 proof)', timeoutMs: 60000 })

  // The delegate states its box; the statement verifies under the actor.
  const ab = await C.call('dm.actorBox')
  t.is(ab.box, enabled.box, 'the node\'s own DM box')
  t.ok(ps.verifyActorBox({ actor: ab.actor, box: ab.box, gen: ab.gen, at: ab.at }, ab.sig), 'signed by the delegate')

  // The owner activates Conversas for P and shares to the actor with its proof.
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await O.web.request('dm.pageGenerate', {
    page: P,
    gen: 1,
    recipients: [{ member: O.key, box: boxO }, { member: ab.actor, box: ab.box, proof: { gen: ab.gen, at: ab.at, sig: ab.sig } }]
  })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: O.keyPair, box: made.box })
  await holdWeb(diary, O.storage)
  await holdCore(diary, C.dataDir)
  const cert = createCert({ member: P }, kp)
  const [own, toCore] = made.shares
  await O.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: own.sealed, by: O.key, sig: own.sig, box: made.box, groupBox: made.groupBox, cert })

  // dm.lookup on core: a held replica's dm-key answers without the network.
  t.alike(await C.call('dm.lookup', { member: P }), { box: made.box, gen: 1 }, 'from the stored replica')
  t.alike(await C.call('dm.pageSecrets', { page: P, gen: 1, sealed: toCore.sealed, by: O.key, sig: toCore.sig, box: made.box, groupBox: made.groupBox, cert }), { ok: true }, 'the core delegate adopts')

  // A member writes to the page with a photo; the core node reads it.
  const photo = png(40000)
  const item = await O.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: P })
  const sent = await O.web.request('dm.send', { to: P, text: 'foto', media: [item] })
  // An unreadable blocklist (a directory in its place) refuses the pull,
  // never files items as if nobody were blocked.
  const blFile = path.join(C.dataDir, 'blocklist.json')
  const blAside = blFile + '.teste'
  const hadBl = fs.existsSync(blFile)
  if (hadBl) fs.renameSync(blFile, blAside)
  fs.mkdirSync(blFile)
  const unreadable = await rejection(C.call('dm.pull'))
  t.alike([unreadable && unreadable.code, unreadable && unreadable.message], ['USAGE', BLOCKLIST_UNREADABLE], 'an unreadable blocklist refuses dm.pull')
  fs.rmdirSync(blFile)
  if (hadBl) fs.renameSync(blAside, blFile)
  const pulled = await C.call('dm.pull')
  t.is(pulled.incomplete, false, 'the pool read to its end')
  // Not followed by the page: a request.
  const list = await C.call('dm.list', { page: P, folder: 'request' })
  t.ok(JSON.stringify(list).includes(O.key), 'the page inbox lists the member')
  const th = await C.call('dm.thread', { page: P, peer: O.key })
  t.alike(th.messages.map((m) => m.id), [sent.id])
  const got = await C.session.dmReadMedia({ from: O.key, id: sent.id, index: 0, page: P })
  t.ok(b4a.equals(got.bytes, photo), 'the photo opens on core (media.readFile kind dm)')
  await C.call('dm.seen', { page: P, peer: O.key })

  // The reply as the page: text only; the member's box is looked up through the seeder.
  const refused = await rejection(C.call('dm.pageDraft', { page: P, kind: 'msg', to: O.key, text: 'x', media: [item] }))
  t.alike([refused.code, refused.message], ['USAGE', TEXT_ONLY], 'media refused before any digest')
  const draft = await C.call('dm.pageDraft', { page: P, kind: 'msg', to: O.key, text: 'resposta da página' })
  const { signature, expiresAt } = signed(draft.digest, pageKp)
  await C.call('dm.pageSend', { page: P, id: draft.id, signature, expiresAt })
  await until(async () => {
    await O.web.request('dm.pull')
    const r = await O.web.request('dm.thread', { peer: P })
    return r.messages.some((m) => m.text === 'resposta da página')
  }, { name: 'reply delivered', timeoutMs: 30000 })
  t.pass('the member reads the page\'s reply')

  // Still refused on core with the factory (PR 6, PR 7).
  for (const [method, params] of [['dm.send', { to: P, text: 'x' }], ['dm.set', { peer: P, state: 'archived' }]]) {
    t.is((await rejection(C.call(method, params))).message, DM_WEB_ONLY, method)
  }

  // The stranger lookup over the real seeder link, with its two gates.
  const probe = (association, revoked = []) => {
    const dm = createCoreDm({ dataDir: tmpDir(t, 'varanda-core-dm-probe-'), association, accountOrigin, createSocket: socketTo, ops: lookupOps(coreKey, revoked) })
    t.teardown(() => dm.close(), { force: true })
    return dm.handlers['dm.lookup']
  }
  t.alike(await probe(assoc.hex)({ member: O.key }), { box: boxO, gen: 1 }, 'control: the seeder serves the owner\'s dm-key')
  const other = generateAssociationKeyPair()
  const stranger = await rejection(probe(hex(other.publicKey))({ member: O.key }))
  t.is(stranger && stranger.message, NO_SEEDER, 'a seeder not certified by this association is never read')
  // A diary certified by an issuer, then revoked: its certificate no longer
  // verifies for its key, so its dm-key is not taken.
  const qKp = crypto.keyPair()
  const Q = await memberNode(t, assoc, host, { keyPair: qKp, blob, cert: createIssuedCert({ member: hex(qKp.publicKey) }, issuer.kp, issuer.cert) })
  await push(t, Q, host)
  const boxQ = hex((await dmBoxKeyPairFromPrf(Q.prf, 1)).publicKey)
  t.alike(await probe(assoc.hex)({ member: Q.key }), { box: boxQ, gen: 1 }, 'control: an issued certificate verifies')
  t.alike(await probe(assoc.hex, [hex(issuerKp.publicKey)])({ member: Q.key }), { box: null, gen: null }, 'a revoked issuer: none')

  // A seeder answer that is unknown (a window block that fails) neither
  // flags the page nor clears a flag: the stored replica agrees.
  let unknownAsked = 0
  peeks.set(P, () => {
    unknownAsked++
    return scanDmKey(fakeDiary({ length: 100, keys: { 1: 1 }, fail: [50] }))
  })
  const seenBefore = C.events.length
  await C.call('dm.pull')
  await until(() => unknownAsked > 0, { name: 'unknown peek', timeoutMs: 30000 })
  await new Promise((resolve) => setTimeout(resolve, 500))
  t.absent(C.events.slice(seenBefore).some((e) => e.event === 'dm.pageKeyMismatch'), 'an unknown answer flags nothing')

  // The seeder shows a gen 2 rotation the stored replica (gen 1, the held
  // box) has not caught up with: the seeder decides, and the page is flagged.
  const rotated = hex((await dmBoxKeyPairFromPrf(crypto.randomBytes(32), 1)).publicKey)
  peeks.set(P, { box: rotated, gen: 2 })
  await C.call('dm.pull')
  await until(() => C.events.some((e) => e.event === 'dm.pageKeyMismatch' && e.data.page === P), { name: 'page key mismatch', timeoutMs: 30000 })
  const late = await rejection((async () => {
    const d = await C.call('dm.pageDraft', { page: P, kind: 'msg', to: O.key, text: 'depois da troca' })
    return C.call('dm.pageSend', { page: P, id: d.id, ...signed(d.digest, pageKp) })
  })())
  t.is(late && late.message, KEY_MISMATCH, 'no send while the key differs')
})

test('core dm: a session without the factory refuses dm.enable as before', async (t) => {
  const kp = generateAssociationKeyPair()
  const C = coreNode(t, { assoc: { kp, hex: hex(kp.publicKey) }, bootstrap: ['127.0.0.1:1'], dm: null })
  const err = await rejection(C.call('dm.enable'))
  t.alike([err.code, err.message], ['USAGE', DM_WEB_ONLY])
  t.alike([(await rejection(C.session.dmReadMedia({}))).message], [DM_WEB_ONLY])
})
