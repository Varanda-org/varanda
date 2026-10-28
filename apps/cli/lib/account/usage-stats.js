'use strict'

// Anonymous usage statistics for the moderation panel (GET api/stats): how
// many members the association has, what the seeder sees (activity, storage,
// connections) and a daily history of those counts. COUNTS ONLY: nothing here
// ever holds or returns a key, an e-mail, a sub, a username or an address, and
// it never touches reports, pending changes or blocked cases (exportLinks and
// moderation.stats are never called). The account store and the seeder
// reader are injected (no require of store.js or seeder-health.js), and so is
// the calendar: `dayOf(ms)` names the day a timestamp belongs to (UTC by
// default; production passes the Brasília localDay), used for the history
// rows and handed to accounts.linkStats(dayOf) for the sign-up days.
//
// History: ONE file, <dataDir>/usage.json = { v: 1, days: [row, ...] }, each
// row { day: 'YYYY-MM-DD', ...COUNT_FIELDS } with every count a non-negative
// safe integer or null (unknown). It is always replaced whole through
// writeJsonAtomic (packages/core/lib/store.js: O_EXCL temp, fsync, rename,
// dir fsync) with mode 0o600, so a crash leaves the previous file, and only
// while canWrite() says this process may write (the same gate as the account
// store). A file that is not a regular file (a symlink included) or does not
// match the shape exactly marks the history broken: it is logged once, the
// view reports history null and the file is NEVER written, so an operator can
// inspect or repair it. One row per day: PEAK_FIELDS keep the day's maximum,
// the other counts the latest value, and a null read never erases a value.
//
// Sign-up buckets are NOT suppressed for small counts: a member's linkedAt
// equals the date on the public account certificate it publishes, so a
// weekly or monthly count reveals nothing that is not already public.
//
// The seeder is read at most once per freshMs however many panel sessions
// ask (view() coalesces into the same in-flight sample), and the background
// tick samples every sampleMs. Every timer is unref()'d. Logs carry only
// { event: 'usage', reason } with a pt-BR token.

const fs = require('node:fs')
const path = require('node:path')
const { writeJsonAtomic } = require('@varanda/core/lib/store')

const FILE = 'usage.json'
const VERSION = 1
const MAX_DAYS = 400
const SAMPLE_MS = 15 * 60 * 1000
const FIRST_SAMPLE_MS = 60 * 1000
const FRESH_MS = 5 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

const COUNT_FIELDS = ['members', 'admitted', 'activeDay', 'activeWeek', 'blocks', 'bytes', 'mediaBytes', 'topicPosts', 'connections', 'external']
const PEAK_FIELDS = ['activeDay', 'activeWeek', 'connections', 'external']
// Everything but members comes from the seeder; uptimeSeconds is shown in
// the view but never kept in the history.
const SEEDER_FIELDS = COUNT_FIELDS.filter((f) => f !== 'members')
const VIEW_SEEDER_FIELDS = ['uptimeSeconds', ...SEEDER_FIELDS]

const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

function utcDay (ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

function isCount (v) {
  return Number.isSafeInteger(v) && v >= 0
}

// Anything that is not a count is unknown: a malformed value must never
// reach the history, or the next open would find the file invalid.
function count (v) {
  return isCount(v) ? v : null
}

function isPlainObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
}

// A real calendar date: the regex alone accepts 2026-02-30.
function isDay (v) {
  if (typeof v !== 'string' || !DAY_RE.test(v)) return false
  const ms = Date.parse(v + 'T00:00:00Z')
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v
}

function isRow (row) {
  if (!isPlainObject(row)) return false
  const keys = Object.keys(row)
  if (keys.length !== COUNT_FIELDS.length + 1) return false
  if (!isDay(row.day)) return false
  for (const f of COUNT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(row, f)) return false
    if (row[f] !== null && !isCount(row[f])) return false
  }
  return true
}

// Returns the rows (newest maxDays) or null when the file is malformed.
function parseHistory (data, maxDays) {
  if (!isPlainObject(data) || data.v !== VERSION || !Array.isArray(data.days)) return null
  for (let i = 0; i < data.days.length; i++) {
    if (!isRow(data.days[i])) return null
    if (i > 0 && !(data.days[i - 1].day < data.days[i].day)) return null
  }
  return data.days.slice(Math.max(0, data.days.length - maxDays)).map((r) => ({ ...r }))
}

function emptyRow (day) {
  const row = { day }
  for (const f of COUNT_FIELDS) row[f] = null
  return row
}

// Pure. `today` is a 'YYYY-MM-DD' calendar date (in whatever calendar dayOf
// uses); all arithmetic runs on that calendar date through Date.UTC, so no
// time zone or DST can shift it, and end dates are computed as dates, never
// by string concatenation. byDay is [[day, count], ...] in the same calendar.
function signupBuckets (byDay, today) {
  if (!isDay(today)) throw new TypeError('today must be a YYYY-MM-DD date')
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7)) - 1
  const d = Number(today.slice(8, 10))
  const entries = []
  for (const e of Array.isArray(byDay) ? byDay : []) {
    if (Array.isArray(e) && typeof e[0] === 'string' && isCount(e[1])) entries.push(e)
  }
  const sum = (from, to) => {
    let n = 0
    for (const [day, c] of entries) if ((from === null || day >= from) && day < to) n += c
    return n
  }

  const base = Date.UTC(y, m, d)
  const monday = base - ((new Date(base).getUTCDay() + 6) % 7) * DAY_MS
  const weeks = []
  for (let i = 11; i >= 0; i--) {
    const startMs = monday - i * 7 * DAY_MS
    const start = utcDay(startMs)
    const end = utcDay(startMs + 7 * DAY_MS)
    weeks.push({ start, count: sum(start, end) })
  }

  const months = []
  for (let i = 11; i >= 0; i--) {
    const first = utcDay(Date.UTC(y, m - i, 1))
    const next = utcDay(Date.UTC(y, m - i + 1, 1))
    months.push({ month: first.slice(0, 7), count: sum(first, next), total: sum(null, next) })
  }
  return { weeks, months }
}

