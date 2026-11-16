'use strict'

// Member sync of group cores: a quarantine read racing a main-store open of
// the same binding diary (lib/sync.js openMain).
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { testnet } = require('./helpers/net')
const { createCert, generateAssociationKeyPair } = require('../lib/cert')
const { writerHeader } = require('../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../lib/records')
const { hex, PARENT, syncOnce, fakeSeeder, groupMember } = require('./helpers/sync-groups')

// Resolves true once `fn()` holds, false after `ms`.
async function waitFor (fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return fn()
}

test('a gate reading a binding diary through the quarantine while another gate opens it in the main store still gets its blocks', async (t) => {
  t.timeout(120000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const group = hex(crypto.randomBytes(32))
  const items = []
  const fake = await fakeSeeder(t, bootstrap, kp, items)
  // Two writers of the group bound by one diary: both gates read it.
  const d = fake.store.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(createCert({ member: dkey }, kp)))))
  const writers = []
  for (const name of ['w1', 'w2']) {
    const w = fake.store.get({ name })
    await w.ready()
    await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: hex(w.key), on: true }))))
    await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey, member: PARENT }))))
    writers.push(hex(w.key))
    items.push({ key: hex(w.key), diary: dkey, length: 1, seq: writers.length })
  }
  items.sort((x, y) => x.key < y.key ? -1 : 1)

  const m = await groupMember(t, kp, group)
  const events = []
  let diaryReads = 0
  let secondRead = false
  let opening = false
  // The first gate to pass opens the diary in the main store only once the
  // other gate's quarantine read of it is ready and has not replicated yet;
  // that read replicates once the first writer is downloaded (its replica
  // then owns the diary's channel), or after a while when the open waits.
  const quarantineHook = async (key) => {
    if (key !== dkey || ++diaryReads !== 2) return
    secondRead = true
    await waitFor(() => events.some((ev) => ev.event === 'group-downloaded'), 3000)
  }
  const openHook = async (key) => {
    if (!writers.includes(key) || opening) return
    opening = true
    await waitFor(() => secondRead, 10000)
  }
  // Wide budgets: with the fix the second read waits out the 3 s above, and
  // the machine may be busy.
  const { result } = await syncOnce(bootstrap, m, { gateTimeoutMs: 30000, timeoutMs: 60000, onEvent: (ev) => events.push(ev), openHook, quarantineHook })
  t.ok(result.ok, result.errors.join('; '))
  t.ok(secondRead, 'the second gate read the diary through the quarantine')
  t.alike(events.filter((ev) => ev.event === 'group-skipped'), [], 'nothing skipped')
  for (const w of writers) t.ok(events.some((ev) => ev.event === 'group-downloaded' && ev.key === w), 'writer ' + w.slice(0, 8) + ' downloaded')
})
