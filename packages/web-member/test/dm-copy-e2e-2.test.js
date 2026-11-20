'use strict'

// More of the history copy (docs/protocol.md section 11), over the real
// Seeder and real browser nodes, as dm-copy-e2e.test.js: the maker's side (a
// held Página with no rows, no copy allowance) and the importing side (shown
// time, one import at a time, replays, seen marks). A retry that holds its
// stamps is in dm-copy-unit-2.test.js. Local DHT and tmp dirs only.

const test = require('brittle')
const { testnet, until } = require('./helpers/net')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const store = require('../lib/node-store')
const { hex, seederHost, memberNode, png } = require('./helpers/dm-e2e')
const { BLOB, sleep, copyDiary, sweepPool, textsOf, adoptPage } = require('./helpers/dm-copy')
const { account, sibling, ownDrops, copiesOf, kick, idle } = require('./helpers/dm-auto')

const imports = (n) => n.web.events.filter((e) => e.name === 'dm.copyImported')

// The old device A of a new account and its newer device A2 (which knows
// its own device id, as the session tells the engine).
async function devicesOf (t, assoc, host, blob) {
  const acct = await account(t, assoc, host, { old: 1, fresh: 1, blob })
  const A2 = await sibling(t, assoc, host, acct, acct.fresh[0], { blob })
  t.is((await A2.web.request('device.list')).self, acct.fresh[0], 'A2 knows its device id')
  return { acct, A: acct.first, A2 }
}

test('an empty held Página does not end the copy; without the copy allowance the photos stay out; imported rows show their real time', async (t) => {
  t.timeout(200000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const { acct, A, A2 } = await devicesOf(t, assoc, host, BLOB)
  const P = await memberNode(t, assoc, host, { blob: BLOB })
  await copyDiary(A, P)
  await copyDiary(P, A)

  // An adopted Página with no conversation yet, held by A.
  await adoptPage(t, assoc, A, [A])

  // A2 pulls the first message early: its oldest row is filed then.
  await A.web.request('dm.send', { to: P.key, text: 'oi' })
  t.is((await A2.web.request('dm.pull')).added, 1, 'A2 holds the first message')
  await sleep(1500)
  const item = await A.node.dmPutMedia({ bytes: png(3000), mime: 'image/png', width: 64, height: 48, to: P.key })
  await A.web.request('dm.send', { to: P.key, text: 'segunda', media: [item] })
  await P.web.request('dm.pull')
  await P.web.request('dm.send', { to: A.key, text: 'resposta' })
  await A.web.request('dm.pull')
  await sweepPool(host)
  // The weekly copy allowance is spent: the seeder answers 'teto' to every
  // copy stamp, so the text goes on the daily wallet and the photo stage
  // ends at once. (A copy-stamp failure that is not 'teto' fails the kick
  // instead and is tried again: dm-copy-auto.test.js.)
  const seeder = host.current
  const take = seeder._takeStamp.bind(seeder)
  seeder._takeStamp = (diary, day, kind) => {
    if (kind === 'copy') return false
    return take(diary, day, kind)
  }

  await kick(A)
  await idle(t, A)
  t.is(copiesOf(await ownDrops(t, host, acct)).length, 1, 'the text went, and no photo batch: the copy allowance cannot be used')

  await A2.web.request('dm.pull')
  await until(() => imports(A2).length > 0, { name: 'copyImported', timeoutMs: 60000 })
  t.is(imports(A2)[0].data.messages, 2, 'the own store came, though the Página had no rows')

  const thread = await A2.web.request('dm.thread', { peer: P.key })
  t.alike(textsOf(thread), ['oi', 'resposta', 'segunda'])
  const byText = (th, text) => th.messages.find((m) => m.text === text)
  t.is(byText(thread, 'segunda').media[0].id, item.id, 'the photo was not re-put: its descriptor is the original one')

  // The time an imported row shows is the maker's, not the receiver's oldest
  // filing time: it shows after the first message A2 pulled, and as on A.
  const onA = await A.web.request('dm.thread', { peer: P.key })
  t.ok(Date.parse(byText(thread, 'segunda').at) > Date.parse(byText(thread, 'oi').at), 'a message of the offline weeks is not dated before the first one')
  t.is(byText(thread, 'segunda').at, byText(onA, 'segunda').at, 'shown as on the maker')
  t.is(byText(thread, 'resposta').at, byText(onA, 'resposta').at, 'a received message too')
})

test('one import at a time, replays file nothing, and seen marks go in front', async (t) => {
  t.timeout(200000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const { A, A2 } = await devicesOf(t, assoc, host, BLOB)
  const P = await memberNode(t, assoc, host, { blob: BLOB })
  await copyDiary(A, P)
  await copyDiary(P, A)

  await A.web.request('dm.send', { to: P.key, text: 'um' })
  await A.web.request('dm.send', { to: P.key, text: 'dois' })
  await P.web.request('dm.pull')
  await P.web.request('dm.send', { to: A.key, text: 'tres' })
  await A.web.request('dm.pull')
  await A.web.request('dm.seen', { peer: P.key })
  await sweepPool(host)

  // A2 already has seen marks of its own.
  const own = ['a', 'b', 'c'].map((c) => c.repeat(32))
  await store.writeDmSeen(A2.storage, own)

  await kick(A)
  await idle(t, A)

  // Two pulls overlap while the seeder answers slowly: one job imports.
  host.blobDelayMs = 300
  const p1 = A2.web.request('dm.pull')
  await sleep(600)
  const p2 = A2.web.request('dm.pull').catch(() => null)
  await p1
  await p2
  await until(() => imports(A2).length > 0, { name: 'copyImported', timeoutMs: 60000 })
  host.blobDelayMs = 0
  await sleep(2500)
  t.is(imports(A2).length, 1, 'one notice, not one per pull')
  t.is(imports(A2)[0].data.messages, 3, 'each message counted once')
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: P.key })), ['dois', 'tres', 'um'])

  // The seen mark of A came in front of the three of A2.
  const seen = await store.readDmSeen(A2.storage)
  t.is(seen.length, 4, 'one imported mark and the three own')
  t.alike(seen.slice(-3), own, 'the own marks stay last, where the cap keeps them')

  // The same copy again, after the imported list forgot it: nothing new.
  await A2.storage.writeJson('dmCopy', null)
  await store.writeDmCursor(A2.storage, 0)
  const before = host.blobGets
  await A2.web.request('dm.pull')
  await until(() => host.blobGets > before + 1, { name: 'refetched', timeoutMs: 30000 })
  await sleep(1500)
  t.is(imports(A2).length, 1, 'no second notice')
  t.alike(textsOf(await A2.web.request('dm.thread', { peer: P.key })), ['dois', 'tres', 'um'], 'no duplicate')
  t.is((await store.readDmSeen(A2.storage)).length, 4, 'no seen mark twice')
})
