'use strict'

// The pure rules of an event (docs/protocol.md, the `event` key of a post and
// the group `group-event` record): a title, a start, an end (null or later
// than the start) and a place. Core validates records with them, the node
// validates methods with them and the app builds its editor with them, so
// every side agrees. Zero dependencies, no Node built-ins. The checks never
// throw and accept nothing but the exact key set.

const L = require('./limits')
const { isInvisibleOnly, scan } = require('./profile-extra')

const EVENT_KEYS = Object.freeze(['title', 'start', 'end', 'place'])
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// The milliseconds of a canonical instant (the toISOString form, in UTC)
// inside the bounded range, or NaN.
function instantMs (v) {
  try {
    if (typeof v !== 'string' || !INSTANT.test(v)) return NaN
    const ms = Date.parse(v)
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== v) return NaN
    return ms >= L.EVENT_MIN_MS && ms <= L.EVENT_MAX_MS ? ms : NaN
  } catch {
    return NaN
  }
}

function isEventInstant (v) {
  return !Number.isNaN(instantMs(v))
}

// 1..MAX_EVENT_TITLE code points on one line that show something.
function isEventTitle (v) {
  const n = scan(v, false)
  return n >= 1 && n <= L.MAX_EVENT_TITLE && !isInvisibleOnly(v)
}

// '' (no place) or 1..MAX_EVENT_PLACE code points on one line that show
// something.
function isEventPlace (v) {
  const n = scan(v, false)
  return n === 0 || (n >= 1 && n <= L.MAX_EVENT_PLACE && !isInvisibleOnly(v))
}

function isPlainObject (o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// One snapshot of an event: a plain object with the four keys in canonical
// order, each value read once from its own data property's descriptor (never
// through a property get, so a Proxy trap or an accessor cannot answer twice),
// or null when v is not exactly { title, start, end, place } as own enumerable
// data properties of a plain object with no symbol keys.
function snapshot (v) {
  try {
    if (!isPlainObject(v) || Object.getOwnPropertySymbols(v).length > 0) return null
    const names = Object.getOwnPropertyNames(v)
    if (names.length !== EVENT_KEYS.length || !EVENT_KEYS.every((k) => names.includes(k))) return null
    const out = {}
    for (const k of EVENT_KEYS) {
      const d = Object.getOwnPropertyDescriptor(v, k)
      if (!d || !('value' in d) || !d.enumerable) return null
      out[k] = d.value
    }
    return out
  } catch {
    return null
  }
}

function isValidSnapshot (e) {
  if (!isEventTitle(e.title) || !isEventPlace(e.place)) return false
  const start = instantMs(e.start)
  if (Number.isNaN(start)) return false
  if (e.end === null) return true
  const end = instantMs(e.end)
  return !Number.isNaN(end) && end > start && end - start <= L.EVENT_MAX_SPAN_MS
}

// An event: exactly { title, start, end, place } as own data properties.
// start is a canonical instant; end is null or a canonical instant later
// than start and at most EVENT_MAX_SPAN_MS after it.
function isEvent (v) {
  try {
    const e = snapshot(v)
    return e !== null && isValidSnapshot(e)
  } catch {
    return false
  }
}

// A plain copy with exactly the event keys in the canonical order, taken
// from one snapshot, so what is validated afterwards is what is kept. Anything
// that is no event shape is passed through for the validator to reject.
function copyEvent (v) {
  const e = snapshot(v)
  return e === null ? v : e
}

module.exports = {
  EVENT_KEYS,
  MAX_EVENT_TITLE: L.MAX_EVENT_TITLE,
  MAX_EVENT_PLACE: L.MAX_EVENT_PLACE,
  isEventTitle,
  isEventPlace,
  isEventInstant,
  isEvent,
  copyEvent
}
