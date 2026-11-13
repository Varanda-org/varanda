'use strict'

// apps/cli/lib/account/pages-groups.js: a hosted page joins communities and
// groups through its own writer cores, on a real Seeder (local DHT only),
// and a member node reads what the page wrote.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Corestore = require('corestore')
const { testnet, tmpDir, until } = require('./helpers/net')
const { createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const member = require('@varanda/core/lib/member')
const coreStore = require('@varanda/core/lib/store')
const groupLib = require('@varanda/core/lib/group')
const groupCrypto = require('@varanda/core/lib/group-crypto')
const { sealMedia } = require('@varanda/core/lib/group-media')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const { person, startSeeder, syncOnce } = require('../../../packages/core/test/helpers/sync-groups')
const { startSeedWs } = require('../lib/seed-ws')
const { openPageKeys } = require('../lib/account/page-keys')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesGroups } = require('../lib/account/pages-groups')

const PAGE_KEYS = 'cd'.repeat(32)
const coreDir = path.dirname(require.resolve('@varanda/core/lib/seeder'))
const sodium = require(require.resolve('sodium-universal', { paths: [coreDir] }))

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

let nonceCount = 0
function nonce () {
  nonceCount++
  return (String(nonceCount) + 'g'.repeat(43)).slice(0, 43)
}

function newPage (ctx, keys, username) {
  const { key, row } = keys.pending(nonce())
  keys.put(key, row)
  const cert = createIssuedCert({ member: key }, ctx.issuerKp, ctx.issuerCert)
  const usernameRecord = createUsernameRecord({ member: key, username }, ctx.issuerKp, ctx.issuerCert)
  const owner = crypto.keyPair()
  const fields = { page: key, gen: 1, owner: hex(owner.publicKey), admins: [], prev: null, at: new Date().toISOString(), nonce: nonce(), association: ctx.association }
  const signature = signRoster(fields, owner)
  const rosterRecord = issuerCountersign({ type: 'page-roster', ...fields, signature }, ctx.issuerKp, ctx.issuerCert)
  return { key, owner: hex(owner.publicKey), args: { cert, usernameRecord, rosterRecord } }
}

function walk (dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
}

function holdsSecret (buf, secret) {
  const s = b4a.from(secret)
  return buf.includes(s) || buf.includes(b4a.from(hex(s)))
}

