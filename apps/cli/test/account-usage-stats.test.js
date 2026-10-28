'use strict'

// apps/cli/lib/account/usage-stats.js: the anonymous usage history
// (usage.json), sampling, sign-up buckets and the api/stats view. No network:
// the account store and the seeder reader are fakes and the clock is injected.

const fs = require('node:fs')
const path = require('node:path')
const test = require('brittle')
const {
  createUsageStats,
  signupBuckets,
  FILE,
  COUNT_FIELDS
} = require('../lib/account/usage-stats')
const { tmpDir } = require('./helpers/net')

const T0 = Date.parse('2026-10-27T12:00:00.000Z')
const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function clock (start = T0) {
  const c = { t: start, now: () => c.t }
  return c
}

function fakeAccounts (members = 3) {
  const a = {
    members,
    calls: [],
    byDay: [['2026-10-20', 2], ['2026-10-26', 1]],
    linkStats (dayOf) {
      a.calls.push(dayOf)
      return { members: a.members, maxMembers: 500, byDay: a.byDay }
    }
  }
  return a
}

function counts (over = {}) {
  return {
    uptimeSeconds: 100,
    admitted: 3,
    activeDay: 2,
    activeWeek: 3,
    blocks: 40,
    bytes: 4000,
    mediaBytes: 1000,
    topicPosts: 5,
    connections: 4,
    external: 1,
    ...over
  }
}

// Each call shifts the next scripted result (a function runs, an Error
// throws); past the end it keeps returning the last one.
function seeder (script) {
  const s = {
    reads: 0,
    async read () {
      const next = script.length > 1 ? script.shift() : script[0]
      s.reads++
      if (next instanceof Error) throw next
      return typeof next === 'function' ? next() : next
    }
  }
  return s
}

function setup (t, opts = {}) {
  const dir = opts.dir || tmpDir(t)
  const c = opts.clock || clock()
  const accounts = opts.accounts || fakeAccounts()
  const s = opts.seeder || seeder([counts()])
  const logs = []
  const stats = createUsageStats({
    dataDir: dir,
    accounts,
    readSeeder: s.read,
    now: c.now,
    log: (e) => logs.push(e),
    ...opts.extra
  })
  return { dir, c, accounts, s, logs, stats, file: path.join(dir, FILE) }
}

function row (day, over = {}) {
  const r = { day }
  for (const f of COUNT_FIELDS) r[f] = null
  return Object.assign(r, over)
}

test('view: one seeder read per freshMs, concurrent views coalesce', async (t) => {
  const { c, s, stats } = setup(t)
  const v1 = await stats.view()
  t.is(s.reads, 1)
  t.is(v1.seeder.at, new Date(T0).toISOString())
  c.t += 4 * MIN
  await stats.view()
  t.is(s.reads, 1, 'within freshMs: no read')
  c.t += 2 * MIN
  await stats.view()
  t.is(s.reads, 2, 'after freshMs: read again')
  c.t += 10 * MIN
  await Promise.all([stats.view(), stats.view(), stats.view()])
  t.is(s.reads, 3, 'concurrent views share one read')
})

test('view: a failing seeder is still read at most once per freshMs', async (t) => {
  const { c, s, stats } = setup(t, { seeder: seeder([new Error('down')]) })
  const v = await stats.view()
  t.is(v.seeder, null)
  await stats.view()
  t.is(s.reads, 1)
  c.t += 6 * MIN
  await stats.view()
  t.is(s.reads, 2)
})

test('view: a sample already in flight is awaited, not skipped', async (t) => {
  let release
  const held = new Promise((resolve) => { release = resolve })
  const { s, stats } = setup(t, { seeder: seeder([() => held.then(() => counts())]) })
  const tick = stats.sample()
  const pending = stats.view()
  release()
  await tick
  const v = await pending
  t.is(s.reads, 1, 'one shared read')
  t.ok(v.seeder !== null, 'the view carries the in-flight read, not the empty snapshot')
  t.is(v.history.length, 1, 'and the row it wrote')
})

