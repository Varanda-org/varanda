'use strict'

// The pure rules of the Varandinha (the balcony garden): the pot and act
// shapes of the `garden-state` record, growth under the reader's clock, the
// reducer of one play session, and the folds of neighbours' `garden-help`
// records. Core validates records with them, the node judges plays and helps
// with them and the app draws the balcony with them, so every side agrees.
// Zero dependencies, no Node built-ins. Nothing here throws, no input is ever
// mutated and the clock is always a `now` argument in ms: peer records are
// read once into plain copies, and only the copies are judged and used.

const GARDEN_POTS = 6
// Portuguese ASCII ids, as THEME_IDS and the Feira KINDS; the pt-BR labels
// live in the app.
const GARDEN_PLANTS = Object.freeze([
  Object.freeze({ id: 'manjericao', ripeMs: 21600000 }),
  Object.freeze({ id: 'tomate', ripeMs: 36000000 }),
  Object.freeze({ id: 'pimenta', ripeMs: 57600000 }),
  Object.freeze({ id: 'alecrim', ripeMs: 86400000 }),
  Object.freeze({ id: 'samambaia', ripeMs: 129600000 }),
  Object.freeze({ id: 'espada', ripeMs: 172800000 })
])
const GARDEN_WATER_GAP_MS = 10800000
const GARDEN_WATER_BOOST_MS = 3600000
const GARDEN_WATER_MAX = 12
const GARDEN_HELP_BOOST_MS = 7200000
const GARDEN_HELP_PER_POT = 3
const GARDEN_GIVEN_BOOST_MS = 1800000
const GARDEN_GIVEN_PER_POT = 3
const GARDEN_SAVES_DAILY_MAX = 6
const GARDEN_HELPS_DAILY_MAX = 5
const GARDEN_ACTS_MAX = 24
const GARDEN_HELP_WINDOW_MS = 259200000
const GARDEN_HELP_ROWS = 24
const GARDEN_STREET_PAGE = 20
const GARDEN_DAY_MS = 86400000
// Brasília time, fixed UTC-3 (no daylight saving time since 2019), the same
// day math as packages/core/lib/activity.js, copied so this package keeps
// zero dependencies.
const GARDEN_DAY_OFFSET_MS = -10800000
// The feed's tolerance for a record dated ahead of the reader's clock
// (packages/core/lib/feed.js).
const GARDEN_MAX_FUTURE_MS = 86400000

const POT_KEYS = Object.freeze(['plant', 'at', 'water', 'w'])
const PLANT_ACT_KEYS = Object.freeze(['op', 'pot', 'plant'])
const POT_ACT_KEYS = Object.freeze(['op', 'pot'])
const POT_OPS = Object.freeze(['water', 'harvest', 'clear'])
const FOLLOW_KEYS = Object.freeze(['type', 'key', 'on', 'at'])
const FLAG_KEYS = Object.freeze(['type', 'on', 'at'])
const STATE_KEYS = Object.freeze(['type', 'pots', 'n', 'at'])
const HELP_KEYS = Object.freeze(['type', 'to', 'pot', 'at'])

// Rows a fold reads at most: the index and the peeks hand over far fewer
// (GARDEN_HELP_ROWS), so a longer list is no honest input and counts nothing.
const FOLD_ROWS_MAX = 1024
const MAX_TIME_MS = 8.64e15
const HEX64 = /^[0-9a-f]{64}$/

const isHex64 = (v) => typeof v === 'string' && HEX64.test(v)

