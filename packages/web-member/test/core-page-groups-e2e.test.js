'use strict'

// A Página's private group across node kinds (docs/rpc.md 5.114): a browser
// admin (a real session, ./helpers/dm-e2e.js memberNode) and a core admin
// (@varanda/core session with the real core-dm factory) both adopt the
// page's secrets from the owner's dm.pageGenerate. A post the browser seals
// as the page opens on core through the real withPageGroupBox and group.read
// with `page`; a post core seals (group.seal) opens on the browser. The
// envelopes are appended to the page's writer as the service would.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir } = require('./helpers/net')
const { hex, seederHost, memberNode } = require('./helpers/dm-e2e')
const { createCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const grp = require('@varanda/core/lib/group')
const coreStore = require('@varanda/core/lib/store')
const { createSession } = require('@varanda/core/lib/session')
const { createCoreDm } = require('../lib/core-dm')
const { createGroupKeys } = require('../lib/group-keys')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf, dmBoxKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)
// Under the runner's 180 s kill.
const TEST_TIMEOUT_MS = 170000

function noop () {}

function socketTo (url) {
  const ws = new WebSocket(url)
  ws.on('error', noop)
  return ws
}

// A member-ops identity. `groupBox` (hex): the box its group writers name,
// in place of its holder's (the page's group box, held only by the admins).
async function plainMember (t, assocKp, name, { keyPair = crypto.keyPair(), groupBox = null } = {}) {
  const storage = memoryNodeStorage()
  const prf = crypto.randomBytes(32)
  const holder = createGroupKeys()
  t.teardown(() => holder.close(), { force: true })
  const groupKeys = groupBox === null
    ? holder
    : new Proxy(holder, {
      get (target, prop) {
        if (prop === 'boxPublicKey') return () => b4a.from(groupBox, 'hex')
        const v = target[prop]
        return typeof v === 'function' ? v.bind(target) : v
      }
    })
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce), groupKeys }
  await ops.idCreate(ctx)
  const key = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: key }, assocKp))
  await ops.profileSet(ctx, { name, bio: '' })
  await holder.unlock(storage, prf)
  return { storage, key, ctx, prf }
}

async function pipe (source, target) {
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await target.download({ start: 0, end: source.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
}

// `from`'s diary and the group cores `keys` it holds, into the browser
// storage `to`.
async function share (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to, from.key))
  for (const key of keys) {
    await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to, key))
    await store.addGroupReplica(to, key)
  }
  await store.addGroupDiary(to, from.key)
}

// The same into a core node's store (no run up).
async function shareCore (from, dataDir, keys) {
  const dst = await coreStore.openStore(dataDir)
  try {
    const sources = [() => store.openDiary(from.storage)].concat(keys.map((k) => () => store.openGroupCoreReadOnly(from.storage, k)))
    for (const open of sources) {
      const src = await open()
      const a = src.replicate(true, { keepAlive: false })
      const b = dst.replicate(false)
      a.pipe(b).pipe(a)
      try {
        const replica = dst.get({ key: src.key })
        await replica.ready()
        await replica.download({ start: 0, end: src.length }).done()
        await replica.close()
      } finally {
        a.destroy()
        b.destroy()
        await src.close()
      }
    }
  } finally {
    await dst.close()
  }
}

async function writers (m) {
  return (await store.readGroupWriters(m.storage)).map((e) => e.key)
}

// Appends a sealed envelope to the page's writer of `group`, as the
// service would ('group-seal').
async function appendSealed (p, group, s) {
  const entry = (await store.readGroupWriters(p.storage)).find((e) => e.group === group)
  const kp = await groupKeyPairFromPrf(p.prf, new Uint8Array(b4a.from(entry.nonce, 'hex')))
  const core = await store.openGroupWriter(p.storage, kp)
  try {
    await store.appendGroupRecord(core, grp.groupSealed({ kid: s.kid, nonce: s.nonce, box: s.box, at: s.at }), { private: true })
  } finally {
    await core.close()
  }
  return entry.key
}