test('view: exact shape, linkStats gets dayOf', async (t) => {
  const { accounts, stats } = setup(t)
  const v = await stats.view()
  t.alike(Object.keys(v), ['at', 'members', 'seeder', 'signups', 'history'])
  t.is(v.at, new Date(T0).toISOString())
  t.alike(v.members, { total: 3, max: 500 })
  t.alike(v.seeder, { at: new Date(T0).toISOString(), ...counts() })
  t.is(v.signups.weeks.length, 12)
  t.is(v.signups.months.length, 12)
  const { uptimeSeconds, ...kept } = counts()
  t.alike(v.history, [row('2026-10-27', { members: 3, ...kept })], 'uptime is never kept')
  t.ok(accounts.calls.length > 0 && accounts.calls.every((f) => typeof f === 'function'))
  // deep copies: mutating the view never touches the state
  v.history[0].members = 999
  const v2 = await stats.view()
  t.is(v2.history[0].members, 3)
})

test('sample: one row per day, peaks maxed, others latest, null keeps', async (t) => {
  const s = seeder([
    counts({ activeDay: 5, connections: 9, blocks: 40 }),
    counts({ activeDay: 2, connections: 3, blocks: 50, external: null }),
    null,
    counts({ activeDay: 1, connections: 1, blocks: 60 })
  ])
  const accounts = fakeAccounts(3)
  const { c, stats } = setup(t, { seeder: s, accounts })
  await stats.sample()
  c.t += HOUR
  accounts.members = 4
  await stats.sample()
  let h = (await stats.view()).history
  t.is(h.length, 1)
  t.is(h[0].activeDay, 5, 'peak kept')
  t.is(h[0].connections, 9, 'peak kept')
  t.is(h[0].blocks, 50, 'latest')
  t.is(h[0].external, 1, 'null read keeps the earlier value')
  t.is(h[0].members, 4)

  c.t += HOUR
  accounts.linkStats = () => { throw new Error('x') }
  await stats.sample() // seeder null, members throws
  accounts.linkStats = fakeAccounts(4).linkStats
  h = (await stats.view()).history
  t.is(h.length, 1)
  t.is(h[0].blocks, 50)
  t.is(h[0].members, 4)

  c.t += DAY
  await stats.sample()
  h = (await stats.view()).history
  t.is(h.length, 2)
  t.is(h[1].day, '2026-10-28')
  t.is(h[1].activeDay, 1, 'a new day starts from scratch')
  t.is(h[1].blocks, 60)
})

test('sample: a clock stepped back changes nothing', async (t) => {
  const { c, stats } = setup(t)
  await stats.sample()
  c.t -= 2 * DAY
  await stats.sample()
  const h = (await stats.view()).history
  t.is(h.length, 1)
  t.is(h[0].day, '2026-10-27')
})

test('sample: injected dayOf decides the row', async (t) => {
  const dayOf = (ms) => new Date(ms - 3 * HOUR).toISOString().slice(0, 10)
  const c = clock(Date.parse('2026-10-27T02:00:00.000Z'))
  const { stats, accounts } = setup(t, { clock: c, extra: { dayOf } })
  await stats.sample()
  let h = (await stats.view()).history
  t.alike(h.map((r) => r.day), ['2026-10-26'])
  t.is(accounts.calls[0], dayOf)
  c.t = Date.parse('2026-10-27T03:00:00.000Z')
  await stats.sample()
  h = (await stats.view()).history
  t.alike(h.map((r) => r.day), ['2026-10-26', '2026-10-27'])
})

test('sample: a read straddling local midnight lands on the day it started', async (t) => {
  const dayOf = (ms) => new Date(ms - 3 * HOUR).toISOString().slice(0, 10)
  const c = clock(Date.parse('2026-10-27T02:59:59.000Z')) // 23:59:59 local, 2026-10-26
  const s = seeder([() => {
    c.t = Date.parse('2026-10-27T03:00:01.000Z') // past local midnight
    return counts({ activeDay: 50, activeWeek: 60 })
  }])
  const { stats } = setup(t, { clock: c, seeder: s, extra: { dayOf } })
  await stats.sample()
  t.is(s.reads, 1)
  const v = await stats.view() // fresh: no second read
  t.is(s.reads, 1)
  t.alike(v.history.map((r) => r.day), ['2026-10-26'], 'no new-day row created')
  t.is(v.history[0].activeDay, 50)
  t.is(v.history[0].activeWeek, 60)
})