function isTime (v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_TIME_MS
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// One plain copy of v with exactly `keys`, each value read once from its own
// enumerable data property (never through a get, so a Proxy trap or an
// accessor cannot answer twice), or null when v is anything else.
function snapshot (v, keys) {
  try {
    if (!isPlainObject(v) || Object.getOwnPropertySymbols(v).length > 0) return null
    const names = Object.getOwnPropertyNames(v)
    if (names.length !== keys.length || !keys.every((k) => names.includes(k))) return null
    const out = {}
    for (const k of keys) {
      const d = Object.getOwnPropertyDescriptor(v, k)
      if (!d || !('value' in d) || !d.enumerable) return null
      out[k] = d.value
    }
    return out
  } catch {
    return null
  }
}

// A plain copy of a dense array of at most `max` items with no other own
// property, each item read once from its data property, or null.
function snapshotArray (v, max) {
  try {
    if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) return null
    if (Object.getOwnPropertySymbols(v).length > 0) return null
    const ld = Object.getOwnPropertyDescriptor(v, 'length')
    const len = ld && ld.value
    if (!Number.isSafeInteger(len) || len < 0 || len > max) return null
    if (Object.getOwnPropertyNames(v).length !== len + 1) return null
    const out = []
    for (let i = 0; i < len; i++) {
      const d = Object.getOwnPropertyDescriptor(v, String(i))
      if (!d || !('value' in d) || !d.enumerable) return null
      out.push(d.value)
    }
    return out
  } catch {
    return null
  }
}

// One own data property of a caller-built object (an options bag, a row),
// extra keys allowed, or undefined. Never runs a getter.
function field (o, k) {
  try {
    if (o === null || typeof o !== 'object') return undefined
    const d = Object.getOwnPropertyDescriptor(o, k)
    return d && 'value' in d ? d.value : undefined
  } catch {
    return undefined
  }
}

// The ms of a canonical instant (Date.parse finite and the toISOString form
// round trips), or NaN.
function isoMs (v) {
  try {
    if (typeof v !== 'string' || v.length > 32) return NaN
    const ms = Date.parse(v)
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== v) return NaN
    return ms
  } catch {
    return NaN
  }
}

function plantOf (id) {
  if (typeof id !== 'string') return null
  for (const p of GARDEN_PLANTS) if (p.id === id) return p
  return null
}

function isPlantId (v) {
  return plantOf(v) !== null
}

function isPotIndex (v) {
  return Number.isSafeInteger(v) && v >= 0 && v < GARDEN_POTS
}

function isSaveOrdinal (v) {
  return Number.isSafeInteger(v) && v >= 1 && v <= GARDEN_SAVES_DAILY_MAX
}

// Epoch ms of 00:00 Brasília of the day containing ms, or NaN. The double
// modulo keeps the result right for instants before the epoch too. The
// earliest instants start their day below the Date range, which is NaN too.
function dayStart (ms) {
  if (!isTime(ms)) return NaN
  const start = ms - (((ms + GARDEN_DAY_OFFSET_MS) % GARDEN_DAY_MS) + GARDEN_DAY_MS) % GARDEN_DAY_MS
  return isTime(start) ? start : NaN
}

// The Brasília calendar day of ms as 'YYYY-MM-DD', or null.
function gardenDay (ms) {
  try {
    if (!isTime(ms)) return null
    const day = new Date(ms + GARDEN_DAY_OFFSET_MS).toISOString().slice(0, 10)
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
  } catch {
    return null
  }
}

// A pot: null (empty) or { plant, at, water, w }. Returns the copy, null for
// an empty pot, or undefined when v is no pot dated at or before recordAtMs.
function copyPot (v, recordAtMs) {
  if (v === null) return null
  const p = snapshot(v, POT_KEYS)
  if (p === null || !isPlantId(p.plant)) return undefined
  const at = isoMs(p.at)
  const water = isoMs(p.water)
  if (Number.isNaN(at) || Number.isNaN(water) || !(at <= water) || !(water <= recordAtMs)) return undefined
  if (!Number.isSafeInteger(p.w) || p.w < 0 || p.w > GARDEN_WATER_MAX) return undefined
  return p
}

function copyPots (v, recordAtMs) {
  const list = snapshotArray(v, GARDEN_POTS)
  if (list === null || list.length !== GARDEN_POTS) return null
  const out = []
  for (const item of list) {
    const p = copyPot(item, recordAtMs)
    if (p === undefined) return null
    out.push(p)
  }
  return out
}

