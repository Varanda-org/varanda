'use strict'

// What the seeder remembers of group roots it purged (goneRoots in
// admitted.json, docs/protocol.md "Root G" and "Denial bounds"): which
// entries hold root admission back, how many a creator keeps, how they
// survive restarts and re-signed logs, and the hard bound. Split from
// seeder-groups.test.js to keep each file under the runner's timeout.

const test = require('brittle')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const { keyPair: signingKeyPair } = require('hypercore-crypto')
const { testnet, until } = require('./helpers/net')
const { createIssuedCert } = require('../lib/cert')
const { createSnapshot } = require('../lib/blocklist')
const { writeBlocklist } = require('../lib/store')
const { groupJoinRecord } = require('../lib/records')
const { groupPost } = require('../lib/group')
const { groupHeader, writerHeader } = require('./helpers/seeder-groups')
const {
  hex,
  makeAssociation,
  readFile,
  readGroups,
  prepareSeederDir,
  startSeeder,
  encode,
  member,
  admit,
  reader,
  admitted,
  rejected,
  stored,
  moderator,
  creatorAndMember,
  scansDone,
  issuedCreatorAndMember,
  makeIssuer
} = require('./helpers/seeder-groups')

// A new member's own join of a root: a fresh core, or `keyPair`'s key with a
// new block 0 (a root re-signed by whoever holds its key). The header names
// the member unless `diary` names another one. `beforeAdmit(R)` runs once
// the root key is known (a core's key is not its signer's public key) and
// before the seeder sees the member. Resolves with { C, R }.
async function offerRoot (t, bootstrap, assoc, { keyPair = null, diary = null, name = 'Nova', join = 'open', beforeAdmit = null } = {}) {
  const C = await member(t, bootstrap, assoc, async () => [])
  const core = keyPair === null ? C.store.get({ name: 'fresh' }) : C.store.get({ keyPair })
  await core.ready()
  await core.append(encode(groupHeader({ diary: diary || C.key, name, join })))
  const R = hex(core.key)
  await C.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  if (beforeAdmit !== null) await beforeAdmit(R)
  await admit(C, assoc)
  return { C, R }
}

// Covered goneRoots entries (blocked creators, no issuer) up to `n`, the
// creator chosen by the map's size: 63 per creator at most, also over
// several calls, so each still has room for one denial of its own.
function fillCovered (seeder, blocked, n) {
  while (seeder._goneRoots.size < n) {
    const creator = blocked[Math.floor(seeder._goneRoots.size / 63)]
    if (creator === undefined) throw new Error('fillCovered: too few creators for ' + n)
    seeder._goneRoots.set(hex(crypto.randomBytes(32)), { creator, issuer: null })
  }
}

function blockedKeys (n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(hex(signingKeyPair().publicKey))
  return out
}