test('sample: maxDays drops the oldest row', async (t) => {
  const { c, stats } = setup(t, { extra: { maxDays: 3 } })
  for (let i = 0; i < 4; i++) {
    if (i > 0) c.t += DAY
    await stats.sample()
  }
  const h = (await stats.view()).history
  t.alike(h.map((r) => r.day), ['2026-10-28', '2026-10-29', '2026-10-30'])
})

test('persist: stop() writes 0o600 { v, days }, reopen reads it back', async (t) => {
  const dir = tmpDir(t)
  const { stats, file } = setup(t, { dir })
  await stats.sample()
  t.absent(fs.existsSync(file), 'nothing written before stop')
  await stats.stop()
  t.is(fs.statSync(file).mode & 0o777, 0o600)
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  t.alike(Object.keys(data), ['v', 'days'])
  t.is(data.v, 1)
  t.is(data.days.length, 1)

  const again = setup(t, { dir, seeder: seeder([null]) })
  const v = await again.stats.view()
  t.alike(v.history, data.days)
  t.alike(again.logs, [])
})

test('persist: flush false and canWrite false write nothing', async (t) => {
  const a = setup(t)
  await a.stats.sample()
  await a.stats.stop({ flush: false })
  t.absent(fs.existsSync(a.file))

  const b = setup(t, { extra: { canWrite: () => false } })
  await b.stats.sample()
  b.stats.persist()
  await b.stats.stop()
  t.absent(fs.existsSync(b.file))

  const c = setup(t)
  await c.stats.view()
  t.absent(fs.existsSync(c.file), 'view never persists')
})

test('persist: a failing write is logged once per streak and stays dirty', async (t) => {
  const dir = tmpDir(t)
  const { stats, logs, file } = setup(t, { dir })
  fs.mkdirSync(file) // a directory where the file goes: rename fails
  await stats.sample()
  stats.persist()
  stats.persist()
  t.alike(logs, [{ event: 'usage', reason: 'falhou' }])
  fs.rmdirSync(file)
  stats.persist()
  t.ok(fs.existsSync(file), 'still dirty, written after the failure')
  t.is(logs.length, 1)
})

const BAD = {
  'bad JSON': '{"v":1,"days":[',
  'v 2': JSON.stringify({ v: 2, days: [] }),
  'unsorted days': JSON.stringify({ v: 1, days: [row('2026-10-02'), row('2026-10-01')] }),
  'extra key': JSON.stringify({ v: 1, days: [{ ...row('2026-10-01'), extra: 1 }] }),
  'negative count': JSON.stringify({ v: 1, days: [row('2026-10-01', { members: -1 })] }),
  'impossible date': JSON.stringify({ v: 1, days: [row('2026-02-30')] })
}

for (const [name, bytes] of Object.entries(BAD)) {
  test('open: ' + name + ' is invalid, logged once, never written', async (t) => {
    const dir = tmpDir(t)
    fs.writeFileSync(path.join(dir, FILE), bytes)
    const { stats, logs, file } = setup(t, { dir })
    await stats.sample()
    const v = await stats.view()
    t.is(v.history, null)
    t.alike(v.members, { total: 3, max: 500 }, 'the rest of the view still works')
    await stats.stop()
    t.alike(logs, [{ event: 'usage', reason: 'invalido' }])
    t.is(fs.readFileSync(file, 'utf8'), bytes)
  })
}

