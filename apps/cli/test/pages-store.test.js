'use strict'

// apps/cli/lib/account/pages-store.js: the page ACL sidecar (pages.json,
// replaced whole on every write). No network; the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  openPagesStore, FILE, MAX_PAGES_PER_OWNER, MAX_PAGE_ADMINS, MAX_PAGES, MAX_PAGE_WRITERS,
  MAX_FOLLOWS, NONCE_TTL_MS, INVITE_TTL_MS, MAX_PAGE_MOVES
} = require('../lib/account/pages-store')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { signActorBox } = require('@varanda/core/lib/page-secrets')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-11-03T12:00:00.000Z')
const DAY = 24 * 3600 * 1000

function key () {
  return b4a.toString(crypto.keyPair().publicKey, 'hex')
}

function sig () {
  return b4a.toString(crypto.randomBytes(64), 'hex')
}

function nonce () {
  return b4a.toString(crypto.randomBytes(32), 'base64url')
}

function iso (ms) {
  return new Date(ms).toISOString()
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = { t: T0 }
  const open = (more = {}) => openPagesStore(dir, { now: () => c.t, ...opts, ...more })
  return { dir, file: path.join(dir, FILE), c, open, store: open() }
}

async function rejects (t, p, code, msg) {
  try {
    await p
    t.fail(msg + ': resolved')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

function throwsCode (t, fn, code, msg) {
  try {
    fn()
    t.fail(msg + ': returned')
  } catch (err) {
    t.is(err.code, code, msg)
  }
}

// Invite, accept and commit one admin; returns the committed row.
async function addAdmin (store, page, member, seq) {
  const row = store.get(page)
  await store.invite(page, member, { gen: row.gen + 1, rosterSignature: sig() })
  const next = store.accept(page, member)
  return store.setRoster(page, { gen: next.gen, seq, owner: next.owner, admins: next.admins })
}

test('pages-store: create, get, caps and a page key refused as owner', async (t) => {
  const { store, dir } = setup(t)
  t.absent(fs.existsSync(path.join(dir, FILE)), 'opening writes nothing')
  const owner = key()
  const page = key()
  const row = await store.create({ page, owner })
  t.is(row.owner, owner)
  t.alike(row.admins, [])
  t.is(row.gen, 1)
  t.is(row.rosterSeq, 2)
  t.is(row.length, 3)
  t.is(row.paused, false)
  t.is(row.closed, null)
  t.alike(row.media, { items: 0 })
  t.alike(store.get(page), row)
  t.ok(store.isPage(page))
  t.absent(store.isPage(owner))
  t.is(store.get(key()), null)
  await rejects(t, store.create({ page, owner }), 'pedido-invalido', 'a page is created once')
  await rejects(t, store.create({ page: key(), owner: page }), 'pedido-invalido', 'a page key cannot own a page')
  const mine = key()
  for (let i = 0; i < MAX_PAGES_PER_OWNER; i++) await store.create({ page: key(), owner: mine })
  await rejects(t, store.create({ page: key(), owner: mine }), 'limite', 'the 9th page of one owner')
  t.is(MAX_PAGES, 256)
  await t.exception.all(store.create({ page: 'x', owner }), /page/)
})

test('pages-store: MAX_PAGES counts live pages only', async (t) => {
  const { store } = setup(t)
  const pages = []
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = key()
    pages.push(page)
    await store.create({ page, owner: key() })
  }
  await rejects(t, store.create({ page: key(), owner: key() }), 'limite', 'page 257')
  await store.close(pages[0])
  await store.create({ page: key(), owner: key() })
  t.is(store.stats().pages, MAX_PAGES)
  t.is(store.stats().closed, 1)
})

test('pages-store: invite, accept, remove and listFor', async (t) => {
  const { store, c } = setup(t)
  const owner = key()
  const page = key()
  const a = key()
  await store.create({ page, owner })
  t.is(store.role(page, owner), 'owner')
  t.is(store.authorize(page, owner, 'owner'), 'owner')
  throwsCode(t, () => store.authorize(page, a), 'sem-permissao', 'a stranger is not an admin')
  throwsCode(t, () => store.accept(page, a), 'sem-permissao', 'accept without an invite')
  await rejects(t, store.invite(page, a, { gen: 3, rosterSignature: sig() }), 'expirado', 'an invite for a stale gen')
  await rejects(t, store.invite(page, owner, { gen: 2, rosterSignature: sig() }), 'pedido-invalido', 'the owner is not invited')
  const rs = sig()
  const inv = await store.invite(page, a, { gen: 2, rosterSignature: rs })
  t.is(inv.expiresAt, iso(T0 + INVITE_TTL_MS))
  const list = store.listFor(a)
  t.is(list.invites.length, 1)
  t.is(list.invites[0].page, page)
  t.is(list.invites[0].rosterSignature, rs)
  t.is(store.get(page).admins.length, 0, 'an invite never changes the ACL')
  const next = store.accept(page, a)
  t.alike(next, { page, gen: 2, owner, admins: [a], prev: 2, rosterSignature: rs })
  t.is(store.get(page).admins.length, 0, 'accept is read-only')
  const row = await store.setRoster(page, { gen: next.gen, seq: 3, owner, admins: next.admins })
  t.alike(row.admins, [a])
  t.is(row.gen, 2)
  t.is(row.rosterSeq, 3)
  t.alike(row.invites, {}, 'the accepted invite is spent')
  t.is(store.role(page, a), 'admin')
  t.is(store.listFor(a).admin.length, 1)
  t.is(store.listFor(owner).owned.length, 1)
  throwsCode(t, () => store.authorize(page, a, 'owner'), 'sem-permissao', 'an admin is not the owner')
  await rejects(t, store.setRoster(page, { gen: 2, seq: 4, owner, admins: [] }), 'expirado', 'same gen, other admins')
  const rm = store.remove(page, a)
  t.alike(rm, { page, gen: 3, owner, admins: [], prev: 3 })
  throwsCode(t, () => store.remove(page, key()), 'pedido-invalido', 'remove a non-admin')
  await store.setRoster(page, { gen: rm.gen, seq: 4, owner, admins: rm.admins })
  t.is(store.role(page, a), null)
  throwsCode(t, () => store.authorize(page, a), 'sem-permissao', 'removed admin')
  // Re-append of the newest roster only moves its seq.
  const re = await store.setRoster(page, { gen: 3, seq: 300, owner, admins: [] })
  t.is(re.gen, 3)
  t.is(re.rosterSeq, 300)
  await rejects(t, store.setRoster(page, { gen: 4, seq: 300, owner, admins: [] }), 'pedido-invalido', 'seq must grow')
  // An expired invite is 'expirado' at accept.
  const b = key()
  await store.invite(page, b, { gen: 4, rosterSignature: sig() })
  c.t += INVITE_TTL_MS
  throwsCode(t, () => store.accept(page, b), 'expirado', 'an invite after 7 days')
  t.is(store.listFor(b).invites.length, 0)
})

test('pages-store: admins plus pending invites are capped', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  let seq = 3
  for (let i = 0; i < MAX_PAGE_ADMINS - 1; i++) await addAdmin(store, page, key(), seq++)
  const row = store.get(page)
  t.is(row.admins.length, MAX_PAGE_ADMINS - 1)
  const last = key()
  await store.invite(page, last, { gen: row.gen + 1, rosterSignature: sig() })
  await rejects(t, store.invite(page, key(), { gen: row.gen + 1, rosterSignature: sig() }), 'limite', 'the 17th admin (pending)')
  const next = store.accept(page, last)
  await store.setRoster(page, { gen: next.gen, seq: seq++, owner, admins: next.admins })
  await rejects(t, store.invite(page, key(), { gen: next.gen + 1, rosterSignature: sig() }), 'limite', 'the 17th admin')
  await rejects(t, store.setRoster(page, { gen: next.gen + 1, seq, owner, admins: [...next.admins, key()] }), 'limite', 'a roster of 17 admins')
})

