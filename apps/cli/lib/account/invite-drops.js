'use strict'

// Surprise invite drops: the server secret that draws each member's weekly
// minutes (./invite-drop-time.js) and the ledger of drops already notified.
// Two sidecars in dataDir, both mode 0o600 and replaced whole through
// writeJsonAtomic (packages/core/lib/store.js):
//
//   invite-drops-key.json = { v: 1, secret, enabledAt }. Created once, at
//   open, only when neither file exists. A valid key is never rewritten and
//   heal never recreates one that disappears while running: a new secret
//   draws new minutes, and the slot indexes in the ledger only mean something
//   under the old one. So a missing key next to an existing ledger, or a key
//   file this module would not have written, is left as it is and the drops
//   are unavailable until an operator restores it.
//
//   invite-drops.json = { v: 1, rows: [{ member, week, slots }] }: which
//   slots of a member's Brasília week were already handed to push. No minute
//   is ever stored, so the file says when nobody's invites open. Rows are
//   add-only and union-merged by member+week (slots union), and a week that
//   ended is dropped on each write.
//
// Writes follow ./invites-store.js: one in-process queue, guard() before and
// after the write, a re-read and union merge first (the service lock goes
// stale after 30 s and another holder may have replaced the file), a dirty
// flag that makes the next write or heal rewrite, and a file this module
// would not have written is never rewritten. Errors carry only a token in
// `code`; bad argument shapes throw TypeError.
//
// startInviteDropLoop hands due drops to push, one tick at a time. A notice
// never leaves outside 09:00-21:00 Brasília: a minute missed while the
// service was down goes out at the next window of the same week, and never
// after Monday 00:00. Slots are claimed (written) before the notify calls and
// never unmarked, so a crash between the two loses a notice instead of
// sending it twice. A member that canNotify refuses (no consent to the
// current terms yet) is skipped before the claim, so the notice still goes
// out later that week once consent exists. Logs carry only
// { event: 'sorteio', reason }.

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { weekStartMs, inWindow, windowEndMs, grantMinutes, grantsOpened, WEEK_MS } = require('./invite-drop-time')

const KEY_FILE = 'invite-drops-key.json'
const FILE = 'invite-drops.json'
const VERSION = 1
const PER_WEEK_MAX = 100
const BATCH_MAX = 32
const JOBS_PER_SLOT = 4
// A slot claimed closer than this to 21:00 could reach push after the
// deadline and be dropped, and a claimed slot is never retried. On Sunday
// there is no later window in the week, so the margin does not apply there.
const CLAIM_MARGIN_MS = 2 * 60 * 1000
const DAY_MS = WEEK_MS / 7
const KEY_KEYS = ['v', 'secret', 'enabledAt']
const ROW_KEYS = ['member', 'week', 'slots']
const MEMBER_ROW_KEYS = ['member', 'linkedAt']

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function has (map, key) {
  return Object.prototype.hasOwnProperty.call(map, key)
}

function exactKeys (obj, keys) {
  return Object.keys(obj).length === keys.length && keys.every((k) => has(obj, k))
}

function validMember (m) {
  return isLowerHex(m, 32)
}

function validWeek (w) {
  if (!isCanonicalIso(w)) return false
  const ms = Date.parse(w)
  return weekStartMs(ms) === ms
}

function validSlot (s) {
  return Number.isSafeInteger(s) && s >= 0 && s < PER_WEEK_MAX
}

function validSlots (slots) {
  if (!Array.isArray(slots) || slots.length === 0) return false
  for (let i = 0; i < slots.length; i++) {
    if (!validSlot(slots[i])) return false
    if (i > 0 && slots[i] <= slots[i - 1]) return false
  }
  return true
}

function iso (ms) {
  return new Date(ms).toISOString()
}

function rowKey (member, week) {
  return member + '\n' + week
}

// Missing is undefined, which JSON cannot produce: a file holding `null` is
// a parsed value, and the callers reject it as invalid instead of treating it
// as absent (which would let open generate a key over it).
function readJson (file) {
  let st
  try {
    st = fs.lstatSync(file)
  } catch (err) {
    if (err.code === 'ENOENT') return undefined
    throw err
  }
  if (!st.isFile()) throw new Error('sorteio inválido')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function exists (file) {
  try {
    fs.lstatSync(file)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

function fromKeyJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, KEY_KEYS) || obj.v !== VERSION) throw new Error('sorteio inválido')
  if (!isLowerHex(obj.secret, 32) || !isCanonicalIso(obj.enabledAt)) throw new Error('sorteio inválido')
  return { secret: Buffer.from(obj.secret, 'hex'), enabledAtMs: Date.parse(obj.enabledAt) }
}