async function rejects (t, promise, code, msg) {
  try {
    await promise
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

// Retries while the fold is still partial ('indisponivel').
function settled (fn, name, timeoutMs = 90000) {
  return until(async () => {
    try {
      return await fn()
    } catch (err) {
      if (err.code === 'indisponivel') return null
      throw err
    }
  }, { name, timeoutMs, intervalMs: 500 })
}

function lastJoins (entries, group) {
  const last = new Map()
  for (const j of groupLib.groupJoinHistory(entries, group)) last.set(j.writer, j.on)
  return last
}

// The device-held group box of a page, as the owner's device would publish
// it (docs/rpc.md 5.84 'dm-box'): only its public half reaches the ACL.
function dmRow (groupBox, extra = {}) {
  return { gen: 1, box: hex(crypto.randomBytes(32)), groupBox: hex(groupBox.publicKey), shares: {}, pending: {}, reboxPending: false, legacyBundle: null, rotatePending: null, ...extra }
}

function boxPair () {
  for (;;) {
    const kp = groupCrypto.newBoxKeyPair()
    if (!groupLib.isWeakBoxKey(hex(kp.publicKey))) return kp
  }
}

// Every block of a core the member node holds.
async function blocksOf (ctx, key) {
  return member.withIdentity(ctx, async ({ store }) => {
    const core = await coreStore.openReplica(store, key)
    try {
      return await coreStore.readBlocks(core)
    } finally {
      await core.close().catch(() => {})
    }
  })
}

// The newest epoch entry sealed to `writer` on the group's root:
// { kid, sealed } or null.
async function epochEntry (ctx, G, writer, after = -1) {
  let out = null
  for (const e of await blocksOf(ctx, G)) {
    const r = e && e.record
    if (!r || r.type !== 'group-key' || e.seq <= after) continue
    const k = r.keys.find((x) => x.writer === writer)
    if (k) out = { kid: r.kid === null ? { writer: G, seq: e.seq } : r.kid, sealed: b4a.from(k.sealed, 'base64'), seq: e.seq }
  }
  return out
}

// The epoch key from `entry` with any of the X25519 secrets, or null.
function openWith (entry, G, secrets) {
  for (const secretKey of secrets) {
    if (!(secretKey instanceof Uint8Array) || secretKey.byteLength !== 32) continue
    const publicKey = b4a.alloc(32)
    sodium.crypto_scalarmult_base(publicKey, secretKey)
    if (groupCrypto.openFrom(entry.sealed, { publicKey, secretKey }) !== null) return true
    if (groupCrypto.openEpochKey(entry.sealed, { publicKey, secretKey }, G, entry.kid) !== null) return true
  }
  return false
}

// Every 32-byte candidate secret of a page-keys row: the box fields and
// both halves of every 64-byte secret.
function x25519Candidates (row) {
  const out = []
  for (const k of ['secretKey', 'mediaSecretKey', 'boxSecretKey', 'groupBoxSecretKey']) {
    const v = row[k]
    if (!v) continue
    if (v.byteLength === 32) out.push(b4a.from(v))
    if (v.byteLength === 64) out.push(b4a.from(v.subarray(0, 32)), b4a.from(v.subarray(32)))
  }
  for (const v of Object.values(row.writers || {})) out.push(b4a.from(v.subarray(0, 32)), b4a.from(v.subarray(32)))
  return out
}

// What a device does for 'group-seal': the inner record bound to the writer,
// group and kid, sealed under the epoch key.
function sealFor ({ text, writer, group, kid, key, seq }) {
  const record = groupLib.groupPost({ text })
  const sealed = groupCrypto.sealRecord(groupLib.sealedInner(record, { writer, group, kid }), key)
  return { kid, nonce: sealed.nonce, box: sealed.box, at: record.at, writer, seq }
}

function zeroRowCopy (row) {
  if (!row) return
  for (const k of ['secretKey', 'mediaSecretKey', 'boxSecretKey', 'groupBoxSecretKey']) if (row[k]) row[k].fill(0)
  for (const v of Object.values(row.writers || {})) v.fill(0)
}

async function mediaPost (ctx, group, media, sealed = false) {
  // Exercise real replication and private envelopes with a browser-shaped
  // record, since the core member only creates text posts.
  const original = groupLib.groupPost
  try {
    groupLib.groupPost = (params) => original({ ...params, media, sealed })
    return await member.groupPost(ctx, { group, text: '' })
  } finally {
    groupLib.groupPost = original
  }
}

test('pages-groups: cached v1 and v2 posts paginate without a seeder connection', async (t) => {
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const issuerKp = crypto.keyPair()
  const ctx = { association, issuerKp, issuerCert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const a = await person(t, kp, 'Ana')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Fotos', join: 'open', community })
  const textPost = await member.groupPost(a, { group, text: 'texto v1' })
  const media = [{ core: hex(crypto.randomBytes(32)), mime: 'image/gif', start: 1, blocks: 1, bytes: 1, sha256: hex(crypto.randomBytes(32)), width: 1, height: 1 }]
  const visible = await mediaPost(a, group, media)
  const hidden = await mediaPost(a, group, media)
  await member.groupHide(a, { group, target: { writer: group, seq: hidden.seq }, on: true })
  const dir = tmpDir(t, 'varanda-account-')
  const source = await coreStore.openStore(a.dataDir)
  const target = new Corestore(path.join(dir, 'pages-replicas'))
  let left
  let right
  try {
    await target.ready()
    const copies = []
    for await (const discoveryKey of source.list()) {
      const from = source.get({ discoveryKey, writable: false })
      await from.ready()
      const to = target.get({ key: from.key, writable: false })
      await to.ready()
      copies.push({ from, to })
    }
    left = source.replicate(true)
    right = target.replicate(false)
    left.pipe(right).pipe(left)
    for (const { from, to } of copies) {
      for (let seq = 0; seq < from.contiguousLength; seq++) await to.get(seq, { raw: true, timeout: 10000 })
    }
  } finally {
    if (left) left.destroy()
    if (right) right.destroy()
    await target.close()
    await source.close()
  }
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const pagesStore = openPagesStore(dir)
  const writer = createPagesWriter({ dir, keys, association })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  const page = newPage(ctx, keys, 'fotos')
  await writer.createPage(page.args)
  await pagesStore.create({ page: page.key, owner: page.owner })
  const pg = createPagesGroups({ dir, writer, pagesStore, keys, association, fetchTimeoutMs: 10 })
  t.teardown(() => pg.close(), { force: true })
  await pg.ready()
  // 500 reactors on the visible post, the page among them: the read sends
  // the compact summary and never the fold's `by` list.
  const reactors = [...Array.from({ length: 499 }, (_, i) => i.toString(16).padStart(64, '0')), page.key]
  const build = groupLib.buildGroup
  groupLib.buildGroup = (...args) => {
    const view = build(...args)
    for (const p of view.posts) if (p.seq === visible.seq) p.reactions = [{ emoji: '\u{1f44d}', count: reactors.length, by: reactors }]
    // The fold keeps a hidden post's card; the read must not pass it on.
    for (const p of view.posts) if (p.seq === hidden.seq) p.card = { url: 'https://exemplo.com.br/', host: 'exemplo.com.br', title: 'oculto', desc: '', image: null }
    return view
  }
  let first
  try {
    first = await pg.groupRead(page.key, group, { limit: 2 })
  } finally {
    groupLib.buildGroup = build
  }
  t.alike(first.items[1].reactions, [{ emoji: '\u{1f44d}', count: 500, mine: true }], 'compact reactions, no reactor keys')
  t.absent('reactions' in first.items[0], 'absent when empty')
  t.ok(JSON.stringify(first).length < 20000)
  t.alike(first.items.map((p) => p.seq), [hidden.seq, visible.seq])
  t.is(first.items[0].media, null, 'hidden media is omitted')
  t.is(first.items[0].text, '')
  t.is(first.items[0].card, null, 'a hidden post carries no card')
  t.is(first.items[1].card, null, 'no card is null')
  t.alike(first.items[1].media, media, 'v2 descriptors survive the cached fold')
  t.is(first.items[1].text, '')
  t.is(first.incomplete, true, 'the missing writer listing stays explicit')
  const older = await pg.groupRead(page.key, group, { before: first.next })
  t.alike(older.items.map((p) => p.seq), [textPost.seq])
  t.is(older.items[0].media, null, 'v1 posts have media null')
  t.is(older.items[0].text, 'texto v1')
})

test('pages-groups: a page joins, posts, waits for approval, leaves and reads a private group', async (t) => {
  t.timeout(600000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const issuerKp = crypto.keyPair()
  const ctx = { association, issuerKp, issuerCert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const seeder = await startSeeder(t, bootstrap, kp)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + server.port

  // A member creates a community with an open, an approval and a private group.
  const a = await person(t, kp, 'Ana')
  const { community: C } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group: G } = await member.groupCreate(a, { name: 'Praça', join: 'open', community: C })
  const { group: GA } = await member.groupCreate(a, { name: 'Clube', join: 'approval', community: C })
  const { group: GP } = await member.groupCreate(a, { name: 'Segredo', join: 'open', visibility: 'private', community: C })
  const { group: GP2 } = await member.groupCreate(a, { name: 'Segredo 2', join: 'open', visibility: 'private', community: C })
  const { group: GP3 } = await member.groupCreate(a, { name: 'Segredo 3', join: 'open', visibility: 'private', community: C })
  const { group: GP4 } = await member.groupCreate(a, { name: 'Segredo 4', join: 'open', visibility: 'private', community: C })
  await member.groupPost(a, { group: GP, text: 'segredo antes' })
  const photo = { core: hex(crypto.randomBytes(32)), mime: 'image/png', start: 1, blocks: 1, bytes: 1, sha256: hex(crypto.randomBytes(32)), width: 1, height: 1 }
  const publicMedia = [photo, { ...photo, start: 2, mime: 'image/gif' }]
  const privateMedia = [{ core: photo.core, start: 1, ...sealMedia(b4a.from('fixture'), { plainMime: 'image/gif', w: 1, h: 1 }).item }]
  const publicPost = await mediaPost(a, G, publicMedia)
  await mediaPost(a, GP, privateMedia, true)
  await syncOnce(bootstrap, a)

  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const pagesStore = openPagesStore(dir)
  const logs = []
  const writer = createPagesWriter({ dir, keys, association, seederWs, log: (e) => logs.push(e) })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  let pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs, log: (e) => logs.push(e) })
  t.teardown(() => pg.close(), { force: true })
  await pg.ready()
  await until(() => writer.connected() && pg.connected(), { name: 'links up', timeoutMs: 20000 })

  const page = newPage(ctx, keys, 'padaria')
  await writer.createPage(page.args)
  await pagesStore.create({ page: page.key, owner: page.owner })

  // Community, then an open group, then a post the member reads.
  const joined = await until(async () => {
    try {
      return await pg.communityJoin(page.key, C)
    } catch (err) {
      if (err.code === 'indisponivel') return null
      throw err
    }
  }, { name: 'community join', timeoutMs: 60000 })
  t.is(joined.state, 'member', 'the page is a member of the open community')
  t.is((await settled(() => pg.groupJoin(page.key, G), 'group join')).state, 'member', 'and of the open group')
  const kinds = pg.writersOf(page.key).map((w) => w.kind).sort()
  t.ok(kinds.includes('community') && kinds.includes('group'), 'the ACL keeps the page writers')
  await settled(() => pg.groupPost(page.key, G, { text: 'pão quente na praça' }), 'group post')
  const seen = await until(async () => {
    await syncOnce(bootstrap, a)
    const r = await member.groupRead(a, { group: G })
    return r.items.find((p) => p.text === 'pão quente na praça') || null
  }, { name: 'member reads the page post', timeoutMs: 180000, intervalMs: 500 })
  t.is(seen.diary, page.key, 'attributed to the page diary')
  await member.withIdentity(a, async ({ store }) => {
    const replica = await coreStore.openReplica(store, seen.writer)
    const record = await replica.get(seen.seq)
    t.alike(Object.keys(record).sort(), ['at', 'replyTo', 'seen', 'text', 'type'], 'the service still writes the exact v1 record')
  })
  const publicRead = await until(async () => {
    const r = await pg.groupRead(page.key, G)
    return r.items.some((p) => p.writer === G && p.seq === publicPost.seq) ? r : null
  }, { name: 'page reads public media', timeoutMs: 60000, intervalMs: 500 })
  t.alike(publicRead.items.find((p) => p.writer === G && p.seq === publicPost.seq).media, publicMedia)
  t.is(publicRead.items.find((p) => p.diary === page.key).media, null, 'v1 page posts have media null')
  await member.groupHide(a, { group: G, target: { writer: G, seq: publicPost.seq }, on: true })
  await syncOnce(bootstrap, a)
  const hiddenPhoto = await until(async () => {
    const r = await pg.groupRead(page.key, G)
    return r.items.find((p) => p.writer === G && p.seq === publicPost.seq && p.hidden) || null
  }, { name: 'page reads hidden media', timeoutMs: 60000, intervalMs: 500 })
  t.is(hiddenPhoto.media, null)

  // Approval group: requested until the admin admits.
  t.is((await settled(() => pg.groupJoin(page.key, GA), 'approval join')).state, 'requested', 'an approval group stays requested')
  await until(async () => {
    await syncOnce(bootstrap, a)
    try {
      await member.groupAdmit(a, { group: GA, member: page.key, on: true })
      return true
    } catch {
      return false
    }
  }, { name: 'admin admits the page', timeoutMs: 180000, intervalMs: 500 })
  await syncOnce(bootstrap, a)
  await until(async () => (await settled(() => pg.groupJoin(page.key, GA), 'rejoin')).state === 'member', { name: 'admitted', timeoutMs: 60000, intervalMs: 500 })
  t.pass('admitted by the admin')
  await rejects(t, Promise.resolve().then(() => pg.refuse()), 'sem-permissao', 'the page never acts as an admin')

  // Leave: the writer is no longer counted.
  t.is((await pg.groupLeave(page.key, G)).state, 'left')
  t.absent(pg.writersOf(page.key).some((w) => w.group === G), 'the ACL drops the left writer')
  await until(async () => {
    await syncOnce(bootstrap, a)
    return (await member.groupInfo(a, { group: G })).members === 1
  }, { name: 'leave folded', timeoutMs: 180000, intervalMs: 500 })
  t.pass('the member counts the page out')

  // Private group: refused until the page's group box is on its ACL row.
  await rejects(t, settled(() => pg.groupJoin(page.key, GP), 'boxless join'), 'sem-caixa', 'no device-held group box: no private join')
  const boxA = boxPair()
  await pagesStore.setDm(page.key, dmRow(boxA))
  t.is((await settled(() => pg.groupJoin(page.key, GP), 'private join')).state, 'requested', 'a private group waits for the admit')
  for (const g of [GP2, GP3, GP4]) t.is((await settled(() => pg.groupJoin(page.key, g), 'other private join')).state, 'requested')
  await until(async () => {
    await syncOnce(bootstrap, a)
    try {
      await member.groupAdmit(a, { group: GP, member: page.key, on: true })
      return true
    } catch {
      return false
    }
  }, { name: 'admin admits the page in private', timeoutMs: 180000, intervalMs: 500 })
  await syncOnce(bootstrap, a)
  const privWriter = pg.writersOf(page.key).find((w) => w.group === GP).writer
  const priv = await until(async () => {
    const r = await settled(() => pg.groupRead(page.key, GP), 'private read')
    return r.role === 'member' && r.sealed >= 2 ? r : null
  }, { name: 'page folds the private group', timeoutMs: 120000, intervalMs: 500 })
  t.is(priv.private, true)
  t.alike(priv.items, [], 'the service reads no private item')
  t.absent(JSON.stringify(priv).includes('"key"'), 'and no key')
  await rejects(t, pg.groupPost(page.key, GP, { text: 'em claro' }), 'privado', 'a plain post in a private group is refused')

  // The admin's history hand-off sealed an epoch to the page writer's box;
  // the test, holding that box like the owner's device, seals a post.
  const entryA = await until(() => epochEntry(a, GP, privWriter), { name: 'epoch for the page writer', timeoutMs: 60000, intervalMs: 500 })
  const keyA = groupCrypto.openEpochKey(entryA.sealed, boxA, GP, entryA.kid)
  t.ok(keyA, 'the device-held box opens the epoch entry')
  const SENTINEL = 'sentinela-' + hex(crypto.randomBytes(8))
  await rejects(t, pg.groupSeal(page.key, GP, sealFor({ text: SENTINEL, writer: privWriter, group: GP, kid: entryA.kid, key: keyA, seq: 2 })), 'sequencia', 'a seq other than the writer length is refused')
  await rejects(t, pg.groupSeal(page.key, GP, sealFor({ text: SENTINEL, writer: hex(crypto.randomBytes(32)), group: GP, kid: entryA.kid, key: keyA, seq: 1 })), 'sequencia', 'another writer is refused')
  const sealedPost = await settled(() => pg.groupSeal(page.key, GP, sealFor({ text: SENTINEL, writer: privWriter, group: GP, kid: entryA.kid, key: keyA, seq: 1 })), 'group seal')
  t.is(sealedPost.seq, 1, 'the envelope lands at the seq the device read')
  groupCrypto.wipe(keyA)
  const back = await until(async () => {
    await syncOnce(bootstrap, a)
    const r = await member.groupRead(a, { group: GP })
    return r.items.find((p) => p.text === SENTINEL) || null
  }, { name: 'member reads the page sealed post', timeoutMs: 180000, intervalMs: 500 })
  t.is(back.diary, page.key)

  // An envelope sealed under an epoch that a removal superseded waits: the
  // removed member holds that key. A second page joins, is admitted and then
  // banned; the ban opens a new epoch E2.
  const page2 = newPage(ctx, keys, 'mercearia')
  await writer.createPage(page2.args)
  await pagesStore.create({ page: page2.key, owner: page2.owner })
  await pagesStore.setDm(page2.key, dmRow(boxPair()))
  t.is((await settled(() => pg.communityJoin(page2.key, C), 'page2 community')).state, 'member')
  await settled(() => pg.groupJoin(page2.key, GP), 'page2 private join')
  await until(async () => {
    await syncOnce(bootstrap, a)
    try {
      await member.groupAdmit(a, { group: GP, member: page2.key, on: true })
      return true
    } catch {
      return false
    }
  }, { name: 'admin admits page2', timeoutMs: 180000, intervalMs: 500 })
  const beforeBan = (await blocksOf(a, GP)).length - 1
  await until(async () => {
    await syncOnce(bootstrap, a)
    try {
      await member.groupBan(a, { group: GP, member: page2.key, on: true })
      return true
    } catch {
      return false
    }
  }, { name: 'admin bans page2', timeoutMs: 180000, intervalMs: 500 })
  const entryE2 = await until(async () => {
    const e = await epochEntry(a, GP, privWriter, beforeBan)
    return e !== null && e.kid.seq !== entryA.kid.seq ? e : null
  }, { name: 'the ban opens E2', timeoutMs: 60000, intervalMs: 500 })
  await until(async () => {
    await syncOnce(bootstrap, a)
    const r = await settled(() => pg.groupRead(page.key, GP), 'read E2')
    return r.epoch !== null && r.epoch.writer === entryE2.kid.writer && r.epoch.seq === entryE2.kid.seq
  }, { name: 'the service folds E2', timeoutMs: 180000, intervalMs: 500 })
  const staleKey = groupCrypto.openEpochKey(entryA.sealed, boxA, GP, entryA.kid)
  await rejects(t, pg.groupSeal(page.key, GP, sealFor({ text: SENTINEL + '-velho', writer: privWriter, group: GP, kid: entryA.kid, key: staleKey, seq: 2 })), 'aguardando-chave', 'an envelope under the superseded epoch waits')
  groupCrypto.wipe(staleKey)
  const keyE2 = groupCrypto.openEpochKey(entryE2.sealed, boxA, GP, entryE2.kid)
  t.ok(keyE2, 'the page box opens E2')
  t.is((await pg.groupSeal(page.key, GP, sealFor({ text: SENTINEL + '-novo', writer: privWriter, group: GP, kid: entryE2.kid, key: keyE2, seq: 2 }))).seq, 2, 'an envelope under E2 is accepted')
  groupCrypto.wipe(keyE2)

  // SERVICE-CANNOT-OPEN: with the data dir and VARANDA_PAGE_KEYS, nothing
  // the service holds opens the epoch or the post.
  {
    const held = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
    const rows = [page.key].map((k) => held.get(k))
    t.ok(rows.every((r) => r !== null && !r.groupBoxSecretKey), 'no page-keys row holds a group box secret')
    const candidates = rows.flatMap(x25519Candidates)
    t.ok(candidates.length >= 4)
    t.absent(openWith(entryA, GP, candidates), 'no X25519 secret of page-keys.json opens the epoch entry')
    const read = JSON.stringify(await settled(() => pg.groupRead(page.key, GP), 'read after seal'))
    t.absent(read.includes(SENTINEL), 'the group read answers no text')
    t.absent(read.includes(privateMedia[0].key), 'and no media key')
    t.absent(walk(dir).some((f) => fs.readFileSync(f).includes(b4a.from(SENTINEL))), 'the sentinel is nowhere in the data dir')
    t.absent(walk(dir).some((f) => fs.readFileSync(f).includes(b4a.from(privateMedia[0].key))), 'nor the media key')
    for (const r of rows) zeroRowCopy(r)
  }
  // Control: the same helper with the writer's header box recovers the key.
  t.ok(openWith(entryA, GP, [boxA.secretKey]), 'the header box secret opens it (control)')

  // The group box rotates: every private action waits, then group-rebox
  // moves the membership to a writer boxed to the new key.
  const legacy = keys.get(page.key)
  keys.put(page.key, { ...legacy, groupBoxSecretKey: crypto.randomBytes(32) })
  const boxB = boxPair()
  await pagesStore.setDm(page.key, dmRow(boxB, { reboxPending: true }))
  await rejects(t, settled(() => pg.groupRead(page.key, GP), 'read while pending'), 'aguardando-chave', 'a read waits for the rebox')
  await rejects(t, settled(() => pg.groupSeal(page.key, GP, sealFor({ text: 'x', writer: privWriter, group: GP, kid: entryA.kid, key: crypto.randomBytes(32), seq: 2 })), 'seal while pending'), 'aguardando-chave', 'a seal waits for the rebox')
  await rejects(t, settled(() => pg.groupJoin(page.key, GP), 'join while pending'), 'aguardando-chave', 'a join waits for the rebox')
  // A failure after a leave: the step stays filed, reboxPending stays set,
  // and the next call completes the rejoin from the leave in the fold.
  await pg.close()
  let failJoinOn = true
  const flaky = {
    append: (k, records) => {
      if (failJoinOn && records[0] && records[0].type === 'group-join' && records[0].on === true) {
        failJoinOn = false
        return Promise.reject(Object.assign(new Error('falha'), { code: 'falha-injetada' }))
      }
      return writer.append(k, records)
    },
    info: (k) => writer.info(k),
    readEntries: (k) => writer.readEntries(k),
    pageKeys: () => writer.pageKeys()
  }
  pg = createPagesGroups({ dir, writer: flaky, pagesStore, keys, association, seederWs, log: (e) => logs.push(e) })
  await pg.ready()
  await until(() => pg.connected(), { name: 'link up (flaky)', timeoutMs: 20000 })
  t.is(await pg.reboxNeeded(page.key), 4, 'four private memberships wait for the rebox')
  await rejects(t, settled(() => pg.groupRebox(page.key), 'failing rebox'), 'incerto', 'a rejoin that fails after the leave is uncertain')
  t.is(pagesStore.get(page.key).dm.reboxPending, true, 'reboxPending stays set')
  t.ok(fs.existsSync(path.join(dir, 'pages-groups', page.key, 'rebox.json')), 'the step is filed')
  t.absent(keys.get(page.key).groupBoxSecretKey, 'a start deletes the legacy group box secret')
  const reboxed = await settled(() => pg.groupRebox(page.key), 'rebox')
  t.is(reboxed.groups.length, 1, 'the next call completes the group whose rejoin failed')
  t.alike(reboxed.left, [])
  t.alike(JSON.parse(fs.readFileSync(path.join(dir, 'pages-groups', page.key, 'rebox.json'), 'utf8')).steps, {}, 'no step is left')
  t.is(await pg.reboxNeeded(page.key), 0, 'no membership is boxed to another key')
  for (const g of [GP, GP2, GP3, GP4]) t.ok(pg.writersOf(page.key).some((w) => w.group === g), 'every private group has a writer again')
  t.absent(keys.get(page.key).groupBoxSecretKey, 'the legacy group box secret is deleted')
  t.is(pagesStore.get(page.key).dm.reboxPending, false, 'reboxPending clears')
  const newWriter = pg.writersOf(page.key).find((w) => w.group === GP).writer
  t.not(newWriter, privWriter, 'a new writer')
  const oldLog = (await until(async () => {
    await syncOnce(bootstrap, a)
    const b = await blocksOf(a, privWriter)
    return b.some((e) => e.record && e.record.type === 'group-leave') ? b : null
  }, { name: 'old writer leave replicates', timeoutMs: 180000, intervalMs: 500 }))
  t.ok(oldLog.some((e) => e.record && e.record.type === 'group-leave'), 'the old writer carries a group-leave')
  const newHeader = (await until(async () => {
    await syncOnce(bootstrap, a)
    const b = await blocksOf(a, newWriter)
    return b.length > 0 ? b : null
  }, { name: 'new writer replicates', timeoutMs: 180000, intervalMs: 500 }))[0].record
  t.is(newHeader.box, hex(boxB.publicKey), 'the new header names the new box')
  t.is(newHeader.rejoin.writer, privWriter, 'and rejoins after the old writer leave')
  t.ok(oldLog.some((e) => e.seq === newHeader.rejoin.seq && e.record.type === 'group-leave'), 'naming that exact leave block')
  t.is((await settled(() => pg.groupRead(page.key, GP), 'read after rebox')).role === 'member', false, 'the page waits for a new admit')

  // Admitted again; a new epoch opens with the new box, never the old one.
  await until(async () => {
    await syncOnce(bootstrap, a)
    try {
      await member.groupAdmit(a, { group: GP, member: page.key, on: true })
      return true
    } catch {
      return false
    }
  }, { name: 'admin admits the new writer', timeoutMs: 180000, intervalMs: 500 })
  const lastSeq = (await blocksOf(a, GP)).length - 1
  // Rekeyed until the new writer is among the entitled recipients.
  const { rekeyed, entryB } = await until(async () => {
    await syncOnce(bootstrap, a)
    let r
    try {
      r = await member.groupRekey(a, { group: GP })
    } catch {
      return null
    }
    const e = await epochEntry(a, GP, newWriter, lastSeq)
    return e !== null && e.kid.writer === r.epoch.writer && e.kid.seq === r.epoch.seq ? { rekeyed: r.epoch, entryB: e } : null
  }, { name: 'admin opens a new epoch', timeoutMs: 180000, intervalMs: 1000 })
  t.alike(entryB.kid, rekeyed, 'the new epoch has an entry for the new writer')
  t.absent(openWith(entryB, GP, [boxA.secretKey]), 'the old group box secret does not open it')
  t.ok(openWith(entryB, GP, [boxB.secretKey]), 'the new one does')

  // Groups that no longer fold (here: blocked) never hold the rotation:
  // one is left while reboxPending, the other is left by the rebox.
  await pg.close()
  pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs, log: (e) => logs.push(e), blocklist: { has: (k) => k === GP2 || k === GP3 } })
  await pg.ready()
  await until(() => pg.connected(), { name: 'link up (blocked)', timeoutMs: 20000 })
  await pagesStore.setDm(page.key, dmRow(boxPair(), { reboxPending: true }))
  t.alike(await pg.groupLeave(page.key, GP2), { state: 'left' }, 'an unfoldable group is left while reboxPending')
  // A membership whose writer the fold no longer counts as live (its diary
  // join turned off by hand) but still boxed to the old key.
  const stale = pg.writersOf(page.key).find((w) => w.group === GP4).writer
  await writer.append(page.key, [groupJoinRecord({ group: GP4, writer: stale, on: false })])
  t.absent(pg.writersOf(page.key).some((w) => w.group === GP2), 'and its writer is dropped')
  const orphaned = await settled(() => pg.groupRebox(page.key), 'rebox past an unfoldable group')
  t.alike(orphaned, { groups: [GP], left: [GP3, GP4].sort() }, 'the unfoldable group and the stale membership are left and listed, the other one moved')
  t.absent(pg.writersOf(page.key).some((w) => w.group === GP4), 'the stale membership row is dropped')
  t.is(pagesStore.get(page.key).dm.reboxPending, false, 'and reboxPending clears')
  const last = lastJoins(await writer.readEntries(page.key), GP3)
  t.ok([...last.values()].every((on) => on === false), 'the diary join of the unfoldable group is off')

  // Crash points, each followed by a restart (state from the ACL rows only).
  let crash = null
  let crashGroup = GP
  const crashy = {
    append: async (k, records) => {
      const r = records[0]
      if (crash === 'fail-join-on' && r && r.type === 'group-join' && r.on === true && r.group === crashGroup) {
        crash = null
        throw Object.assign(new Error('falha'), { code: 'falha-injetada' })
      }
      if (crash === 'after-join-on' && r && r.type === 'group-join' && r.on === true && r.group === GP) {
        crash = null
        await writer.append(k, records)
        throw Object.assign(new Error('falha'), { code: 'falha-injetada' })
      }
      if (crash === 'before-join-off' && r && r.type === 'group-join' && r.on === false && r.group === GP) {
        crash = null
        throw Object.assign(new Error('falha'), { code: 'falha-injetada' })
      }
      return writer.append(k, records)
    },
    info: (k) => writer.info(k),
    readEntries: (k) => writer.readEntries(k)
  }
  async function restartPg (w) {
    await pg.close()
    pg = createPagesGroups({ dir, writer: w, pagesStore, keys, association, seederWs, log: (e) => logs.push(e) })
    await pg.ready()
    await until(() => pg.connected(), { name: 'link up (restart)', timeoutMs: 20000 })
  }
  const gpWriter = () => {
    const row = pg.writersOf(page.key).find((w) => w.group === GP)
    return row ? row.writer : null
  }

  // 1. The new writer's diary join landed, the ACL row did not.
  await restartPg(crashy)
  await pagesStore.setDm(page.key, dmRow(boxPair(), { reboxPending: true }))
  crash = 'after-join-on'
  await rejects(t, settled(() => pg.groupRebox(page.key), 'crash after join on'), 'incerto', 'a crash after the join on is uncertain')
  await restartPg(writer)
  t.is(gpWriter(), null, 'after the crash the ACL lists no writer in GP')
  t.alike(await settled(() => pg.groupRebox(page.key), 'recover row'), { groups: [GP], left: [] }, 'recovery finds the bound replacement')
  const bound = gpWriter()
  t.ok(bound, 'and persists its row again')
  t.alike(lastJoins(await writer.readEntries(page.key), GP).get(bound), true, 'the replacement join is on')
  t.is(pagesStore.get(page.key).dm.reboxPending, false)

  // 2. The leave landed, its diary join off did not.
  await restartPg(crashy)
  await pagesStore.setDm(page.key, dmRow(boxPair(), { reboxPending: true }))
  crash = 'before-join-off'
  await rejects(t, settled(() => pg.groupRebox(page.key), 'crash before join off'), 'incerto', 'a crash before the join off is uncertain')
  await restartPg(writer)
  t.alike(lastJoins(await writer.readEntries(page.key), GP).get(bound), true, 'after the crash the old join is still on')
  t.alike(await settled(() => pg.groupRebox(page.key), 'recover leave'), { groups: [GP], left: [] }, 'recovery completes the rotation')
  t.alike(lastJoins(await writer.readEntries(page.key), GP).get(bound), false, 'the old writer join is turned off first')
  t.ok(gpWriter() && gpWriter() !== bound, 'the ACL lists the replacement, not the retired writer')
  t.absent(Object.keys(keys.get(page.key).writers).includes(bound) && pg.writersOf(page.key).some((w) => w.writer === bound), 'the retired writer is not listed')

  // A partial fold (no seeder listing): the rebox still leaves the old
  // writer and files the step; the new writer waits for a complete fold.
  await pg.close()
  pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs: null, fetchTimeoutMs: 500, log: (e) => logs.push(e) })
  await pg.ready()
  const beforePartial = gpWriter()
  await pagesStore.setDm(page.key, dmRow(boxPair(), { reboxPending: true }))
  await rejects(t, pg.groupRebox(page.key), 'incerto', 'a rebox on a partial fold is not complete')
  t.alike(lastJoins(await writer.readEntries(page.key), GP).get(beforePartial), false, 'but the old writer already left')
  t.alike(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'pages-groups', page.key, 'rebox.json'), 'utf8')).steps), [GP], 'and the step is filed')
  t.is(pagesStore.get(page.key).dm.reboxPending, true)
  await restartPg(writer)
  t.alike(await settled(() => pg.groupRebox(page.key), 'rebox after partial'), { groups: [GP], left: [] }, 'a complete fold binds the new writer')
  t.ok(gpWriter() && gpWriter() !== beforePartial)

  // A writer cap that leaves no room for a new writer: the page leaves the
  // group and lists it, never keeping the old box.
  await pg.close()
  pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs, log: (e) => logs.push(e), maxWritersPerGroup: 6 })
  await pg.ready()
  await until(() => pg.connected(), { name: 'link up again', timeoutMs: 20000 })
  const boxC = boxPair()
  await pagesStore.setDm(page.key, dmRow(boxC, { reboxPending: true }))
  // A status read that opens the page state first, beside the rebox: the
  // rebox still sees every membership.
  const [needed, capped] = await Promise.all([pg.reboxNeeded(page.key), settled(() => pg.groupRebox(page.key), 'capped rebox')])
  t.ok(Number.isSafeInteger(needed), 'the concurrent read answers a count')
  t.alike(capped, { groups: [], left: [GP] }, 'the capped group is left and listed')
  t.absent(pg.writersOf(page.key).some((w) => w.group === GP), 'no writer is kept in it')
  t.is(pagesStore.get(page.key).dm.reboxPending, false)

  // A leave is never held: with reboxPending set and a partial fold, the
  // page still leaves a private group.
  await restartPg(writer)
  t.is((await settled(() => pg.groupJoin(page.key, GP), 'rejoin GP')).state, 'requested')
  const rejoined = gpWriter()
  await pagesStore.setDm(page.key, dmRow(boxPair(), { reboxPending: true }))
  await pg.close()
  pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs: null, fetchTimeoutMs: 500, log: (e) => logs.push(e) })
  await pg.ready()
  t.alike(await pg.groupLeave(page.key, GP), { state: 'left' }, 'the leave runs while reboxPending, on a partial fold')
  t.alike(lastJoins(await writer.readEntries(page.key), GP).get(rejoined), false, 'and turns the join off')
  await restartPg(writer)

  // A rebox that failed after the leave, then the owner's own leave: the
  // filed step goes with it and no later rebox rejoins the group.
  await restartPg(crashy)
  await pagesStore.setDm(page.key, dmRow(boxPair()))
  t.is((await settled(() => pg.groupJoin(page.key, GP2), 'join GP2')).state, 'requested')
  await pagesStore.setDm(page.key, dmRow(boxPair(), { reboxPending: true }))
  crash = 'fail-join-on'
  crashGroup = GP2
  await rejects(t, settled(() => pg.groupRebox(page.key), 'rebox GP2'), 'incerto', 'the rejoin fails after the leave')
  const stepFile = path.join(dir, 'pages-groups', page.key, 'rebox.json')
  t.alike(Object.keys(JSON.parse(fs.readFileSync(stepFile, 'utf8')).steps), [GP2], 'the step is filed')
  t.alike(await settled(() => pg.groupLeave(page.key, GP2), 'owner leaves GP2'), { state: 'left' }, 'the owner leaves')
  t.alike(JSON.parse(fs.readFileSync(stepFile, 'utf8')).steps, {}, 'and the step goes with the leave')
  await restartPg(writer)
  t.alike(await settled(() => pg.groupRebox(page.key), 'rebox after leave'), { groups: [], left: [] }, 'the next rebox rejoins nothing')
  t.absent(pg.writersOf(page.key).some((w) => w.group === GP2), 'no writer in the left group')
  t.ok([...lastJoins(await writer.readEntries(page.key), GP2).values()].every((on) => on === false), 'every join in it stays off')
  t.is(pagesStore.get(page.key).dm.reboxPending, false)

  // The 17th writer of a page is 'limite' while the 16 have a live join.
  const full = newPage(ctx, keys, 'feira')
  await writer.createPage(full.args)
  await pagesStore.create({ page: full.key, owner: full.owner })
  const fullRow = keys.get(full.key)
  const writers = {}
  for (let i = 0; i < 16; i++) {
    const kpw = crypto.keyPair()
    writers[hex(kpw.publicKey)] = kpw.secretKey
  }
  keys.put(full.key, { ...fullRow, writers })
  for (const w of Object.keys(writers)) await writer.append(full.key, [groupJoinRecord({ group: hex(crypto.randomBytes(32)), writer: w, on: true })])
  await rejects(t, settled(() => pg.communityJoin(full.key, C), 'full join', 20000), 'limite', 'the 17th writer is limite')
  t.is(Object.keys(keys.get(full.key).writers).length, 16, 'live writers are never pruned')

  // No writer secret on disk outside page-keys.json, nor in a log.
  const row = keys.get(page.key)
  t.absent(row.groupBoxSecretKey, 'the page holds no group box secret')
  const secrets = [...Object.values(row.writers)]
  t.is(secrets.length >= 2, true, 'the page holds writer secrets')
  const files = walk(dir).filter((f) => path.basename(f) !== 'page-keys.json')
  for (const f of files) {
    const buf = fs.readFileSync(f)
    if (secrets.some((s) => holdsSecret(buf, s))) t.fail('secret in ' + path.relative(dir, f))
  }
  const logged = JSON.stringify(logs)
  t.absent(logged.includes(privateMedia[0].key), 'no private media key in the logs')
  t.absent(secrets.some((s) => logged.includes(hex(s))), 'no secret in the logs')
  t.absent(logged.includes(privWriter), 'no key in the logs')
})