test('pages-store: a page key is refused as admin and transferee', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const page = key()
  const other = key()
  await store.create({ page, owner })
  await store.create({ page: other, owner: key() })
  await rejects(t, store.invite(page, other, { gen: 2, rosterSignature: sig() }), 'pedido-invalido', 'page as invitee')
  await rejects(t, store.invite(page, page, { gen: 2, rosterSignature: sig() }), 'pedido-invalido', 'page as its own admin')
  await rejects(t, store.setRoster(page, { gen: 2, seq: 3, owner, admins: [other] }), 'pedido-invalido', 'page in a roster')
  await rejects(t, store.setRoster(page, { gen: 2, seq: 3, owner: other, admins: [] }), 'pedido-invalido', 'page as roster owner')
  await rejects(t, store.offer(page, other, iso(T0 + DAY)), 'pedido-invalido', 'page as transferee')
  await rejects(t, store.offer(page, owner, iso(T0 + DAY)), 'pedido-invalido', 'offer to the owner')
})

test('pages-store: offer, cancel and transfer', async (t) => {
  const { store, c } = setup(t)
  const owner = key()
  const page = key()
  const a = key()
  const to = key()
  await store.create({ page, owner })
  await addAdmin(store, page, a, 3)
  throwsCode(t, () => store.transferAccept(page, to), 'sem-permissao', 'no offer')
  await rejects(t, store.offer(page, to, iso(T0)), 'expirado', 'an offer already expired')
  await rejects(t, store.offer(page, to, iso(T0 + 8 * DAY)), 'pedido-invalido', 'an offer beyond 7 days')
  const o = await store.offer(page, to, iso(T0 + DAY), { seq: 4 })
  t.alike(o, { to, exp: iso(T0 + DAY), gen: 2, seq: 4 })
  const offers = store.listFor(to).offers
  t.is(offers.length, 1)
  t.is(offers[0].page, page)
  throwsCode(t, () => store.transferAccept(page, key()), 'sem-permissao', 'another key accepts')
  t.ok(await store.cancel(page))
  t.is(store.get(page).offer, null)
  t.is(store.listFor(to).offers.length, 0)
  throwsCode(t, () => store.transferAccept(page, to), 'sem-permissao', 'a cancelled offer')
  await store.offer(page, to, iso(T0 + DAY))
  c.t = T0 + DAY
  throwsCode(t, () => store.transferAccept(page, to), 'expirado', 'an expired offer')
  c.t = T0
  // A full recipient is 'limite'.
  for (let i = 0; i < MAX_PAGES_PER_OWNER; i++) await store.create({ page: key(), owner: to })
  throwsCode(t, () => store.transferAccept(page, to), 'limite', 'recipient owns 8 pages')
  const t2 = key()
  await store.offer(page, t2, iso(T0 + DAY))
  const next = store.transferAccept(page, t2)
  t.alike(next, { page, gen: 3, owner: t2, admins: [a, owner].sort(), prev: 3 })
  const row = await store.setRoster(page, { gen: next.gen, seq: 5, owner: next.owner, admins: next.admins })
  t.is(row.owner, t2)
  t.ok(row.admins.includes(owner), 'the previous owner stays an admin')
  t.is(row.offer, null, 'the offer is spent')
  t.is(store.role(page, owner), 'admin')
  t.is(store.listFor(owner).owned.length, 0)
  t.is(store.listFor(t2).owned.length, 1)
  // An offer made before a later roster is stale.
  const t3 = key()
  await store.offer(page, t3, iso(T0 + DAY))
  const rm = store.remove(page, a)
  await store.setRoster(page, { gen: rm.gen, seq: 6, owner: t2, admins: rm.admins })
  throwsCode(t, () => store.transferAccept(page, t3), 'sem-permissao', 'the offer was dropped by the roster')
})

test('pages-store: a paused page refuses setRoster and writers', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  await store.pause(page)
  t.is(store.get(page).paused, true)
  await rejects(t, store.setRoster(page, { gen: 2, seq: 3, owner, admins: [key()] }), 'pausada', 'paused setRoster')
  await rejects(t, store.setWriters(page, []), 'pausada', 'paused setWriters')
  await rejects(t, store.clearWriters(page), 'pausada', 'paused clearWriters')
  await rejects(t, store.setFollows(page, 1), 'pausada', 'paused setFollows')
  await rejects(t, store.setMedia(page, 1), 'pausada', 'paused setMedia')
  t.is(store.get(page).follows, 0)
  t.is(store.get(page).media.items, 0)
  t.is(store.stats().paused, 1)
})

test('pages-store: expectLength only grows', async (t) => {
  const { store } = setup(t)
  const page = key()
  await store.create({ page, owner: key() })
  t.is((await store.expectLength(page, 5)).length, 5)
  await rejects(t, store.expectLength(page, 4), 'pedido-invalido', 'shrinking length')
  t.is((await store.expectLength(page, 5)).length, 5)
})

test('pages-store: a paused or closed page freezes its length and keeps its offer', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  const to = key()
  await store.offer(page, to, iso(T0 + DAY), { seq: 3 })
  await store.pause(page)
  await rejects(t, store.expectLength(page, 9), 'pausada', 'paused expectLength')
  await rejects(t, store.cancel(page), 'pausada', 'paused cancel')
  t.is(store.get(page).offer.to, to, 'the offer the diary still shows stays')
  const other = key()
  await store.create({ page: other, owner: key() })
  await store.close(other)
  await rejects(t, store.expectLength(other, 9), 'encerrada', 'closed expectLength')
})

test('pages-store: writers, delegates and pages never share a key', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const page = key()
  const other = key()
  await store.create({ page, owner })
  await store.create({ page: other, owner: key() })
  const w = (writer) => [{ group: key(), writer, kind: 'group', state: 'member' }]
  await rejects(t, store.setWriters(page, w(page)), 'pedido-invalido', 'the page as its writer')
  await rejects(t, store.setWriters(page, w(other)), 'pedido-invalido', 'another page as a writer')
  await rejects(t, store.setWriters(page, w(owner)), 'pedido-invalido', 'the owner as a writer')
  const writer = key()
  await store.setWriters(page, w(writer))
  await rejects(t, store.create({ page: writer, owner: key() }), 'pedido-invalido', 'a writer key as a new page')
  await rejects(t, store.setDelegate(page, { diary: key(), length: 1, termsVersion: 12 }), 'pedido-invalido', 'a page as a delegate')
  await rejects(t, store.setDelegate(key(), { diary: page, length: 1, termsVersion: 12 }), 'pedido-invalido', 'a page as a delegate diary')
})

