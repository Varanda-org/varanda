'use strict'

// A Página's private groups on a core node (docs/rpc.md 5.114): an admin
// node holding the page's group box folds the group as the page and seals
// for the page's writer; the session routes group.read and group.seal with
// `page` only with the `dm` factory. Port of the web-member page-groups
// cases. P stands in for the page: its device box is the page's group box.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const member = require('../lib/member')
const groups = require('../lib/group')
const store = require('../lib/store')
const { newSession, connect, failure, testnet, until } = require('./helpers/net')
const { person, createGroup, joinGroup, exchange, sync, rawAppend, ownWriter, texts } = require('./helpers/private-member')
const { startSeeder, syncOnce } = require('./helpers/sync-groups')
const syncLib = require('../lib/sync')
const { storedPageRoots } = syncLib

// The `pages` each session run is handed. Set before the session module
// loads (helpers/net requires it on the first newSession), which binds
// runSync then.
const runPages = []
const realRunSync = syncLib.runSync
syncLib.runSync = (opts) => {
  runPages.push(opts.pages)
  return realRunSync(opts)
}

const BOOTSTRAP = ['127.0.0.1:49737']
const REKEY_PENDING = 'aguardando nova chave'
const NO_PAGE_KEY = { code: 'USAGE', message: 'sem chave da página' }
const MEDIA_NO = { code: 'USAGE', message: 'mídia disponível só na versão web' }

function boxOf (ctx) {
  const pair = store.ensureBoxKeyPair(ctx.dataDir)
  return { publicKey: b4a.from(pair.publicKey), secretKey: b4a.from(pair.secretKey) }
}

// A: a private group with a post; P (the page) joins with a writer boxed to
// its box and A admits it; B: an admin node holding copies of it all.
async function world (t) {
  const kp = crypto.keyPair()
  const a = await person(t, kp, 'Ana')
  const p = await person(t, kp, 'Padaria')
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Conselho', join: 'open', visibility: 'private' })
  await member.groupPost(a, { group, text: 'só para o conselho' })
  await exchange(a, p)
  await joinGroup(p, { group })
  await exchange(p, a)
  await member.groupAdmit(a, { group, member: p.key, on: true })
  await member.groupPost(a, { group, text: 'bem-vinda, padaria' })
  await sync(a, p, b)
  return { kp, a, p, b, group, pw: ownWriter(p, group) }
}

test('core: an admin node reads the private group as the page and seals for its writer', async (t) => {
  const { a, p, b, group, pw } = await world(t)
  const r = await member.pageGroupRead(b, { group, page: p.key, box: boxOf(p) })
  t.alike(r.items.map((x) => [x.diary, x.text]), [[a.key, 'bem-vinda, padaria'], [a.key, 'só para o conselho']])
  t.is(r.state, 'ok')
  t.is(r.role, 'member', 'the page\'s role')
  t.is(r.visibility, 'private')
  t.ok(r.epoch !== null)

  const box = boxOf(p)
  const s = await member.pageGroupSeal(b, { group, page: p.key, box, text: 'pão quente às 7h', replyTo: { writer: r.items[0].writer, seq: r.items[0].seq } })
  t.ok(box.secretKey.every((x) => x === 0), 'the box copy is wiped after use')
  t.is(s.writer, pw, 'the page\'s live writer under its box')
  t.alike(s.kid, r.epoch)
  t.ok(typeof s.at === 'string')
  t.ok(Number.isInteger(s.seq) && s.seq > 0)
  t.alike(store.readGroups(b.dataDir).filter((g) => g.group === group), [], 'nothing written on the admin node')

  // Appended as the service would ('group-seal'): the members' fold (the
  // shared fold the browser node runs too) and the page fold both open it.
  await rawAppend(p, group, groups.groupSealed({ kid: s.kid, nonce: s.nonce, box: s.box, at: s.at }))
  await sync(p, a, b)
  t.ok(texts(await member.groupRead(a, { group })).includes('pão quente às 7h'), 'opens for the creator')
  const again = await member.pageGroupRead(b, { group, page: p.key, box: boxOf(p) })
  t.is(again.items[0].text, 'pão quente às 7h', 'opens in the page fold')
  t.is(again.items[0].diary, p.key)
})