// recordAtMs is the ms of the record that carries the pot: a pot cannot be
// watered after the record that states it was written.
function isPot (v, recordAtMs) {
  return isTime(recordAtMs) && copyPot(v, recordAtMs) !== undefined
}

function isPots (v, recordAtMs) {
  return isTime(recordAtMs) && copyPots(v, recordAtMs) !== null
}

function copyAct (v) {
  const plant = snapshot(v, PLANT_ACT_KEYS)
  if (plant !== null) return plant.op === 'plant' && isPotIndex(plant.pot) && isPlantId(plant.plant) ? plant : null
  const act = snapshot(v, POT_ACT_KEYS)
  if (act === null || typeof act.op !== 'string' || !POT_OPS.includes(act.op) || !isPotIndex(act.pot)) return null
  return act
}

function copyActs (v) {
  const list = snapshotArray(v, GARDEN_ACTS_MAX)
  if (list === null || list.length < 1) return null
  const out = []
  for (const item of list) {
    const a = copyAct(item)
    if (a === null) return null
    out.push(a)
  }
  return out
}

function isAct (v) {
  return copyAct(v) !== null
}

function isActs (v) {
  return copyActs(v) !== null
}

// Whether record is a `follow` of owner that is on: the evidence a helper
// follows the balcony it waters.
function isFollowOf (record, owner) {
  if (!isHex64(owner)) return false
  const f = snapshot(record, FOLLOW_KEYS)
  return f !== null && f.type === 'follow' && f.key === owner && f.on === true && !Number.isNaN(isoMs(f.at))
}

function count (v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : 0
}

// Six per-pot counts: an array of exactly six safe integers >= 0, or six
// zeros for anything else, so a bad argument never reads as NaN.
function counts (v) {
  const list = snapshotArray(v, GARDEN_POTS)
  if (list === null || list.length !== GARDEN_POTS || !list.every((n) => Number.isSafeInteger(n) && n >= 0)) {
    return new Array(GARDEN_POTS).fill(0)
  }
  return list
}

function zeros () {
  return new Array(GARDEN_POTS).fill(0)
}

// The view of a pot copy (already checked) at now.
function viewOf (p, now, received, given) {
  const plant = plantOf(p.plant)
  const at = Date.parse(p.at)
  const water = Date.parse(p.water)
  const waters = Math.min(p.w, Math.floor((water - at) / GARDEN_WATER_GAP_MS))
  const boost = waters * GARDEN_WATER_BOOST_MS +
    Math.min(received, GARDEN_HELP_PER_POT) * GARDEN_HELP_BOOST_MS +
    Math.min(given, GARDEN_GIVEN_PER_POT) * GARDEN_GIVEN_BOOST_MS
  const need = Math.max(plant.ripeMs / 2, plant.ripeMs - boost)
  const progress = now <= at ? 0 : Math.min(1, (now - at) / need)
  const ripe = progress >= 1
  const stage = ripe ? 3 : progress < 0.25 ? 0 : progress < 0.6 ? 1 : 2
  const dry = now - water >= GARDEN_WATER_GAP_MS
  return { plant: plant.id, progress, stage, ripe, ripeAt: at + need, dry, canWater: !ripe && dry }
}

// A view whose ripeAt is no valid time is none, so a caller formatting ripeAt
// as a Date never throws. potView and foldBalcony both read pots through it,
// so they answer alike for the same pot and clock.
function shownView (p, now, received, given) {
  const view = viewOf(p, now, received, given)
  return isTime(view.ripeAt) ? view : null
}

// Growth has no death and no stall: an unwatered pot still ripens, watering
// and neighbours only shorten the wait, never below half of it. A pot watered
// past the reader's future tolerance is no pot.
function potView (pot, now, opts) {
  if (!isTime(now)) return null
  const p = copyPot(pot, now + GARDEN_MAX_FUTURE_MS)
  if (!p) return null
  return shownView(p, now, count(field(opts, 'received')), count(field(opts, 'given')))
}

function emptyPots () {
  return new Array(GARDEN_POTS).fill(null)
}