test('pages-store: two holders at the same seq, the one whose rename lost fails closed', async (t) => {
  const { open, file } = setup(t)
  const a = open()
  await a.create({ page: key(), owner: key() })
  // Another stale holder also wrote seq 1 and its rename landed last: same
  // seq as a's memory, other content and tag.
  const other = JSON.parse(fs.readFileSync(file, 'utf8'))
  other.pages = {}
  other.tag = b4a.toString(crypto.randomBytes(16), 'hex')
  writeJsonAtomic(file, other, 0o600)
  await rejects(t, a.create({ page: key(), owner: key() }), 'indisponivel', 'the holder whose rename lost')
  t.alike(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).pages), [], 'nothing written over the other holder')
})

test('pages-store: a writer core, a delegate diary and a person never share a key', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  const writer = key()
  const group = key()
  await store.setWriters(page, [{ group, writer, kind: 'group', state: 'member' }])
  await rejects(t, store.invite(page, writer, { gen: 2, rosterSignature: sig() }), 'pedido-invalido', 'a writer key invited')
  await rejects(t, store.offer(page, group, iso(T0 + DAY), { seq: 3 }), 'pedido-invalido', 'a group key offered the page')
  await rejects(t, store.setRoster(page, { gen: 2, seq: 3, owner, admins: [writer] }), 'pedido-invalido', 'a writer key as admin')
  await rejects(t, store.setWriters(page, [{ group: owner, writer: key(), kind: 'group', state: 'member' }]), 'pedido-invalido', 'the owner as a group core')
  const actor = key()
  const diary = key()
  await store.setDelegate(actor, { diary, length: 1, termsVersion: 12 })
  await rejects(t, store.create({ page: diary, owner: key() }), 'pedido-invalido', 'a delegate diary as a new page')
  await rejects(t, store.setDelegate(key(), { diary: writer, length: 1, termsVersion: 12 }), 'pedido-invalido', 'a writer core as a delegate diary')
})

test('pages-store: an expired invite or offer no longer reserves its key', async (t) => {
  const { store, c } = setup(t)
  const page = key()
  await store.create({ page, owner: key() })
  const invitee = key()
  const target = key()
  await store.invite(page, invitee, { gen: 2, rosterSignature: sig() })
  await store.offer(page, target, iso(T0 + DAY), { seq: 3 })
  await rejects(t, store.create({ page: invitee, owner: key() }), 'pedido-invalido', 'a live invitee is a person')
  c.t += 8 * DAY
  await store.create({ page: invitee, owner: key() })
  await store.create({ page: target, owner: key() })
  t.ok(store.isPage(invitee) && store.isPage(target), 'expired rows reserve nothing')
})

test('pages-store: setWriters copies its input before the queue runs; pause refuses a closed page', async (t) => {
  const { store, open } = setup(t)
  const page = key()
  await store.create({ page, owner: key() })
  const rows = [{ group: key(), writer: key(), kind: 'group', state: 'member' }]
  const p = store.setWriters(page, rows)
  rows[0].kind = 'not-a-kind'
  await p
  t.is(store.get(page).writers[0].kind, 'group')
  t.is(open().get(page).writers[0].kind, 'group', 'the file reopens')
  await store.close(page)
  await rejects(t, store.pause(page), 'encerrada', 'pause on a closed page')
})

test('pages-store: live nonces are capped by evicting the oldest, never failing another page', async (t) => {
  const { store, c } = setup(t, { maxNonces: 3 })
  const member = key()
  const first = []
  for (let i = 0; i < 3; i++) {
    const n = nonce()
    first.push(n)
    await store.spend(member, n, i)
    c.t += 1000
  }
  t.is(await store.spend(member, nonce(), 3), 3, 'past the cap the commit still lands')
  t.is(store.stats().nonces, 3, 'still capped')
  t.is(store.spent(member, first[0]), null, 'the oldest row was evicted')
  t.is(store.spent(member, first[2]), 2, 'newer rows stay')
  // A commit that adds no nonce never meets the cap.
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  t.is(store.get(page).owner, owner, 'an unrelated page commits at a full table')
  c.t += NONCE_TTL_MS + 1
  t.is(await store.spend(member, nonce(), 4), 4, 'expired nonces are pruned first')
  t.is(store.stats().nonces, 1)
})

test('pages-store: nonce replay answers the same seq, also after close', async (t) => {
  const { store, c, open } = setup(t)
  const owner = key()
  const page = key()
  const n = nonce()
  await store.create({ page, owner, spend: { member: owner, nonce: n, seq: 2 } })
  t.is(store.spent(owner, n), 2)
  t.is(store.spent(key(), n), null, 'keyed by member too')
  const n2 = nonce()
  t.is(await store.spend(owner, n2, 7), 7)
  t.is(await store.spend(owner, n2, 9), 7, 'a replay answers the stored seq')
  const n3 = nonce()
  await store.close(page, { spend: { member: owner, nonce: n3, seq: 8 } })
  t.is(store.spent(owner, n3), 8)
  t.is(store.spent(owner, n2), 7, 'still answered after close')
  t.is(await store.spend(owner, n2, 1), 7)
  t.is(open().spent(owner, n2), 7, 'survives a reopen')
  c.t += NONCE_TTL_MS
  t.is(store.spent(owner, n2), null, 'expired after the TTL')
  await store.spend(key(), nonce(), 1)
  t.is(store.stats().nonces, 1, 'expired nonces are pruned on the next write')
})

test('pages-store: close then every write is encerrada', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const page = key()
  const a = key()
  await store.create({ page, owner })
  await store.invite(page, a, { gen: 2, rosterSignature: sig() })
  await store.offer(page, key(), iso(T0 + DAY))
  const row = await store.close(page)
  t.is(row.closed, iso(T0))
  t.alike(row.invites, {})
  t.is(row.offer, null)
  await rejects(t, store.close(page), 'encerrada', 'close twice')
  await rejects(t, store.setRoster(page, { gen: 2, seq: 3, owner, admins: [a] }), 'encerrada', 'setRoster')
  await rejects(t, store.invite(page, a, { gen: 2, rosterSignature: sig() }), 'encerrada', 'invite')
  await rejects(t, store.offer(page, key(), iso(T0 + DAY)), 'encerrada', 'offer')
  await rejects(t, store.setWriters(page, []), 'encerrada', 'setWriters')
  await rejects(t, store.setFollows(page, 1), 'encerrada', 'setFollows')
  await rejects(t, store.move(page, key()), 'encerrada', 'move')
  throwsCode(t, () => store.accept(page, a), 'encerrada', 'accept')
  throwsCode(t, () => store.transferAccept(page, key()), 'encerrada', 'transferAccept')
  const list = store.listFor(owner)
  t.is(list.owned.length, 1)
  t.is(list.owned[0].closed, true, 'a closed page is flagged')
  t.ok(store.isPage(page), 'a closed key stays a page key')
  t.is(store.listFor(a).invites.length, 0)
  await store.create({ page: key(), owner }) // a closed page does not count for the owner
})

