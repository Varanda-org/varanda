'use strict'

// Visitas (docs/protocol.md section 11): the budget for sending visit pings
// and the rules of the list of visitors. Pure: no sodium, no I/O, no clock
// read here (every caller passes `now` in ms).
//
// A visit names a day, never a time: `day` is a canonical UTC date
// (YYYY-MM-DD), the same precision the signed inner v6 carries. Every age is
// a whole number of UTC days, today minus that day.

const { VISIT_DAILY_MAX, VISIT_PROFILE_DAYS, VISIT_STAMP_RESERVE, VISIT_LIST_MAX, VISIT_KEEP_DAYS } = require('@varanda/rpc')

const DAY_MS = 86400000
// A received ping may name yesterday or tomorrow as well as today: the two
// clocks can sit on either side of midnight UTC. Anything further is refused.
const VISIT_DAY_SLACK = 1
const DAY = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const HEX64 = /^[0-9a-f]{64}$/

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

// A time in ms inside the Date range.
function isTime (ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15
}

function isVisitDay (s) {
  if (typeof s !== 'string' || !DAY.test(s)) return false
  const ms = Date.parse(s + 'T00:00:00.000Z')
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s
}

// The canonical day of a time in ms. Throws on a time that is not one.
function visitDay (ms) {
  if (!isTime(ms)) throw new TypeError('data inválida')
  return new Date(ms).toISOString().slice(0, 10)
}

// Whole days since 1970-01-01 (UTC), or NaN for anything that is no day.
function dayNumber (day) {
  return isVisitDay(day) ? Date.parse(day + 'T00:00:00.000Z') / DAY_MS : NaN
}

// The ms of the start of a day (UTC), or NaN.
function dayMs (day) {
  return dayNumber(day) * DAY_MS
}

// Days from `day` to the day of `now`: 0 today, 1 yesterday, below zero a
// day still to come. NaN for anything that is no day, or a `now` that is no time.
function ageOf (day, now) {
  if (!isTime(now)) return NaN
  return dayNumber(visitDay(now)) - dayNumber(day)
}

// True when a received ping's day is today, give or take VISIT_DAY_SLACK.
function visitDayFresh (day, now) {
  const age = ageOf(day, now)
  return Number.isFinite(age) && Math.abs(age) <= VISIT_DAY_SLACK
}

// The rows of an own sent log that count: { to, day } with both well formed.
function validSent (sent) {
  const out = []
  for (const r of Array.isArray(sent) ? sent : []) {
    if (r !== null && typeof r === 'object' && isHex64(r.to) && isVisitDay(r.day)) out.push(r)
  }
  return out
}

// Pings sent today. A row dated after today (the clock moved back) counts as
// today, so turning the clock back never frees the daily budget.
function sentToday (sent, now) {
  // No clock reading means no budget left, never a fresh one.
  if (!isTime(now)) return VISIT_DAILY_MAX
  let n = 0
  for (const r of validSent(sent)) if (ageOf(r.day, now) <= 0) n++
  return n
}

// Whether a node may send one more ping to `to` now. sent: its own log of
// { to, day }; stamps: how many postage stamps its wallet holds. Returns
// { ok: true } or { ok: false, reason }, reason one of 'invalid', 'self',
// 'daily' (VISIT_DAILY_MAX already sent today), 'recent' (a ping to `to` in
// the last VISIT_PROFILE_DAYS days, or dated in the future) and 'stamps'
// (sending would leave fewer than VISIT_STAMP_RESERVE stamps for messages).
function canVisit ({ self, to, sent, stamps, now } = {}) {
  if (!isHex64(self) || !isHex64(to) || !isTime(now)) return { ok: false, reason: 'invalid' }
  if (to === self) return { ok: false, reason: 'self' }
  const rows = validSent(sent)
  if (sentToday(rows, now) >= VISIT_DAILY_MAX) return { ok: false, reason: 'daily' }
  if (rows.some(r => r.to === to && ageOf(r.day, now) < VISIT_PROFILE_DAYS)) return { ok: false, reason: 'recent' }
  if (!Number.isSafeInteger(stamps) || stamps <= VISIT_STAMP_RESERVE) return { ok: false, reason: 'stamps' }
  return { ok: true }
}

// The part of a sent log that canVisit still reads: rows younger than
// VISIT_PROFILE_DAYS (and those dated in the future). Older rows say nothing
// about the budget and are not kept.
// A `now` that is no time prunes nothing, so a bad clock never frees the budget.
function pruneSent (sent, now) {
  if (!isTime(now)) return validSent(sent).map(r => ({ to: r.to, day: r.day }))
  return validSent(sent).filter(r => ageOf(r.day, now) < VISIT_PROFILE_DAYS).map(r => ({ to: r.to, day: r.day }))
}

function byNewest (a, b) {
  return b.rank - a.rank || (a.n > a.rank) - (b.n > b.rank) || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)
}

// The list of visitors: rows { from, day } (opened, verified pings) ->
// [{ from, day }], one row per visitor (the newest day), newest first, at
// most VISIT_LIST_MAX. A visit VISIT_KEEP_DAYS days old or older is
// forgotten, and a day beyond VISIT_DAY_SLACK in the future is no visit.
// opts: { self (hex64, never listed), blocked (Set or array of keys never
// listed) }. Every other field of a row is dropped: a list says who and
// which day, nothing finer. A day later than today ranks as today, after
// the visits dated today, so a ping dated ahead never outranks a genuine
// visit for the cap (the row keeps its own day).
function listVisits (rows, now, opts = {}) {
  if (!isTime(now)) return []
  const { self, blocked } = opts !== null && typeof opts === 'object' ? opts : {}
  if (blocked !== undefined && blocked !== null && !Array.isArray(blocked) && typeof (blocked && blocked.has) !== 'function') return []
  const skip = Array.isArray(blocked) ? new Set(blocked) : (blocked || new Set())
  const today = dayNumber(visitDay(now))
  const best = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r === null || typeof r !== 'object' || !isHex64(r.from) || r.from === self || skip.has(r.from)) continue
    const n = dayNumber(r.day)
    if (!Number.isFinite(n) || today - n >= VISIT_KEEP_DAYS || n - today > VISIT_DAY_SLACK) continue
    const had = best.get(r.from)
    if (had === undefined || n > had.n) best.set(r.from, { from: r.from, day: r.day, n, rank: Math.min(n, today) })
  }
  return [...best.values()].sort(byNewest).slice(0, VISIT_LIST_MAX).map(r => ({ from: r.from, day: r.day }))
}

module.exports = Object.freeze({
  VISIT_DAILY_MAX,
  VISIT_PROFILE_DAYS,
  VISIT_STAMP_RESERVE,
  VISIT_LIST_MAX,
  VISIT_KEEP_DAYS,
  VISIT_DAY_SLACK,
  isVisitDay,
  visitDay,
  dayNumber,
  dayMs,
  visitDayFresh,
  sentToday,
  canVisit,
  pruneSent,
  listVisits
})