test('purged roots of blocked creators with no revoked issuer do not count toward the denial bound: root admission stays open', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  // Deleted accounts with up to 63 purged roots each.
  const blocked = blockedKeys(66)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked, revokedIssuers: [] }, mod.kp, mod.cert))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  fillCovered(seeder, blocked, 4096)
  t.is(seeder._goneRootReason(seeder._goneRoots.keys().next().value), 'blocked', 'each entry still refuses its root')
  t.is(seeder._rootsClosed(), false, 'covered entries do not close root admission')

  // A fresh root of an unblocked creator is admitted.
  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)

  // A root naming a blocked diary is still refused, with no entry of its own.
  const { R: X } = await offerRoot(t, bootstrap, assoc, { diary: blocked[0], name: 'Antiga' })
  await rejected(events, X, 'blocked')
  t.absent(seeder._groups.has(X), 'the blocked creator\'s root is not admitted')
  t.is(seeder._goneRoots.size, 4096, 'no covered entry was evicted')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a purged root whose creator is blocked and whose issuer is revoked still counts toward the denial bound, also once only the block is lifted', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  // Distinct creators: held entries count once per creator.
  const blocked = blockedKeys(4096)
  const issuer = hex(signingKeyPair().publicKey)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked, revokedIssuers: [issuer] }, mod.kp, mod.cert))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const held = []
  for (let i = 0; i < 4096; i++) {
    const k = hex(crypto.randomBytes(32))
    seeder._goneRoots.set(k, { creator: blocked[i], issuer })
    held.push(k)
  }
  t.is(seeder._rootsClosed(), true, 'entries with a revoked issuer close root admission')

  const K = hex(crypto.randomBytes(32))
  seeder._noteGoneRoot(K, blocked[0], 'blocked')
  t.ok(held.every((k) => seeder._goneRoots.has(k)), 'no entry with a revoked issuer was evicted')
  t.ok(seeder._goneRoots.has(K), 'and the new one is kept')

  // Only the block is lifted: the issuer stays revoked.
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 2, blocked: [], revokedIssuers: [issuer] }, mod.kp, mod.cert) })
  await until(() => events.find((e) => e.event === 'blocklist' && e.seq === 2), { name: 'lista 2 adotada' })
  t.is(seeder._goneRootReason(held[0]), 'revoked-issuer', 'the root stays refused')
  t.is(seeder._rootsClosed(), true, 'and root admission stays closed')
  const { R: F } = await offerRoot(t, bootstrap, assoc)
  await rejected(events, F, 'denials-full')
  t.absent(seeder._groups.has(F), 'a fresh root of an unblocked creator is refused')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a purged root whose creator is blocked and whose recorded issuer is not revoked now still counts toward the denial bound', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  // Distinct creators: held entries count once per creator.
  const blocked = blockedKeys(4096)
  // Its revocation was lifted since the purge; a later one must still find
  // the entry once the block is lifted.
  const issuer = hex(signingKeyPair().publicKey)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked, revokedIssuers: [] }, mod.kp, mod.cert))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const held = []
  for (let i = 0; i < 4096; i++) {
    const k = hex(crypto.randomBytes(32))
    seeder._goneRoots.set(k, { creator: blocked[i], issuer })
    held.push(k)
  }
  t.is(seeder._goneRootReason(held[0]), 'blocked', 'each entry is in force through the block')
  t.is(seeder._rootsClosed(), true, 'entries with a recorded issuer close root admission')

  const K = hex(crypto.randomBytes(32))
  seeder._noteGoneRoot(K, blocked[0], 'blocked')
  t.ok(held.every((k) => seeder._goneRoots.has(k)), 'no entry with a recorded issuer was evicted')
  t.alike(seeder._goneRoots.get(K), { creator: blocked[0], issuer: null }, 'and the new one is kept')
  t.is(seeder._denialsLost, false, 'no denial was lost')
  const { R: F } = await offerRoot(t, bootstrap, assoc)
  await rejected(events, F, 'denials-full')
  t.absent(seeder._groups.has(F), 'a fresh root of an unblocked creator is refused')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a covered entry is never evicted: its root, re-signed with a block 0 naming an unblocked diary, stays refused', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const blocked = blockedKeys(66)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked, revokedIssuers: [] }, mod.kp, mod.cert))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // R was purged for its blocked creator; covered denials noted later fill
  // the map past ROOT_CREATORS_MAX. Then whoever holds R's key signs a new
  // block 0 naming an unblocked diary.
  const { C, R } = await offerRoot(t, bootstrap, assoc, {
    keyPair: signingKeyPair(),
    beforeAdmit: (R) => {
      seeder._goneRoots.set(R, { creator: blocked[0], issuer: null })
      fillCovered(seeder, blocked, 4096)
      seeder._noteGoneRoot(hex(crypto.randomBytes(32)), blocked[1], 'blocked')
      t.ok(seeder._goneRoots.has(R), 'the covered entry stays')
      t.is(seeder._goneRoots.size, 4097, 'nothing was evicted')
      t.is(seeder._rootsClosed(), false, 'root admission stays open')
    }
  })
  await rejected(events, R, 'blocked')
  t.absent(seeder._groups.has(R), 'the re-signed root is not admitted')
  t.is(await stored(seeder, R), false, 'nothing kept')
  t.ok(C.key !== blocked[0], 'its header names another diary')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root purged for its blocked creator and admitted again through a member once the block is lifted is purged again when the creator is blocked again', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const others = blockedKeys(66)
  const mod = moderator(assoc)
  const list = (seq, extra) => createSnapshot({ seq, blocked: [...others, ...extra], revokedIssuers: [] }, mod.kp, mod.cert)
  const adopted = (seq) => until(() => events.find((e) => e.event === 'blocklist' && e.seq === seq), { name: 'lista ' + seq + ' adotada' })
  writeBlocklist(dataDir, list(1, []))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })
  // B keeps a copy of R to serve it once A is gone, so A cannot bind R again.
  const copy = B.store.get({ key: b4a.from(R, 'hex') })
  await copy.ready()
  await copy.get(0, { timeout: 20000 })
  await copy.get(1, { timeout: 20000 })
  await A.swarm.destroy()

  await reader(t, bootstrap, publicKey, { blocklist: list(2, [A.key]) })
  await rejected(events, R, 'blocked')
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(seeder, R)), { name: 'R purgado' })
  // Covered denials noted later fill the map past ROOT_CREATORS_MAX.
  fillCovered(seeder, others, 4096)
  seeder._noteGoneRoot(hex(crypto.randomBytes(32)), others[0], 'blocked')
  t.ok(seeder._goneRoots.has(R), 'R\'s entry stays')

  // The block is lifted: a member's join admits R again, and it keeps `bound`.
  await reader(t, bootstrap, publicKey, { blocklist: list(3, []) })
  await adopted(3)
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true && seeder._groupServed.has(R), { name: 'R de volta, vinculado' })
  t.is(readGroups(dataDir)[R].diary, A.key, 'listed under its creator')

  // Blocked again: purged again, although only members keep it.
  await reader(t, bootstrap, publicKey, { blocklist: list(4, [A.key]) })
  await adopted(4)
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(seeder, R)), { name: 'R purgado de novo' })
  t.absent(seeder._groupServed.has(R), 'the root is purged again')
  t.ok(seeder._groupServed.has(W), 'W kept')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root admitted again with a block 0 naming another diary keeps its entry: it is purged and refused once its creator is blocked again', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const [X] = blockedKeys(1)
  const mod = moderator(assoc)
  const list = (seq, blocked) => createSnapshot({ seq, blocked, revokedIssuers: [] }, mod.kp, mod.cert)
  writeBlocklist(dataDir, list(1, []))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // R was purged for X, whose block is lifted since. Whoever holds R's key
  // signs a block 0 naming D, and D's join admits it.
  const { C: D, R } = await offerRoot(t, bootstrap, assoc, {
    keyPair: signingKeyPair(),
    beforeAdmit: (R) => { seeder._goneRoots.set(R, { creator: X, issuer: null }) }
  })
  await admitted(events, R)
  t.is(seeder._groups.get(R).diary, D.key, 'served under the diary its block 0 names')
  t.ok(seeder._goneRoots.has(R) && seeder._goneRoots.get(R).creator === X, 'X\'s entry stays')

  // X is blocked again: R is purged and its next admission refused.
  await reader(t, bootstrap, publicKey, { blocklist: list(2, [X]) })
  await until(() => events.find((e) => e.event === 'blocklist' && e.seq === 2), { name: 'lista 2 adotada' })
  await until(async () => seeder._drops.size === 0 && !seeder._groupServed.has(R) && !(await stored(seeder, R)), { name: 'R purgado', timeoutMs: 20000 })
  t.absent(seeder._groupServed.has(R), 'the root is purged')
  // The purge logs one refusal; the next admission (a retry or D's new
  // join) another.
  await D.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => events.filter((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'blocked').length >= 2, { name: 'R recusado de novo', timeoutMs: 20000 })
  t.absent(seeder._groups.has(R), 'and refused again')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a bound root dropped for a fork is remembered: its log re-signed naming another diary is refused while its creator is blocked', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const mod = moderator(assoc)
  const list = (seq, blocked) => createSnapshot({ seq, blocked, revokedIssuers: [] }, mod.kp, mod.cert)
  writeBlocklist(dataDir, list(1, []))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const kp = signingKeyPair()
  const { C, R } = await offerRoot(t, bootstrap, assoc, { keyPair: kp })
  await admitted(events, R)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })

  // C rewrites R from block 0, naming D.
  const D = await member(t, bootstrap, assoc, async () => [])
  const core = C.store.get({ keyPair: kp })
  await core.ready()
  await core.truncate(0)
  await core.append(encode(groupHeader({ diary: D.key, name: 'Outra' })))
  await rejected(events, R, 'fork')
  t.ok(seeder._goneRoots.has(R) && seeder._goneRoots.get(R).creator === C.key, 'the fork drop writes C\'s entry')
  t.is(seeder._goneRootReason(R), null, 'not in force while C is not gone')

  // C's join may admit the re-signed log again under D meanwhile. C is
  // blocked, and D's join offers it: purged if served, refused either way.
  await reader(t, bootstrap, publicKey, { blocklist: list(2, [C.key]) })
  await until(() => events.find((e) => e.event === 'blocklist' && e.seq === 2), { name: 'lista 2 adotada' })
  const from = events.length
  await D.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await admit(D, assoc)
  await until(() => events.slice(from).some((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'blocked'), { name: 'R recusado', timeoutMs: 20000 })
  await until(async () => seeder._drops.size === 0 && scansDone(seeder) && !seeder._groupServed.has(R) && !(await stored(seeder, R)), { name: 'R fora', timeoutMs: 20000 })
  t.absent(seeder._groups.has(R), 'the re-signed root is refused')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a bound root of an issued creator dropped for a fork is remembered with no issuer: it does not hold roots back, stays across a restart the creator survives, and its re-signed log is refused once the creator is blocked', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const mod = moderator(assoc)
  const list = (seq, blocked) => createSnapshot({ seq, blocked, revokedIssuers: [] }, mod.kp, mod.cert)
  writeBlocklist(dataDir, list(1, []))
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { issuer, A, R } = await issuedCreatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admitted(first.events, R)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true && readGroups(dataDir)[R].issuer === issuer.hex, { name: 'R vinculado com o emissor' })

  // A rewrites R from block 0, naming D, admitted already.
  const D = await member(t, bootstrap, assoc, async () => [])
  await admit(D, assoc)
  await A.cores.root.truncate(0)
  await A.cores.root.append(encode(groupHeader({ diary: D.key, name: 'Outra' })))
  await rejected(first.events, R, 'fork')
  t.alike(first.seeder._goneRoots.get(R), { creator: A.key, issuer: null, first: 1 }, 'the fork drop writes A\'s entry, with no issuer')
  await first.seeder.close()

  // A's certificate still verifies at the restart (_forgetRevoked runs for
  // it), then A is blocked.
  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.ok(second.seeder._goneRoots.has(R), 'the entry stays across the restart')
  await reader(t, bootstrap, publicKey, { blocklist: list(2, [A.key]) })
  await until(() => second.events.find((e) => e.event === 'blocklist' && e.seq === 2), { name: 'lista 2 adotada' })
  t.is(second.seeder._goneRootReason(R), 'blocked', 'in force once A is blocked')
  t.absent(second.seeder._goneRootHeld(second.seeder._goneRoots.get(R)), 'and it does not count toward the denial bound')
  t.absent(second.seeder._rootsClosed(), 'root admission stays open')

  // D's join offers the re-signed log: purged if served, refused either way.
  const from = second.events.length
  await D.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => second.events.slice(from).some((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'blocked'), { name: 'R recusado', timeoutMs: 20000 })
  await until(async () => second.seeder._drops.size === 0 && scansDone(second.seeder) && !second.seeder._groupServed.has(R) && !(await stored(second.seeder, R)), { name: 'R fora', timeoutMs: 20000 })
  t.absent(second.seeder._groups.has(R), 'the re-signed root is refused')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a gate that forgets a creator\'s revoked issuer keeps its goneRoots entries with no issuer: a root admitted again naming another diary is purged and refused once the creator is blocked', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const mod = moderator(assoc)
  const list = (seq, blocked) => createSnapshot({ seq, blocked, revokedIssuers: [] }, mod.kp, mod.cert)
  writeBlocklist(dataDir, list(1, []))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // R was purged for C's revoked issuer, a revocation lifted since. Whoever
  // holds R's key signs a block 0 naming D, and D's join admits it.
  const C = await member(t, bootstrap, assoc, async () => [])
  const issuer = makeIssuer(assoc)
  const { C: D, R } = await offerRoot(t, bootstrap, assoc, {
    keyPair: signingKeyPair(),
    beforeAdmit: (R) => {
      seeder._revokedCreators.set(C.key, issuer.hex)
      seeder._goneRoots.set(R, { creator: C.key, issuer: issuer.hex })
    }
  })
  await admitted(events, R)
  t.is(seeder._groups.get(R).diary, D.key, 'served under the diary its block 0 names')

  // C is gated again: its certificate verifies, so the stale issuer goes.
  await admit(C, assoc)
  await until(() => !seeder._revokedCreators.has(C.key), { name: 'emissor esquecido' })
  t.alike(seeder._goneRoots.get(R), { creator: C.key, issuer: null }, 'C\'s entry stays, with no issuer')

  // C is blocked: R is purged and its next admission refused.
  await reader(t, bootstrap, publicKey, { blocklist: list(2, [C.key]) })
  await until(() => events.find((e) => e.event === 'blocklist' && e.seq === 2), { name: 'lista 2 adotada' })
  await until(async () => seeder._drops.size === 0 && !seeder._groupServed.has(R) && !(await stored(seeder, R)), { name: 'R purgado', timeoutMs: 20000 })
  t.absent(seeder._groupServed.has(R), 'the root is purged')
  await D.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => events.filter((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'blocked').length >= 2, { name: 'R recusado de novo', timeoutMs: 20000 })
  t.absent(seeder._groups.has(R), 'and refused again')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a bound root dropped for its quota is remembered: a fresh log for its key naming another diary is refused once its creator is blocked', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const mod = moderator(assoc)
  const list = (seq, blocked) => createSnapshot({ seq, blocked, revokedIssuers: [] }, mod.kp, mod.cert)
  writeBlocklist(dataDir, list(1, []))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxLogBlocks: 4 })

  const kp = signingKeyPair()
  const { C, R } = await offerRoot(t, bootstrap, assoc, { keyPair: kp })
  await admitted(events, R)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })

  // C grows R past the log quota, then goes offline with its copy.
  const core = C.store.get({ keyPair: kp })
  await core.ready()
  for (let i = 0; i < 4; i++) await core.append(encode(groupPost({ text: 'oi ' + i })))
  await rejected(events, R, 'quota')
  t.alike(seeder._goneRoots.get(R), { creator: C.key, issuer: null, first: 1 }, 'the quota drop writes C\'s entry')
  t.is(seeder._goneRootReason(R), null, 'not in force while C is not gone')
  await C.swarm.destroy()

  // C is blocked; D offers a fresh log for R's key whose block 0 names D.
  await reader(t, bootstrap, publicKey, { blocklist: list(2, [C.key]) })
  await until(() => events.find((e) => e.event === 'blocklist' && e.seq === 2), { name: 'lista 2 adotada' })
  const from = events.length
  const { C: D } = await offerRoot(t, bootstrap, assoc, { keyPair: kp })
  await until(() => events.slice(from).some((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'blocked'), { name: 'R recusado', timeoutMs: 20000 })
  await until(async () => seeder._drops.size === 0 && scansDone(seeder) && !seeder._groupServed.has(R) && !(await stored(seeder, R)), { name: 'R fora', timeoutMs: 20000 })
  t.absent(seeder._groups.has(R), 'the fresh log is refused')
  t.absent(events.some((e) => e.event === 'group-admitted' && e.key === R && e.diary === D.key), 'never served under D')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a bound root dropped as unbound once its creator leaves for its quota is remembered: a fresh log for its key naming another diary is refused once the creator is blocked', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const mod = moderator(assoc)
  const list = (seq, blocked) => createSnapshot({ seq, blocked, revokedIssuers: [] }, mod.kp, mod.cert)
  writeBlocklist(dataDir, list(1, []))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxLogBlocks: 4 })

  const kp = signingKeyPair()
  const { C, R } = await offerRoot(t, bootstrap, assoc, { keyPair: kp })
  await admitted(events, R)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })

  // C's diary passes the log quota; no member keeps R, so R goes unbound.
  for (let i = 0; i < 3; i++) await C.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await rejected(events, R, 'unbound')
  t.alike(seeder._goneRoots.get(R), { creator: C.key, issuer: null, first: 1 }, 'the unbound drop writes C\'s entry')
  await C.swarm.destroy()

  await reader(t, bootstrap, publicKey, { blocklist: list(2, [C.key]) })
  await until(() => events.find((e) => e.event === 'blocklist' && e.seq === 2), { name: 'lista 2 adotada' })
  const from = events.length
  await offerRoot(t, bootstrap, assoc, { keyPair: kp })
  await until(() => events.slice(from).some((e) => e.event === 'group-rejected' && e.key === R && e.reason === 'blocked'), { name: 'R recusado', timeoutMs: 20000 })
  await until(async () => seeder._drops.size === 0 && scansDone(seeder) && !seeder._groupServed.has(R) && !(await stored(seeder, R)), { name: 'R fora', timeoutMs: 20000 })
  t.absent(seeder._groups.has(R), 'the fresh log is refused')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a goneRoots entry naming another creator is never replaced, and one whose root is bound again is never evicted', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const [C, D2, D, C2] = blockedKeys(4)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [C, D2], revokedIssuers: [] }, mod.kp, mod.cert))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // R keeps C's entry and is bound again under D2, which joined R before 64
  // other roots. D2's roots are purged, R last, each binding going after
  // its note.
  const R = hex(crypto.randomBytes(32))
  seeder._goneRoots.set(R, { creator: C, issuer: null })
  seeder._groups.set(R, { diary: D2, group: R, seq: 2, bound: true, first: 2 })
  const decoys = []
  for (let i = 0; i < 64; i++) {
    const k = hex(crypto.randomBytes(32))
    seeder._groups.set(k, { diary: D2, group: k, seq: 3 + i, bound: true, first: 3 + i })
    decoys.push(k)
  }
  for (const k of [...decoys, R]) {
    seeder._noteGoneRoot(k, D2, 'blocked')
    seeder._groups.delete(k)
  }
  t.alike(seeder._goneRoots.get(R), { creator: C, issuer: null }, 'C\'s entry for R stays')
  t.is(seeder._goneRootReason(R), 'blocked', 'and refuses R while C is blocked')

  // C2 holds 64 entries, R1's ranked last while R1 is bound again under D.
  // Another bound root of C2 dropped then (its quota, a fork) is purged but
  // does not evict R1's entry.
  const R1 = hex(crypto.randomBytes(32))
  seeder._goneRoots.set(R1, { creator: C2, issuer: null, first: 1000 })
  seeder._groups.set(R1, { diary: D, group: R1, seq: 2, bound: true, first: 2 })
  for (let i = 0; i < 63; i++) seeder._goneRoots.set(hex(crypto.randomBytes(32)), { creator: C2, issuer: null, first: i })
  const Rn = hex(crypto.randomBytes(32))
  seeder._groups.set(Rn, { diary: C2, group: Rn, seq: 100, bound: true, first: 100 })
  seeder._noteGoneRoot(Rn, C2, 'quota')
  seeder._groups.delete(Rn)
  t.alike(seeder._goneRoots.get(R1), { creator: C2, issuer: null, first: 1000 }, 'R1\'s entry stays')
  t.absent(seeder._goneRoots.has(Rn), 'the other root is not remembered')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a block drops a served root whose kept entry is back in force before noting the creator\'s other roots, whatever their order', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const mod = moderator(assoc)
  const list = (seq, blocked) => createSnapshot({ seq, blocked, revokedIssuers: [] }, mod.kp, mod.cert)
  writeBlocklist(dataDir, list(1, []))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // Rn, a root C binds, is served first.
  const { C, R: Rn } = await offerRoot(t, bootstrap, assoc)
  await admitted(events, Rn)
  await until(() => readGroups(dataDir)[Rn] && readGroups(dataDir)[Rn].bound === true, { name: 'Rn vinculado' })
  // R1 keeps C's entry, ranked last of C's 64, and is served under D.
  const { R: R1 } = await offerRoot(t, bootstrap, assoc, {
    keyPair: signingKeyPair(),
    beforeAdmit: (R1) => { seeder._goneRoots.set(R1, { creator: C.key, issuer: null, first: 1000 }) }
  })
  await admitted(events, R1)
  for (let i = 0; i < 63; i++) seeder._goneRoots.set(hex(crypto.randomBytes(32)), { creator: C.key, issuer: null, first: 0 })
  const order = [...seeder._groupServed.keys()]
  t.ok(order.indexOf(Rn) < order.indexOf(R1), 'Rn is visited before R1')

  // C is blocked: both go, R1 through its kept entry.
  await reader(t, bootstrap, publicKey, { blocklist: list(2, [C.key]) })
  await until(() => events.find((e) => e.event === 'blocklist' && e.seq === 2), { name: 'lista 2 adotada' })
  await until(async () => seeder._drops.size === 0 && !seeder._groupServed.has(Rn) && !seeder._groupServed.has(R1) && !(await stored(seeder, R1)), { name: 'Rn e R1 purgados', timeoutMs: 20000 })
  t.ok(events.some((e) => e.event === 'group-rejected' && e.key === R1 && e.reason === 'blocked'), 'R1 is dropped')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('goneRoots entries recorded with an issuer hold roots back by distinct creator: 64 revoked creators with 64 dropped roots each leave root admission open', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const issuer = makeIssuer(assoc)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // One issuer's 64 creators, none served, each with 64 dropped roots that
  // its revocation gave the issuer.
  for (const creator of blockedKeys(64)) {
    for (let i = 0; i < 64; i++) seeder._goneRoots.set(hex(crypto.randomBytes(32)), { creator, issuer: issuer.hex, first: i })
  }
  t.is(seeder._goneRoots.size, 4096)
  t.ok(seeder._goneRootHeld(seeder._goneRoots.values().next().value), 'each entry holds its root back')
  t.absent(seeder._rootsClosed(), '64 creators do not close root admission')

  // 4096 distinct creators do.
  for (const creator of blockedKeys(4096 - 64 - 1)) seeder._goneRoots.set(hex(crypto.randomBytes(32)), { creator, issuer: issuer.hex })
  t.absent(seeder._rootsClosed(), '4095 creators still leave it open')
  seeder._goneRoots.set(hex(crypto.randomBytes(32)), { creator: blockedKeys(1)[0], issuer: issuer.hex })
  t.ok(seeder._rootsClosed(), '4096 creators close it')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a revocation that a purge records puts in force the kept entry of another served root in the same pass', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxLogBlocks: 4 })

  // C, from issuer I, binds K3, which B's writer keeps.
  const issuer = makeIssuer(assoc)
  let K3 = null
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    K3 = await make('root', groupHeader({ diary: key, name: 'Mantida' }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: K3, writer: K3, on: true })]
  }, { certOf: (key) => createIssuedCert({ member: key }, issuer.kp, issuer.cert) })
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: K3, diary: key }))
    return [groupJoinRecord({ group: K3, writer: W, on: true })]
  })
  await admit(C, assoc)
  await admit(B, assoc)
  await admitted(events, K3)
  await admitted(events, W)
  await until(() => readGroups(dataDir)[K3] && readGroups(dataDir)[K3].bound === true && readGroups(dataDir)[K3].issuer === issuer.hex, { name: 'K3 vinculado com o emissor' })

  // K2 was C's (dropped for a fork, entry with no issuer) and is served
  // again under D2.
  const { R: K2 } = await offerRoot(t, bootstrap, assoc, {
    keyPair: signingKeyPair(),
    beforeAdmit: (K2) => { seeder._goneRoots.set(K2, { creator: C.key, issuer: null }) }
  })
  await admitted(events, K2)

  // C's diary leaves for its quota: C is not served and not recorded as
  // revoked; B keeps K3 served.
  for (let i = 0; i < 3; i++) await C.diary.append(groupJoinRecord({ group: K3, writer: K3, on: true }))
  await until(() => events.some((e) => e.event === 'rejected' && e.key === C.key && e.reason === 'quota'), { name: 'C fora pela cota' })
  t.ok(seeder._groupServed.has(K3) && seeder._groupServed.has(K2), 'K3 and K2 still served')
  t.absent(seeder._revokedCreators.has(C.key), 'C not recorded as revoked')

  // I is revoked: the pass that purges K3 also drops K2.
  const pass = seeder._dropUnsupportedRoots.bind(seeder)
  let k2AfterPass = null
  seeder._dropUnsupportedRoots = () => {
    pass()
    if (k2AfterPass === null && !seeder._groupServed.has(K3)) k2AfterPass = seeder._groupServed.has(K2)
  }
  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert) })
  await until(() => k2AfterPass !== null, { name: 'passagem que purga K3', timeoutMs: 20000 })
  t.is(k2AfterPass, false, 'K2 dropped in the same pass')
  t.alike(seeder._goneRoots.get(K2), { creator: C.key, issuer: issuer.hex }, 'its entry now carries the issuer')
  t.ok(events.some((e) => e.event === 'group-rejected' && e.key === K2 && e.reason === 'revoked-issuer'), 'K2 dropped as revoked-issuer')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a restart drops a root accepted early in the pass whose kept entry a later root\'s revoked issuer puts in force', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxLogBlocks: 4 })

  // C, from issuer I, binds Ra, which B's writer keeps (the binding keeps I).
  const issuer = makeIssuer(assoc)
  let Ra = null
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    Ra = await make('root', groupHeader({ diary: key, name: 'Mantida' }), [groupPost({ text: 'oi' })])
    return [groupJoinRecord({ group: Ra, writer: Ra, on: true })]
  }, { certOf: (key) => createIssuedCert({ member: key }, issuer.kp, issuer.cert) })
  let W = null
  const B = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W = await make('w', writerHeader({ group: Ra, diary: key }))
    return [groupJoinRecord({ group: Ra, writer: W, on: true })]
  })
  await admit(C, assoc)
  await admit(B, assoc)
  await admitted(first.events, Ra)
  await admitted(first.events, W)
  await until(() => readGroups(dataDir)[Ra] && readGroups(dataDir)[Ra].bound === true && readGroups(dataDir)[Ra].issuer === issuer.hex, { name: 'Ra vinculado com o emissor' })

  // Rb was C's (an entry with no issuer) and is served again under D2.
  const { R: Rb } = await offerRoot(t, bootstrap, assoc, {
    keyPair: signingKeyPair(),
    beforeAdmit: (Rb) => { first.seeder._goneRoots.set(Rb, { creator: C.key, issuer: null }) }
  })
  await admitted(first.events, Rb)
  // C's diary leaves for its quota; B keeps Ra served.
  for (let i = 0; i < 3; i++) await C.diary.append(groupJoinRecord({ group: Ra, writer: Ra, on: true }))
  await until(() => first.events.some((e) => e.event === 'rejected' && e.key === C.key && e.reason === 'quota'), { name: 'C fora pela cota' })
  await until(() => readGroups(dataDir)[Rb] && readFile(dataDir).goneRoots && readFile(dataDir).goneRoots[Rb], { name: 'Rb gravado' })
  t.ok(first.seeder._groupServed.has(Ra) && first.seeder._groupServed.has(Rb), 'Ra and Rb served')
  await first.seeder.close()

  // Stopped: I is revoked, and the restart visits Rb before Ra.
  const file = readFile(dataDir)
  const groups = { [Rb]: file.groups[Rb] }
  for (const [k, v] of Object.entries(file.groups)) if (k !== Rb) groups[k] = v
  file.groups = groups
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify(file))
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [], revokedIssuers: [issuer.hex] }, mod.kp, mod.cert))
  t.is(Object.keys(readGroups(dataDir))[0], Rb, 'Rb listed first')
  t.ok(Object.keys(readGroups(dataDir)).indexOf(Ra) > 0, 'Ra after it')

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, maxLogBlocks: 4 })
  t.absent(second.seeder._groupServed.has(Rb), 'Rb is not served after the start')
  t.absent(await stored(second.seeder, Rb), 'its core is purged')
  t.alike(second.seeder._goneRoots.get(Rb), { creator: C.key, issuer: issuer.hex }, 'its entry carries the issuer')
  t.ok(second.events.some((e) => e.event === 'group-rejected' && e.key === Rb && e.reason === 'revoked-issuer'), 'dropped as revoked-issuer')
  t.absent(second.seeder._groupServed.has(Ra), 'Ra is purged too')
  t.absent(await stored(second.seeder, Ra), 'its core too')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a lifted goneRoots entry stays below the hard bound: its root, admitted again through a member, keeps `bound` and is purged when the creator is blocked again', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const others = blockedKeys(66)
  const mod = moderator(assoc)
  const list = (seq, extra) => createSnapshot({ seq, blocked: [...others, ...extra], revokedIssuers: [] }, mod.kp, mod.cert)
  const adopted = (seq) => until(() => events.find((e) => e.event === 'blocklist' && e.seq === seq), { name: 'lista ' + seq + ' adotada' })
  writeBlocklist(dataDir, list(1, []))
  // B's live join (group R, writer W) admits R again as soon as a list
  // lifts A's block, and that admission clears R's goneRoots entry. While R
  // is held, it fails before it is served, so the entry stays until then.
  const held = new Set()
  let refused = 0
  const admitHook = async (key, step) => {
    if (step !== 'persist' || !held.has(key)) return
    refused++
    throw new Error('held')
  }
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex, admitHook })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })
  held.add(R)
  // B keeps a copy of R to serve it once A is gone, so A cannot bind R again.
  const copy = B.store.get({ key: b4a.from(R, 'hex') })
  await copy.ready()
  await copy.get(0, { timeout: 20000 })
  await copy.get(1, { timeout: 20000 })
  await A.swarm.destroy()

  await reader(t, bootstrap, publicKey, { blocklist: list(2, [A.key]) })
  await rejected(events, R, 'blocked')
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(seeder, R)), { name: 'R purgado' })

  // The block is lifted. Before any join admits R again, more denials are
  // noted with the map past ROOT_CREATORS_MAX: R's lifted entry stays.
  await reader(t, bootstrap, publicKey, { blocklist: list(3, []) })
  await adopted(3)
  await until(() => refused > 0, { name: 'readmissão de R retida' })
  fillCovered(seeder, others, 4096)
  seeder._noteGoneRoot(hex(crypto.randomBytes(32)), others[0], 'blocked')
  t.absent(seeder._groupServed.has(R), 'R not admitted yet')
  t.ok(seeder._goneRoots.has(R), 'R\'s lifted entry stays')
  held.delete(R)
  await B.diary.append(groupJoinRecord({ group: R, writer: R, on: true }))
  await until(() => readGroups(dataDir)[R] && seeder._groupServed.has(R), { name: 'R de volta' })
  t.is(readGroups(dataDir)[R].bound, true, 'R keeps `bound`')

  // Blocked again: purged again, although only members keep it.
  await reader(t, bootstrap, publicKey, { blocklist: list(4, [A.key]) })
  await adopted(4)
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(seeder, R)), { name: 'R purgado de novo', timeoutMs: 20000 })
  t.absent(seeder._groupServed.has(R), 'the root is purged again')
  t.ok(seeder._groupServed.has(W), 'W kept')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root refused for a gone creator leaves its kept header fields as they were, also when the offered block 0 changes them', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const others = blockedKeys(1050)
  const mod = moderator(assoc)
  const list = (seq, extra) => createSnapshot({ seq, blocked: [...others, ...extra], revokedIssuers: [] }, mod.kp, mod.cert)
  const adopted = (seq) => until(() => events.find((e) => e.event === 'blocklist' && e.seq === seq), { name: 'lista ' + seq + ' adotada' })
  writeBlocklist(dataDir, list(1, []))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(events, R)
  await admitted(events, W)
  await until(() => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true, { name: 'R vinculado' })
  const kept = { ...seeder._groupHeaders.get(R) }
  t.is(kept.name, 'Cadeiras da praia')
  const kp = A.cores.root.keyPair
  await A.swarm.destroy()

  await reader(t, bootstrap, publicKey, { blocklist: list(2, [A.key]) })
  await rejected(events, R, 'blocked')
  await until(async () => seeder._drops.size === 0 && !(R in readGroups(dataDir)) && !(await stored(seeder, R)), { name: 'R purgado' })
  t.ok(seeder._groupServed.has(W), 'W kept, so R\'s header fields stay')
  // The block is lifted and R's entry, no longer in force, goes at the hard
  // bound (with one other lifted entry, so the map ends below it); then A is
  // blocked again. Only A's block now refuses R.
  await reader(t, bootstrap, publicKey, { blocklist: list(3, []) })
  await adopted(3)
  fillCovered(seeder, others, 65535)
  seeder._goneRoots.set(hex(crypto.randomBytes(32)), { creator: hex(crypto.randomBytes(32)), issuer: null })
  seeder._noteGoneRoot(hex(crypto.randomBytes(32)), others[0], 'blocked')
  t.absent(seeder._goneRoots.has(R), 'the lifted entry went')
  t.is(seeder._rootsClosed(), false, 'root admission stays open')
  await reader(t, bootstrap, publicKey, { blocklist: list(4, [A.key]) })
  await adopted(4)

  // R's key signs a new block 0 naming A, with another name and join rule.
  const { C } = await offerRoot(t, bootstrap, assoc, { keyPair: kp, diary: A.key, name: 'Outro nome', join: 'approval' })
  const backoff = () => seeder._groupBackoff.get(C.key + ':' + R)
  await until(() => backoff() && backoff().reason === 'blocked', { name: 'R recusado na conferência do cabeçalho' })
  t.alike(seeder._groupHeaders.get(R), kept, 'the kept header fields did not change')
  t.is(seeder.indexGroup(R).header.name, 'Cadeiras da praia', '/index/group answers the old name')
  t.absent(seeder._groups.has(R), 'R not admitted')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a root whose creator is already blocked when first fetched is refused and its header is still recorded: members\' writers are judged by its visibility', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const [D] = blockedKeys(1)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [D], revokedIssuers: [] }, mod.kp, mod.cert))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // B made public root R naming blocked D and joins it; E's writer fits R,
  // C's writer carries a box, which a public group refuses.
  let R = null
  const B = await member(t, bootstrap, assoc, async ({ make }) => {
    R = await make('root', groupHeader({ diary: D, name: 'Bloqueada' }))
    return [groupJoinRecord({ group: R, writer: R, on: true })]
  })
  let W1 = null
  const E = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W1 = await make('w', writerHeader({ group: R, diary: key }))
    return [groupJoinRecord({ group: R, writer: W1, on: true })]
  })
  let W2 = null
  const C = await member(t, bootstrap, assoc, async ({ key, make }) => {
    W2 = await make('w', writerHeader({ group: R, diary: key, box: hex(crypto.randomBytes(32)) }))
    return [groupJoinRecord({ group: R, writer: W2, on: true })]
  })
  // The writers come first, while no header of R is known here; then the
  // root, through B's join, is refused.
  await admit(E, assoc)
  await admitted(events, W1)
  await admit(C, assoc)
  await until(() => events.some((e) => e.key === W2 && (e.event === 'group-admitted' || e.event === 'group-rejected')), { name: 'W2 julgado' })
  await admit(B, assoc)
  await rejected(events, R, 'blocked')
  await until(() => !seeder._groupServed.has(W2), { name: 'W2 largado', timeoutMs: 10000 }).catch(() => {})

  t.absent(seeder._groups.has(R), 'R not admitted')
  t.is(seeder._groupVisibility(R), 'public', 'R\'s visibility is recorded')
  const page = seeder.indexGroup(R)
  t.is(page && page.header && page.header.kind, 'group', '/index/group shows its kind')
  t.is(page && page.header && page.header.visibility, 'public', 'and its visibility')
  t.ok(seeder._groupServed.has(W1), 'the fitting writer is served')
  t.absent(seeder._groupServed.has(W2), 'the boxed writer is not')
  t.ok(events.some((e) => e.event === 'group-rejected' && e.key === W2 && e.reason === 'header-invalid'), 'refused as header-invalid')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('goneRoots keeps up to 65536 entries, also across a restart, and a denial past that fails closed', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const blocked = blockedKeys(1050)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked, revokedIssuers: [] }, mod.kp, mod.cert))
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  const seeder = first.seeder

  // Past the hard bound of the other denial maps, a covered denial is kept.
  fillCovered(seeder, blocked, 8192)
  const K1 = hex(crypto.randomBytes(32))
  seeder._noteGoneRoot(K1, blocked[0], 'blocked')
  t.ok(seeder._goneRoots.has(K1), 'a denial past 8192 entries is kept')
  t.is(seeder._denialsLost, false, 'no denial was lost')

  // Past 65536 one finds no room: every root is refused (fail closed).
  fillCovered(seeder, blocked, 65536)
  const K2 = hex(crypto.randomBytes(32))
  seeder._noteGoneRoot(K2, blocked[1], 'blocked')
  t.absent(seeder._goneRoots.has(K2), 'no room for the next one')
  t.is(seeder._denialsLost, true, 'the denial is lost')
  t.ok(first.events.some((e) => e.event === 'warning' && e.reason === 'denials-full' && e.what === 'goneRoots'), 'logged as a warning')
  t.is(seeder._rootsClosed(), true, 'root admission is closed')
  const { R: F } = await offerRoot(t, bootstrap, assoc)
  await rejected(first.events, F, 'denials-full')
  t.absent(seeder._groups.has(F), 'a fresh root is refused')
  await seeder.close()

  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.is(second.seeder._goneRoots.size, 65536, 'every kept entry is read back at start')
  t.is(second.seeder._rootsClosed(), true, 'root admission stays closed after a restart')
  const { R: G } = await offerRoot(t, bootstrap, assoc)
  await rejected(second.events, G, 'denials-full')
  t.absent(second.seeder._groups.has(G), 'a fresh root is still refused')
  // A full map in force closes admission by itself, before any denial is lost.
  second.seeder._denialsLost = false
  t.is(second.seeder._rootsClosed(), true, '65536 entries in force close root admission')
  second.seeder._denialsLost = true
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})