test('pages-store: move copies the ACL, drops invites and offers, old row refuses writes', async (t) => {
  const { store, open } = setup(t)
  const owner = key()
  const k1 = key()
  const k2 = key()
  const a = key()
  await store.create({ page: k1, owner })
  await addAdmin(store, k1, a, 3)
  await store.invite(k1, key(), { gen: 3, rosterSignature: sig() })
  await store.offer(k1, key(), iso(T0 + DAY))
  for (let i = 1; i < MAX_PAGES_PER_OWNER; i++) await store.create({ page: key(), owner })
  await rejects(t, store.move(k1, k1), 'pedido-invalido', 'move onto itself')
  await rejects(t, store.move(k1, a), 'pedido-invalido', 'move onto an admin')
  const { from, to } = await store.move(k1, k2)
  t.is(from.movedTo, k2)
  t.is(from.closed, iso(T0))
  t.alike(from.invites, {})
  t.is(from.offer, null)
  t.is(to.owner, owner)
  t.alike(to.admins, [a])
  t.is(to.gen, 1)
  t.is(to.rosterSeq, 2)
  t.is(to.movedFrom, k1)
  t.alike(to.invites, {})
  t.is(to.offer, null)
  const owned = store.listFor(owner).owned
  t.is(owned.filter((p) => !p.closed).length, MAX_PAGES_PER_OWNER, 'owned count unchanged')
  t.is(owned.find((p) => p.page === k1).movedTo, k2, 'a moved page is flagged')
  await rejects(t, store.setRoster(k1, { gen: 3, seq: 9, owner, admins: [] }), 'encerrada', 'old row setRoster')
  await rejects(t, store.invite(k1, key(), { gen: 3, rosterSignature: sig() }), 'encerrada', 'old row invite')
  await rejects(t, store.setFollows(k1, 2), 'encerrada', 'old row setFollows')
  t.is(store.stats().moved, 1)
  const again = open()
  t.alike(again.get(k2), to)
  t.alike(again.get(k1), from)
})

test('pages-store: follows, writers and media', async (t) => {
  const { store } = setup(t)
  const page = key()
  await store.create({ page, owner: key() })
  t.is((await store.setFollows(page, MAX_FOLLOWS)).follows, MAX_FOLLOWS)
  await rejects(t, store.setFollows(page, MAX_FOLLOWS + 1), 'limite', 'follow 4096')
  t.is((await store.setMedia(page, 3)).media.items, 3)
  const w = (i) => ({ group: key(), writer: key(), kind: i % 2 ? 'group' : 'community', state: 'member' })
  const writers = Array.from({ length: MAX_PAGE_WRITERS }, (_, i) => w(i))
  t.is((await store.setWriters(page, writers)).writers.length, MAX_PAGE_WRITERS)
  await rejects(t, store.setWriters(page, [...writers, w(1)]), 'limite', 'the 17th writer')
  await t.exception.all(() => store.setWriters(page, [{ ...writers[0], kind: 'x' }]), /writers/)
  t.alike((await store.clearWriters(page)).writers, [])
})

test('pages-store: delegate rows replay', async (t) => {
  const { store, open } = setup(t)
  const actor = key()
  const diary = key()
  t.is(store.delegate(actor), null)
  await store.setDelegate(actor, { diary, length: 4, termsVersion: 12 })
  t.alike(store.delegate(actor), { diary, length: 4, termsVersion: 12 })
  await t.exception.all(store.setDelegate(actor, { diary: actor, length: 1, termsVersion: 1 }), /row/)
  t.alike(open().delegate(actor), { diary, length: 4, termsVersion: 12 })
  await store.setDelegate(actor, null)
  t.is(open().delegate(actor), null)
  t.is(store.stats().delegates, 0)
})

test('pages-store: reopen equals memory and the file, one sidecar only', async (t) => {
  const { store, open, file, dir } = setup(t)
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  await addAdmin(store, page, key(), 3)
  await store.offer(page, key(), iso(T0 + DAY), { seq: 4 })
  await store.setFollows(page, 10)
  await store.setDelegate(key(), { diary: key(), length: 2, termsVersion: 3 })
  await store.spend(owner, nonce(), 5)
  await store.move(page, key())
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.alike({ charges: {}, ...onDisk }, store.snapshot(), 'the file equals memory (an empty charges table is left out)')
  t.absent('charges' in onDisk, 'no charges key while nothing is charged')
  t.alike(open().snapshot(), store.snapshot(), 'a reopen equals memory')
  t.is(onDisk.seq, 8, 'seq grows by one per write')
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  t.alike(fs.readdirSync(dir), [FILE], 'no journal and no temp file')
})

test('pages-store: another holder wrote meanwhile, the store fails closed without writing', async (t) => {
  const { store, open, file } = setup(t)
  const page = key()
  await store.create({ page, owner: key() })
  const other = open()
  await other.setFollows(page, 5)
  const before = fs.readFileSync(file, 'utf8')
  await rejects(t, store.setFollows(page, 1), 'indisponivel', 'a stale seq')
  t.is(fs.readFileSync(file, 'utf8'), before, 'nothing was written')
  t.absent(store.available())
  throwsCode(t, () => store.get(page), 'indisponivel', 'reads fail closed too')
  t.is(open().get(page).follows, 5)
})

test('pages-store: a replaced file at the same path but another seq is refused', async (t) => {
  const { store, file } = setup(t)
  const page = key()
  await store.create({ page, owner: key() })
  fs.unlinkSync(file)
  await rejects(t, store.setFollows(page, 1), 'indisponivel', 'the file vanished')
  t.absent(fs.existsSync(file), 'nothing was written')
})

test('pages-store: a lock refused after the write is not acknowledged; the store keeps working once it answers again', async (t) => {
  const { open } = setup(t)
  let calls = 0
  // Asked before the re-read (0), right before the rename (1), after it (2).
  let lostAt = 2
  const store = open({ guard: () => calls++ !== lostAt })
  const page = key()
  await rejects(t, store.create({ page, owner: key() }), 'indisponivel', 'guard false after the write')
  t.ok(open().isPage(page), 'the write itself is on disk for the next holder')
  t.ok(store.isPage(page), 'memory follows the file')
  lostAt = -1
  const other = key()
  await store.create({ page: other, owner: key() })
  t.ok(open().isPage(other), 'the next write lands: the store did not stop')
})

test('pages-store: after fail() every write and read is refused', async (t) => {
  const { open } = setup(t)
  const store = open()
  const page = key()
  await store.create({ page, owner: key() })
  store.fail()
  await rejects(t, store.create({ page: key(), owner: key() }), 'indisponivel', 'writes refused')
  throwsCode(t, () => store.get(page), 'indisponivel', 'reads fail closed')
})

test('pages-store: a write that throws after the rename fails reads closed too', async (t) => {
  const { open } = setup(t)
  let boom = false
  const store = open({
    writeJson (file, obj, mode) {
      writeJsonAtomic(file, obj, mode)
      if (boom) throw new Error('dir fsync')
    }
  })
  const owner = key()
  const page = key()
  const a = key()
  const to = key()
  const actor = key()
  await store.create({ page, owner })
  await store.invite(page, a, { gen: 2, rosterSignature: sig() })
  await store.offer(page, to, iso(T0 + DAY))
  await store.setDelegate(actor, { diary: key(), length: 1, termsVersion: 1 })
  const n = nonce()
  await store.spend(owner, n, 5)
  boom = true
  await rejects(t, store.setFollows(page, 7), 'indisponivel', 'the throwing write')
  t.is(open().get(page).follows, 7, 'the new state is on disk')
  throwsCode(t, () => store.get(page), 'indisponivel', 'get')
  throwsCode(t, () => store.role(page, owner), 'indisponivel', 'role')
  throwsCode(t, () => store.authorize(page, owner), 'indisponivel', 'authorize')
  throwsCode(t, () => store.accept(page, a), 'indisponivel', 'accept')
  throwsCode(t, () => store.remove(page, a), 'indisponivel', 'remove')
  throwsCode(t, () => store.transferAccept(page, to), 'indisponivel', 'transferAccept')
  throwsCode(t, () => store.listFor(owner), 'indisponivel', 'listFor')
  throwsCode(t, () => store.isPage(page), 'indisponivel', 'isPage')
  throwsCode(t, () => store.spent(owner, n), 'indisponivel', 'spent')
  throwsCode(t, () => store.delegate(actor), 'indisponivel', 'delegate')
  throwsCode(t, () => store.stats(), 'indisponivel', 'stats')
  boom = false
  await rejects(t, store.setFollows(page, 8), 'indisponivel', 'later writes')
  t.ok(open().available(), 'a reopen loads the file')
})

