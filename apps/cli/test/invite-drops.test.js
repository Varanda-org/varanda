'use strict'

// apps/cli/lib/account/invite-drops.js: the invite drop secret, the notified
// ledger and the tick loop that hands due drops to push. No network; the
// clock and the timer are injected.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const test = require('brittle')
const { openInviteDrops, startInviteDropLoop, KEY_FILE, FILE } = require('../lib/account/invite-drops')
const { weekStartMs, windowEndMs, inWindow } = require('../lib/account/invite-drop-time')
const { tmpDir } = require('./helpers/net')

const HOUR = 3600 * 1000
const DAY = 24 * HOUR
// Monday 2026-10-26 00:00 Brasília.
const WEEK0 = Date.parse('2026-10-26T03:00:00.000Z')
const WEEK0_ISO = new Date(WEEK0).toISOString()
const LINKED = '2026-10-01T12:00:00.000Z'

function member () {
  return nodeCrypto.randomBytes(32).toString('hex')
}

function setup (t, opts = {}) {
  const dir = path.join(tmpDir(t), 'account')
  fs.mkdirSync(dir, { mode: 0o700 })
  const c = { t: WEEK0, now: () => c.t }
  const open = (more = {}) => openInviteDrops(dir, { perWeek: 1, now: c.now, ...opts, ...more })
  return { dir, keyFile: path.join(dir, KEY_FILE), file: path.join(dir, FILE), c, open }
}

// A timer that only fires when the test says so.
function manualTimer () {
  const m = { fn: null, cleared: 0 }
  m.setTimer = (fn) => {
    m.fn = fn
    return { unref () {} }
  }
  m.clearTimer = () => { m.cleared++; m.fn = null }
  m.fire = async () => {
    const fn = m.fn
    m.fn = null
    if (fn) await fn()
  }
  return m
}

function loop (s, drops, { members, notify, room = () => 128, guard, canNotify, logs = [] } = {}) {
  const timer = manualTimer()
  const calls = []
  const l = startInviteDropLoop({
    drops,
    listMembers: () => members,
    notify: (job) => {
      calls.push(job)
      return notify ? notify(job) : 'queued'
    },
    room,
    canNotify,
    now: s.c.now,
    guard,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
    log: (line) => logs.push(line)
  })
  return { l, timer, calls, logs }
}

// A member whose single minute this week satisfies pred.
function pick (drops, nowMs, pred) {
  for (;;) {
    const m = member()
    const [minute] = drops.minutes(m, LINKED, nowMs)
    if (minute !== null && pred(minute)) return { m, minute }
  }
}

function mode (file) {
  return fs.statSync(file).mode & 0o777
}

test('the key is created once and kept on a second open, mode 0600', async (t) => {
  const s = setup(t)
  const a = s.open()
  t.ok(a.available())
  const first = fs.readFileSync(s.keyFile, 'utf8')
  const obj = JSON.parse(first)
  t.alike(Object.keys(obj).sort(), ['enabledAt', 'secret', 'v'])
  t.is(obj.enabledAt, WEEK0_ISO)
  t.ok(/^[0-9a-f]{64}$/.test(obj.secret))
  t.is(mode(s.keyFile), 0o600)
  s.c.t += DAY
  const b = s.open()
  t.ok(b.available())
  t.is(fs.readFileSync(s.keyFile, 'utf8'), first)
  const m = member()
  t.alike(b.minutes(m, LINKED, s.c.t), a.minutes(m, LINKED, s.c.t))
  await b.markNotified(m, WEEK0_ISO, [0])
  t.is(mode(s.file), 0o600)
  const ledger = fs.readFileSync(s.file, 'utf8')
  t.absent(/minute/.test(ledger))
  t.alike(JSON.parse(ledger), { v: 1, rows: [{ member: m, week: WEEK0_ISO, slots: [0] }] })
})

test('opened is 0 before the minute, 1 after, 0 again next Monday', (t) => {
  const s = setup(t)
  const drops = s.open()
  const m = member()
  const [minute] = drops.minutes(m, LINKED, s.c.t)
  t.ok(minute >= WEEK0 && minute < WEEK0 + 7 * DAY)
  t.ok(inWindow(minute))
  t.is(drops.opened(m, LINKED, minute - 60000), 0)
  t.is(drops.opened(m, LINKED, minute), 1)
  t.is(drops.opened(m, LINKED, WEEK0 + 7 * DAY - 1), 1)
  t.is(drops.opened(m, LINKED, WEEK0 + 7 * DAY), 0)
  t.is(drops.opened(m, null, minute), 0)
})