// The ledger as a Map of member+week to a Set of slots.
function fromJson (obj) {
  if (!isPlainObject(obj) || !exactKeys(obj, ['v', 'rows']) || obj.v !== VERSION) throw new Error('sorteio inválido')
  if (!Array.isArray(obj.rows)) throw new Error('sorteio inválido')
  const rows = new Map()
  for (const r of obj.rows) {
    if (!isPlainObject(r) || !exactKeys(r, ROW_KEYS)) throw new Error('sorteio inválido')
    if (!validMember(r.member) || !validWeek(r.week) || !validSlots(r.slots)) throw new Error('sorteio inválido')
    const k = rowKey(r.member, r.week)
    if (rows.has(k)) throw new Error('sorteio inválido')
    rows.set(k, { member: r.member, week: r.week, slots: new Set(r.slots) })
  }
  return rows
}

function readLedger (file) {
  const obj = readJson(file)
  return obj === undefined ? null : fromJson(obj)
}

function toJson (rows) {
  const list = [...rows.values()]
    .map((r) => ({ member: r.member, week: r.week, slots: [...r.slots].sort((a, b) => a - b) }))
    .sort((a, b) => a.week !== b.week ? (a.week < b.week ? -1 : 1) : (a.member < b.member ? -1 : a.member > b.member ? 1 : 0))
  return { v: VERSION, rows: list }
}

function canonical (rows) {
  return JSON.stringify(toJson(rows))
}

function copyRows (rows) {
  const out = new Map()
  for (const [k, r] of rows) out.set(k, { member: r.member, week: r.week, slots: new Set(r.slots) })
  return out
}

// Union of memory and disk, without the weeks that ended by nowMs.
function merge (mem, disk, nowMs) {
  const out = copyRows(mem)
  if (disk) {
    for (const [k, r] of disk) {
      const cur = out.get(k)
      if (!cur) out.set(k, { member: r.member, week: r.week, slots: new Set(r.slots) })
      else for (const s of r.slots) cur.slots.add(s)
    }
  }
  for (const [k, r] of out) {
    if (Date.parse(r.week) + WEEK_MS <= nowMs) out.delete(k)
  }
  return out
}

function checkMarks (marks) {
  if (!Array.isArray(marks)) throw new TypeError('marks must be an array')
  for (const m of marks) {
    if (!isPlainObject(m) || !validMember(m.member)) throw new TypeError('member must be 64 lowercase hex characters')
    if (!validWeek(m.week)) throw new TypeError('week must be a canonical Brasília week start')
    if (!Array.isArray(m.slots) || m.slots.length === 0 || !m.slots.every(validSlot)) throw new TypeError('slots must be integers from 0 to 99')
  }
}