test('pages-store: a sparse admins array is refused', async (t) => {
  const { store, file, open } = setup(t)
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  const sparse = new Array(2)
  sparse[0] = key()
  await t.exception.all(store.setRoster(page, { gen: 2, seq: 3, owner, admins: sparse }), /admins/)
  t.ok(open().available(), 'the file still loads')
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
  obj.pages[page].admins = [key(), null]
  obj.pages[page].admins.sort()
  fs.writeFileSync(file, JSON.stringify(obj))
  t.absent(open().available(), 'a hole or null admin is never loaded')
})

test('pages-store: a replayed nonce writes nothing on any mutating method', async (t) => {
  const { store, file } = setup(t)
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  const n1 = nonce()
  await store.invite(page, key(), { gen: 2, rosterSignature: sig(), spend: { member: owner, nonce: n1, seq: 11 } })
  let before = fs.readFileSync(file, 'utf8')
  t.is(await store.invite(page, key(), { gen: 2, rosterSignature: sig(), spend: { member: owner, nonce: n1, seq: 99 } }), 11, 'invite replay')
  t.is(fs.readFileSync(file, 'utf8'), before, 'invite replay wrote nothing')
  t.is(store.spent(owner, n1), 11, 'the stored seq is kept')
  const n2 = nonce()
  await store.offer(page, key(), iso(T0 + DAY), { spend: { member: owner, nonce: n2, seq: 12 } })
  before = fs.readFileSync(file, 'utf8')
  t.is(await store.offer(page, key(), iso(T0 + DAY), { spend: { member: owner, nonce: n2, seq: 98 } }), 12, 'offer replay')
  t.is(fs.readFileSync(file, 'utf8'), before, 'offer replay wrote nothing')
  const n3 = nonce()
  await store.setFollows(page, 3, { spend: { member: owner, nonce: n3, seq: 13 } })
  before = fs.readFileSync(file, 'utf8')
  t.is(await store.setFollows(page, 4, { spend: { member: owner, nonce: n3, seq: 97 } }), 13, 'setFollows replay')
  t.is(fs.readFileSync(file, 'utf8'), before, 'setFollows replay wrote nothing')
  t.is(store.get(page).follows, 3)
  await store.close(page)
  t.is(await store.setFollows(page, 4, { spend: { member: owner, nonce: n3, seq: 97 } }), 13, 'replay after close')
})

test('pages-store: a paused page refuses every ACL step before the append', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const page = key()
  const a = key()
  const to = key()
  await store.create({ page, owner })
  await addAdmin(store, page, a, 3)
  await store.invite(page, key(), { gen: 3, rosterSignature: sig() })
  await store.offer(page, to, iso(T0 + DAY))
  await store.pause(page)
  await rejects(t, store.invite(page, key(), { gen: 3, rosterSignature: sig() }), 'pausada', 'invite')
  await rejects(t, store.offer(page, key(), iso(T0 + DAY)), 'pausada', 'offer')
  throwsCode(t, () => store.accept(page, a), 'pausada', 'accept')
  throwsCode(t, () => store.remove(page, a), 'pausada', 'remove')
  throwsCode(t, () => store.transferAccept(page, to), 'pausada', 'transferAccept')
})

test('pages-store: a new page key is never a person or a delegate', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const page = key()
  const a = key()
  const actor = key()
  await store.create({ page, owner })
  await addAdmin(store, page, a, 3)
  await store.setDelegate(actor, { diary: key(), length: 1, termsVersion: 1 })
  await rejects(t, store.create({ page: owner, owner: key() }), 'pedido-invalido', 'an owner as a new page')
  await rejects(t, store.create({ page: a, owner: key() }), 'pedido-invalido', 'an admin as a new page')
  await rejects(t, store.create({ page: actor, owner: key() }), 'pedido-invalido', 'a delegate as a new page')
  const other = key()
  const otherOwner = key()
  await store.create({ page: other, owner: otherOwner })
  await rejects(t, store.move(page, otherOwner), 'pedido-invalido', 'move onto another page owner')
  await rejects(t, store.move(page, actor), 'pedido-invalido', 'move onto a delegate')
  await rejects(t, store.move(page, other), 'pedido-invalido', 'move onto a page')
  const invitee = key()
  const target = key()
  await store.invite(page, invitee, { gen: 3, rosterSignature: sig() })
  await store.offer(page, target, iso(T0 + DAY))
  await rejects(t, store.create({ page: invitee, owner: key() }), 'pedido-invalido', 'a pending invitee as a new page')
  await rejects(t, store.create({ page: target, owner: key() }), 'pedido-invalido', 'an offer target as a new page')
  await rejects(t, store.move(other, invitee), 'pedido-invalido', 'move onto a pending invitee')
  await rejects(t, store.move(other, target), 'pedido-invalido', 'move onto an offer target')
})

test('pages-store: at most MAX_PAGE_MOVES moves through movedFrom', async (t) => {
  const { store } = setup(t)
  let page = key()
  await store.create({ page, owner: key() })
  for (let i = 0; i < MAX_PAGE_MOVES; i++) {
    const next = key()
    await store.move(page, next)
    page = next
  }
  await rejects(t, store.move(page, key()), 'pedido-invalido', 'the 5th move')
  t.is(store.stats().moved, MAX_PAGE_MOVES)
})

test('pages-store: an admin removed from the live key loses the old keys too', async (t) => {
  const { store, open } = setup(t)
  const owner = key()
  const a = key()
  const b = key()
  const c = key()
  const k1 = key()
  const k2 = key()
  const k3 = key()
  const pages = (list) => [...list.owned, ...list.admin].map((p) => p.page)
  const removeAdmin = async (page, member, seq) => {
    const rm = store.remove(page, member)
    await store.setRoster(page, { gen: rm.gen, seq, owner, admins: rm.admins })
  }
  await store.create({ page: k1, owner })
  await addAdmin(store, k1, a, 3)
  await addAdmin(store, k1, b, 4)
  await addAdmin(store, k1, c, 5)
  await removeAdmin(k1, c, 6)
  await store.move(k1, k2)
  t.is(store.role(k1, b), 'admin', 'before the remove, the old key still counts')
  await removeAdmin(k2, b, 5)

  t.alike(pages(store.listFor(b)), [], 'the removed admin is listed neither the old key nor the new one')
  t.is(store.role(k1, b), null)
  t.is(store.role(k2, b), null)
  throwsCode(t, () => store.authorize(k1, b), 'sem-permissao', 'the old key refuses the removed admin')
  t.alike(pages(store.listFor(c)), [], 'an admin removed before the move stays unlisted')
  t.is(store.role(k1, c), null)
  const ofA = store.listFor(a).admin
  t.is(ofA.find((p) => p.page === k1).movedTo, k2, 'a remaining admin still sees the old key as moved')
  t.ok(ofA.some((p) => p.page === k2))
  t.is(store.role(k1, a), 'admin')
  t.is(store.listFor(owner).owned.find((p) => p.page === k1).movedTo, k2, 'the owner still sees the old key')
  t.is(store.authorize(k1, owner, 'owner'), 'owner')
  t.is(open().role(k1, b), null, 'the same after a reopen')

  // A second move: the end of the chain decides for every key behind it.
  await store.move(k2, k3)
  await removeAdmin(k3, a, 3)
  t.alike(pages(store.listFor(a)), [], 'removed from K3, nothing of K1 or K2 is listed')
  t.is(store.role(k1, a), null)
  t.is(store.role(k2, a), null)
  throwsCode(t, () => store.authorize(k2, a), 'sem-permissao', 'K2 refuses the admin removed from K3')
  t.alike(pages(store.listFor(owner)).sort(), [k1, k2, k3].sort(), 'the owner keeps the whole chain')
  t.alike(pages(store.listFor(b)), [], 'the admin removed from K2 stays unlisted')
})