test('a member linked after the last window of the week gets 0', (t) => {
  const s = setup(t)
  const drops = s.open()
  // Sunday 22:00 Brasília.
  const linked = new Date(WEEK0 + 6 * DAY + 22 * HOUR).toISOString()
  const m = member()
  t.alike(drops.minutes(m, linked, WEEK0 + 6 * DAY + 23 * HOUR), [null])
  t.is(drops.opened(m, linked, WEEK0 + 6 * DAY + 23 * HOUR), 0)
})

test('opened throws indisponivel when unavailable', (t) => {
  const s = setup(t)
  fs.writeFileSync(s.keyFile, '{}', { mode: 0o600 })
  const drops = s.open()
  t.absent(drops.available())
  t.exception(() => drops.opened(member(), LINKED, WEEK0), /indisponivel/)
})

test('a slot notifies once across ticks and across a reopen', async (t) => {
  const s = setup(t)
  const drops = s.open()
  // Not in the last two minutes of a window, which no tick claims.
  const { m, minute } = pick(drops, s.c.t, (x) => x < WEEK0 + 6 * DAY && windowEndMs(x) - x >= 2 * 60000)
  const members = [{ member: m, linkedAt: LINKED }]
  const a = loop(s, drops, { members })
  a.l.start()
  s.c.t = minute - 60000
  await a.timer.fire()
  t.is(a.calls.length, 0, 'not before the minute')
  s.c.t = minute
  await a.timer.fire()
  t.is(a.calls.length, 1)
  t.is(a.calls[0].member, m)
  t.is(a.calls[0].topic, drops.topic(m, WEEK0_ISO, 0))
  t.ok(/^[0-9a-f]{32}$/.test(a.calls[0].topic))
  t.is(a.calls[0].deadline, windowEndMs(minute))
  t.ok(drops.wasNotified(m, WEEK0_ISO, 0))
  s.c.t = minute + 60000
  await a.timer.fire()
  t.is(a.calls.length, 1, 'not again on the next tick')
  await a.l.stop()

  const again = s.open()
  const b = loop(s, again, { members })
  b.l.start()
  await b.timer.fire()
  t.is(b.calls.length, 0, 'not again after a reopen')
  await b.l.stop()
})

test('a minute missed while stopped notifies once in window, never at 03:00 nor after week end', async (t) => {
  const s = setup(t)
  const drops = s.open()
  const { m, minute } = pick(drops, s.c.t, (x) => x < WEEK0 + 6 * DAY)
  const members = [{ member: m, linkedAt: LINKED }]
  const a = loop(s, drops, { members })
  a.l.start()
  // Next day, 00:00 Brasília: out of the window.
  const nextDay = weekStartMs(minute) + (Math.floor((minute - WEEK0) / DAY) + 1) * DAY
  s.c.t = nextDay
  await a.timer.fire()
  t.is(a.calls.length, 0, 'not at 03:00Z')
  s.c.t = nextDay + 9 * HOUR
  await a.timer.fire()
  t.is(a.calls.length, 1, 'at the next window of the same week')
  s.c.t += 60000
  await a.timer.fire()
  t.is(a.calls.length, 1)
  await a.l.stop()

  // Another member, never notified, seen only after the week ended.
  const late = pick(drops, WEEK0, (x) => x < WEEK0 + 6 * DAY).m
  const monday = WEEK0 + 7 * DAY + 9 * HOUR
  const [next] = drops.minutes(late, LINKED, monday)
  const b = loop(s, drops, { members: [{ member: late, linkedAt: LINKED }] })
  b.l.start()
  s.c.t = monday
  await b.timer.fire()
  t.is(b.calls.length, next <= monday ? 1 : 0, 'the old week minute never goes out')
  t.absent(drops.wasNotified(late, WEEK0_ISO, 0))
  await b.l.stop()
})