test('a lost denial keeps root admission closed across restarts after an entry is lifted, until the operator clears the mark', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const blocked = blockedKeys(1050)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked, revokedIssuers: [] }, mod.kp, mod.cert))
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  fillCovered(first.seeder, blocked, 65536)
  first.seeder._noteGoneRoot(hex(crypto.randomBytes(32)), blocked[1], 'blocked')
  t.is(first.seeder._denialsLost, true, 'the denial is lost')
  await first.seeder._persist()
  t.is(readFile(dataDir).denialsLost, true, 'and marked in admitted.json')
  await first.seeder.close()

  // The last creator is unblocked: its entries are lifted, the map is no
  // longer all in force, and the lost root is still unknown.
  const last = blocked[Math.floor(65535 / 63)]
  writeBlocklist(dataDir, createSnapshot({ seq: 2, blocked: blocked.filter((k) => k !== last), revokedIssuers: [] }, mod.kp, mod.cert))
  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.is(second.seeder._goneRoots.size, 65536, 'every entry is read back')
  t.ok([...second.seeder._goneRoots.keys()].some((k) => second.seeder._goneRootReason(k) === null), 'one entry is lifted')
  t.is(second.seeder._rootsClosed(), true, 'root admission stays closed')
  t.is(second.events.filter((e) => e.event === 'warning' && e.reason === 'denials-full').length, 1, 'warned once at start')
  const { R: G } = await offerRoot(t, bootstrap, assoc)
  await rejected(second.events, G, 'denials-full')
  t.absent(second.seeder._groups.has(G), 'a fresh root is refused')
  await second.seeder._persist()
  await second.seeder.close()
  t.is(readFile(dataDir).denialsLost, true, 'the mark stays in admitted.json')

  // The operator clears the mark with the seeder stopped.
  const file = readFile(dataDir)
  delete file.denialsLost
  fs.writeFileSync(path.join(dataDir, 'admitted.json'), JSON.stringify(file))
  const third = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  t.is(third.seeder._rootsClosed(), false, 'root admission opens once the mark is cleared')
  t.is(third.events.filter((e) => e.event === 'warning' && e.reason === 'denials-full').length, 0, 'with no warning')
  const { A, B, R, W } = await creatorAndMember(t, bootstrap, assoc)
  await admit(A, assoc)
  await admit(B, assoc)
  await admitted(third.events, R)
  await admitted(third.events, W)
  t.is([first, second, third].reduce((n, s) => n + s.events.filter((e) => e.event === 'fatal').length, 0), 0)
})