test('pages-store: a closed end of the move chain keeps its roster for the old keys', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const a = key()
  const k1 = key()
  const k2 = key()
  await store.create({ page: k1, owner })
  await addAdmin(store, k1, a, 3)
  await store.move(k1, k2)
  await store.close(k2)
  t.is(store.role(k1, a), 'admin')
  const listed = store.listFor(a).admin
  t.is(listed.find((p) => p.page === k1).movedTo, k2, 'the old key is still listed as moved')
  t.ok(listed.find((p) => p.page === k2).closed)
})

test('pages-store: a move chain whose end row is missing, or that loops, counts no old roster', async (t) => {
  const { store, open, file } = setup(t)
  const owner = key()
  const a = key()
  const k1 = key()
  const k2 = key()
  await store.create({ page: k1, owner })
  await addAdmin(store, k1, a, 3)
  await store.move(k1, k2)
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete obj.pages[k2]
  fs.writeFileSync(file, JSON.stringify(obj))
  const gone = open()
  t.ok(gone.available(), 'the file still loads')
  t.is(gone.role(k1, owner), null, 'no end row: the owner role on K1 does not count')
  t.is(gone.role(k1, a), null, 'nor the admin role')
  t.alike(gone.listFor(a).admin, [], 'K1 is listed to no one')
  t.alike(gone.listFor(owner).owned, [])

  obj.pages[k2] = { ...obj.pages[k1], movedTo: k1, movedFrom: k1 }
  fs.writeFileSync(file, JSON.stringify(obj))
  const loop = open()
  t.ok(loop.available(), 'a loop loads')
  t.is(loop.role(k1, a), null, 'a loop never reaches an end')
  t.is(loop.role(k2, owner), null)
})

test('pages-store: a file it would not write makes it unavailable, readOnly never writes', async (t) => {
  const { store, open, file } = setup(t)
  const page = key()
  await store.create({ page, owner: key() })
  const ro = open({ readOnly: true })
  t.ok(ro.isPage(page))
  await rejects(t, ro.setFollows(page, 1), 'indisponivel', 'readOnly write')
  await rejects(t, open({ guard: () => false }).setFollows(page, 1), 'indisponivel', 'lost lock')
  fs.writeFileSync(file, '{"v":1}')
  const bad = open()
  t.absent(bad.available())
  throwsCode(t, () => bad.isPage(page), 'indisponivel', 'bad file')
  await rejects(t, bad.setFollows(page, 1), 'indisponivel', 'bad file write')
  t.is(fs.readFileSync(file, 'utf8'), '{"v":1}', 'a bad file is never rewritten')
})

test('pages-store: no secret key is ever stored', async (t) => {
  const { store, file } = setup(t)
  const kp = crypto.keyPair()
  const page = b4a.toString(kp.publicKey, 'hex')
  await store.create({ page, owner: key() })
  const secret = b4a.toString(kp.secretKey, 'hex')
  t.absent(fs.readFileSync(file, 'utf8').includes(secret))
  t.absent(fs.readFileSync(file, 'utf8').includes(secret.slice(0, 64)))
})

function sealedB64 () {
  return crypto.randomBytes(213).toString('base64')
}

function dmRow (gen, members, by) {
  const shares = {}
  for (const m of members) shares[m] = { gen, sealed: sealedB64(), by, sig: sig(), at: iso(T0) }
  return { gen, box: key(), groupBox: key(), shares, pending: {}, reboxPending: false, legacyBundle: null, rotatePending: null }
}

test('pages-store: dm keeps opaque shares, survives a reopen, leaves at close and move', async (t) => {
  const { store, open } = setup(t)
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  t.absent('dm' in store.get(page), 'a page starts without dm')
  t.exception.all(() => store.setDm(page, { ...dmRow(1, [owner], owner), gen: 0 }), /dm must be/)
  const bad = dmRow(1, [owner], owner)
  bad.shares[owner].sealed = crypto.randomBytes(212).toString('base64')
  t.exception.all(() => store.setDm(page, bad), /dm must be/, 'a sealed share of another size is refused')
  const d = dmRow(1, [owner], owner)
  t.exception.all(() => store.setDm(page, { ...d, legacyBundle: { for: owner, id: key(), count: 1025 } }), /dm must be/, 'a bundle of more than 1024 chunks is refused')
  t.exception.all(() => store.setDm(page, { ...d, legacyBundle: { for: owner, id: key() } }), /dm must be/, 'a bundle without its count is refused')
  d.legacyBundle = { for: owner, id: key(), count: 3 }
  await store.setDm(page, d)
  t.alike(open().get(page).dm, d, 'persisted in pages.json')
  await store.close(page)
  t.absent('dm' in store.get(page), 'a close drops the shares')

  const p2 = key()
  const k2 = key()
  await store.create({ page: p2, owner })
  await store.setDm(p2, dmRow(1, [owner], owner))
  await store.move(p2, k2)
  t.absent('dm' in store.get(p2), 'a moved page keeps no shares')
  await store.setDm(k2, null)
  t.absent('dm' in store.get(k2))
})