test('none and dropped stay marked; logs hold only event and reason', async (t) => {
  const s = setup(t)
  const drops = s.open()
  // Sunday 20:58 Brasília. Both minutes are drawn at or before it, so both
  // are due.
  const at = WEEK0 + 6 * DAY + 20 * HOUR + 58 * 60000
  const one = pick(drops, s.c.t, (x) => x <= at)
  const two = pick(drops, s.c.t, (x) => x <= at)
  const outcomes = { [one.m]: 'none', [two.m]: 'dropped' }
  const a = loop(s, drops, {
    members: [{ member: one.m, linkedAt: LINKED }, { member: two.m, linkedAt: LINKED }],
    notify: (job) => outcomes[job.member]
  })
  a.l.start()
  s.c.t = at
  await a.timer.fire()
  t.is(a.calls.length, 2)
  // Ties on the minute are broken by member key, as the loop orders them.
  const first = one.minute < two.minute || (one.minute === two.minute && one.m < two.m) ? one.m : two.m
  t.ok(a.calls[0].member === first, 'ordered by minute, then member')
  t.ok(drops.wasNotified(one.m, WEEK0_ISO, 0))
  t.ok(drops.wasNotified(two.m, WEEK0_ISO, 0))
  await a.timer.fire()
  t.is(a.calls.length, 2)
  t.alike(a.logs, [{ event: 'sorteio', reason: 'ligado' }, { event: 'sorteio', reason: 'descartado' }])
  for (const line of a.logs) t.alike(Object.keys(line).sort(), ['event', 'reason'])
  for (const job of a.calls) t.ok(job.deadline - s.c.t === 2 * 60000, 'deadline is 21:00 Brasília today')
  await a.l.stop()
})

test('the batch follows room(): 0 takes nothing, 7 takes one slot', async (t) => {
  const s = setup(t)
  const drops = s.open()
  // Sunday 20:00 Brasília, and three members whose minutes are all due by then.
  const at = WEEK0 + 6 * DAY + 20 * HOUR
  const ms = [pick(drops, s.c.t, (x) => x <= at), pick(drops, s.c.t, (x) => x <= at), pick(drops, s.c.t, (x) => x <= at)]
  ms.sort((a, b) => a.minute - b.minute || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0))
  let r = 0
  const a = loop(s, drops, { members: ms.map((x) => ({ member: x.m, linkedAt: LINKED })), room: () => r })
  a.l.start()
  s.c.t = at
  await a.timer.fire()
  t.is(a.calls.length, 0)
  t.absent(fs.existsSync(s.file), 'nothing claimed')
  r = 7
  await a.timer.fire()
  t.is(a.calls.length, 1)
  t.is(a.calls[0].member, ms[0].m, 'earliest minute first')
  r = 128
  await a.timer.fire()
  t.is(a.calls.length, 3)
  t.alike(a.logs, [{ event: 'sorteio', reason: 'ligado' }, { event: 'sorteio', reason: 'enviado' }, { event: 'sorteio', reason: 'enviado' }])
  await a.l.stop()
})

test('member rows with any other key are skipped', async (t) => {
  const s = setup(t)
  const drops = s.open()
  const one = pick(drops, s.c.t, (x) => x < WEEK0 + 7 * DAY)
  const a = loop(s, drops, {
    members: [{ member: one.m, linkedAt: LINKED, email: 'a@b.c' }, { member: one.m }, null, { member: 'x', linkedAt: LINKED }]
  })
  a.l.start()
  s.c.t = WEEK0 + 6 * DAY + 20 * HOUR
  await a.timer.fire()
  t.is(a.calls.length, 0)
  await a.l.stop()
})

test('a bad key file is left byte-identical and nothing is sent', async (t) => {
  const s = setup(t)
  const bad = '{"v":1,"secret":"zz","enabledAt":"2026-10-26T03:00:00.000Z"}'
  fs.writeFileSync(s.keyFile, bad, { mode: 0o600 })
  const drops = s.open()
  t.absent(drops.available())
  const m = member()
  const a = loop(s, drops, { members: [{ member: m, linkedAt: LINKED }] })
  a.l.start()
  s.c.t = WEEK0 + 6 * DAY + 20 * HOUR
  await a.timer.fire()
  t.is(a.calls.length, 0)
  t.is(fs.readFileSync(s.keyFile, 'utf8'), bad)
  t.absent(fs.existsSync(s.file))
  t.alike(a.logs, [{ event: 'sorteio', reason: 'indisponivel' }])
  await t.exception(drops.markNotified(m, WEEK0_ISO, [0]), /indisponivel/)
  t.is(await drops.heal(), false)
  t.is(fs.readFileSync(s.keyFile, 'utf8'), bad)
  await a.l.stop()
})

