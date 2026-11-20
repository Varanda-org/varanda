'use strict'

// The automatic history copy between devices of one passkey (docs/protocol.md
// section 11) over the real Seeder and real browser nodes: with two old
// devices online exactly one copy goes to the new one, and a disconnected
// device gets no claim and imports nothing. The copy is kicked by each old
// device's continuous run. Local DHT and tmp dirs only.

const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { stoppedOf } = require('./helpers/session')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const gc = require('@varanda/core/lib/group-crypto')
const { dmLocalKeyFromPrf } = require('../lib/passkey')
const store = require('../lib/node-store')
const { hex, seederHost, memberNode, push } = require('./helpers/dm-e2e')
const { BLOB, sleep, copyDiary, sweepPool, textsOf } = require('./helpers/dm-copy')
const { account, sibling, ownDrops, claimsOf, copiesOf, copied, kick } = require('./helpers/dm-auto')

async function setup (t, { old, fresh }) {
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const acct = await account(t, assoc, host, { old, fresh, blob: BLOB })
  const A = acct.first
  const P = await memberNode(t, assoc, host, { blob: BLOB })
  await copyDiary(A, P)
  await copyDiary(P, A)
  await A.web.request('dm.send', { to: P.key, text: 'oi' })
  await A.web.request('dm.send', { to: P.key, text: 'tudo bem?' })
  await P.web.request('dm.pull')
  await P.web.request('dm.send', { to: A.key, text: 'tudo' })
  return { assoc, host, acct, A, P }
}

test('two old devices online: one claim wins and exactly one copy goes to the new device', async (t) => {
  t.timeout(300000)
  const { assoc, host, acct, A, P } = await setup(t, { old: 2, fresh: 1 })
  const [, idB] = acct.old
  const [idC] = acct.fresh
  const B = await sibling(t, assoc, host, acct, idB, { blob: BLOB })
  t.is((await B.web.request('dm.pull')).added, 3, 'the other old device holds the conversation too')
  await A.web.request('dm.pull')
  // The pool forgets the originals: what C gets comes from the copy.
  await sweepPool(host)

  await Promise.all([kick(A), kick(B)])
  await copied(t, host, acct)
  // Long enough for the losing claim to settle and step back.
  await until(async () => claimsOf(await ownDrops(t, host, acct)).length >= 2, { name: 'both claims', timeoutMs: 60000, intervalMs: 500 })
  await sleep(8000)
  const drops = await ownDrops(t, host, acct)
  const claims = claimsOf(drops)
  t.is(claims.length, 2, 'both old devices claimed')
  t.alike(claims.map((c) => c.body.for), [[idC], [idC]], 'each for the new device only')
  t.alike(claims.map((c) => c.body.by).sort(), [acct.old[0], idB].sort(), 'one claim by each')
  const copies = copiesOf(drops)
  t.is(copies.length, 1, 'exactly one text copy')
  t.is(copies[0].body.id, claims[0].body.copy, 'made by the claim first in the pool')

  const C = await sibling(t, assoc, host, acct, idC, { blob: BLOB })
  t.is((await C.web.request('device.list')).self, idC, 'the new device knows its id')
  await C.web.request('dm.pull')
  await until(() => C.web.events.some((e) => e.name === 'dm.copyImported'), { name: 'copyImported', timeoutMs: 60000 })
  t.alike(textsOf(await C.web.request('dm.thread', { peer: P.key })), ['oi', 'tudo', 'tudo bem?'], 'the new device holds the conversation')
})

test('a disconnected device gets no claim, and one turned off after its copy imports nothing', async (t) => {
  t.timeout(300000)
  const { assoc, host, acct, A, P } = await setup(t, { old: 1, fresh: 2 })
  const [idC, idD] = acct.fresh
  await A.web.request('dm.pull')
  await sweepPool(host)
  // D is turned off before any copy.
  await A.web.request('device.disconnect', { id: idD })
  await kick(A)
  const drops = await copied(t, host, acct)
  const claims = claimsOf(drops)
  t.is(claims.length, 1, 'one claim')
  t.alike(claims[0].body.for, [idC], 'for the device still on, never the disconnected one')
  const copies = copiesOf(drops)
  t.is(copies.length, 1, 'one copy')

  // C is turned off after its copy went: it imports nothing.
  await A.web.request('device.disconnect', { id: idC })
  await A.web.request('sync.stop')
  await push(t, A, host)
  // An off device is not admitted to push, so its run reads the diary
  // without the push check, then dm.enable finds the key current.
  const C = await sibling(t, assoc, host, acct, idC, { blob: BLOB, enable: false })
  const { runId } = await C.web.request('sync.start', { once: true, timeoutMs: 30000 })
  await stoppedOf(C.web.events, runId)
  t.is((await C.web.request('device.list')).off, true, 'C knows it is off')
  await C.web.request('dm.enable')
  const gets = host.blobGets
  const pulled = await C.web.request('dm.pull')
  t.is(pulled.incomplete, false, 'the pull went through')
  // The pointer reached C and was set aside unread: what follows is the off
  // rule at work, not a pull that brought nothing.
  const localKey = await dmLocalKeyFromPrf(acct.prf)
  let copyState = null
  await until(async () => {
    const sealed = await store.readDmCopy(C.storage)
    copyState = sealed === null ? null : gc.openRecord(sealed, localKey)
    return copyState !== null && copyState.imported.includes(copies[0].body.id)
  }, { name: 'copy pointer handled', timeoutMs: 30000, intervalMs: 250 })
  t.is(copyState.todo.length, 0, 'the copy pointer reached C and nothing waits')
  await sleep(3000)
  t.is(host.blobGets, gets, 'the device that is off fetched nothing')
  t.absent(C.web.events.some((e) => e.name === 'dm.copyImported'), 'and imported nothing')
  t.alike(textsOf(await C.web.request('dm.thread', { peer: P.key }).catch(() => ({ messages: [] }))), [], 'no conversation there')
})