test('pages-store: actor boxes: signed by the member, newer only, pruned by a removal, gone at close, carried by a move', async (t) => {
  const { store, open, c } = setup(t)
  const ownerKp = crypto.keyPair()
  const owner = b4a.toString(ownerKp.publicKey, 'hex')
  const danKp = crypto.keyPair()
  const dan = b4a.toString(danKp.publicKey, 'hex')
  const page = key()
  const stated = (kp, at, box = key()) => {
    const v = { box, gen: 1, at: iso(at) }
    return { ...v, sig: signActorBox({ actor: b4a.toString(kp.publicKey, 'hex'), ...v }, kp) }
  }
  await store.create({ page, owner })
  await store.invite(page, dan, { gen: 2, rosterSignature: sig() })
  const n = store.accept(page, dan)
  await store.setRoster(page, { gen: n.gen, seq: 3, owner: n.owner, admins: n.admins })
  t.absent('actorBoxes' in store.get(page), 'no key while empty')

  const first = stated(danKp, c.t - 1000)
  await store.setActorBox(page, dan, first)
  t.alike(open().get(page).actorBoxes, { [dan]: first }, 'persisted')
  await rejects(t, store.setActorBox(page, owner, stated(danKp, c.t)), 'assinatura-invalida', 'signed by another actor')
  await rejects(t, store.setActorBox(page, dan, { ...stated(danKp, c.t), sig: sig() }), 'assinatura-invalida', 'a bad signature')
  await rejects(t, store.setActorBox(page, dan, stated(danKp, c.t - 2000)), 'expirado', 'older')
  await rejects(t, store.setActorBox(page, dan, stated(danKp, c.t - 1000)), 'expirado', 'same at, another box')
  await rejects(t, store.setActorBox(page, dan, stated(danKp, c.t + 11 * 60000)), 'pedido-invalido', 'too far ahead')
  const outsiderKp = crypto.keyPair()
  await rejects(t, store.setActorBox(page, b4a.toString(outsiderKp.publicKey, 'hex'), stated(outsiderKp, c.t)), 'sem-permissao', 'outside the roster')
  t.exception.all(() => store.setActorBox(page, dan, { ...first, extra: 1 }), /value must be/)
  await store.setActorBox(page, dan, first)
  t.alike(store.get(page).actorBoxes, { [dan]: first }, 'the same statement again changes nothing')
  const second = stated(danKp, c.t)
  await store.setActorBox(page, dan, second)
  await store.setActorBox(page, owner, stated(ownerKp, c.t))
  t.alike(Object.keys(store.get(page).actorBoxes).sort(), [owner, dan].sort())
  t.alike(store.get(page).actorBoxes[dan], second, 'a newer one replaces it')

  const k2 = key()
  await store.move(page, k2)
  t.absent('actorBoxes' in store.get(page), 'the moved row keeps none')
  t.alike(store.get(k2).actorBoxes[dan], second, 'carried to K2 with its roster')
  const gone = store.remove(k2, dan)
  await store.setRoster(k2, { gen: gone.gen, seq: 3, owner: gone.owner, admins: gone.admins })
  t.alike(Object.keys(store.get(k2).actorBoxes), [owner], 'a removal forgets the removed member only')
  await store.close(k2)
  t.absent('actorBoxes' in store.get(k2), 'a close drops them')
})

test('pages-store: an invite share becomes a share at accept; a removed admin keeps none', async (t) => {
  const { store } = setup(t)
  const owner = key()
  const bia = key()
  const caio = key()
  const page = key()
  await store.create({ page, owner })
  const share = { sealed: sealedB64(), sig: sig() }
  await rejects(t, store.invite(page, bia, { gen: 2, rosterSignature: sig(), share }), 'pedido-invalido', 'no share before the page has dm')
  await store.setDm(page, dmRow(1, [owner], owner))
  await store.invite(page, bia, { gen: 2, rosterSignature: sig(), share })
  t.alike(store.get(page).dm.pending[bia], { gen: 1, ...share }, 'kept with the invite')
  const next = store.accept(page, bia)
  await store.setRoster(page, { gen: next.gen, seq: 3, owner: next.owner, admins: next.admins })
  const row = store.get(page)
  t.alike(row.dm.pending, {}, 'pending emptied')
  t.is(row.dm.shares[bia].sealed, share.sealed, 'moved to the shares')
  t.is(row.dm.shares[bia].by, owner, 'by the inviter')
  t.is(row.dm.shares[bia].gen, 1)

  await store.invite(page, caio, { gen: 3, rosterSignature: sig() })
  const n2 = store.accept(page, caio)
  await store.setRoster(page, { gen: n2.gen, seq: 4, owner: n2.owner, admins: n2.admins })
  t.absent(store.get(page).dm.shares[caio], 'an invite without a share files none')
  const gone = store.remove(page, bia)
  await store.setRoster(page, { gen: gone.gen, seq: 5, owner: gone.owner, admins: gone.admins })
  t.absent(store.get(page).dm.shares[bia], 'a removed admin keeps no share')
  t.ok(store.get(page).dm.shares[owner])
})

test('pages-store: never commits a row its own reader would refuse; promoteDm only promotes the rotation it names', async (t) => {
  const { store, open } = setup(t)
  const owner = key()
  const bia = key()
  const page = key()
  await store.create({ page, owner })
  const P = { kind: 'box', idem: owner + ':' + nonce(), gen: 1, box: key(), groupBox: key(), shares: { [owner]: { gen: 1, sealed: sealedB64(), by: owner, sig: sig(), at: iso(T0) } } }
  await store.setDm(page, { gen: 0, box: null, groupBox: null, shares: {}, pending: {}, reboxPending: false, legacyBundle: null, rotatePending: P })
  await rejects(t, store.invite(page, bia, { gen: 2, rosterSignature: sig(), share: { sealed: sealedB64(), sig: sig() } }), 'rotacao-necessaria', 'no invite share during a first rotation')
  t.ok(store.available(), 'the store stays usable')
  await store.invite(page, bia, { gen: 2, rosterSignature: sig() })
  t.ok(open().get(page).invites[bia], 'a further write and a reopen succeed')

  t.is(await store.promoteDm(page, { idem: owner + ':' + nonce(), gen: 1 }), null, 'another rotation is not promoted')
  t.is(store.get(page).dm.rotatePending.idem, P.idem, 'and nothing was written')
  const d = await store.promoteDm(page, { idem: P.idem, gen: 1 })
  t.is(d.gen, 1)
  t.is(d.box, P.box)
  t.is(d.rotatePending, null)
  t.alike(open().get(page).dm, d)
})

test('pages-store: the legacy bundle is carried through a promotion, a roster change and a transfer', async (t) => {
  const { store, open } = setup(t)
  const owner = key()
  const bia = key()
  const page = key()
  await store.create({ page, owner })
  const bundle = { for: owner, id: key(), count: 2 }
  const P = { kind: 'box', idem: owner + ':' + nonce(), gen: 2, box: key(), groupBox: key(), shares: { [owner]: { gen: 2, sealed: sealedB64(), by: owner, sig: sig(), at: iso(T0) } } }
  await store.setDm(page, { ...dmRow(1, [owner], owner), legacyBundle: bundle, rotatePending: P })
  const d = await store.promoteDm(page, { idem: P.idem, gen: 2 })
  t.alike(d.legacyBundle, bundle, 'kept by the promotion')
  await store.invite(page, bia, { gen: 2, rosterSignature: sig() })
  const next = store.accept(page, bia)
  await store.setRoster(page, { gen: next.gen, seq: 3, owner: next.owner, admins: next.admins })
  t.alike(store.get(page).dm.legacyBundle, bundle, 'kept by a roster change')
  await store.setRoster(page, { gen: next.gen + 1, seq: 4, owner: bia, admins: [owner] })
  t.alike(open().get(page).dm.legacyBundle, bundle, 'kept, still for the old owner, after a transfer')
  await store.close(page)
  t.absent('dm' in store.get(page), 'a close drops it')
})