test('a missing key next to an existing ledger is not regenerated', async (t) => {
  const s = setup(t)
  const first = s.open()
  const m = member()
  await first.markNotified(m, WEEK0_ISO, [0])
  fs.unlinkSync(s.keyFile)
  const ledger = fs.readFileSync(s.file, 'utf8')
  const drops = s.open()
  t.absent(drops.available())
  t.absent(fs.existsSync(s.keyFile))
  const a = loop(s, drops, { members: [{ member: member(), linkedAt: LINKED }] })
  a.l.start()
  s.c.t = WEEK0 + 6 * DAY + 20 * HOUR
  await a.timer.fire()
  t.is(a.calls.length, 0)
  t.alike(a.logs, [{ event: 'sorteio', reason: 'indisponivel' }])
  t.is(fs.readFileSync(s.file, 'utf8'), ledger)
  await a.l.stop()
})

test('a key that disappears while running is not recreated by heal', async (t) => {
  const s = setup(t)
  const drops = s.open()
  await drops.markNotified(member(), WEEK0_ISO, [0])
  fs.unlinkSync(s.keyFile)
  await drops.heal()
  t.absent(fs.existsSync(s.keyFile))
})

test('a bad ledger is not rewritten', async (t) => {
  const s = setup(t)
  s.open()
  const bad = JSON.stringify({ v: 1, rows: [{ member: member(), week: WEEK0_ISO, slots: [1, 0] }] })
  fs.writeFileSync(s.file, bad, { mode: 0o600 })
  const drops = s.open()
  t.absent(drops.available())
  await t.exception(drops.markNotified(member(), WEEK0_ISO, [0]), /indisponivel/)
  t.is(await drops.heal(), false)
  t.is(fs.readFileSync(s.file, 'utf8'), bad)
})

test('the ledger union-merges a replaced file and drops ended weeks', async (t) => {
  const s = setup(t)
  const drops = s.open()
  const m = member()
  const other = member()
  await drops.markNotified(m, WEEK0_ISO, [1])
  // Another holder replaced the file meanwhile.
  fs.writeFileSync(s.file, JSON.stringify({ v: 1, rows: [{ member: other, week: WEEK0_ISO, slots: [0] }] }))
  await drops.markNotified(m, WEEK0_ISO, [0])
  const rows = JSON.parse(fs.readFileSync(s.file, 'utf8')).rows
  t.alike(rows.find((r) => r.member === m).slots, [0, 1])
  t.alike(rows.find((r) => r.member === other).slots, [0])
  s.c.t = WEEK0 + 7 * DAY
  const week1 = new Date(WEEK0 + 7 * DAY).toISOString()
  await drops.markNotified(m, week1, [0])
  t.alike(JSON.parse(fs.readFileSync(s.file, 'utf8')).rows, [{ member: m, week: week1, slots: [0] }])
})

test('guard false writes nothing and skips only that tick', async (t) => {
  const s = setup(t)
  const blocked = s.open({ guard: () => false })
  t.absent(blocked.available())
  t.absent(fs.existsSync(s.keyFile))

  let ok = true
  const drops = s.open({ guard: () => ok })
  t.ok(drops.available())
  const at = WEEK0 + 6 * DAY + 20 * HOUR
  const one = pick(drops, s.c.t, (x) => x <= at)
  const a = loop(s, drops, { members: [{ member: one.m, linkedAt: LINKED }], guard: () => ok })
  a.l.start()
  ok = false
  s.c.t = at
  await a.timer.fire()
  t.is(a.calls.length, 0)
  t.absent(fs.existsSync(s.file))
  t.ok(drops.available(), 'one failed lock read does not fail the drops')
  t.ok(a.timer.fn !== null, 'nor stop the loop')
  ok = true
  await a.timer.fire()
  t.is(a.calls.length, 1, 'the next tick sends')
  t.ok(drops.wasNotified(one.m, WEEK0_ISO, 0))
  await a.l.stop()
})

test('a key file holding null is invalid: not regenerated, not rewritten', async (t) => {
  const s = setup(t)
  fs.writeFileSync(s.keyFile, 'null', { mode: 0o600 })
  const drops = s.open()
  t.absent(drops.available())
  t.is(fs.readFileSync(s.keyFile, 'utf8'), 'null')
  t.absent(fs.existsSync(s.file))
  await t.exception(drops.markNotified(member(), WEEK0_ISO, [0]), /indisponivel/)
  t.is(await drops.heal(), false)
  t.is(fs.readFileSync(s.keyFile, 'utf8'), 'null')
})

