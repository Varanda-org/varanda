'use strict'

// Surprise invite drops: the minutes of a Brasília Monday-week at which a
// member's weekly invites open. The schedule is a pure function of a server
// secret, the member key and the week, so a restart recomputes the same
// minutes without storing them, and a member cannot predict them without the
// secret. Never reads the process time zone: Brasília is fixed UTC-3.

const nodeCrypto = require('node:crypto')
const { dayStart, DAY_MS, DAY_OFFSET_MS } = require('@varanda/core/lib/activity')

const MINUTE_MS = 60000
const WEEK_MS = 7 * DAY_MS
const WINDOW_START_MIN = 540
const WINDOW_END_MIN = 1260
const PER_WEEK_MAX = 100
const MAX_COUNTER = 16
const MEMBER_RE = /^[0-9a-f]{64}$/
const TWO_64 = 1n << 64n

// Same rule as invites-store.js weekStart: the weekday is read from the
// shifted instant in UTC.
function weekStartMs (ms) {
  const day = dayStart(ms)
  return day - ((new Date(day + DAY_OFFSET_MS).getUTCDay() + 6) % 7) * DAY_MS
}

function minuteOfDay (ms) {
  return Math.floor((ms - dayStart(ms)) / MINUTE_MS)
}

function inWindow (ms) {
  const m = minuteOfDay(ms)
  return m >= WINDOW_START_MIN && m < WINDOW_END_MIN
}

function windowEndMs (ms) {
  return dayStart(ms) + WINDOW_END_MIN * MINUTE_MS
}

function checkMs (name, v) {
  if (!Number.isSafeInteger(v)) throw new TypeError(name + ' must be a safe integer')
}

// A missing bound means no bound, so callers without a link or enable time
// still get the whole week.
function bound (name, v) {
  if (v === undefined || v === null) return -Infinity
  checkMs(name, v)
  return v
}

function eligibleMinutes ({ weekStartMs, linkedAtMs, enabledAtMs } = {}) {
  checkMs('weekStartMs', weekStartMs)
  const from = Math.max(bound('linkedAtMs', linkedAtMs), bound('enabledAtMs', enabledAtMs))
  const out = []
  for (let d = 0; d < 7; d++) {
    const day = weekStartMs + d * DAY_MS
    for (let m = WINDOW_START_MIN; m < WINDOW_END_MIN; m++) {
      const t = day + m * MINUTE_MS
      if (t >= from) out.push(t)
    }
  }
  return out
}

// Uniform index in [0, n) from the first 8 HMAC bytes, or -1 when the sample
// falls in the biased tail and must be redrawn.
function draw (secret, member, weekIso, k, c, n) {
  const mac = nodeCrypto.createHmac('sha256', secret)
    .update('invite-drop\n' + member + '\n' + weekIso + '\n' + k + '\n' + c)
    .digest()
  const v = mac.readBigUInt64BE(0)
  const bn = BigInt(n)
  const limit = TWO_64 - (TWO_64 % bn)
  if (v >= limit) return -1
  return Number(v % bn)
}

function grantMinutes ({ secret, member, weekStartMs, perWeek, linkedAtMs, enabledAtMs } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new TypeError('secret must be a 32-byte Buffer')
  if (typeof member !== 'string' || !MEMBER_RE.test(member)) throw new TypeError('member must be 64 lowercase hex characters')
  if (!Number.isSafeInteger(perWeek) || perWeek < 1 || perWeek > PER_WEEK_MAX) throw new TypeError('perWeek must be an integer from 1 to 100')
  const eligible = eligibleMinutes({ weekStartMs, linkedAtMs, enabledAtMs })
  const weekIso = new Date(weekStartMs).toISOString()
  const taken = new Set()
  const out = []
  for (let k = 0; k < perWeek; k++) {
    if (eligible.length < k + 1) {
      out.push(null)
      continue
    }
    let idx = -1
    let last = 0
    for (let c = 0; c < MAX_COUNTER; c++) {
      const i = draw(secret, member, weekIso, k, c, eligible.length)
      if (i === -1) continue
      last = i
      if (!taken.has(i)) {
        idx = i
        break
      }
    }
    // A free index always exists here because eligible.length > k, so the
    // linear probe keeps the slot instead of dropping a member's invite.
    if (idx === -1) {
      idx = last
      while (taken.has(idx)) idx = (idx + 1) % eligible.length
    }
    taken.add(idx)
    out.push(eligible[idx])
  }
  return out
}

function grantsOpened (minutes, nowMs) {
  let n = 0
  for (const m of minutes) if (m !== null && m <= nowMs) n++
  return n
}

module.exports = {
  WINDOW_START_MIN,
  WINDOW_END_MIN,
  MINUTE_MS,
  WEEK_MS,
  weekStartMs,
  inWindow,
  windowEndMs,
  eligibleMinutes,
  grantMinutes,
  grantsOpened
}
