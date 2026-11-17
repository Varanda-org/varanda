'use strict'

// The admin device of a Página holds its secrets but not its diary (#352,
// from #441). The session's continuous run finds the page's live group joins
// by the bounded diary peek (refreshRemotePageRoots), restarts once with them
// as pageRoots, and keeps the group synced. No stub: a real session
// (helpers/dm-e2e.js memberNode) against a real Seeder over WebSocket on the
// local DHT; the test never peeks and never passes pageRoots itself.
const test = require('brittle')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, until } = require('./helpers/net')
const { hex, seederHost, memberNode } = require('./helpers/dm-e2e')
const { stoppedOf } = require('./helpers/session')
const { createCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const { runSync } = require('../lib/sync')
const { createGroupKeys } = require('../lib/group-keys')
const { memoryNodeStorage } = require('../lib/node-storage')
const { groupKeyPairFromPrf, dmBoxKeyPairFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)

function noop () {}

async function plainMember (t, assocKp, name, keyPair = crypto.keyPair()) {
  const storage = memoryNodeStorage()
  const prf = crypto.randomBytes(32)
  const groupKeys = createGroupKeys()
  t.teardown(() => groupKeys.close(), { force: true })
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce), groupKeys }
  await ops.idCreate(ctx)
  const key = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: key }, assocKp))
  if (name !== null) await ops.profileSet(ctx, { name, bio: '' })
  await groupKeys.unlock(storage, prf)
  return { storage, key, ctx, keyPair }
}

function once (m, url) {
  return runSync({
    storage: m.storage,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    retryMinMs: 100,
    retryMaxMs: 200,
    mediaPollMs: 50,
    groupsChangedMs: 20,
    once: true,
    timeoutMs: 30000,
    onEvent: () => {}
  })
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

async function share (from, to, keys) {
  await pipe(await store.openDiary(from.storage), await store.openReplica(to.storage, from.key))
  for (const key of keys) {
    await pipe(await store.openGroupCoreReadOnly(from.storage, key), await store.openGroupReplica(to.storage, key))
    await store.addGroupReplica(to.storage, key)
  }
  await store.addGroupDiary(to.storage, from.key)
}

async function ownWriter (s, group) {
  const e = (await store.readGroupWriters(s.storage)).find((x) => x.group === group)
  return e === undefined ? null : e.key
}

async function lengthOf (storage, key) {
  const core = await store.openGroupCoreReadOnly(storage, key)
  if (core === null) return 0
  try { return core.contiguousLength } finally { await core.close() }
}

test('a page admin node that does not store the page diary finds its group roots by peek and keeps the group synced', async (t) => {
  // Under the runner's 180 s kill, so a slow failure still names its wait.
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc)
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }

  // N: the admin device, a real session that owns page P.
  const N = await memberNode(t, assoc, host)
  const boxN = hex((await dmBoxKeyPairFromPrf(N.prf, 1)).publicKey)
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const made = await N.web.request('dm.pageGenerate', { page: P, gen: 1, recipients: [{ member: N.key, box: boxN }] })

  // The page diary, kept apart from N: certificate, roster naming N as
  // owner, the dm-key, then the page's join of a private group G that O made.
  const o = await plainMember(t, kp, 'Ana')
  const p = await plainMember(t, kp, null, pageKp)
  const diary = await store.openDiary(p.storage, pageKp)
  const fields = { page: P, gen: 1, owner: N.key, admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }
  await store.appendRecord(diary, issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, N.keyPair) }, issuer.kp, issuer.cert))
  await store.appendRecord(diary, { type: 'dm-key', box: made.box, gen: 1, at: AT })
  await diary.close()

  const { community, group: general } = await ops.communityCreate(o.ctx, { name: 'Bairro', join: 'open' })
  const { group } = await ops.groupCreate(o.ctx, { name: 'Conselho', join: 'approval', visibility: 'private', community })
  await share(o, p, [community, general, group])
  await ops.communityJoin(p.ctx, { community })
  await ops.groupJoin(p.ctx, { group })
  await share(p, o, [await ownWriter(p, community), await ownWriter(p, general), await ownWriter(p, group)])
  await ops.groupAdmit(o.ctx, { group, member: P, on: true })
  await ops.groupPost(o.ctx, { group, text: 'um' })
  t.ok((await once(o, host.url)).ok)
  t.ok((await once(p, host.url)).ok)

  // N's stored cores are read only with no run up: group replicas are not
  // shared instances (node-store openGroupReplica), and a second Hypercore
  // on a core the live run downloads into drops the run's blocks. So a
  // check stops the run and compares; a mismatch starts it again (with the
  // roots the session kept) until the core changes, then checks again. A
  // group is read at a run's start and its root can land a run after the
  // community that lists it, so a few rounds may be needed.
  const changedSince = (mark, key) => N.web.events.slice(mark).some((e) => e.name === 'groups.changed' && e.data.group === key)
  const untilStored = async (key, name) => {
    for (let round = 0; ; round++) {
      await N.web.request('sync.stop', {})
      const here = await lengthOf(N.storage, key)
      const there = await lengthOf(o.storage, key)
      if (here > 0 && here === there) return here
      if (round >= 4) throw new Error('tempo esgotado: ' + name + ' (' + here + ' de ' + there + ')')
      const mark = N.web.events.length
      await N.web.request('sync.start', {})
      await until(() => changedSince(mark, key), { name, timeoutMs: 20000 }).catch(noop)
    }
  }

  // N adopts the secrets while a continuous run is up: page.read peeks the
  // roster from the seeder, since N does not store the diary, and the peek is
  // served by a run. Adoption alone starts no scan; the next run does.
  const s1 = made.shares[0]
  const adopt = { page: P, gen: 1, sealed: s1.sealed, by: N.key, sig: s1.sig, box: made.box, groupBox: made.groupBox, cert: createCert({ member: P }, kp) }
  await N.web.request('sync.start', {})
  let adopted = null
  await until(async () => {
    try {
      adopted = await N.web.request('dm.pageSecrets', adopt)
      return true
    } catch {
      return false
    }
  }, { name: 'secrets adopted', timeoutMs: 60000, intervalMs: 200 })
  t.alike(adopted, { ok: true })
  await N.web.request('sync.stop', {})
  t.is(await store.replicaExists(N.storage, P), false, 'N does not store the page diary')
  t.is(await lengthOf(N.storage, community), 0, 'nor the community')
  t.is(await lengthOf(N.storage, group), 0, 'nor the group')

  // The next continuous run scans the held page and restarts with its roots.
  // No restart or request of ours until the community changed: only the
  // scan's own roots restart preempts this run, and only its successor
  // brings the community, which nothing else on N follows.
  const mark = N.web.events.length
  const { runId } = await N.web.request('sync.start', {})
  t.is((await stoppedOf(N.web.events, runId)).reason, 'preempted', 'the scan found the roots and restarted the run')
  await until(() => changedSince(mark, community), { name: 'community fetched', timeoutMs: 60000 })
  t.pass('the community root came in by the scan restart')
  t.ok(await untilStored(community, 'community stored'), 'the community is stored whole')
  t.ok(await untilStored(group, 'group fetched'), 'the group root came in through the runs')

  await ops.groupPost(o.ctx, { group, text: 'dois' })
  t.ok((await once(o, host.url)).ok)
  // The group is not live inside a run (it is read at the run's start), so
  // a later run, which starts with the roots the scan kept, brings it.
  const before = await lengthOf(N.storage, group)
  t.ok((await untilStored(group, 'second post')) > before, 'a later run keeps it synced')
  t.alike(await store.readGroupWriters(N.storage), [], 'never an own writer')
})