test('open: a symlink is invalid and never written through', async (t) => {
  const dir = tmpDir(t)
  const target = path.join(dir, 'target.json')
  const bytes = JSON.stringify({ v: 1, days: [] })
  fs.writeFileSync(target, bytes)
  fs.symlinkSync(target, path.join(dir, FILE))
  const { stats, logs, file } = setup(t, { dir })
  await stats.sample()
  t.is((await stats.view()).history, null)
  await stats.stop()
  t.alike(logs, [{ event: 'usage', reason: 'invalido' }])
  t.ok(fs.lstatSync(file).isSymbolicLink())
  t.is(fs.readFileSync(target, 'utf8'), bytes)
})

test('open: more than maxDays rows keeps the newest', async (t) => {
  const dir = tmpDir(t)
  const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map((d) => row(d, { members: 1 }))
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ v: 1, days }))
  // The clock sits on the last stored day, so the view's sample updates
  // that row instead of appending one.
  const c = clock(Date.parse('2026-10-04T12:00:00.000Z'))
  const { stats, logs } = setup(t, { dir, clock: c, seeder: seeder([null]), extra: { maxDays: 2 } })
  const h = (await stats.view()).history
  t.alike(h.map((r) => r.day), ['2026-10-03', '2026-10-04'])
  t.alike(logs, [])
})

test('signupBuckets: Monday weeks, all 7 days counted', (t) => {
  // 2026-10-26 is a Monday; 2026-10-25 a Sunday.
  const byDay = [
    ['2026-10-25', 1], // Sunday: previous week
    ['2026-10-26', 10], ['2026-10-27', 10], ['2026-10-28', 10], ['2026-10-29', 10],
    ['2026-10-30', 10], ['2026-10-31', 10], ['2026-11-01', 10], // Sunday: same week
    ['2026-11-02', 100] // next Monday: a new week
  ]
  const { weeks } = signupBuckets(byDay, '2026-11-01')
  t.is(weeks.length, 12)
  t.alike(weeks[11], { start: '2026-10-26', count: 70 })
  t.alike(weeks[10], { start: '2026-10-19', count: 1 })
  const next = signupBuckets(byDay, '2026-11-02').weeks
  t.alike(next[11], { start: '2026-11-02', count: 100 })
  t.alike(next[10], { start: '2026-10-26', count: 70 })
})

test('signupBuckets: year boundary, 12 months, cumulative totals', (t) => {
  const byDay = [
    ['2024-05-01', 7], // before the window: counted in every total
    ['2025-02-10', 1],
    ['2025-12-29', 2], // Monday 2025-12-29 week crosses the year
    ['2026-01-02', 3],
    ['2026-01-05', 4]
  ]
  const { weeks, months } = signupBuckets(byDay, '2026-01-06')
  t.is(weeks.length, 12)
  t.alike(weeks[11], { start: '2026-01-05', count: 4 })
  t.alike(weeks[10], { start: '2025-12-29', count: 5 })
  t.is(weeks[0].start, '2025-10-20')
  t.is(months.length, 12)
  t.alike(months.map((m) => m.month), [
    '2025-02', '2025-03', '2025-04', '2025-05', '2025-06', '2025-07',
    '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01'
  ])
  t.alike(months[0], { month: '2025-02', count: 1, total: 8 })
  t.alike(months[10], { month: '2025-12', count: 2, total: 10 })
  t.alike(months[11], { month: '2026-01', count: 7, total: 17 })
})

test('view: no key or e-mail ever leaks', async (t) => {
  const accounts = fakeAccounts()
  accounts.byDay = [['2026-10-27', 1]]
  const { stats } = setup(t, { accounts })
  const json = JSON.stringify(await stats.view())
  t.absent(/[0-9a-f]{64}/i.test(json))
  t.absent(json.includes('@'))
})

test('start: ticks write the file, stop leaves no timer', async (t) => {
  const { stats, s, file } = setup(t, { extra: { firstSampleMs: 20, sampleMs: 50 } })
  stats.start()
  stats.start() // idempotent
  const deadline = Date.now() + 5000
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  t.ok(fs.existsSync(file))
  await stats.stop()
  const reads = s.reads
  fs.unlinkSync(file)
  await new Promise((resolve) => setTimeout(resolve, 150))
  t.is(s.reads, reads, 'no tick after stop')
  t.absent(fs.existsSync(file))
})