test('core: a post sealed by another member opens in the page fold', async (t) => {
  const { a, p, b, group } = await world(t)
  await member.groupPost(a, { group, text: 'de outro membro' })
  await exchange(a, b)
  const r = await member.pageGroupRead(b, { group, page: p.key, box: boxOf(p) })
  t.is(r.items[0].text, 'de outro membro')
})

test('core: another box folds nothing as the page', async (t) => {
  const { p, b, group } = await world(t)
  const wrong = boxOf(b)
  const r = await member.pageGroupRead(b, { group, page: p.key, box: wrong })
  t.alike(r.items, [], 'nothing opens')
  t.is(r.state, 'ok')
  const sealBox = boxOf(b)
  const err = await member.pageGroupSeal(b, { group, page: p.key, box: sealBox, text: 'oi' }).catch((e) => e)
  t.is(err.message, 'sem permissão no grupo', 'no writer of the page under that box')
  t.ok(sealBox.secretKey.every((x) => x === 0), 'the box copy is wiped when the seal throws')
})

test('core: a root not held here is NOT_FOUND', async (t) => {
  const { p, b } = await world(t)
  const err = await member.pageGroupRead(b, { group: 'cd'.repeat(32), page: p.key, box: boxOf(p) }).catch((e) => e)
  t.is(err.code, 'NOT_FOUND')
})

test('core: after a rebox the seal waits for a new epoch, which the old box cannot open', async (t) => {
  const { a, p, b, group, pw } = await world(t)
  const oldBox = boxOf(p)
  // The rebox: the old writer leaves, a writer boxed to a new box joins.
  await member.groupLeave(p, { group })
  fs.rmSync(path.join(p.dataDir, 'group-box.json'))
  await exchange(p, a)
  await joinGroup(p, { group })
  const nw = ownWriter(p, group)
  t.not(nw, pw)
  await exchange(p, a)
  // Admitted again: the admit hands the history only, no epoch covers the
  // old writer's leave yet.
  await member.groupAdmit(a, { group, member: p.key, on: true })
  await sync(a, p, b)
  const before = await member.pageGroupRead(b, { group, page: p.key, box: boxOf(p) })
  t.is(before.role, 'member')
  t.is(before.state, 'rekey-pending', 'no eligible epoch covers the new writer')
  const err = await member.pageGroupSeal(b, { group, page: p.key, box: boxOf(p), text: 'oi' }).catch((e) => e)
  t.is(err.message, REKEY_PENDING)

  // The distributor opens a new epoch for the entitled writers.
  await member.groupRekey(a, { group })
  await sync(a, p, b)
  const after = await member.pageGroupRead(b, { group, page: p.key, box: boxOf(p) })
  t.is(after.state, 'ok')
  const s = await member.pageGroupSeal(b, { group, page: p.key, box: boxOf(p), text: 'de volta' })
  t.is(s.writer, nw)
  t.alike(s.kid, after.epoch)

  // The old box: its writer left, and it seals nothing.
  const oldErr = await member.pageGroupSeal(b, { group, page: p.key, box: oldBox, text: 'oi' }).catch((e) => e)
  t.ok(oldErr instanceof Error, 'the old box seals nothing')
})

// `held.pages`: what heldPages() answers; `held.ops`: the session's ops;
// `copies`: every box copy handed out.
function fakeDm (box, calls, held = { pages: [] }, copies = []) {
  return ({ ops }) => {
    held.ops = ops
    return {
      handlers: {},
      readMedia: async () => { throw new Error('no') },
      withPageGroupBox: async (page, fn) => {
        calls.push(page)
        return fn(() => {
          if (box === null) return null
          const copy = { publicKey: b4a.from(box.publicKey), secretKey: b4a.from(box.secretKey) }
          copies.push(copy)
          return copy
        })
      },
      heldPages: () => held.pages.slice(),
      close: async () => {}
    }
  }
}

