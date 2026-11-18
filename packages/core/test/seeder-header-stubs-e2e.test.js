'use strict'

// Header stubs end to end (#350, docs/protocol.md section 10, "Seeder group
// admission"): a real seeder keeps the block 0 of a core a member's diary
// joined to a group but that can never count for it, and lists it to a
// reader that announces CAP_HEADER_STUBS. The reader holds that block alone,
// though the core's author is never reachable from it, and its fold no
// longer waits for the core.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { generateAssociationKeyPair } = require('../lib/cert')
const { groupJoinRecord } = require('../lib/records')
const store = require('../lib/store')
const member = require('../lib/member')
const { hex, person, exchange, startSeeder, syncOnce, runUntil, heldCopy, recorded, texts } = require('./helpers/sync-groups')

test('a seeder keeps a joined core whose block 0 can never count as a header stub, and a reader that never reaches its author holds that block alone (#350)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const seeder = await startSeeder(t, bootstrap, kp)
  const a = await person(t, kp, 'Ana')
  const b = await person(t, kp, 'Bia')
  const { community } = await member.communityCreate(a, { name: 'Bairro', join: 'open' })
  const { group } = await member.groupCreate(a, { name: 'Horta', join: 'open', community })
  await exchange(a, b)
  await member.communityJoin(b, { community })
  await member.groupJoin(b, { group })
  await member.groupPost(b, { group, text: 'oi' })

  // B's diary also joins Kb to G: a core of B's store whose block 0 is no
  // writer header, with blocks past it. A never exchanges with B again.
  let kb = null
  const s = await store.openStore(b.dataDir)
  try {
    const core = s.get({ name: 'kb' })
    await core.ready()
    await core.append(crypto.randomBytes(64))
    await core.append(b4a.from('um'))
    await core.append(b4a.from('dois'))
    kb = hex(core.key)
    await core.close()
    await store.appendRecord(await store.openDiary(s), groupJoinRecord({ group, writer: kb, on: true }))
  } finally {
    await s.close()
  }

  const ra = await syncOnce(bootstrap, a)
  t.ok(ra.result.ok, 'A pushes its diary and root: ' + ra.result.errors.join('; '))
  const held = () => seeder._stubCores?.get(kb)?.ready === true
  await runUntil(b, bootstrap, held)
  t.ok(held(), 'the seeder holds Kb\'s block 0 as a header stub')

  const logs = []
  const r = await syncOnce(bootstrap, a, { log: (line) => logs.push(line) })
  t.ok(r.result.ok, r.result.errors.join('; '))
  t.alike(r.events.filter((ev) => ev.event === 'group-skipped' && ev.key === kb).map((ev) => ev.reason), [], 'Kb\'s listing is never refused')
  t.is(recorded(a)[kb], b.key, 'recorded with the diary that joined it')
  t.alike(await heldCopy(a, kb), { contiguous: 1, held: [0] }, 'block 0 alone')
  t.absent(logs.some((l) => l.includes('listou escritores errados demais')), 'the seeder is not cut off')
  t.ok((await texts(a, group)).includes('oi'), 'B\'s writer is read')
  t.is((await member.groupRead(a, { group })).incomplete, false, 'the fold no longer waits for Kb')
})
