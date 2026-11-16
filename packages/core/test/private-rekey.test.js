'use strict'

// The periodic rotation of a private group's epoch key on the core node
// (member.periodicRekey; the policy is lib/group-rekey.js), with an
// injected clock: a due group rotates once and every member reads after,
// a group not due does not, a failure writes nothing, a plain member never
// rotates and a second distributor waits. The session tests script the
// sync (no network): runSync is replaced before session.js loads.
const test = require('brittle')

const syncPath = require.resolve('../lib/sync')
const realSync = require(syncPath)
const idle = async () => ({ ok: true, downloaded: {}, unadvertised: [], skipped: [], errors: [] })
let scripted = idle
require.cache[syncPath].exports = { ...realSync, runSync: (opts) => scripted(opts) }

const member = require('../lib/member')
const { REKEY_PERIOD_MS, REKEY_OTHER_WAIT_MS, REKEY_JITTER_MS, REKEY_CHECK_MS } = require('../lib/group-rekey')
const { exchange, sync, rootEntries, texts, privateGroup, ownWriter } = require('./helpers/private-member')
const { newSession, connect, until } = require('./helpers/net')
const store = require('../lib/store')

const DAY = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000

const firstBlocks = (entries) => entries.filter((e) => e.record.type === 'group-key' && e.record.kid === null).length

// Under load the two nodes' setup alone can take about 30 s.
const SLOW_MS = 180000

async function admitted (t) {
  t.timeout(SLOW_MS)
  const { kp, a, b, group } = await privateGroup(t)
  await member.groupPost(a, { group, text: 'antes da troca' })
  await member.groupAdmit(a, { group, member: b.key, on: true })
  await exchange(a, b)
  return { kp, a, b, group }
}

async function openedAt (a, group) {
  return Date.parse((await rootEntries(a, group))[1].record.at)
}

test('core: a due group rotates once, and every member reads after the rotation', async (t) => {
  const { a, b, group } = await admitted(t)
  const before = (await member.groupRead(a, { group })).epoch
  const now = Date.now() + REKEY_PERIOD_MS + MINUTE
  const r = await member.periodicRekey(a, { now })
  t.ok(r.checked.includes(group))
  t.alike(r.rotated, [group])
  t.alike(r.failed, [])
  const after = await member.groupRead(a, { group })
  t.is(after.state, 'ok')
  t.not(after.epoch.seq, before.seq, 'a new epoch in use')
  t.is(firstBlocks(await rootEntries(a, group)), 2)

  const again = await member.periodicRekey(a, { now })
  t.alike(again.rotated, [], 'the new epoch is idle')
  t.is(firstBlocks(await rootEntries(a, group)), 2, 'rotated once')

  await member.groupPost(a, { group, text: 'depois da troca' })
  await exchange(a, b)
  const read = await member.groupRead(b, { group })
  t.is(read.state, 'ok')
  t.alike(read.epoch, after.epoch)
  t.alike(texts(read), ['antes da troca', 'depois da troca'])
  await member.groupPost(b, { group, text: 'da Bia' })
  await exchange(b, a)
  t.ok(texts(await member.groupRead(a, { group })).includes('da Bia'), 'the creator reads the member')
})

test('core: a group not due yet does not rotate', async (t) => {
  const { a, group } = await admitted(t)
  const opened = await openedAt(a, group)
  const r = await member.periodicRekey(a, { now: opened + REKEY_PERIOD_MS - MINUTE })
  t.alike(r.rotated, [])
  t.is(r.next, opened + REKEY_PERIOD_MS)
  t.is(firstBlocks(await rootEntries(a, group)), 1)
  const skipped = await member.periodicRekey(a, { now: Date.now() + 365 * DAY, ready: () => false })
  t.alike([skipped.checked, skipped.rotated], [[], []], 'ready() skips every group')
})

