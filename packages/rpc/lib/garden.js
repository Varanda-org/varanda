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
// Enfeites: ids only, in their canonical order; where each one is drawn is
// the app's business.
const GARDEN_DECOR_IDS = Object.freeze(['rede', 'varal', 'gato', 'pisca'])
// The Barraquinha opens on Saturdays (getUTCDay of the Brasília-shifted
// instant), and a mimo offered that day can be taken for a week from the
// start of its day.
const GARDEN_STALL_WEEKDAY = 6
const GARDEN_STALL_WINDOW_MS = 7 * GARDEN_DAY_MS
const GARDEN_GIFTS_DAILY_MAX = 3
const GARDEN_TAKES_DAILY_MAX = 6
// Six takes a day across the nine Brasília days that the eight-day take
// prune (691200000 ms) can touch, so every take an honest writer keeps fits:
// the bound of the own takes list and of the index takes map.
const GARDEN_TAKE_ROWS = 54
const GARDEN_GIFT_ROWS = 12
const GARDEN_SHELF_ROWS = 8
const GARDEN_SHELF_SHOWN = 4

const POT_KEYS = Object.freeze(['plant', 'at', 'water', 'w'])
const PLANT_ACT_KEYS = Object.freeze(['op', 'pot', 'plant'])
const POT_ACT_KEYS = Object.freeze(['op', 'pot'])
const POT_OPS = Object.freeze(['water', 'harvest', 'clear'])
const FOLLOW_KEYS = Object.freeze(['type', 'key', 'on', 'at'])
const FLAG_KEYS = Object.freeze(['type', 'on', 'at'])
const STATE_KEYS = Object.freeze(['type', 'pots', 'n', 'at'])
const HELP_KEYS = Object.freeze(['type', 'to', 'pot', 'at'])
const DECOR_KEYS = Object.freeze(['type', 'items', 'at'])
const GIFT_KEYS = Object.freeze(['type', 'to', 'item', 'at'])
const TAKE_KEYS = Object.freeze(['type', 'from', 'seq', 'at'])

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

function isDecorId (v) {
  return typeof v === 'string' && GARDEN_DECOR_IDS.includes(v)
}

// Strictly ascending in GARDEN_DECOR_IDS order, so one set of enfeites has
// exactly one encoding and no id repeats.
function copyDecor (v) {
  const list = snapshotArray(v, GARDEN_DECOR_IDS.length)
  if (list === null) return null
  let last = -1
  for (const id of list) {
    const i = isDecorId(id) ? GARDEN_DECOR_IDS.indexOf(id) : -1
    if (i <= last) return null
    last = i
  }
  return list
}

function isDecor (v) {
  return copyDecor(v) !== null
}

function isGiftItem (v) {
  return isPlantId(v)
}

// The same Brasília shift as gardenDay.
function stallDay (ms) {
  if (!isTime(ms)) return false
  try {
    return new Date(ms + GARDEN_DAY_OFFSET_MS).getUTCDay() === GARDEN_STALL_WEEKDAY
  } catch {
    return false
  }
}

// A mimo dated on a Saturday, not past the reader's future tolerance, while
// the week from the start of its day lasts.
function offerListable (atMs, now) {
  if (!isTime(atMs) || !isTime(now) || !stallDay(atMs)) return false
  if (!(atMs <= now + GARDEN_MAX_FUTURE_MS)) return false
  const start = dayStart(atMs)
  return !Number.isNaN(start) && now < start + GARDEN_STALL_WINDOW_MS
}