// One play session: every act in order against a copy of the pots. One
// invalid act refuses the whole batch. Watering is judged with no
// neighbour boosts, so a session the node accepts never depends on helps it
// could not verify; only harvest reads the passed counts.
function applyActs (state, acts, now, opts) {
  if (!isTime(now)) return { ok: false, reason: 'invalid' }
  let pots
  if (state === null || state === undefined) {
    pots = emptyPots()
  } else {
    pots = copyPots(field(state, 'pots'), now)
    if (pots === null) return { ok: false, reason: 'state' }
  }
  const list = copyActs(acts)
  if (list === null) return { ok: false, reason: 'acts' }
  const received = counts(field(opts, 'received'))
  const given = counts(field(opts, 'given'))
  let iso
  try {
    iso = new Date(now).toISOString()
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  for (const act of list) {
    const p = pots[act.pot]
    if (act.op === 'plant') {
      if (p !== null) return { ok: false, reason: 'occupied' }
      pots[act.pot] = { plant: act.plant, at: iso, water: iso, w: 0 }
      continue
    }
    if (p === null) return { ok: false, reason: 'empty' }
    if (act.op === 'water') {
      if (!viewOf(p, now, 0, 0).canWater) return { ok: false, reason: 'not-dry' }
      pots[act.pot] = { plant: p.plant, at: p.at, water: iso, w: Math.min(p.w + 1, GARDEN_WATER_MAX) }
    } else if (act.op === 'harvest') {
      if (!viewOf(p, now, received[act.pot], given[act.pot]).ripe) return { ok: false, reason: 'not-ripe' }
      pots[act.pot] = null
    } else {
      pots[act.pot] = null
    }
  }
  return { ok: true, state: { pots } }
}

function inWindow (atMs, now) {
  return atMs <= now + GARDEN_MAX_FUTURE_MS && atMs >= now - GARDEN_HELP_WINDOW_MS
}

function rows (v) {
  return snapshotArray(v, FOLD_ROWS_MAX) || []
}

function seqOf (row) {
  const seq = field(row, 'seq')
  return Number.isSafeInteger(seq) && seq >= 1 ? seq : null
}

// A garden-help record copy, or null.
function helpOf (record) {
  const h = snapshot(record, HELP_KEYS)
  if (h === null || h.type !== 'garden-help' || !isHex64(h.to) || !isPotIndex(h.pot)) return null
  const atMs = isoMs(h.at)
  return Number.isNaN(atMs) ? null : { to: h.to, pot: h.pot, at: h.at, atMs }
}

function potsOrEmpty (pots) {
  return copyPots(pots, Infinity) || emptyPots()
}

// The neighbours' helps to owner's balcony. Each counted help is signed by
// a follower (its follow record is the evidence), dated inside the window,
// at most one per helper per Brasília day (the lowest seq of that day), and
// lands on a pot planted no later than the help. The day is dayStart, the
// same day the writer checks use. The window spans up to five days, so the
// helper list keeps one row per neighbour (the newest kept help): a few
// accounts cannot fill it and push real helpers off.
function foldHelps (args) {
  const perPot = zeros()
  const empty = { perPot, helpers: [] }
  const owner = field(args, 'owner')
  const now = field(args, 'now')
  if (!isHex64(owner) || !isTime(now)) return empty
  const pots = potsOrEmpty(field(args, 'pots'))
  const byDay = new Map()
  for (const row of rows(field(args, 'helps'))) {
    const author = field(row, 'author')
    const seq = seqOf(row)
    if (!isHex64(author) || author === owner || seq === null) continue
    const h = helpOf(field(row, 'record'))
    if (h === null || h.to !== owner || !inWindow(h.atMs, now)) continue
    if (!isFollowOf(field(row, 'follow'), owner)) continue
    const day = dayStart(h.atMs)
    if (Number.isNaN(day)) continue
    const key = author + '/' + day
    const prev = byDay.get(key)
    if (prev === undefined || seq < prev.seq) byDay.set(key, { author, seq, pot: h.pot, at: h.at, atMs: h.atMs })
  }
  const kept = []
  for (const h of byDay.values()) {
    const p = pots[h.pot]
    if (p !== null && h.atMs >= Date.parse(p.at)) kept.push(h)
  }
  kept.sort((a, b) => a.atMs - b.atMs || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || a.seq - b.seq)
  for (const h of kept) if (perPot[h.pot] < GARDEN_HELP_PER_POT) perPot[h.pot]++
  const newest = new Map()
  for (const h of kept) {
    const prev = newest.get(h.author)
    if (prev === undefined || h.atMs > prev.atMs || (h.atMs === prev.atMs && h.seq < prev.seq)) newest.set(h.author, h)
  }
  const helpers = [...newest.values()]
    .sort((a, b) => b.atMs - a.atMs || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || a.seq - b.seq)
    .slice(0, GARDEN_HELP_ROWS)
    .map((h) => ({ author: h.author, seq: h.seq, pot: h.pot, at: h.at }))
  return { perPot, helpers }
}

// The own helps to other balconies, as a small boost to every own pot
// planted no later than the help: one per balcony per day, at most
// GARDEN_HELPS_DAILY_MAX a day (the lowest seqs), inside the window.
function foldGiven (args) {
  const perPot = zeros()
  const self = field(args, 'self')
  const now = field(args, 'now')
  if (!isHex64(self) || !isTime(now)) return { perPot }
  const pots = potsOrEmpty(field(args, 'pots'))
  const byTo = new Map()
  for (const row of rows(field(args, 'given'))) {
    const seq = seqOf(row)
    if (seq === null) continue
    const h = helpOf(field(row, 'record'))
    if (h === null || h.to === self || !inWindow(h.atMs, now)) continue
    const day = dayStart(h.atMs)
    if (Number.isNaN(day)) continue
    const key = h.to + '/' + day
    const prev = byTo.get(key)
    if (prev === undefined || seq < prev.seq) byTo.set(key, { seq, day, atMs: h.atMs })
  }
  const byDay = new Map()
  for (const h of byTo.values()) {
    if (!byDay.has(h.day)) byDay.set(h.day, [])
    byDay.get(h.day).push(h)
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => a.seq - b.seq)
    for (const h of list.slice(0, GARDEN_HELPS_DAILY_MAX)) {
      for (let i = 0; i < GARDEN_POTS; i++) {
        const p = pots[i]
        if (p !== null && Date.parse(p.at) <= h.atMs && perPot[i] < GARDEN_GIVEN_PER_POT) perPot[i]++
      }
    }
  }
  return { perPot }
}