test('core: a failed rotation writes nothing and leaves the group not rekey-pending', async (t) => {
  const { a, group } = await admitted(t)
  const s = require('../lib/store')
  const st = await s.openStore(a.dataDir)
  let bytes
  try {
    const core = st.get({ key: Buffer.from(group, 'hex'), writable: false })
    await core.ready()
    bytes = core.byteLength
  } finally {
    await st.close()
  }
  const free = Math.ceil(bytes / 9) + 1
  const ctx = { ...a, limits: { maxLogBytes: bytes + free } }
  const r = await member.periodicRekey(ctx, { now: Date.now() + REKEY_PERIOD_MS + MINUTE })
  t.alike(r.rotated, [])
  t.alike(r.failed, [{ group, message: 'rotação grande demais para o espaço do diário' }])
  t.is(firstBlocks(await rootEntries(a, group)), 1, 'no block written')
  t.is((await member.groupRead(a, { group })).state, 'ok', 'not rekey-pending')
  await member.groupPost(a, { group, text: 'segue' })
})

test('core: a plain member never rotates', async (t) => {
  const { b, group } = await admitted(t)
  const r = await member.periodicRekey(b, { now: Date.now() + 365 * DAY })
  t.ok(r.checked.includes(group), 'checked')
  t.alike([r.rotated, r.failed, r.next], [[], [], null])
  t.is(firstBlocks(await rootEntries(b, group)), 1)
})

test('core: two distributors, the opener rotates at once and the other waits', async (t) => {
  const { a, b, group } = await admitted(t)
  await member.groupAdmin(a, { group, member: b.key, on: true })
  await sync(a, b)
  t.is((await member.groupInfo(b, { group })).role, 'admin')
  const due = (await openedAt(a, group)) + REKEY_PERIOD_MS
  const jitter = () => 0.25
  const wait = due + REKEY_OTHER_WAIT_MS + Math.floor(0.25 * REKEY_JITTER_MS)
  const rb = await member.periodicRekey(b, { now: due, jitter })
  t.alike(rb.rotated, [], 'the other admin waits')
  t.is(rb.next, wait)
  t.alike((await member.periodicRekey(a, { now: due, jitter })).rotated, [group], 'the opener rotates')
  await sync(a, b)
  t.alike((await member.periodicRekey(b, { now: wait, jitter })).rotated, [], 'the new epoch is idle: nothing for the other admin')
  const bw = ownWriter(b, group)
  t.ok(bw !== group)
  t.is((await member.groupRead(b, { group })).state, 'ok')
})

// ---- the session ----

// A continuous run that lasts until it is aborted; `emit` reaches the
// live run's onEvent.
function continuous () {
  const live = { onEvent: null }
  scripted = ({ signal, onEvent }) => new Promise((resolve) => {
    live.onEvent = onEvent
    const done = () => resolve({ ok: true, downloaded: {}, unadvertised: [], skipped: [], errors: [] })
    if (signal.aborted) return done()
    signal.addEventListener('abort', done)
  })
  return live
}

const started = (link) => link.events.filter((e) => e.event === 'sync.started').length
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// `now`: the session's rekey clock.
async function sessionOf (t, a, now) {
  const session = newSession(t, {
    dataDir: a.dataDir,
    association: a.association,
    bootstrap: ['127.0.0.1:49737'],
    rekeyClock: now,
    rekeyRandom: () => 0,
    rekeyDelayMs: 50
  })
  return connect(t, session)
}

// Every check the session runs: its clock reading and its groups.
function spyChecks (t) {
  const calls = []
  const real = member.periodicRekey
  member.periodicRekey = (ctx, opts) => {
    calls.push({ now: opts.now, groups: opts.groups === null ? null : [...opts.groups] })
    return real(ctx, opts)
  }
  t.teardown(() => { member.periodicRekey = real })
  return calls
}

test('core session: a continuous run checks after its start, rotates a due group once and runs on', async (t) => {
  const { a, group } = await admitted(t)
  const now = Date.now() + REKEY_PERIOD_MS + MINUTE
  continuous()
  const link = await sessionOf(t, a, () => now)
  await link.call('sync.start', { once: false })
  await until(() => link.events.some((e) => e.event === 'groups.changed' && e.data.group === group), { name: 'rotação' })
  await until(() => started(link) === 2, { name: 'a sincronização volta' })
  await settle(300)
  t.is(started(link), 2, 'one check, not repeated')
  t.alike(link.events.filter((e) => e.event === 'sync.stopped').map((e) => e.data.reason), ['preempted'])
  await link.call('sync.stop')
  t.is(firstBlocks(await rootEntries(a, group)), 2, 'rotated once')
  t.is((await member.groupRead(a, { group })).state, 'ok')
})