function createUsageStats ({
  dataDir,
  accounts,
  readSeeder,
  now = Date.now,
  log = () => {},
  canWrite = () => true,
  dayOf = utcDay,
  sampleMs = SAMPLE_MS,
  firstSampleMs = FIRST_SAMPLE_MS,
  freshMs = FRESH_MS,
  maxDays = MAX_DAYS
}) {
  const file = path.join(dataDir, FILE)
  let days = []
  let broken = false
  let dirty = false
  let failing = false
  let lastSeeder = null
  let lastAttempt = null
  let inflight = null
  let timer = null
  let started = false
  let stopped = false

  // OPEN, synchronously, before anything can sample or write.
  let st = null
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    if (err.code !== 'ENOENT') broken = true
  }
  if (st !== null) {
    let parsed = null
    if (st.isFile()) {
      try {
        parsed = parseHistory(JSON.parse(fs.readFileSync(file, 'utf8')), maxDays)
      } catch {}
    }
    if (parsed === null) broken = true
    else days = parsed
  }
  if (broken) {
    days = []
    log({ event: 'usage', reason: 'invalido' })
  }

  async function doSample () {
    // The clock is read BEFORE the seeder: a read that straddles midnight
    // must file the seeder's counts (computed for the day it started) on that
    // day. Filed on the new day, yesterday's activeDay would inflate today's
    // peak all day; filed on yesterday, a new-day count is harmless under max().
    const t = now()
    lastAttempt = t
    let counts = null
    try {
      counts = await readSeeder()
    } catch {
      counts = null
    }
    if (counts !== null && typeof counts === 'object') {
      const norm = {}
      for (const f of VIEW_SEEDER_FIELDS) norm[f] = count(counts[f])
      counts = norm
      lastSeeder = { at: t, counts }
    } else {
      counts = null
    }
    let members = null
    try {
      members = count(accounts.linkStats(dayOf).members)
    } catch {
      members = null
    }

    const day = dayOf(t)
    let row = days.length > 0 ? days[days.length - 1] : null
    if (row !== null && day < row.day) return // the clock stepped back
    if (row === null || day !== row.day) {
      row = emptyRow(day)
      days.push(row)
      if (days.length > maxDays) days.splice(0, days.length - maxDays)
    }
    if (members !== null) row.members = members
    if (counts !== null) {
      for (const f of SEEDER_FIELDS) {
        const v = counts[f]
        if (v === null) continue
        row[f] = PEAK_FIELDS.includes(f) ? Math.max(row[f] ?? 0, v) : v
      }
    }
    dirty = true
  }

  function sample () {
    if (inflight === null) {
      inflight = doSample().finally(() => { inflight = null })
    }
    return inflight
  }

  function persist () {
    if (!dirty || broken || !canWrite()) return
    try {
      writeJsonAtomic(file, { v: VERSION, days }, 0o600)
      dirty = false
      failing = false
    } catch {
      if (!failing) log({ event: 'usage', reason: 'falhou' })
      failing = true
    }
  }

  function schedule (ms) {
    timer = setTimeout(tick, ms)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function tick () {
    timer = null
    if (stopped) return
    try {
      await sample()
      persist()
    } catch {}
    if (!stopped) schedule(sampleMs)
  }

  function start () {
    if (started || stopped) return
    started = true
    schedule(firstSampleMs)
  }

  async function stop ({ flush = true } = {}) {
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (inflight !== null) await inflight.catch(() => {})
    if (flush) persist()
  }

  async function view () {
    // Throttled on the last attempt rather than the last success, so a
    // seeder that is down is still read at most once per freshMs. A read
    // already in flight (a timer tick, another session) is awaited rather
    // than skipped: lastAttempt is set before it resolves, so skipping would
    // answer with the previous snapshot (seeder null on the very first one).
    if (inflight !== null) await inflight.catch(() => {})
    else if (lastAttempt === null || now() - lastAttempt > freshMs) await sample()
    const links = accounts.linkStats(dayOf)
    const t = now()
    let seeder = null
    if (lastSeeder !== null) {
      seeder = { at: new Date(lastSeeder.at).toISOString() }
      for (const f of VIEW_SEEDER_FIELDS) seeder[f] = lastSeeder.counts[f]
    }
    return {
      at: new Date(t).toISOString(),
      members: { total: links.members, max: links.maxMembers },
      seeder,
      signups: signupBuckets(links.byDay, dayOf(t)),
      history: broken ? null : days.map((r) => ({ ...r }))
    }
  }

  return { sample, persist, start, stop, view }
}

module.exports = {
  FILE,
  VERSION,
  MAX_DAYS,
  SAMPLE_MS,
  FIRST_SAMPLE_MS,
  FRESH_MS,
  COUNT_FIELDS,
  PEAK_FIELDS,
  signupBuckets,
  createUsageStats
}