test('pages-store: a move carries the legacy bundle to K2, with its keys or alone in a gen 0 row', async (t) => {
  const { store, open } = setup(t)
  const owner = key()
  const page = key()
  await store.create({ page, owner })
  const bundle = { for: owner, id: key(), count: 2 }
  const bare = { gen: 0, box: null, groupBox: null, shares: {}, pending: {}, reboxPending: false, legacyBundle: null, rotatePending: null }
  t.exception.all(() => store.setDm(page, bare), /dm must be/, 'a gen 0 row with neither a rotation nor a bundle is refused')
  const k2 = key()
  await store.move(page, k2, { dm: { ...bare, legacyBundle: bundle } })
  t.alike(open().get(k2).dm, { ...bare, legacyBundle: bundle }, 'K2 holds the bundle alone, after a reopen')
  t.absent('dm' in store.get(page), 'K1 keeps no dm')

  const k3 = key()
  const withKeys = { ...dmRow(1, [owner], owner), legacyBundle: bundle }
  await store.move(k2, k3, { dm: withKeys })
  t.alike(store.get(k3).dm.legacyBundle, bundle, 'carried with K3 gen 1 keys')
  t.exception.all(() => store.move(k3, key(), { dm: { ...bare } }), /dm must be/, 'a move never commits an empty gen 0 row')
})

test('pages-store: charges keep the 2 per 24 h cap across a reopen, a use once, a refund gives it back', async (t) => {
  const { store, open, file, c } = setup(t)
  const m = key()
  const P = key()
  const [n1, n2, n3] = [nonce(), nonce(), nonce()]
  t.is(await store.charge(m, n1, P), true)
  t.is(await store.charge(m, n1, P), false, 'a resend of the same use is not charged again')
  t.is(await store.charge(m, n2, P), true)
  await rejects(t, store.charge(m, n3, P), 'limite', 'a third use')
  await rejects(t, open().charge(m, n3, P), 'limite', 'a reopen keeps the charges')
  await rejects(t, store.charge(m, n1, key()), 'limite', 'the same nonce on another page is a new use')
  t.ok(await store.charge(key(), n3, P), 'another owner has its own cap')
  await rejects(t, store.charge(key(), nonce(), P, { extra: () => false }), 'limite', 'the extra window also refuses')
  t.is(await store.refund(m, n2, P), true)
  t.is(await store.refund(m, n2, P), false, 'refunding twice writes nothing')
  t.is(await store.refund(m, n1, key()), false, 'a refund is per page')
  t.ok(await open().charge(m, n3, P), 'a refunded use is free again')
  c.t += DAY + 1000
  const next = open()
  const last = nonce()
  t.ok(await next.charge(m, last, P), 'after 24 h the window is open again')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.is(Object.keys(disk.charges).length, 1, 'old charges are dropped on the next write')
  await next.refund(m, last, P)
  t.absent('charges' in JSON.parse(fs.readFileSync(file, 'utf8')), 'an empty table is not written')
})

test('pages-store: a store that cannot write refuses a charge with indisponivel', async (t) => {
  const { open } = setup(t)
  const store = open({ writeJson: () => { throw new Error('EIO') } })
  await rejects(t, store.charge(key(), nonce(), key()), 'indisponivel', 'a failed write')
})

test('pages-store: a malformed charges row makes the file refuse to open; a file without the key opens', async (t) => {
  const { store, open, file } = setup(t)
  const m = key()
  const P = key()
  await store.charge(m, nonce(), P)
  const good = JSON.parse(fs.readFileSync(file, 'utf8'))
  const id = Object.keys(good.charges)[0]
  const bad = [
    { ...good, charges: { [id]: { at: 'ontem', page: P } } },
    { ...good, charges: { [id]: { at: iso(T0), page: P, extra: 1 } } },
    { ...good, charges: { [id]: { at: iso(T0) } } },
    { ...good, charges: { [id]: { at: iso(T0), page: key() } } },
    { ...good, charges: { [id]: { at: iso(T0), page: 'zz' } } },
    { ...good, charges: { ['xx' + id]: { at: iso(T0), page: P } } },
    { ...good, charges: { [m + ':curto:' + P]: { at: iso(T0), page: P } } },
    { ...good, charges: [] }
  ]
  for (const doc of bad) {
    fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 })
    await rejects(t, open().charge(m, nonce(), P), 'indisponivel', 'a malformed charges row')
  }
  const old = { ...good }
  delete old.charges
  fs.writeFileSync(file, JSON.stringify(old), { mode: 0o600 })
  const reopened = open()
  t.ok(await reopened.charge(m, nonce(), P), 'a file written before charges reads as empty')
})

test('pages-store: forgetMember drops a deleted member\'s pending state only; the signed roster and current shares stay', async (t) => {
  const { store, open } = setup(t)
  const owner = key()
  const gone = key()
  const other = key()
  const p1 = key()
  const p2 = key()
  await store.create({ page: p1, owner })
  await store.create({ page: p2, owner })
  await addAdmin(store, p1, gone, 3)
  const share = (gen, by) => ({ gen, sealed: sealedB64(), by, sig: sig(), at: iso(T0) })
  const rotate = { kind: 'box', idem: owner + ':' + nonce(), gen: 2, box: key(), groupBox: key(), shares: { [owner]: share(2, owner), [gone]: share(2, owner) } }
  await store.setDm(p1, { ...dmRow(1, [owner, gone], owner), rotatePending: rotate })
  await store.offer(p1, gone, iso(T0 + DAY))
  await store.setDm(p2, dmRow(1, [owner], owner))
  await store.invite(p2, gone, { gen: 2, rosterSignature: sig(), share: { sealed: sealedB64(), sig: sig() } })
  await store.invite(p2, other, { gen: 2, rosterSignature: sig(), share: { sealed: sealedB64(), sig: sig() } })
  await store.setDelegate(gone, { diary: key(), length: 4, termsVersion: 12 })
  const actor = key()
  const diary = key()
  await store.setDelegate(actor, { diary, length: 4, termsVersion: 12 })
  const keepActor = key()
  await store.setDelegate(keepActor, { diary: key(), length: 2, termsVersion: 12 })
  const before1 = store.get(p1)

  t.ok(store.holdsMember(gone))
  t.ok(store.holdsMember(other), 'another invitee holds their own invite')
  t.is(await store.forgetMember(gone), true)
  const r1 = store.get(p1)
  t.is(r1.owner, owner, 'owner unchanged')
  t.alike(r1.admins, before1.admins, 'the admins list stays until the owner removes them')
  t.is(r1.gen, before1.gen)
  t.is(r1.rosterSeq, before1.rosterSeq)
  t.alike(r1.dm.shares, before1.dm.shares, 'the current key shares stay')
  t.is(r1.offer, null, 'the offer to them goes')
  t.alike(Object.keys(r1.dm.rotatePending.shares), [owner], 'their share in a rotation not yet promoted goes')
  t.is(r1.dm.rotatePending.idem, rotate.idem)
  const r2 = store.get(p2)
  t.alike(Object.keys(r2.invites), [other], 'their invite goes, another stays')
  t.alike(Object.keys(r2.dm.pending), [other], 'the share sealed for them goes')
  t.is(store.delegate(gone), null, 'their delegate row goes')
  t.ok(store.delegate(actor), 'a delegate of another diary stays')
  t.ok(store.delegate(keepActor))
  t.alike(open().snapshot().pages, store.snapshot().pages, 'on disk too')
  t.absent(store.holdsMember(gone))
  t.is(await store.forgetMember(gone), false, 'a second forget writes nothing')

  t.ok(store.holdsMember(diary), 'a delegate naming the diary of a deleted key')
  t.is(await store.forgetMember(diary), true)
  t.is(store.delegate(actor), null)
  t.ok(store.delegate(keepActor))
  t.absent(open().delegate(actor))
  t.ok(store.holdsMember(other))
})