// Gives the ripe pot `pot` away: the pot empties exactly as a harvest would,
// judged by the same ripeness, and the mimo is named by its plant id. No
// weekday check here (the node's giveAllowed holds it) and no new ordinal.
function applyGive (state, pot, now, opts) {
  if (!isTime(now)) return { ok: false, reason: 'invalid' }
  let pots
  if (state === null || state === undefined) {
    pots = emptyPots()
  } else {
    pots = copyPots(field(state, 'pots'), now)
    if (pots === null) return { ok: false, reason: 'state' }
  }
  if (!isPotIndex(pot)) return { ok: false, reason: 'pot' }
  const p = pots[pot]
  if (p === null) return { ok: false, reason: 'empty' }
  const received = counts(field(opts, 'received'))
  const given = counts(field(opts, 'given'))
  if (!viewOf(p, now, received[pot], given[pot]).ripe) return { ok: false, reason: 'not-ripe' }
  pots[pot] = null
  return { ok: true, state: { pots }, item: p.plant }
}

function followsKey (args, key) {
  try {
    const set = field(args, 'follows')
    return set instanceof Set && Set.prototype.has.call(set, key) === true
  } catch {
    return false
  }
}

// Whether self may offer a mimo to `to` now. As in helpAllowed, a row dated
// after today counts as today, so turning the clock back never frees the
// budget, and unreadable input answers 'invalid', never ok.
function giveAllowed (args) {
  const self = field(args, 'self')
  const to = field(args, 'to')
  const now = field(args, 'now')
  const own = ownRows(field(args, 'own'))
  const today = dayStart(now)
  if (!isHex64(self) || !isHex64(to) || own === null || Number.isNaN(today)) return { ok: false, reason: 'invalid' }
  if (to === self) return { ok: false, reason: 'self' }
  if (!followsKey(args, to)) return { ok: false, reason: 'not-following' }
  if (!stallDay(now)) return { ok: false, reason: 'closed' }
  const todays = own.filter((r) => r.atMs >= today)
  if (todays.some((r) => r.to === to)) return { ok: false, reason: 'same-day' }
  if (todays.length >= GARDEN_GIFTS_DAILY_MAX) return { ok: false, reason: 'daily' }
  return { ok: true }
}

function isSeq (v) {
  return Number.isSafeInteger(v) && v >= 1
}

// The own takes rows, or null when the list itself is unreadable. A row
// naming a gift with an unreadable at still marks that gift taken; it only
// leaves the daily count.
function ownTakeRows (v) {
  const list = snapshotArray(v, FOLD_ROWS_MAX)
  if (list === null) return null
  const out = []
  for (const row of list) {
    const from = field(row, 'from')
    const seq = field(row, 'seq')
    const at = field(row, 'at')
    const atMs = typeof at === 'number' ? (Number.isSafeInteger(at) ? at : NaN) : isoMs(at)
    if (isHex64(from) && isSeq(seq)) out.push({ from, seq, atMs })
  }
  return out
}

// A garden-gift record copy, or null.
function giftOf (record) {
  const g = snapshot(record, GIFT_KEYS)
  if (g === null || g.type !== 'garden-gift' || !isHex64(g.to) || !isGiftItem(g.item)) return null
  const atMs = isoMs(g.at)
  return Number.isNaN(atMs) ? null : { to: g.to, item: g.item, at: g.at, atMs }
}

// A garden-take record copy, or null.
function takeOf (record) {
  const t = snapshot(record, TAKE_KEYS)
  if (t === null || t.type !== 'garden-take' || !isHex64(t.from) || !isSeq(t.seq)) return null
  const atMs = isoMs(t.at)
  return Number.isNaN(atMs) ? null : { from: t.from, seq: t.seq, at: t.at, atMs }
}

// Whether self may accept the mimo `gift`, block `seq` of from's diary. The
// accepter need not follow the giver: the giver chose them. A gift with a
// non-canonical at is no gift ('not-found').
function takeAllowed (args) {
  const self = field(args, 'self')
  const from = field(args, 'from')
  const seq = field(args, 'seq')
  const now = field(args, 'now')
  const own = ownTakeRows(field(args, 'own'))
  const today = dayStart(now)
  if (!isHex64(self) || !isHex64(from) || !isSeq(seq) || own === null || Number.isNaN(today)) return { ok: false, reason: 'invalid' }
  if (from === self) return { ok: false, reason: 'self' }
  const g = giftOf(field(args, 'gift'))
  if (g === null || g.to !== self) return { ok: false, reason: 'not-found' }
  if (!offerListable(g.atMs, now)) return { ok: false, reason: 'expired' }
  if (own.some((r) => r.from === from && r.seq === seq)) return { ok: false, reason: 'taken' }
  if (own.filter((r) => r.atMs >= today).length >= GARDEN_TAKES_DAILY_MAX) return { ok: false, reason: 'daily' }
  return { ok: true }
}