test('a ledger holding null is invalid and never rewritten', async (t) => {
  const s = setup(t)
  s.open()
  fs.writeFileSync(s.file, 'null', { mode: 0o600 })
  const drops = s.open()
  t.absent(drops.available())
  await t.exception(drops.markNotified(member(), WEEK0_ISO, [0]), /indisponivel/)
  t.is(await drops.heal(), false)
  t.is(fs.readFileSync(s.file, 'utf8'), 'null')

  // Replaced by null while running: the next write stops instead of
  // rewriting it.
  fs.writeFileSync(s.file, JSON.stringify({ v: 1, rows: [] }), { mode: 0o600 })
  const live = s.open()
  t.ok(live.available())
  fs.writeFileSync(s.file, 'null', { mode: 0o600 })
  await t.exception(live.markNotified(member(), WEEK0_ISO, [0]), /indisponivel/)
  t.absent(live.available())
  t.is(fs.readFileSync(s.file, 'utf8'), 'null')
})

test('markBatch returns only the slots it claimed; another holder\'s slot is not sent again', async (t) => {
  const s = setup(t)
  const a = s.open()
  const b = s.open()
  const m = member()
  t.alike(await b.markNotified(m, WEEK0_ISO, [0]), [{ member: m, week: WEEK0_ISO, slots: [0] }])
  t.alike(await a.markNotified(m, WEEK0_ISO, [0, 1]), [{ member: m, week: WEEK0_ISO, slots: [1] }])
  t.alike(await a.markNotified(m, WEEK0_ISO, [1]), [])

  // A loop on holder c, whose memory predates holder d's claim on disk.
  const at = WEEK0 + 6 * DAY + 20 * HOUR
  const c = s.open()
  const d = s.open()
  const one = pick(c, s.c.t, (x) => x <= at)
  const two = pick(c, s.c.t, (x) => x <= at)
  await d.markNotified(one.m, WEEK0_ISO, [0])
  t.absent(c.wasNotified(one.m, WEEK0_ISO, 0))
  const l = loop(s, c, { members: [{ member: one.m, linkedAt: LINKED }, { member: two.m, linkedAt: LINKED }] })
  l.l.start()
  s.c.t = at
  await l.timer.fire()
  t.is(l.calls.length, 1, 'only the slot this holder claimed')
  t.is(l.calls[0].member, two.m)
  t.ok(c.wasNotified(one.m, WEEK0_ISO, 0))
  await l.l.stop()
})

test('a minute at 20:59 on Saturday is not claimed at 20:59:30 and goes out at 09:00 on Sunday', async (t) => {
  const s = setup(t)
  const drops = s.open()
  const sat2059 = WEEK0 + 5 * DAY + 20 * HOUR + 59 * 60000
  const { m } = pick(drops, s.c.t, (x) => x === sat2059)
  const a = loop(s, drops, { members: [{ member: m, linkedAt: LINKED }] })
  a.l.start()
  s.c.t = sat2059 + 30000
  t.ok(inWindow(s.c.t))
  await a.timer.fire()
  t.is(a.calls.length, 0, 'not claimed two minutes or less before 21:00')
  t.absent(drops.wasNotified(m, WEEK0_ISO, 0))
  t.absent(fs.existsSync(s.file), 'nothing written')
  s.c.t = WEEK0 + 6 * DAY + 9 * HOUR
  t.ok(inWindow(s.c.t))
  t.is(weekStartMs(s.c.t), WEEK0)
  await a.timer.fire()
  t.is(a.calls.length, 1, 'caught up at the next window of the same week')
  t.is(a.calls[0].deadline, windowEndMs(s.c.t))
  await a.l.stop()
})

test('a minute at 20:59 on Sunday is claimed at 20:59:30, with the 21:00 deadline', async (t) => {
  const s = setup(t)
  const drops = s.open()
  const sun2059 = WEEK0 + 6 * DAY + 20 * HOUR + 59 * 60000
  const { m } = pick(drops, s.c.t, (x) => x === sun2059)
  const a = loop(s, drops, { members: [{ member: m, linkedAt: LINKED }] })
  a.l.start()
  s.c.t = sun2059 + 30000
  t.ok(inWindow(s.c.t))
  await a.timer.fire()
  t.is(a.calls.length, 1, 'no later window this week, so the margin does not apply')
  t.is(a.calls[0].member, m)
  t.is(a.calls[0].deadline, WEEK0 + 6 * DAY + 21 * HOUR)
  t.ok(drops.wasNotified(m, WEEK0_ISO, 0))
  await a.timer.fire()
  t.is(a.calls.length, 1, 'once')
  await a.l.stop()
})

