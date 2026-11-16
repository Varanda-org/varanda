'use strict'

// Periodic rotation of a private group's epoch key (docs/protocol.md,
// "Rotation"): pure decisions, no I/O. Both nodes gather the facts from
// their own fold and call rekeyDue; createRekeyGate keeps the per-group
// check limit and the waiting distributor's jitter in memory, with the clock
// and the random source injected so tests are deterministic.

const { validateGroupRecord } = require('./group')

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// T and N for a group of up to REKEY_SCALE_WRITERS entitled writers; both
// grow with the scale s = min(REKEY_MAX_SCALE, max(1, ceil(entitled / 64))),
// so a big group pays about the same bytes per month as a small one.
const REKEY_PERIOD_MS = 7 * DAY_MS
const REKEY_RECORDS = 1000
const REKEY_SCALE_WRITERS = 64
const REKEY_MAX_SCALE = 8
// A distributor that did not open the epoch waits this much longer, plus a
// random delay up to REKEY_JITTER_MS, so the opener usually rotates alone.
const REKEY_OTHER_WAIT_MS = 48 * HOUR_MS
const REKEY_JITTER_MS = 6 * HOUR_MS
// At most one check per group in this interval (a failure waits for it).
const REKEY_CHECK_MS = HOUR_MS
// No periodic rotation while the distributor's writer has less than this
// share of its block or byte budget left: it stays for removal rotations.
const REKEY_LOG_RESERVE = 0.1
// Groups the gate remembers (oldest dropped first).
const REKEY_GATE_MAX = 1024

function rekeyScale (entitled) {
  const n = Number.isSafeInteger(entitled) && entitled > 0 ? entitled : 0
  return Math.min(REKEY_MAX_SCALE, Math.max(1, Math.ceil(n / REKEY_SCALE_WRITERS)))
}

// Whether the writer's log has less than REKEY_LOG_RESERVE of either budget
// left. `log`: { length, bytes, maxBlocks, maxBytes }.
function lowOnLog (log) {
  const { length, bytes, maxBlocks, maxBytes } = log
  if (![length, bytes, maxBlocks, maxBytes].every(Number.isFinite)) return true
  return maxBlocks - length < maxBlocks * REKEY_LOG_RESERVE || maxBytes - bytes < maxBytes * REKEY_LOG_RESERVE
}

function notDue (reason, at = null) {
  return { due: false, at, reason }
}

// The decision for one group. Inputs:
// - rekeyPending, epoch: the fold's (epoch null or pending: never periodic);
// - epochAt: ms of the `at` of the epoch's first block (null if unknown);
// - sealedAts: ms of the `at` of every counted group-sealed under the epoch;
// - entitled: how many writers the fold entitles;
// - ownEpoch: the epoch was opened by a writer of this device;
// - now: ms; jitter: in [0, 1), fixed per epoch by the caller;
// - log: { length, bytes, maxBlocks, maxBytes } of the distributor's writer.
// Every `at` later than now counts as now. -> { due, at, reason }: due now
// (`at` the moment it became due), not due until `at`, or not due with
// `at` null (nothing to wait for: an idle group, no epoch, pending, no room).
function rekeyDue ({ rekeyPending = false, epoch = null, epochAt = null, sealedAts = [], entitled = 0, ownEpoch = false, now, jitter = 0, log = null } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('now required')
  if (rekeyPending === true) return notDue('rekey-pending')
  if (epoch === null || typeof epoch !== 'object') return notDue('no-epoch')
  const ats = (Array.isArray(sealedAts) ? sealedAts : []).map((a) => Number.isFinite(a) ? Math.min(a, now) : now).sort((a, b) => a - b)
  if (ats.length === 0) return notDue('idle')
  if (log !== null && lowOnLog(log)) return notDue('log-reserve')
  const s = rekeyScale(entitled)
  const start = Number.isFinite(epochAt) ? Math.min(epochAt, now) : now
  const ageDue = start + REKEY_PERIOD_MS * s
  const n = REKEY_RECORDS * s
  const countDue = ats.length >= n ? ats[n - 1] : Infinity
  const dueAt = Math.min(ageDue, countDue)
  const reason = countDue <= ageDue ? 'count' : 'age'
  const j = Number.isFinite(jitter) ? Math.min(Math.max(jitter, 0), 1) : 0
  const at = ownEpoch === true ? dueAt : dueAt + REKEY_OTHER_WAIT_MS + Math.floor(j * REKEY_JITTER_MS)
  if (now >= at) return { due: true, at, reason }
  return notDue(ownEpoch === true ? 'young' : 'waiting', at)
}

const parseAt = (at) => {
  const ms = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(ms) ? ms : null
}

// The policy's facts from a private group's cores: `logs` [{ key, entries:
// [{ seq, record }] }], `counted` the writer keys the fold counts, `root`
// the group key, `epoch` the fold's { writer, seq }. Only records valid for
// their place count. -> { epochAt, sealedAts }.
function epochFacts ({ logs, counted, root, epoch }) {
  const out = { epochAt: null, sealedAts: [] }
  if (epoch === null || typeof epoch !== 'object') return out
  for (const log of Array.isArray(logs) ? logs : []) {
    if (!log || !(counted instanceof Set) || !counted.has(log.key)) continue
    const opts = { root: log.key === root, private: true }
    for (const e of Array.isArray(log.entries) ? log.entries : []) {
      const r = e && e.record
      if (!r || typeof r !== 'object' || (r.type !== 'group-sealed' && r.type !== 'group-key')) continue
      if (validateGroupRecord(r, e.seq, opts) !== null) continue
      if (r.type === 'group-key') {
        if (r.kid === null && log.key === epoch.writer && e.seq === epoch.seq) out.epochAt = parseAt(r.at)
      } else if (r.kid.writer === epoch.writer && r.kid.seq === epoch.seq) {
        const ms = parseAt(r.at)
        out.sealedAts.push(ms === null ? NaN : ms)
      }
    }
  }
  return out
}

// In-memory state of the periodic check: when each group was last checked
// and the jitter drawn for each epoch a waiting distributor saw.
function createRekeyGate ({ now = Date.now, random = Math.random, max = REKEY_GATE_MAX } = {}) {
  const checks = new Map()
  const jitters = new Map()
  const remember = (map, key, value) => {
    map.delete(key)
    map.set(key, value)
    while (map.size > max) map.delete(map.keys().next().value)
  }
  return {
    now () {
      return now()
    },
    // A clock that went back never locks a group out.
    ready (group) {
      const last = checks.get(group)
      if (last === undefined) return true
      const t = now()
      return t < last || t - last >= REKEY_CHECK_MS
    },
    checked (group) {
      remember(checks, group, now())
    },
    jitter (group, epoch) {
      const id = group + '/' + (epoch ? epoch.writer + ':' + epoch.seq : '')
      if (!jitters.has(id)) {
        const r = Number(random())
        remember(jitters, id, Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0)
      }
      return jitters.get(id)
    }
  }
}

module.exports = {
  REKEY_PERIOD_MS,
  REKEY_RECORDS,
  REKEY_SCALE_WRITERS,
  REKEY_MAX_SCALE,
  REKEY_OTHER_WAIT_MS,
  REKEY_JITTER_MS,
  REKEY_CHECK_MS,
  REKEY_LOG_RESERVE,
  rekeyScale,
  rekeyDue,
  epochFacts,
  createRekeyGate
}