test('core session: with the factory group.read and group.seal fold as the page', async (t) => {
  const { a, p, b, group, pw } = await world(t)
  const calls = []
  const copies = []
  const session = newSession(t, { dataDir: b.dataDir, association: b.association, bootstrap: BOOTSTRAP, dm: fakeDm(boxOf(p), calls, { pages: [] }, copies) })
  const link = await connect(t, session)
  const r = await link.call('group.read', { group, page: p.key })
  t.alike(r.items.map((x) => x.text), ['bem-vinda, padaria', 'só para o conselho'])
  t.is(r.state, 'ok')
  t.is(r.role, 'member')
  t.is(r.visibility, 'private')
  const s = await link.call('group.seal', { group, page: p.key, text: 'oi' })
  t.is(s.writer, pw)
  t.alike(await failure(link.call('group.seal', { group: 'cd'.repeat(32), page: p.key, text: 'oi' })), { code: 'NOT_FOUND', message: 'grupo não encontrado' })
  t.is(copies.length, 3, 'one copy per fold')
  t.ok(copies.every((c) => c.secretKey.every((x) => x === 0)), 'every copy is wiped, the throwing seal\'s too')
  t.alike(await failure(link.call('group.read', { group, page: p.key, marks: true })), { code: 'USAGE', message: 'leitura sob demanda só na versão web' })
  t.is(r.items[0].diary, a.key)
  t.alike(session.internal, [])
})

test('core session: without the page secrets, no-key read and sem chave da página', async (t) => {
  const { p, b, group } = await world(t)
  const calls = []
  const session = newSession(t, { dataDir: b.dataDir, association: b.association, bootstrap: BOOTSTRAP, dm: fakeDm(null, calls) })
  const link = await connect(t, session)
  const r = await link.call('group.read', { group, page: p.key })
  t.alike(r, { items: [], next: null, hidden: 0, incomplete: false, sealed: 0, epoch: null, state: 'no-key', role: null, visibility: 'private' })
  t.alike(await failure(link.call('group.seal', { group, page: p.key, text: 'oi' })), NO_PAGE_KEY)
  t.alike(session.internal, [])
})

test('core session: media on group.seal is refused before any key use', async (t) => {
  const { p, b, group } = await world(t)
  const calls = []
  const session = newSession(t, { dataDir: b.dataDir, association: b.association, bootstrap: BOOTSTRAP, dm: fakeDm(boxOf(p), calls) })
  const media = [{ core: 'ab'.repeat(32), mime: 'image/png' }]
  const err = await session.handlers['group.seal']({ group, page: p.key, text: 'oi', media }).catch((e) => e)
  t.alike({ code: err.code, message: err.message }, MEDIA_NO)
  const card = await session.handlers['group.seal']({ group, page: p.key, text: 'oi', card: { url: 'https://x' } }).catch((e) => e)
  t.alike({ code: card.code, message: card.message }, MEDIA_NO)
  t.alike(calls, [], 'the page box was never asked for')
  const link = await connect(t, session)
  t.is((await failure(link.call('group.seal', { group, page: p.key, text: 'oi', media }))).code, 'USAGE', 'the dispatcher refuses the param too')
  t.alike(calls, [])
})

test('core: the roots a stored page diary binds, for the sync run', async (t) => {
  const { p, b, group } = await world(t)
  t.ok((await member.pageGroupRoots(b, [p.key])).includes(group), 'the roots the page diary binds (its community too)')
  t.alike(await member.pageGroupRoots(b, ['ef'.repeat(32)]), [], 'a page not stored adds nothing')
  const st = await store.openStore(b.dataDir)
  try {
    const opts = (blocked) => ({ association: b.association, blocked })
    t.ok((await storedPageRoots(st, [p.key], opts(new Set()))).includes(group), 'stored and not blocked: its roots')
    t.alike(await storedPageRoots(st, [p.key], opts(new Set([p.key]))), [], 'a blocked page diary adds nothing')
  } finally {
    await st.close()
  }
})