function openInviteDrops (dataDir, { perWeek, now = Date.now, guard = () => true, readOnly = false } = {}) {
  if (!(Number.isSafeInteger(perWeek) && perWeek >= 1 && perWeek <= PER_WEEK_MAX)) {
    throw new TypeError('perWeek must be an integer from 1 to ' + PER_WEEK_MAX)
  }
  refuseSymlinkDir(dataDir)
  const keyFile = path.join(dataDir, KEY_FILE)
  const file = path.join(dataDir, FILE)
  let key = null
  let rows = new Map()
  let failed = false
  let dirty = false
  let tail = Promise.resolve()
  const cache = new Map()
  let cacheWeek = null

  function openKey () {
    let obj
    try {
      obj = readJson(keyFile)
    } catch {
      return null
    }
    if (obj !== undefined) {
      try {
        return fromKeyJson(obj)
      } catch {
        return null
      }
    }
    if (readOnly || exists(file)) return null
    if (!guard()) return null
    const fresh = { v: VERSION, secret: nodeCrypto.randomBytes(32).toString('hex'), enabledAt: iso(now()) }
    writeJsonAtomic(keyFile, fresh, 0o600)
    if (!guard()) return null
    return fromKeyJson(fresh)
  }

  try {
    key = openKey()
    if (key === null) failed = true
    rows = readLedger(file) || new Map()
  } catch {
    failed = true
  }

  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function usable () {
    if (failed || key === null) throw fail('indisponivel')
  }

  function writable () {
    usable()
    if (readOnly || !guard()) throw fail('indisponivel')
  }

  function reread () {
    let disk
    try {
      disk = readLedger(file)
    } catch {
      failed = true
      throw fail('indisponivel')
    }
    const next = merge(rows, disk, now())
    const stale = dirty || canonical(next) !== canonical(disk || new Map())
    return { next, stale }
  }

  function persist (next) {
    try {
      writeJsonAtomic(file, toJson(next), 0o600)
    } catch (err) {
      dirty = true
      try {
        rows = merge(rows, readLedger(file), now())
      } catch {
        failed = true
      }
      throw err
    }
    dirty = false
    rows = next
    if (!guard()) {
      dirty = true
      throw fail('indisponivel')
    }
  }

  // Every mark of the list in one write: the loop claims a whole batch
  // before it sends any of it. Resolves to the slots this call claimed, as
  // [{ member, week, slots }]: a slot another holder already wrote to disk
  // is left out, so the loop does not send it a second time.
  function markBatch (marks) {
    return enqueue(() => {
      checkMarks(marks)
      writable()
      const { next } = reread()
      const claimed = new Map()
      for (const m of marks) {
        const k = rowKey(m.member, m.week)
        let r = next.get(k)
        if (!r) {
          r = { member: m.member, week: m.week, slots: new Set() }
          next.set(k, r)
        }
        for (const s of m.slots) {
          if (r.slots.has(s)) continue
          r.slots.add(s)
          if (!claimed.has(k)) claimed.set(k, { member: m.member, week: m.week, slots: [] })
          claimed.get(k).slots.push(s)
        }
      }
      // A mark for a week that already ended is pruned at once.
      const final = merge(next, null, now())
      persist(final)
      return [...claimed].filter(([k]) => final.has(k)).map(([, c]) => ({
        member: c.member,
        week: c.week,
        slots: c.slots.sort((a, b) => a - b)
      }))
    })
  }

  function markNotified (member, week, slots) {
    return markBatch([{ member, week, slots }])
  }

  function wasNotified (member, week, slot) {
    usable()
    const r = rows.get(rowKey(member, week))
    return r !== undefined && r.slots.has(slot)
  }

  function heal () {
    return enqueue(() => {
      if (failed || key === null || readOnly || !guard()) return false
      const { next, stale } = reread()
      if (stale) {
        persist(next)
        return true
      }
      rows = next
      return false
    }).catch(() => false)
  }

  // The drawn minutes of a member's week, cached for the current week only.
  function minutes (member, linkedAtIso, nowMs) {
    if (!validMember(member)) throw new TypeError('member must be 64 lowercase hex characters')
    if (!isCanonicalIso(linkedAtIso)) throw new TypeError('linkedAt must be a canonical ISO timestamp')
    if (!Number.isSafeInteger(nowMs)) throw new TypeError('nowMs must be a safe integer')
    usable()
    const ws = weekStartMs(nowMs)
    if (cacheWeek !== ws) {
      cache.clear()
      cacheWeek = ws
    }
    const k = member + '\n' + linkedAtIso
    let out = cache.get(k)
    if (out === undefined) {
      out = grantMinutes({
        secret: key.secret,
        member,
        weekStartMs: ws,
        perWeek,
        linkedAtMs: Date.parse(linkedAtIso),
        enabledAtMs: key.enabledAtMs
      })
      cache.set(k, out)
    }
    return out
  }

  function opened (member, linkedAtIso, nowMs) {
    usable()
    if (linkedAtIso === null) return 0
    return grantsOpened(minutes(member, linkedAtIso, nowMs), nowMs)
  }

  // The push topic of one drop: a later notice for the same slot replaces an
  // undelivered one, and the topic says nothing without the secret.
  function topic (member, week, slot) {
    usable()
    return nodeCrypto.createHmac('sha256', key.secret)
      .update('invite-drop-topic\n' + member + '\n' + week + '\n' + slot)
      .digest('hex')
      .slice(0, 32)
  }

  return {
    perWeek,
    available () { return !failed && key !== null },
    opened,
    minutes,
    topic,
    markNotified,
    markBatch,
    wasNotified,
    heal,
    fail () { failed = true }
  }
}

function validMemberRow (r) {
  return isPlainObject(r) && exactKeys(r, MEMBER_ROW_KEYS) && validMember(r.member) && isCanonicalIso(r.linkedAt)
}