test('pages-groups: restart, rollback, pruning, caps, partial folds and zeroed signing copies', async (t) => {
  t.timeout(600000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const association = hex(kp.publicKey)
  const issuerKp = crypto.keyPair()
  const ctx = { association, issuerKp, issuerCert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const seeder = await startSeeder(t, bootstrap, kp)
  const server = await startSeedWs({ port: 0, seeder })
  t.teardown(() => server.close(), { force: true })
  const seederWs = 'http://127.0.0.1:' + server.port

  const a = await person(t, kp, 'Bia')
  const { community: C } = await member.communityCreate(a, { name: 'Vila', join: 'open' })
  const { group: G1 } = await member.groupCreate(a, { name: 'Horta', join: 'open', community: C })
  const { group: G2 } = await member.groupCreate(a, { name: 'Feira', join: 'open', community: C })
  await syncOnce(bootstrap, a)

  // Every secret copy handed to a writer core, read back after the call.
  const copies = []
  const setKeyPair = Hypercore.prototype.setKeyPair
  Hypercore.prototype.setKeyPair = function (pair) {
    if (pair && pair.secretKey) copies.push(pair.secretKey)
    return setKeyPair.call(this, pair)
  }
  t.teardown(() => { Hypercore.prototype.setKeyPair = setKeyPair })

  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const pagesStore = openPagesStore(dir)
  const real = createPagesWriter({ dir, keys, association, seederWs })
  t.teardown(() => real.close(), { force: true })
  await real.ready()
  let failAppend = false
  const writer = {
    append: (...args) => failAppend ? Promise.reject(Object.assign(new Error('falha'), { code: 'falha-injetada' })) : real.append(...args),
    info: (k) => real.info(k),
    readEntries: (k) => real.readEntries(k)
  }
  let pg = null
  async function start (opts = {}) {
    if (pg !== null) await pg.close()
    pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs, ...opts })
    await pg.ready()
    if (opts.seederWs !== null) await until(() => pg.connected(), { name: 'link up', timeoutMs: 20000 })
  }
  t.teardown(() => pg && pg.close(), { force: true })
  await start()
  await until(() => real.connected(), { name: 'writer link up', timeoutMs: 20000 })

  const page = newPage(ctx, keys, 'quitanda')
  await real.createPage(page.args)
  await pagesStore.create({ page: page.key, owner: page.owner })
  const ownSecrets = () => {
    const row = keys.get(page.key)
    const out = Object.keys((row && row.writers) || {}).sort()
    if (row && row.writers) for (const w of out) row.writers[w].fill(0)
    return out
  }

  const joined = await settled(() => pg.communityJoin(page.key, C), 'community join')
  t.is(joined.state, 'member')
  // Geral joined with the community, when it folded in time.
  const general = joined.group === null ? [] : [joined.group]
  t.is((await settled(() => pg.groupJoin(page.key, G1), 'join G1')).state, 'member')
  t.is((await settled(() => pg.groupJoin(page.key, G2), 'join G2')).state, 'member')
  t.ok(copies.length >= 3, 'the writers signed with a copy of their secret')
  t.ok(copies.every((c) => c.every((b) => b === 0)), 'every signing copy is zeroed after the append')

  // A restart, then a community leave: every group of C is left too.
  await start()
  t.is((await settled(() => pg.communityLeave(page.key, C), 'community leave')).state, 'left')
  const entries = await real.readEntries(page.key)
  for (const g of [C, G1, G2, ...general]) {
    const last = lastJoins(entries, g)
    t.ok(last.size > 0 && [...last.values()].every((on) => on === false), 'the page diary turned every join off')
  }
  t.alike(pg.writersOf(page.key), [], 'the ACL holds no writer row')

  // A failed join leaves no secret behind; the left writers were pruned.
  const before = ownSecrets()
  t.is(before.length, 3 + general.length, 'the left writers still hold their secrets')
  failAppend = true
  await rejects(t, settled(() => pg.communityJoin(page.key, C), 'failed join'), 'falha-injetada', 'the diary join fails')
  failAppend = false
  const after = ownSecrets()
  t.absent(after.some((w) => !before.includes(w)), 'the failed writer secret is gone')
  t.is(after.length, 0, 'left writers are pruned before a new one is minted')
  const rejoined = await settled(() => pg.communityJoin(page.key, C), 'rejoin')
  t.is(rejoined.state, 'member', 'the page rejoins')
  const live = ownSecrets().length
  t.is(live, rejoined.group === null ? 1 : 2, 'only live writer secrets')

  // Caps before a mint: groups with a live join, writers bound per group.
  await start({ maxGroups: 1 })
  await rejects(t, settled(() => pg.groupJoin(page.key, G1), 'groups cap'), 'limite', 'past the groups cap')
  await start({ maxWritersPerGroup: 1 })
  await rejects(t, settled(() => pg.groupJoin(page.key, G2), 'writers cap'), 'limite', 'past the writers per group cap')
  t.is(ownSecrets().length, live, 'no writer was minted past a cap')

  // No listing from the seeder: the fold is partial, the join refused.
  await start({ seederWs: null, fetchTimeoutMs: 500 })
  await rejects(t, pg.groupJoin(page.key, G1), 'indisponivel', 'a partial fold is never acted on')
  t.is(ownSecrets().length, live, 'and nothing was minted')

  // An unreadable revocation list: no certificate is judged without it.
  await start({ revokedIssuers: () => { throw new Error('moderation unreadable') } })
  await rejects(t, pg.groupJoin(page.key, G1), 'indisponivel', 'an unreadable revocation list refuses, never folds')
  t.is(ownSecrets().length, live, 'and nothing was minted either')

  await start()
  const all = await settled(() => pg.leaveAll(page.key), 'leave all')
  t.alike(all, { left: 1, failures: 0, communities: [C] }, 'leaveAll names the communities it left')
})