test('page groups: a post sealed on a browser admin opens on a core admin, and the other way', async (t) => {
  t.timeout(TEST_TIMEOUT_MS)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const host = await seederHost(t, bootstrap, assoc)
  const accountOrigin = 'http://' + new URL(host.url).host

  // O: the owner, a browser admin.
  const O = await memberNode(t, assoc, host)
  const boxO = hex((await dmBoxKeyPairFromPrf(O.prf, 1)).publicKey)

  // C: a core admin with the real factory, its diary at the seeder.
  const C = { dataDir: tmpDir(t, 'varanda-core-pg-') }
  C.session = createSession({
    dataDir: C.dataDir,
    association: assoc.hex,
    bootstrap,
    dhtHost: '127.0.0.1',
    dm: (hooks) => createCoreDm({ ...hooks, accountOrigin, createSocket: socketTo })
  })
  C.events = []
  C.session.attach((event, data) => C.events.push({ event, data }))
  t.teardown(async () => {
    await C.session.detach().catch(noop)
    await C.session.close()
  }, { force: true })
  C.call = (method, params = {}) => C.session.handlers[method](params)
  const { publicKey: coreKey } = await C.call('identity.create')
  await C.call('cert.add', { cert: createCert({ member: coreKey }, kp) })
  await C.call('page.register')
  await C.call('dm.enable')
  const ab = await C.call('dm.actorBox')

  // The page's secrets, for both admins.
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await O.web.request('dm.pageGenerate', {
    page: P,
    gen: 1,
    recipients: [{ member: O.key, box: boxO }, { member: ab.actor, box: ab.box, proof: { gen: ab.gen, at: ab.at, sig: ab.sig } }]
  })

  // The page diary (its writers boxed to the page's group box): roster
  // naming O, dm-key, then a private group of A's community, admitted.
  const p = await plainMember(t, kp, 'Padaria', { keyPair: pageKp, groupBox: made.groupBox })
  const diary = await store.openDiary(p.storage, pageKp)
  const fields = { page: P, gen: 1, owner: O.key, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }
  await store.appendRecord(diary, issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, O.keyPair) }, issuer.kp, issuer.cert))
  await store.appendRecord(diary, { type: 'dm-key', box: made.box, gen: 1, at: AT })
  await diary.close()
  const a = await plainMember(t, kp, 'Ana')
  const { community, group: general } = await ops.communityCreate(a.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(a.ctx, { name: 'Conselho', join: 'open', visibility: 'private', community })
  await ops.groupPost(a.ctx, { group, text: 'só para o conselho' })
  await share(a, p.storage, [community, general, group])
  await ops.communityJoin(p.ctx, { community })
  await ops.groupJoin(p.ctx, { group })
  await share(p, a.storage, await writers(p))
  await ops.groupAdmit(a.ctx, { group, member: P, on: true })
  const roots = [community, general, group]
  const aCores = [...new Set([...roots, ...(await writers(a))])]

  // Both admins hold the cores and adopt.
  const toBrowser = async () => {
    await share(a, O.storage, aCores)
    await share(p, O.storage, await writers(p))
  }
  const toCore = async () => {
    await shareCore(a, C.dataDir, aCores)
    await shareCore(p, C.dataDir, await writers(p))
  }
  await toBrowser()
  await toCore()
  const cert = createCert({ member: P }, kp)
  const [own, toC] = made.shares
  t.alike(await O.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: own.sealed, by: O.key, sig: own.sig, box: made.box, groupBox: made.groupBox, cert }), { ok: true })
  t.alike(await C.call('dm.pageSecrets', { page: P, gen: 1, sealed: toC.sealed, by: O.key, sig: toC.sig, box: made.box, groupBox: made.groupBox, cert }), { ok: true })
  t.is((await C.call('group.read', { group, page: P })).state, 'ok', 'core folds as the page')

  // Browser -> core.
  const fromWeb = await O.web.request('group.seal', { group, page: P, text: 'do navegador' })
  const pw = await appendSealed(p, group, fromWeb)
  t.is(fromWeb.writer, pw, 'the browser seals for the page\'s writer')
  await shareCore(p, C.dataDir, [pw])
  const onCore = await C.call('group.read', { group, page: P })
  t.is(onCore.items[0].text, 'do navegador', 'opens on core')
  t.is(onCore.items[0].diary, P)

  // Core -> browser.
  const fromCore = await C.call('group.seal', { group, page: P, text: 'do core' })
  t.is(fromCore.writer, pw, 'core seals for the same writer')
  t.alike(fromCore.kid, fromWeb.kid, 'under the same epoch')
  await appendSealed(p, group, fromCore)
  await share(p, O.storage, [pw])
  const onWeb = await O.web.request('group.read', { group, page: P })
  t.alike(onWeb.items.slice(0, 2).map((x) => x.text), ['do core', 'do navegador'], 'opens on the browser')
  t.comment('wall ' + Math.round((Date.now() - started) / 1000) + ' s')
})