test('denials noted in one tick share one write of admitted.json, which holds them all', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const [D] = blockedKeys(1)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [D], revokedIssuers: [] }, mod.kp, mod.cert))
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  await seeder._writeQueue
  const file = path.join(dataDir, 'admitted.json')
  const rename = fs.renameSync
  let writes = 0
  fs.renameSync = function (from, to) {
    if (to === file) writes++
    return rename.apply(this, arguments)
  }
  t.teardown(() => { fs.renameSync = rename })

  // A purge of 64 bound roots notes 64 denials back to back.
  const keys = []
  for (let i = 0; i < 64; i++) {
    keys.push(hex(crypto.randomBytes(32)))
    seeder._noteGoneRoot(keys[i], D, 'blocked')
  }
  await seeder._persist()
  await seeder._writeQueue
  fs.renameSync = rename
  t.ok(writes >= 1 && writes <= 2, 'one write for all of them (' + writes + ')')
  const kept = readFile(dataDir).goneRoots || {}
  t.ok(keys.every((k) => kept[k] && kept[k].creator === D), 'the file holds every denial')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('a creator\'s self-joins of keys never served do not keep its later roots from being purged when it is blocked', async (t) => {
  t.timeout(150000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // A first joins 64 root keys that no core ever answers to, then makes two
  // groups naming itself and joins them; B's joins keep them served.
  const real = []
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    const out = []
    for (let i = 0; i < 64; i++) {
      const k = hex(crypto.randomBytes(32))
      out.push(groupJoinRecord({ group: k, writer: k, on: true }))
    }
    for (let i = 0; i < 2; i++) {
      real.push(await make('root' + i, groupHeader({ diary: key, name: 'Grupo ' + i })))
      out.push(groupJoinRecord({ group: real[i], writer: real[i], on: true }))
    }
    return out
  })
  const B = await member(t, bootstrap, assoc, async () => real.map((R) => groupJoinRecord({ group: R, writer: R, on: true })))
  await admit(A, assoc)
  await admit(B, assoc)
  for (const R of real) await admitted(events, R)
  await until(() => scansDone(seeder) && real.every((R) => readGroups(dataDir)[R]), { name: 'diário de A lido', timeoutMs: 20000 })

  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [A.key], revokedIssuers: [] }, mod.kp, mod.cert) })
  await until(() => events.find((e) => e.event === 'blocklist' && e.seq === 1), { name: 'lista 1 adotada' })
  await until(() => seeder._drops.size === 0 && real.every((R) => !seeder._groupServed.has(R)), { name: 'grupos purgados', timeoutMs: 20000 }).catch(() => {})
  for (const R of real) {
    t.absent(seeder._groupServed.has(R), 'the group is purged')
    t.is(seeder._goneRootReason(R), 'blocked', 'and stays refused')
  }
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('one block of a creator with more than 64 bound roots remembers exactly 64, those with the lowest first join', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir, publicKey } = prepareSeederDir(t, assoc)
  const { seeder, events } = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // A made and joined 65 roots naming itself; its own joins keep 64 groups,
  // and B's join admits the 65th, the one with the newest first join.
  const roots = []
  const A = await member(t, bootstrap, assoc, async ({ key, make }) => {
    const out = []
    for (let i = 0; i < 65; i++) {
      roots.push(await make('root' + i, groupHeader({ diary: key, name: 'Raiz ' + i })))
      out.push(groupJoinRecord({ group: roots[i], writer: roots[i], on: true }))
    }
    return out
  })
  const last = roots[64]
  const B = await member(t, bootstrap, assoc, async () => [groupJoinRecord({ group: last, writer: last, on: true })])
  await admit(A, assoc)
  await admit(B, assoc)
  for (const R of roots) await admitted(events, R)
  await until(() => roots.every((R) => readGroups(dataDir)[R] && readGroups(dataDir)[R].bound === true), { name: '65 raízes vinculadas', timeoutMs: 60000 })

  const mod = moderator(assoc)
  await reader(t, bootstrap, publicKey, { blocklist: createSnapshot({ seq: 1, blocked: [A.key], revokedIssuers: [] }, mod.kp, mod.cert) })
  for (const R of roots) await rejected(events, R, 'blocked')
  await until(() => seeder._drops.size === 0 && roots.every((R) => !seeder._groupServed.has(R)), { name: 'purgas feitas', timeoutMs: 60000 })
  await seeder._persist()
  t.is(seeder._goneRoots.size, 64, 'exactly 64 denials written')
  t.ok(roots.slice(0, 64).every((R) => seeder._goneRoots.has(R)), 'the 64 with the lowest first join')
  t.absent(seeder._goneRoots.has(last), 'the 65th is purged but not remembered')
  t.is(Object.keys(readFile(dataDir).goneRoots || {}).length, 64, 'and the file holds 64')
  t.is(events.filter((e) => e.event === 'fatal').length, 0)
})