test('core session: a once run never checks', async (t) => {
  const { a, group } = await admitted(t)
  const now = Date.now() + REKEY_PERIOD_MS + MINUTE
  const calls = spyChecks(t)
  scripted = async ({ onEvent }) => {
    onEvent({ event: 'group-downloaded', key: group, group, length: 3 })
    return idle()
  }
  const link = await sessionOf(t, a, () => now)
  await link.call('sync.start', { once: true })
  await until(() => link.events.some((e) => e.event === 'sync.stopped'), { name: 'fim' })
  await settle(300)
  t.is(started(link), 1)
  t.is(calls.length, 0, 'no check')
  t.is(firstBlocks(await rootEntries(a, group)), 1, 'nothing written')
})

test('core session: growth inside a group\'s hour waits for the hour to end, then one check', async (t) => {
  const { a, group } = await admitted(t)
  const opened = await openedAt(a, group)
  // Due half an hour after the start check: that check finds it young.
  let offset = opened + REKEY_PERIOD_MS - REKEY_CHECK_MS / 2 - Date.now()
  const now = () => Date.now() + offset
  const calls = spyChecks(t)
  const live = continuous()
  const link = await sessionOf(t, a, now)
  await link.call('sync.start', { once: false })
  await until(() => calls.length === 1 && started(link) === 2, { name: 'checagem do início' })
  t.is(calls[0].groups, null, 'the start checks every group')
  t.is(firstBlocks(await rootEntries(a, group)), 1, 'young at the start')

  // Due now, 2 s before the group's hour ends: two growths wait for it.
  const first = calls[0].now
  offset += first + REKEY_CHECK_MS - 2000 - now()
  live.onEvent({ event: 'group-downloaded', key: group, group, length: 3 })
  await settle(100)
  live.onEvent({ event: 'group-downloaded', key: group, group, length: 4 })
  await until(() => calls.length === 2, { name: 'checagem ao fim da hora' })
  t.ok(calls[1].now >= first + REKEY_CHECK_MS, 'not before the hour ends')
  t.alike(calls[1].groups, [group], 'the grown group')
  await until(() => started(link) === 3, { name: 'a sincronização volta' })
  await link.call('sync.stop')
  t.is(calls.length, 2, 'two growths, one check')
  t.is(firstBlocks(await rootEntries(a, group)), 2, 'rotated')
})

test('core session: a community\'s growth never reaches the check', async (t) => {
  const { a, group } = await admitted(t)
  const community = store.readGroups(a.dataDir).find((g) => g.kind === 'community').group
  const opened = await openedAt(a, group)
  let offset = opened + MINUTE - Date.now()
  const now = () => Date.now() + offset
  const calls = spyChecks(t)
  const live = continuous()
  const link = await sessionOf(t, a, now)
  await link.call('sync.start', { once: false })
  await until(() => calls.length === 1 && started(link) === 2, { name: 'checagem do início' })

  // Every gate open: the community and the group grow in one burst.
  offset += 2 * REKEY_CHECK_MS
  live.onEvent({ event: 'group-downloaded', key: community, group: community, length: 5 })
  live.onEvent({ event: 'group-downloaded', key: group, group, length: 5 })
  await until(() => calls.length === 2, { name: 'checagem do grupo' })
  t.alike(calls[1].groups, [group], 'only the group: a community is never checked, so never marked')
  await until(() => started(link) === 3, { name: 'a sincronização volta' })

  // The community alone, again and again: no check, no stop.
  offset += 2 * REKEY_CHECK_MS
  for (let i = 0; i < 3; i++) {
    live.onEvent({ event: 'group-downloaded', key: community, group: community, length: 6 + i })
    await settle(150)
  }
  live.onEvent({ event: 'group-downloaded', key: group, group, length: 9 })
  await until(() => calls.length === 3, { name: 'a próxima checagem do grupo' })
  t.alike(calls[2].groups, [group])
  await until(() => started(link) === 4, { name: 'a sincronização volta de novo' })
  await link.call('sync.stop')
  t.is(calls.length, 3, 'the community\'s growth stopped the run never')
})