test('core session: a continuous run restarts when the held pages change, with the new list', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const { p, b } = await world(t)
  const held = { pages: [] }
  const session = newSession(t, { dataDir: b.dataDir, association: b.association, bootstrap, dm: fakeDm(null, [], held) })
  const link = await connect(t, session)
  const started = () => link.events.filter((e) => e.event === 'sync.started').length
  const from = runPages.length
  await link.call('sync.start')
  await until(() => started() === 1, { name: 'first run' })
  held.ops.pagesChanged()
  // Same list: no restart.
  await new Promise((resolve) => setTimeout(resolve, 300))
  t.is(started(), 1, 'an unchanged list keeps the run')
  held.pages = [p.key]
  held.ops.pagesChanged()
  await until(() => started() === 2, { name: 'restart' })
  t.alike(runPages.slice(from), [[], [p.key]], 'the restarted run is handed the new list')
  await link.call('sync.stop')
})

test('core sync: a delegate outside the community pages a held page\'s roots by their headers and folds its group', async (t) => {
  t.timeout(170000)
  const kp = crypto.keyPair()
  const { bootstrap } = await testnet(t)
  await startSeeder(t, bootstrap, kp)
  const a = await person(t, kp, 'Ana')
  const p = await person(t, kp, 'Padaria')
  const b = await person(t, kp, 'Bia')
  const { group } = await createGroup(a, { name: 'Conselho', join: 'open', visibility: 'private' })
  const community = store.readGroups(a.dataDir).find((g) => g.kind === 'community').group
  await member.groupPost(a, { group, text: 'só para o conselho' })
  await exchange(a, p)
  await joinGroup(p, { group })
  await exchange(p, a)
  await member.groupAdmit(a, { group, member: p.key, on: true })
  await member.groupPost(a, { group, text: 'bem-vinda, padaria' })
  t.ok((await syncOnce(bootstrap, a)).result.ok, 'A reaches the seeder')
  t.ok((await syncOnce(bootstrap, p)).result.ok, 'P reaches the seeder')
  // B holds the page diary alone: no community, no root, no writer.
  await copyCores(p, b, [p.key])
  t.alike(store.readGroups(b.dataDir), [], 'B is in no community and no group')
  const roots = await member.pageGroupRoots(b, [p.key])
  t.ok(roots.includes(community) && roots.includes(group), 'the page diary binds the community and the group')
  const { result, events } = await syncOnce(bootstrap, b, { pages: [p.key] })
  t.ok(result.ok, result.errors.join('; '))
  t.absent(events.some((ev) => ev.event === 'group-skipped' && ev.key === community), 'the community root is never refused')
  const r = await member.pageGroupRead(b, { group, page: p.key, box: boxOf(p) })
  t.is(r.state, 'ok', 'no key wait: the community folded as the parent')
  t.alike(r.items.map((x) => x.text), ['bem-vinda, padaria', 'só para o conselho'])
  const s = await member.pageGroupSeal(b, { group, page: p.key, box: boxOf(p), text: 'pão quente às 7h' })
  t.is(s.writer, ownWriter(p, group), 'seals for the page\'s writer')
})

// Copies cores `keys` of `from` into `to` in process.
async function copyCores (from, to, keys) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  const left = a.replicate(true)
  const right = b.replicate(false)
  left.pipe(right).pipe(left)
  try {
    for (const key of keys) {
      const source = a.get({ key: b4a.from(key, 'hex'), writable: false })
      await source.ready()
      const target = b.get({ key: b4a.from(key, 'hex'), writable: false })
      await target.ready()
      for (let seq = 0; seq < source.length; seq++) await target.get(seq, { raw: true, timeout: 10000 })
    }
  } finally {
    left.destroy()
    right.destroy()
    await b.close()
    await a.close()
  }
}