test('goneRoots names at most 64 roots per creator whatever the order and the source of their bindings, also across a restart', async (t) => {
  t.timeout(60000)
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { dataDir } = prepareSeederDir(t, assoc)
  const [X] = blockedKeys(1)
  const mod = moderator(assoc)
  writeBlocklist(dataDir, createSnapshot({ seq: 1, blocked: [X], revokedIssuers: [] }, mod.kp, mod.cert))
  const first = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })

  // 70 bound roots of X, as a hole fetched late in descending seq order or
  // an older build could leave them: 66 with a first join (seq 2..67), four
  // with none. They are noted newest first, each binding going right after
  // its note, as a purge does.
  const ranked = []
  for (let i = 0; i < 66; i++) {
    const R = hex(crypto.randomBytes(32))
    first.seeder._groups.set(R, { diary: X, group: R, seq: 2 + i, bound: true, first: 2 + i })
    ranked.push(R)
  }
  const unknown = []
  for (let i = 0; i < 4; i++) {
    const R = hex(crypto.randomBytes(32))
    first.seeder._groups.set(R, { diary: X, group: R, seq: 1, bound: true })
    unknown.push(R)
  }
  for (const R of [...unknown, ...[...ranked].reverse()]) {
    first.seeder._noteGoneRoot(R, X, 'blocked')
    first.seeder._groups.delete(R)
  }
  t.is(first.seeder._goneRoots.size, 64, 'no more than 64 entries name X')
  t.ok(ranked.slice(0, 64).every((R) => first.seeder._goneRoots.has(R)), 'the 64 lowest first joins are kept')
  await first.seeder._persist()
  await first.seeder.close()

  // After a restart the ones left out are noted again, with no first join.
  const second = await startSeeder(t, bootstrap, dataDir, { associationKey: assoc.hex })
  for (const R of [ranked[64], ranked[65], ...unknown]) second.seeder._noteGoneRoot(R, X, 'blocked')
  t.is(second.seeder._goneRoots.size, 64, 'still 64 after a restart')
  t.ok(ranked.slice(0, 64).every((R) => second.seeder._goneRoots.has(R) && second.seeder._goneRoots.get(R).first === ranked.indexOf(R) + 2), 'the same 64, with their first join')
  t.is(first.events.filter((e) => e.event === 'fatal').length + second.events.filter((e) => e.event === 'fatal').length, 0)
})