// `since` is the seq of the owner's live on flag: a record at or below it was
// left live by an older join (a Phase 1 leave does not tombstone it), so it
// never returns after a rejoin. Without a valid since nothing shows.
function liveSince (seq, since) {
  return isSeq(seq) && isSeq(since) && seq > since
}

function foldDecor (args) {
  const none = { items: [] }
  const now = field(args, 'now')
  if (!isTime(now) || !liveSince(field(args, 'seq'), field(args, 'since'))) return none
  const d = snapshot(field(args, 'record'), DECOR_KEYS)
  if (d === null || d.type !== 'garden-decor') return none
  const items = copyDecor(d.items)
  const atMs = isoMs(d.at)
  if (items === null || Number.isNaN(atMs) || atMs > now + GARDEN_MAX_FUTURE_MS) return none
  return { items }
}

const byText = (a, b) => a < b ? -1 : a > b ? 1 : 0

// A giver can date a gift up to GARDEN_MAX_FUTURE_MS ahead and still be
// listed, so ranking by the claimed date alone would let a few followers
// dating ahead own every row of the cut. Rows dated after now come after
// every row at or before now, nearest to now first, as the engagement index
// orders helps (gardenRowOrder).
function pendingOrder (now) {
  return (a, b) => {
    const fa = a.atMs > now
    const fb = b.atMs > now
    if (fa !== fb) return fa ? 1 : -1
    if (a.atMs !== b.atMs) return fa ? a.atMs - b.atMs : b.atMs - a.atMs
    return byText(a.author, b.author) || a.seq - b.seq
  }
}

function inSet (set, key) {
  try {
    return set instanceof Set && Set.prototype.has.call(set, key) === true
  } catch {
    return false
  }
}

// The mimos offered to owner that are still open. Each comes from a
// follower of owner (the follow is the evidence, so a stranger cannot fill
// the list), one per giver per Brasília day, the lowest seq. That pick is
// made before the taken pairs are dropped, so taking the first gift of a day
// never surfaces a second one. The daily cap is the writer's check: a fourth
// gift that slipped through is not dropped here. An unreadable taken list
// shows nothing rather than gifts already taken. A follow is one-sided and a
// giver may backdate a gift to the end of its Saturday, so givers the owner
// follows (`followed`, a Set) rank before all others: accounts the owner
// never followed cannot push them out of the cut.
function foldPending (args) {
  const empty = { rows: [] }
  const owner = field(args, 'owner')
  const now = field(args, 'now')
  if (!isHex64(owner) || !isTime(now)) return empty
  const taken = snapshotArray(field(args, 'taken'), FOLD_ROWS_MAX)
  if (taken === null) return empty
  const followed = field(args, 'followed')
  const byDay = new Map()
  for (const row of rows(field(args, 'gifts'))) {
    const author = field(row, 'author')
    const seq = seqOf(row)
    if (!isHex64(author) || author === owner || seq === null) continue
    const g = giftOf(field(row, 'record'))
    if (g === null || g.to !== owner || !offerListable(g.atMs, now)) continue
    if (!isFollowOf(field(row, 'follow'), owner)) continue
    const day = dayStart(g.atMs)
    if (Number.isNaN(day)) continue
    const key = author + '/' + day
    const prev = byDay.get(key)
    if (prev === undefined || seq < prev.seq) byDay.set(key, { author, seq, item: g.item, at: g.at, atMs: g.atMs })
  }
  const done = new Set()
  for (const row of taken) {
    const from = field(row, 'from')
    const seq = seqOf(row)
    if (isHex64(from) && seq !== null) done.add(from + '/' + seq)
  }
  const mine = new Map()
  for (const g of byDay.values()) {
    if (!mine.has(g.author)) mine.set(g.author, inSet(followed, g.author))
  }
  const byDate = pendingOrder(now)
  const out = [...byDay.values()]
    .filter((g) => !done.has(g.author + '/' + g.seq))
    .sort((a, b) => (mine.get(b.author) - mine.get(a.author)) || byDate(a, b))
    .slice(0, GARDEN_GIFT_ROWS)
    .map((g) => ({ author: g.author, seq: g.seq, item: g.item, at: g.at }))
  return { rows: out }
}