function startInviteDropLoop ({
  drops,
  listMembers,
  notify,
  room,
  canNotify = () => true,
  now = Date.now,
  guard = () => true,
  tickMs = 30000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {}
} = {}) {
  if (!drops || typeof listMembers !== 'function' || typeof notify !== 'function' || typeof room !== 'function') {
    throw new TypeError('drops, listMembers, notify and room are required')
  }
  if (typeof canNotify !== 'function') throw new TypeError('canNotify must be a function')
  let timer = null
  let inflight = null
  let started = false
  let stopped = false
  let wasAvailable = null

  function noteAvailable () {
    const ok = drops.available()
    if (ok !== wasAvailable) {
      log({ event: 'sorteio', reason: ok ? 'ligado' : 'indisponivel' })
      wasAvailable = ok
    }
    return ok
  }

  function schedule (ms) {
    timer = setTimer(tick, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function halt () {
    stopped = true
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  function consents (member) {
    try {
      return canNotify(member) === true
    } catch {
      return false
    }
  }

  function due (nowMs, week) {
    let members
    try {
      members = listMembers()
    } catch {
      return []
    }
    if (!Array.isArray(members)) return []
    const out = []
    for (const r of members) {
      if (!validMemberRow(r)) continue
      const mins = drops.minutes(r.member, r.linkedAt, nowMs)
      const mine = []
      for (let slot = 0; slot < mins.length; slot++) {
        const m = mins[slot]
        if (m === null || m > nowMs) continue
        if (drops.wasNotified(r.member, week, slot)) continue
        mine.push({ minute: m, member: r.member, slot })
      }
      if (mine.length > 0 && consents(r.member)) out.push(...mine)
    }
    return out.sort((a, b) => {
      if (a.minute !== b.minute) return a.minute - b.minute
      if (a.member !== b.member) return a.member < b.member ? -1 : 1
      return a.slot - b.slot
    })
  }

  // A false guard() skips the tick and keeps the timer: one failed read of
  // the lock file must not end the drops until a restart. A lock that is
  // really lost goes through the service's loseLock(), which fails the drops
  // and stops this loop.
  async function run () {
    if (!guard()) return
    if (!noteAvailable()) return
    const nowMs = now()
    if (!inWindow(nowMs)) return
    const ws = weekStartMs(nowMs)
    // Left for the next window of the same week (the catch-up rule).
    const lastDay = nowMs - ws >= 6 * DAY_MS
    if (!lastDay && windowEndMs(nowMs) - nowMs < CLAIM_MARGIN_MS) return
    const week = new Date(ws).toISOString()
    let r
    try {
      r = room()
    } catch {
      return
    }
    const n = Math.min(BATCH_MAX, Math.floor((Number.isFinite(r) ? r : 0) / JOBS_PER_SLOT))
    if (n <= 0) return
    const batch = due(nowMs, week).slice(0, n)
    if (batch.length === 0) return
    const byMember = new Map()
    for (const d of batch) {
      if (!byMember.has(d.member)) byMember.set(d.member, [])
      byMember.get(d.member).push(d.slot)
    }
    const marks = [...byMember].map(([member, slots]) => ({ member, week, slots }))
    let claimed
    try {
      claimed = await drops.markBatch(marks)
    } catch {
      noteAvailable()
      return
    }
    const mine = new Set()
    for (const c of Array.isArray(claimed) ? claimed : []) {
      for (const s of c.slots) mine.add(c.member + '\n' + s)
    }
    const deadline = windowEndMs(nowMs)
    let queued = false
    let dropped = false
    for (const d of batch) {
      if (!mine.has(d.member + '\n' + d.slot)) continue
      let outcome
      try {
        outcome = notify({ member: d.member, topic: drops.topic(d.member, week, d.slot), deadline })
      } catch {
        continue
      }
      if (outcome === 'queued') queued = true
      else if (outcome === 'dropped') dropped = true
    }
    if (queued) log({ event: 'sorteio', reason: 'enviado' })
    if (dropped) log({ event: 'sorteio', reason: 'descartado' })
  }

  async function tick () {
    timer = null
    if (stopped) return
    inflight = run().catch(() => {}).finally(() => { inflight = null })
    await inflight
    if (!stopped) schedule(tickMs)
  }

  function start () {
    if (started || stopped) return
    started = true
    noteAvailable()
    schedule(0)
  }

  async function stop () {
    halt()
    if (inflight !== null) await inflight
  }

  return { start, stop }
}

module.exports = {
  openInviteDrops,
  startInviteDropLoop,
  KEY_FILE,
  FILE,
  BATCH_MAX
}