test('a member without consent is skipped before the claim and caught up the same week', async (t) => {
  const s = setup(t)
  const drops = s.open()
  // Saturday 12:00 Brasília, two members due by then.
  const at = WEEK0 + 5 * DAY + 12 * HOUR
  const ms = [pick(drops, s.c.t, (x) => x <= at), pick(drops, s.c.t, (x) => x <= at)]
  ms.sort((a, b) => a.minute - b.minute || (a.m < b.m ? -1 : a.m > b.m ? 1 : 0))
  const [early, later] = ms
  let consent = false
  const asked = []
  const a = loop(s, drops, {
    members: ms.map((x) => ({ member: x.m, linkedAt: LINKED })),
    // 7 is room for one slot: the refused member must not take it.
    room: () => 7,
    canNotify: (member) => {
      asked.push(member)
      return member !== early.m || consent
    }
  })
  a.l.start()
  s.c.t = at
  await a.timer.fire()
  t.ok(asked.includes(early.m))
  t.is(a.calls.length, 1, 'the batch slot went to the member with consent')
  t.is(a.calls[0].member, later.m)
  t.absent(drops.wasNotified(early.m, WEEK0_ISO, 0), 'not claimed')
  const ledger = JSON.parse(fs.readFileSync(s.file, 'utf8'))
  t.absent(ledger.rows.some((r) => r.member === early.m), 'nothing written for the refused member')

  s.c.t += 60000
  await a.timer.fire()
  t.is(a.calls.length, 1, 'still refused: nothing sent')
  t.absent(drops.wasNotified(early.m, WEEK0_ISO, 0))

  consent = true
  s.c.t += 60000
  await a.timer.fire()
  t.is(a.calls.length, 2, 'claimed and sent once consent exists')
  t.is(a.calls[1].member, early.m)
  t.ok(drops.wasNotified(early.m, WEEK0_ISO, 0))
  s.c.t += 60000
  await a.timer.fire()
  t.is(a.calls.length, 2, 'once')
  await a.l.stop()
})

test('a canNotify that throws counts as no consent', async (t) => {
  const s = setup(t)
  const drops = s.open()
  const at = WEEK0 + 5 * DAY + 12 * HOUR
  const { m } = pick(drops, s.c.t, (x) => x <= at)
  const a = loop(s, drops, { members: [{ member: m, linkedAt: LINKED }], canNotify: () => { throw new Error('boom') } })
  a.l.start()
  s.c.t = at
  await a.timer.fire()
  t.is(a.calls.length, 0)
  t.absent(fs.existsSync(s.file), 'nothing written')
  await a.l.stop()
})

test('a readOnly open never creates the key', (t) => {
  const s = setup(t)
  const drops = s.open({ readOnly: true })
  t.absent(drops.available())
  t.absent(fs.existsSync(s.keyFile))
})

test('stop clears the timer and awaits the tick in flight', async (t) => {
  const s = setup(t)
  const drops = s.open()
  // Due by the clock below, so the tick really reaches markBatch.
  const one = pick(drops, s.c.t, (x) => x <= WEEK0 + 6 * DAY + 20 * HOUR)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const a = loop(s, drops, {
    members: [{ member: one.m, linkedAt: LINKED }],
    room: () => 128
  })
  a.l.start()
  s.c.t = WEEK0 + 6 * DAY + 20 * HOUR
  const origMark = drops.markBatch
  drops.markBatch = async (marks) => { await gate; return origMark(marks) }
  const ticking = a.timer.fire()
  let stopped = false
  const stopping = a.l.stop().then(() => { stopped = true })
  await new Promise((resolve) => setImmediate(resolve))
  t.absent(stopped, 'stop waits for the tick')
  release()
  await ticking
  await stopping
  t.ok(stopped)
  t.is(a.timer.fn, null, 'no tick is scheduled after stop')
})

test('forget drops a member\'s marks (Excluir conta) and keeps the others', async (t) => {
  const s = setup(t)
  const drops = s.open()
  const m = member()
  const other = member()
  await drops.markBatch([{ member: m, week: WEEK0_ISO, slots: [0] }, { member: other, week: WEEK0_ISO, slots: [0] }])
  t.ok(drops.holds(m))
  t.alike(await drops.forget(m), { changed: true })
  t.absent(drops.holds(m))
  t.ok(drops.holds(other))
  t.alike(await drops.forget(m), { changed: false })
  t.alike(JSON.parse(fs.readFileSync(s.file, 'utf8')).rows.map((r) => r.member), [other])
})
