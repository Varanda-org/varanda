'use strict'

// Personal Conversas on a core node (lib/core-dm.js injected into
// @varanda/core/lib/session as its `dm` factory), text only: a core
// session, a real local seeder (local DHT on 127.0.0.1, tmp dirs) and
// browser nodes. The core node writes inner v9 (msg, ctl) and v10 (react)
// from its diary, signed by the diary signer; the browser engine keeps
// writing v1, v2 and v4.
// Every inner built in this process, read back from its bytes. The core
// dm exports are frozen, so the engines get a copy with a recording
// buildInner: it goes into the require cache before anything loads them.
const dmPath = require.resolve('@varanda/core/lib/dm')
const realDm = require(dmPath)
const spied = { built: null }
require.cache[dmPath].exports = {
  ...realDm,
  buildInner (fields, keyPair, opts) {
    const out = realDm.buildInner(fields, keyPair, opts)
    if (spied.built !== null) {
      const len = (out[0] << 8) | out[1]
      const body = JSON.parse(Buffer.from(out.subarray(2, 2 + len)).toString('utf8'))
      spied.built.push({ v: body.v, kind: body.kind, from: body.from, signer: body.signer, opts })
    }
    return out
  }
}

const test = require('brittle')
const crypto = require('hypercore-crypto')
const fs = require('node:fs')
const path = require('node:path')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until } = require('./helpers/net')
const { createIssuerCert, createIssuedCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { diaryKeyOfSigner, isDiaryOfSigner } = require('@varanda/core/lib/diary-signer')
const { createSession } = require('@varanda/core/lib/session')
const dmCore = realDm
const { dmTextBytes } = require('@varanda/rpc')
const { fileNodeStorage } = require('../lib/file-storage')
const { ensureDmSeed } = require('@varanda/core/lib/store')
const { createCoreDm, TEXT_ONLY, MOMENT_WEB_ONLY, DM_OFF } = require('../lib/core-dm')
const { USE_PAGE_DRAFT, NO_STAMPS } = require('../lib/dm')
const { hex, seederHost, memberNode, push, rejection } = require('./helpers/dm-e2e')

const AT = '2026-11-03T12:00:00.000Z'
const DM_WEB_ONLY = 'mensagens diretas disponíveis só no navegador'
const TEST_TIMEOUT_MS = 150000
const WORST_TEXT = '\u{1F600}'.repeat(dmCore.DM_MAX_TEXT)
const TOO_LONG = 'mensagem longa demais'

function noop () {}

function socketTo (url) {
  const ws = new WebSocket(url)
  ws.on('error', noop)
  return ws
}

// { v, kind, from, signer, opts } of each inner built during this test,
// by the core and the browser node alike.
function spyInners (t) {
  const built = []
  spied.built = built
  t.teardown(() => { if (spied.built === built) spied.built = null }, { force: true })
  return built
}

// A core node on dataDir (a new one by default), with the dm factory, and
// a call(method, params) that answers like the dispatcher. ensured: when
// given, each dmKeyEnsure answer is pushed to it.
function coreNode (t, { assoc, bootstrap, accountOrigin, dataDir = tmpDir(t, 'varanda-core-pessoal-'), ensured = null }) {
  const counted = (ops) => ensured === null
    ? ops
    : { ...ops, dmKeyEnsure: async (p) => { const r = await ops.dmKeyEnsure(p); ensured.push(r); return r } }
  const factory = (hooks) => createCoreDm({ ...hooks, ops: counted(hooks.ops), accountOrigin, createSocket: socketTo })
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

async function pushCore (C, host, key) {
  const { runId } = await C.call('sync.start', { once: true, timeoutMs: 30000 })
  await until(() => C.events.some((e) => e.event === 'sync.stopped' && e.data.runId === runId), { timeoutMs: 60000, name: 'core push' })
  await until(() => host.current._served.has(key) || host.current._admitted.has(key), { name: 'core served', timeoutMs: 30000 })
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

async function pullAll (call) {
  for (let i = 0; i < 20; i++) {
    const r = await call('dm.pull')
    if (r.incomplete === false) return r
  }
  throw new Error('pull incompleto')
}

async function threadOf (call, peer) {
  return (await call('dm.thread', { peer })).messages
}

test('core dm personal: media, card, momento and a page dm.set are refused before any unlock, signer or socket', async (t) => {
  const built = spyInners(t)
  let sockets = 0
  const calls = []
  const ops = {
    readers: {},
    own: async () => { calls.push('own'); return 'ef'.repeat(32) },
    dmLookup: async () => { calls.push('lookup'); return null },
    moderation: async () => ({ blocked: new Set(), revokedIssuers: new Set() }),
    signer: async () => { calls.push('signer'); throw new Error('nunca') },
    delegate: async () => null
  }
  const dm = createCoreDm({ dataDir: tmpDir(t), association: 'ab'.repeat(32), accountOrigin: 'http://127.0.0.1:1', createSocket: () => { sockets++; return socketTo('ws://127.0.0.1:1/seeder') }, ops })
  t.teardown(() => dm.close())
  const P = 'aa'.repeat(32)
  const cases = [
    ['dm.send', { to: P, text: 'x', media: [{}] }, TEXT_ONLY],
    ['dm.send', { to: P, text: 'x', card: {} }, TEXT_ONLY],
    ['dm.send', { to: P, text: '\u{1F44D}', moment: 3 }, MOMENT_WEB_ONLY],
    ['dm.set', { page: P, peer: P, state: 'accepted' }, USE_PAGE_DRAFT]
  ]
  for (const [method, params, message] of cases) {
    const err = await rejection(dm.handlers[method](params))
    t.is(err && err.message, message, method + ' ' + Object.keys(params).join(','))
  }
  t.alike(calls, [], 'no store, signer or lookup op')
  t.is(sockets, 0, 'no seeder link')
  t.is(built.length, 0, 'nothing signed')
})

// Text only, the longest text (4-byte characters) fits next to a v2
// certificate (budget 4006, docs/protocol.md section 11). A reply takes
// room the text then lacks: refused as too long, as a browser v2 bound
// reply with a v2 certificate already is (budget 3895).
test('core dm personal: the longest text with a v2 certificate fits a v9 inner; a reply at that length is too long', (t) => {
  const assoc = generateAssociationKeyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc)
  const signer = crypto.keyPair()
  const diary = hex(diaryKeyOfSigner(signer.publicKey))
  const cert = createIssuedCert({ member: diary, date: AT }, issuerKp, issuerCert)
  t.is(cert.v, 2, 'the larger certificate')
  const to = 'bb'.repeat(32)
  const fields = { kind: 'msg', id: 'a'.repeat(32), from: diary, to, at: AT, cert }
  const budget = dmCore.textBudget({ ...fields, signer: hex(signer.publicKey) })
  t.ok(dmTextBytes(WORST_TEXT) <= budget, 'the budget holds ' + dmTextBytes(WORST_TEXT) + ' text bytes (budget ' + budget + ')')
  const inner = dmCore.buildInner({ ...fields, text: WORST_TEXT }, signer, { diary })
  const len = (inner[0] << 8) | inner[1]
  t.ok(len + 66 <= dmCore.DM_INNER_BYTES, 'v9 worst case fits (' + (len + 66) + ' of ' + dmCore.DM_INNER_BYTES + ' bytes)')
  const body = dmCore.openInner(inner, to, { association: hex(assoc.publicKey) })
  t.is(body && body.v, 9)
  t.is(body && body.text, WORST_TEXT, 'opens whole for the recipient')
  const replyTo = { from: to, id: 'c'.repeat(32), digest: 'd'.repeat(64) }
  t.ok(dmCore.textBudget({ ...fields, replyTo, signer: hex(signer.publicKey) }) < dmTextBytes(WORST_TEXT), 'a bound reply leaves less room')
  t.exception.all(() => dmCore.buildInner({ ...fields, replyTo, text: WORST_TEXT }, signer, { diary }), new RegExp(TOO_LONG), 'refused, never cut')
})

test('core dm personal: core and browser talk both ways, reply, react, and the core node reads its own copies back', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const built = spyInners(t)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const accountOrigin = 'http://' + new URL(host.url).host

  const O = await memberNode(t, assoc, host)
  await push(t, O, host)

  // The core node, with an issued (v2) certificate, its dm-key pushed.
  const C = coreNode(t, { assoc, bootstrap, accountOrigin })
  const { publicKey: coreKey } = await C.call('identity.create')
  await C.call('cert.add', { cert: createIssuedCert({ member: coreKey }, issuer.kp, issuer.cert) })
  await pushCore(C, host, coreKey)
  await C.call('dm.enable')
  await pushCore(C, host, coreKey)
  await until(async () => (await walletOf(C.dataDir)) >= dmCore.DM_STAMP_WALLET, { name: 'core wallet', timeoutMs: 60000 })

  // Text only: refused with the wallet as it was and nothing signed.
  const stamps = await walletOf(C.dataDir)
  const signedBefore = built.length
  for (const [params, message] of [
    [{ to: O.key, text: 'foto', media: [{ blob: 'x' }] }, TEXT_ONLY],
    [{ to: O.key, text: 'link', card: { url: 'https://example.com' } }, TEXT_ONLY],
    [{ to: O.key, text: '\u{1F44D}', moment: 1 }, MOMENT_WEB_ONLY]
  ]) {
    const err = await rejection(C.call('dm.send', params))
    t.alike([err && err.code, err && err.message], ['USAGE', message], 'refused: ' + Object.keys(params).join(','))
  }
  t.is(await walletOf(C.dataDir), stamps, 'no stamp spent')
  t.is(built.length, signedBefore, 'nothing signed')

  // Core to browser.
  const first = await C.call('dm.send', { to: O.key, text: 'oi do core' })
  const coreBuilt = () => built.filter((b) => b.from === coreKey)
  t.alike(coreBuilt().map((b) => [b.v, b.kind]), [[9, 'msg']], 'a v9 msg from the diary')
  t.ok(isDiaryOfSigner(coreKey, coreBuilt()[0].signer), 'signed by the diary signer')
  await until(async () => {
    await O.web.request('dm.pull')
    return (await threadOf(O.web.request, coreKey)).some((m) => m.id === first.id)
  }, { name: 'core message delivered', timeoutMs: 30000 })
  const atO = (await threadOf(O.web.request, coreKey)).find((m) => m.id === first.id)
  t.alike([atO.text, atO.from, atO.mine], ['oi do core', coreKey, false], 'the browser reads it from the core diary')

  // Browser to core, a bound reply to the core message. The browser peeks
  // the core dm-key through its running sync.
  await O.web.request('sync.start', {})
  const back = await O.web.request('dm.send', { to: coreKey, text: 'oi do navegador', replyTo: first.id })
  await until(async () => {
    await pullAll(C.call)
    return (await threadOf(C.call, O.key)).some((m) => m.id === back.id)
  }, { name: 'browser message delivered', timeoutMs: 30000 })
  const atC = (await threadOf(C.call, O.key)).find((m) => m.id === back.id)
  t.alike([atC.text, atC.mine, atC.replyTo], ['oi do navegador', false, first.id], 'the core node reads the reply')

  // A bound reply at the longest text does not fit: refused before any
  // stamp. The same text alone fits; then a bound reply.
  const left = await walletOf(C.dataDir)
  const long = await rejection(C.call('dm.send', { to: O.key, text: WORST_TEXT, replyTo: back.id }))
  t.alike([long && long.code, long && long.message], ['USAGE', TOO_LONG], 'a reply at the longest text is too long')
  // The wallet (18) stays above the low mark (10): no top-up refills it meanwhile.
  t.is(await walletOf(C.dataDir), left, 'no stamp spent for it')
  const longest = await C.call('dm.send', { to: O.key, text: WORST_TEXT })
  await until(async () => {
    await O.web.request('dm.pull')
    return (await threadOf(O.web.request, coreKey)).some((m) => m.id === longest.id)
  }, { name: 'longest text delivered', timeoutMs: 30000 })
  t.ok((await threadOf(O.web.request, coreKey)).find((m) => m.id === longest.id).text === WORST_TEXT, 'the longest text arrives whole')
  const reply = await C.call('dm.send', { to: O.key, text: 'resposta do core', replyTo: back.id })
  await until(async () => {
    await O.web.request('dm.pull')
    return (await threadOf(O.web.request, coreKey)).some((m) => m.id === reply.id)
  }, { name: 'core reply delivered', timeoutMs: 30000 })
  const replyAtO = (await threadOf(O.web.request, coreKey)).find((m) => m.id === reply.id)
  t.alike([replyAtO.text, replyAtO.replyTo], ['resposta do core', back.id], 'the bound reply arrives')

  // A reaction each way.
  t.alike(await C.call('dm.react', { to: O.key, target: { from: O.key, id: back.id }, emoji: '\u{1F44D}' }), { ok: true })
  t.alike(await O.web.request('dm.react', { to: coreKey, target: { from: coreKey, id: first.id }, emoji: '\u{1F600}' }), { ok: true })
  await until(async () => {
    await O.web.request('dm.pull')
    const m = (await threadOf(O.web.request, coreKey)).find((x) => x.id === back.id)
    return Array.isArray(m.reactions) && m.reactions.some((r) => r.emoji === '\u{1F44D}' && !r.mine)
  }, { name: 'core reaction delivered', timeoutMs: 30000 })
  await until(async () => {
    await pullAll(C.call)
    const m = (await threadOf(C.call, O.key)).find((x) => x.id === first.id)
    return Array.isArray(m.reactions) && m.reactions.some((r) => r.emoji === '\u{1F600}' && !r.mine)
  }, { name: 'browser reaction delivered', timeoutMs: 30000 })
  t.pass('reactions both ways')

  // A folder op: a request from a third member, accepted on core. Only the
  // ctl self copy can move it to the inbox once the local store is gone.
  const Q = await memberNode(t, assoc, host)
  await push(t, Q, host)
  await Q.web.request('sync.start', {})
  const asked = await Q.web.request('dm.send', { to: coreKey, text: 'posso falar?' })
  await until(async () => {
    await pullAll(C.call)
    return (await threadOf(C.call, Q.key)).some((m) => m.id === asked.id)
  }, { name: 'request delivered', timeoutMs: 30000 })
  const folderOf = async (call, peer) => {
    const l = await call('dm.list', { folder: 'request' })
    return JSON.stringify(l).includes(peer) ? 'request' : 'inbox'
  }
  t.is(await folderOf(C.call, Q.key), 'request', 'a request before the op')
  t.alike(await C.call('dm.set', { peer: Q.key, state: 'accepted' }), { ok: true })
  t.is(await folderOf(C.call, Q.key), 'inbox', 'accepted here')

  t.alike(coreBuilt().map((b) => [b.v, b.kind]), [[9, 'msg'], [9, 'msg'], [9, 'msg'], [10, 'react'], [9, 'ctl']], 'core: v9 msgs, a v10 reaction, a v9 ctl')
  t.ok(coreBuilt().every((b) => b.opts && b.opts.diary === coreKey && isDiaryOfSigner(coreKey, b.signer)), 'all from the diary, signed by its signer')
  const browserBuilt = built.filter((b) => b.from === O.key || b.from === Q.key)
  t.alike(browserBuilt.map((b) => [b.v, b.kind]), [[2, 'msg'], [4, 'react'], [1, 'msg']], 'browser: v2 bound reply, v4 reaction, v1 text, as before')
  t.ok(browserBuilt.every((b) => b.opts === undefined && b.signer === undefined), 'the browser engine passes no diary')

  // A seed whose dm-key was never recorded (an enable cut short): the
  // first send publishes the dm-key, once, and the message goes out.
  const ensured = []
  const D = coreNode(t, { assoc, bootstrap, accountOrigin, ensured })
  const { publicKey: dKey } = await D.call('identity.create')
  await D.call('cert.add', { cert: createIssuedCert({ member: dKey }, issuer.kp, issuer.cert) })
  await pushCore(D, host, dKey)
  const off = await rejection(D.call('dm.send', { to: O.key, text: 'sem semente' }))
  t.alike([off && off.code, off && off.message], ['USAGE', DM_OFF], 'no seed: refused, nothing created')
  t.is(ensured.length, 0)
  ensureDmSeed(D.dataDir)
  const sendD = () => D.call('dm.send', { to: O.key, text: 'sem dm.enable' })
  let fromD = await sendD().catch((err) => err)
  t.is(ensured.length, 1, 'the send published the dm-key')
  t.ok(ensured[0].seq > 0, 'appended to the diary')
  if (fromD instanceof Error) {
    // The top-up the publish starts may not have landed yet.
    t.is(fromD.message, NO_STAMPS, 'only refused for want of stamps')
    await until(async () => (await walletOf(D.dataDir)) >= 2, { name: 'D wallet', timeoutMs: 60000 })
    fromD = await sendD()
  }
  t.is(ensured.length, 1, 'published once')
  await until(async () => {
    await O.web.request('dm.pull')
    return (await threadOf(O.web.request, dKey)).some((m) => m.id === fromD.id)
  }, { name: 'D message delivered', timeoutMs: 30000 })
  t.pass('the message sent before dm.enable arrives')

  // The same identity with no local Conversas store: every row comes back
  // from the pool, the own copies included.
  await C.session.close()
  fs.rmSync(path.join(C.dataDir, 'private', 'dm'), { recursive: true, force: true })
  const C2 = coreNode(t, { assoc, bootstrap, accountOrigin, dataDir: C.dataDir })
  await until(async () => {
    await pullAll(C2.call)
    const ids = (await threadOf(C2.call, O.key)).map((m) => m.id)
    return [first.id, back.id, longest.id, reply.id].every((id) => ids.includes(id))
  }, { name: 'own copies read back', timeoutMs: 30000 })
  const again = await threadOf(C2.call, O.key)
  t.alike(again.filter((m) => m.mine).map((m) => m.id).sort(), [first.id, longest.id, reply.id].sort(), 'the own v9 copies read back as mine')
  const reacted = again.find((m) => m.id === back.id)
  t.ok(Array.isArray(reacted.reactions) && reacted.reactions.some((r) => r.mine && r.emoji === '\u{1F44D}'), 'the own v10 reaction reads back')
  await until(async () => {
    await pullAll(C2.call)
    return (await folderOf(C2.call, Q.key)) === 'inbox' && (await threadOf(C2.call, Q.key)).length > 0
  }, { name: 'ctl self copy read back', timeoutMs: 30000 })
  t.pass('the own v9 ctl reads back: the request stays accepted')
})

test('core dm personal: a session without the factory still refuses dm.send, dm.react and dm.set', async (t) => {
  const kp = generateAssociationKeyPair()
  const session = createSession({ dataDir: tmpDir(t), association: hex(kp.publicKey), bootstrap: ['127.0.0.1:1'], dhtHost: '127.0.0.1', dm: null })
  t.teardown(() => session.close(), { force: true })
  const P = 'aa'.repeat(32)
  for (const [method, params] of [['dm.send', { to: P, text: 'x' }], ['dm.react', { to: P, target: { from: P, id: 'c'.repeat(32) }, emoji: '\u{1F44D}' }], ['dm.set', { peer: P, state: 'accepted' }]]) {
    const err = await rejection(session.handlers[method](params))
    t.alike([err && err.code, err && err.message], ['USAGE', DM_WEB_ONLY], method)
  }
})
