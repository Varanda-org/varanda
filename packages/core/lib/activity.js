'use strict'

// Active-diary counts for the seeder's health and metrics (anonymous usage
// stats). Privacy rule: this module only ever yields COUNTS. The state it
// keeps (activityLength, activeAt) lives on the seeder's in-memory served
// entry: it is never persisted, never logged and never returned per diary,
// it leaves with the entry when the diary is dropped, and a restart zeroes
// it. No key, address or length ever leaves through countActive().
//
// Requires nothing, so it stays dependency-free and loads on every runtime.

const DAY_MS = 86400000
const WEEK_DAYS = 7
// Brasília time, fixed UTC-3: Brazil has had no daylight saving time since
// 2019, so a fixed offset is exact. The account service's daily history
// (apps/cli/lib/account/usage-stats.js) buckets by the same localDay, so the
// seeder's "today" and the panel's history agree on where a day starts.
const DAY_OFFSET_MS = -3 * 3600000

// Epoch ms of 00:00 Brasília of the day containing ms. The double modulo
// keeps the result right for instants before the epoch too.
function dayStart (ms) {
  return ms - (((ms + DAY_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS
}

// The Brasília calendar day of ms as 'YYYY-MM-DD'.
function localDay (ms) {
  return new Date(ms + DAY_OFFSET_MS).toISOString().slice(0, 10)
}

// Record that a served diary's signed length grew. Only a strictly larger
// safe integer over an existing baseline counts: an equal length (the
// synchronous first check of a serve, a restore, a re-gate) or a bad value
// changes nothing, so restarts and rescans never look like activity.
function noteGrowth (entry, length, nowMs) {
  if (!Number.isSafeInteger(length) || !Number.isSafeInteger(entry.activityLength)) return false
  if (length <= entry.activityLength) return false
  entry.activityLength = length
  entry.activeAt = nowMs
  return true
}

// Count the gated entries active today and in the last WEEK_DAYS Brasília
// days, today included. An activeAt in the future (the wall clock stepped
// back since it was set) is >= both window starts, so it counts in both: a
// clock step can only over-count until the next day, never hide activity.
function countActive (entries, nowMs) {
  const today = dayStart(nowMs)
  const weekStart = today - (WEEK_DAYS - 1) * DAY_MS
  let activeDay = 0
  let activeWeek = 0
  for (const entry of entries) {
    if (entry.gated !== true || !Number.isFinite(entry.activeAt)) continue
    if (entry.activeAt >= today) activeDay++
    if (entry.activeAt >= weekStart) activeWeek++
  }
  return { activeDay, activeWeek }
}

module.exports = { DAY_MS, WEEK_DAYS, DAY_OFFSET_MS, dayStart, localDay, noteGrowth, countActive }