// The owner's Prateleira: the mimos they took since their live flag. A take
// stands on the gift it names (read from the giver's diary by the caller):
// a garden-gift to owner, still inside its week. The giver's follow is not
// needed, the owner's own take is the consent. One row per gift (the lowest
// take seq), then one per giver per Brasília day of the gift (the lowest
// gift seq). The daily take cap is the writer's check, not dropped here.
// An honest diary never keeps more than GARDEN_TAKE_ROWS live takes in the
// window, so a longer list counts nothing and a reader never has to fetch
// more gift blocks than that for one balcony.
function foldShelf (args) {
  const empty = { rows: [] }
  const owner = field(args, 'owner')
  const now = field(args, 'now')
  const since = field(args, 'since')
  if (!isHex64(owner) || !isTime(now) || !isSeq(since)) return empty
  const takes = snapshotArray(field(args, 'takes'), GARDEN_TAKE_ROWS)
  if (takes === null) return empty
  const byGift = new Map()
  for (const row of takes) {
    const seq = seqOf(row)
    if (!liveSince(seq, since)) continue
    const t = takeOf(field(row, 'record'))
    if (t === null || t.from === owner || t.atMs > now + GARDEN_MAX_FUTURE_MS) continue
    const g = giftOf(field(row, 'gift'))
    if (g === null || g.to !== owner || !offerListable(g.atMs, now)) continue
    const key = t.from + '/' + t.seq
    const prev = byGift.get(key)
    if (prev === undefined || seq < prev.seq) byGift.set(key, { seq, from: t.from, gseq: t.seq, item: g.item, at: g.at, atMs: g.atMs })
  }
  const byDay = new Map()
  for (const r of byGift.values()) {
    const day = dayStart(r.atMs)
    if (Number.isNaN(day)) continue
    const key = r.from + '/' + day
    const prev = byDay.get(key)
    if (prev === undefined || r.gseq < prev.gseq) byDay.set(key, r)
  }
  const out = [...byDay.values()]
    .sort((a, b) => b.atMs - a.atMs || byText(a.from, b.from) || a.gseq - b.gseq)
    .slice(0, GARDEN_SHELF_ROWS)
    .map((r) => ({ seq: r.seq, from: r.from, gseq: r.gseq, item: r.item, at: r.at }))
  return { rows: out }
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
  GARDEN_DECOR_IDS,
  GARDEN_STALL_WEEKDAY,
  GARDEN_STALL_WINDOW_MS,
  GARDEN_GIFTS_DAILY_MAX,
  GARDEN_TAKES_DAILY_MAX,
  GARDEN_TAKE_ROWS,
  GARDEN_GIFT_ROWS,
  GARDEN_SHELF_ROWS,
  GARDEN_SHELF_SHOWN,
  DECOR_KEYS,
  GIFT_KEYS,
  TAKE_KEYS,
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
  saveOrdinal,
  isDecorId,
  isDecor,
  isGiftItem,
  stallDay,
  offerListable,
  applyGive,
  giveAllowed,
  takeAllowed,
  foldDecor,
  foldPending,
  foldShelf
})
