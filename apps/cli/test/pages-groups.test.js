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
const { sealMedia } = require('@varanda/core/lib/group-media')
const { groupJoinRecord } = require('@varanda/core/lib/records')
const { person, startSeeder, syncOnce } = require('../../../packages/core/test/helpers/sync-groups')
const { startSeedWs } = require('../lib/seed-ws')
const { openPageKeys } = require('../lib/account/page-keys')
const { createPagesWriter } = require('../lib/account/pages-writer')
const { openPagesStore } = require('../lib/account/pages-store')
const { createPagesGroups } = require('../lib/account/pages-groups')

const PAGE_KEYS = 'cd'.repeat(32)

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
  const first = await pg.groupRead(page.key, group, { limit: 2 })
  t.alike(first.items.map((p) => p.seq), [hidden.seq, visible.seq])
  t.is(first.items[0].media, null, 'hidden media is omitted')
  t.is(first.items[0].text, '')
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
  await member.groupPost(a, { group: GP, text: 'segredo antes' })
  const photo = { core: hex(crypto.randomBytes(32)), mime: 'image/png', start: 1, blocks: 1, bytes: 1, sha256: hex(crypto.randomBytes(32)), width: 1, height: 1 }
  const publicMedia = [photo, { ...photo, start: 2, mime: 'image/gif' }]
  const privateMedia = [{ core: photo.core, start: 1, ...sealMedia(b4a.from('fixture'), { plainMime: 'image/gif', w: 1, h: 1 }).item }]
  const publicPost = await mediaPost(a, G, publicMedia)
  const privatePost = await mediaPost(a, GP, privateMedia, true)
  await syncOnce(bootstrap, a)

  const dir = tmpDir(t, 'varanda-account-')
  const keys = openPageKeys({ dir, env: { VARANDA_PAGE_KEYS: PAGE_KEYS } })
  const pagesStore = openPagesStore(dir)
  const logs = []
  const writer = createPagesWriter({ dir, keys, association, seederWs, log: (e) => logs.push(e) })
  t.teardown(() => writer.close(), { force: true })
  await writer.ready()
  const pg = createPagesGroups({ dir, writer, pagesStore, keys, association, seederWs, log: (e) => logs.push(e) })
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

  // Private group.
  t.is((await settled(() => pg.groupJoin(page.key, GP), 'private join')).state, 'requested', 'a private group waits for the admit')
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
  const priv = await until(async () => {
    const r = await pg.groupRead(page.key, GP)
    return r.items.some((p) => p.writer === GP && p.seq === privatePost.seq) ? r : null
  }, { name: 'page reads the sealed post', timeoutMs: 120000, intervalMs: 500 })
  t.is(priv.role, 'member')
  t.alike(priv.items.find((p) => p.writer === GP && p.seq === privatePost.seq).media, privateMedia, 'a member page receives opened private items')
  t.is(priv.items.find((p) => p.text === 'segredo antes').media, null)
  await settled(() => pg.groupPost(page.key, GP, { text: 'da padaria, em segredo' }), 'private post')
  const back = await until(async () => {
    await syncOnce(bootstrap, a)
    const r = await member.groupRead(a, { group: GP })
    return r.items.find((p) => p.text === 'da padaria, em segredo') || null
  }, { name: 'member reads the page sealed post', timeoutMs: 180000, intervalMs: 500 })
  t.is(back.diary, page.key)

  // The page's private writer: boxed to the page box, never the member's,
  // and its post stored sealed.
  const row = keys.get(page.key)
  const privWriter = pg.writersOf(page.key).find((w) => w.group === GP).writer
  const raw = fs.readdirSync(path.join(dir, 'pages-groups', page.key))
  t.ok(raw.includes('writer-' + privWriter))
  const memberBox = coreStore.ensureBoxKeyPair(a.dataDir)
  const pageBox = pg.groupBoxPublic(page.key)
  t.not(pageBox, hex(memberBox.publicKey), 'the page has its own box')
  const sealedFiles = walk(path.join(dir, 'pages-groups', page.key)).map((f) => fs.readFileSync(f))
  t.absent(sealedFiles.some((b) => b.includes(b4a.from('da padaria, em segredo'))), 'the page post is stored sealed')
  t.ok(sealedFiles.some((b) => b.includes(b4a.from(pageBox))), 'the writer header names the page box')
  t.absent(sealedFiles.some((b) => b.includes(b4a.from(hex(memberBox.publicKey)))), 'and never the member box')

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

  // No writer or box secret on disk outside page-keys.json, nor in a log.
  const secrets = [...Object.values(row.writers), row.groupBoxSecretKey]
  t.is(secrets.length >= 4, true, 'the page holds writer secrets and a group box')
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