// One balcony as a reader sees it. A flag or a state dated more than
// GARDEN_MAX_FUTURE_MS ahead of now is dropped (a dropped flag reads off) and
// the balcony reads as six empty pots with stale true; an off or missing
// flag shows no pots either.
function foldBalcony (args) {
  const owner = field(args, 'owner')
  const now = field(args, 'now')
  const out = { on: false, pots: emptyPots(), helpers: [], stale: false }
  if (!isHex64(owner) || !isTime(now)) return out
  let stale = false
  const flag = snapshot(field(args, 'flag'), FLAG_KEYS)
  const flagMs = flag && flag.type === 'garden' && typeof flag.on === 'boolean' ? isoMs(flag.at) : NaN
  let on = !Number.isNaN(flagMs) && flag.on === true
  if (!Number.isNaN(flagMs) && flagMs > now + GARDEN_MAX_FUTURE_MS) {
    on = false
    stale = true
  }
  let pots = null
  const state = snapshot(field(args, 'state'), STATE_KEYS)
  const stateMs = state && state.type === 'garden-state' && isSaveOrdinal(state.n) ? isoMs(state.at) : NaN
  if (!Number.isNaN(stateMs)) {
    if (stateMs > now + GARDEN_MAX_FUTURE_MS) stale = true
    else pots = copyPots(state.pots, stateMs)
  }
  if (!on || pots === null) return { on, pots: emptyPots(), helpers: [], stale }
  const helps = foldHelps({ owner, pots, helps: field(args, 'helps'), now })
  const given = foldGiven({ self: owner, pots, given: field(args, 'given'), now })
  const views = pots.map((p, i) => p === null ? null : shownView(p, now, helps.perPot[i], given.perPot[i]))
  return { on: true, pots: views, helpers: helps.helpers, stale: false }
}

// The own helps rows as ms, or null when the list itself is unreadable. A
// row's at is a canonical instant or a safe integer of ms.
function ownRows (v) {
  const list = snapshotArray(v, FOLD_ROWS_MAX)
  if (list === null) return null
  const out = []
  for (const row of list) {
    const to = field(row, 'to')
    const at = field(row, 'at')
    const atMs = typeof at === 'number' ? (Number.isSafeInteger(at) ? at : NaN) : isoMs(at)
    if (isHex64(to) && !Number.isNaN(atMs)) out.push({ to, atMs })
  }
  return out
}

// Whether self may water to's balcony now. A row dated after today (the
// clock moved back) counts as today, so turning the clock back never frees
// the daily budget. Unreadable input answers 'invalid', never ok.
function helpAllowed (args) {
  const self = field(args, 'self')
  const to = field(args, 'to')
  const now = field(args, 'now')
  if (!isHex64(self) || !isHex64(to) || !isTime(now)) return { ok: false, reason: 'invalid' }
  if (to === self) return { ok: false, reason: 'self' }
  let follows = false
  try {
    const set = field(args, 'follows')
    follows = set instanceof Set && Set.prototype.has.call(set, to) === true
  } catch {
    follows = false
  }
  if (!follows) return { ok: false, reason: 'not-following' }
  const own = ownRows(field(args, 'own'))
  if (own === null) return { ok: false, reason: 'invalid' }
  const today = dayStart(now)
  if (Number.isNaN(today)) return { ok: false, reason: 'invalid' }
  const todays = own.filter((r) => r.atMs >= today)
  if (todays.some((r) => r.to === to)) return { ok: false, reason: 'same-day' }
  if (todays.length >= GARDEN_HELPS_DAILY_MAX) return { ok: false, reason: 'daily' }
  return { ok: true }
}

// The ordinal n of the next saved state today: 1 on a fresh Brasília day,
// null past GARDEN_SAVES_DAILY_MAX. A previous state dated after today counts
// as today; an unreadable one, or a clock whose day start is no valid time
// (helpAllowed's 'invalid'), answers null, never a fresh budget.
function saveOrdinal (prevState, now) {
  const today = dayStart(now)
  if (Number.isNaN(today)) return null
  if (prevState === null || prevState === undefined) return 1
  const n = field(prevState, 'n')
  const atMs = isoMs(field(prevState, 'at'))
  if (!isSaveOrdinal(n) || Number.isNaN(atMs)) return null
  if (atMs < today) return 1
  return n < GARDEN_SAVES_DAILY_MAX ? n + 1 : null
}

module.exports = Object.freeze({
  GARDEN_POTS,
  GARDEN_PLANTS,
  GARDEN_WATER_GAP_MS,
  GARDEN_WATER_BOOST_MS,
  GARDEN_WATER_MAX,
  GARDEN_HELP_BOOST_MS,
  GARDEN_HELP_PER_POT,
  GARDEN_GIVEN_BOOST_MS,
  GARDEN_GIVEN_PER_POT,
  GARDEN_SAVES_DAILY_MAX,
  GARDEN_HELPS_DAILY_MAX,
  GARDEN_ACTS_MAX,
  GARDEN_HELP_WINDOW_MS,
  GARDEN_HELP_ROWS,
  GARDEN_STREET_PAGE,
  GARDEN_DAY_MS,
  GARDEN_DAY_OFFSET_MS,
  GARDEN_MAX_FUTURE_MS,
  isPlantId,
  isPotIndex,
  isPot,
  isPots,
  isSaveOrdinal,
  isAct,
  isActs,
  isFollowOf,
  gardenDay,
  dayStart,
  potView,
  applyActs,
  foldHelps,
  foldGiven,
  foldBalcony,
  helpAllowed,
  saveOrdinal
})
