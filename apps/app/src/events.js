// Eventos: the pure card model. An event is a diary post with an `event`
// {title, start, end, place}; instants are canonical ISO UTC strings (toISOString form) and are
// shown in the reader's local time. A gone event (deleted or hidden post) is
// shown as 'cancelado'. No React, no platform module, nothing from a peer
// trusted beyond the shape checks below. Limits are kept by hand, in step with
// the event shape of the contract (docs/rpc.md).

export const TITLE_MAX = 80
export const PLACE_MAX = 120
export const CANCELLED_TEXT = 'cancelado'

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
// Mirrors EVENT_MIN_MS and EVENT_MAX_MS of the contract (2020-01-01, 2100-01-01).
const MIN_MS = Date.UTC(2020, 0, 1)
const MAX_MS = Date.UTC(2100, 0, 1)
const points = (v) => [...v].length
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']
const pad = (n) => String(n).padStart(2, '0')

// Milliseconds of an instant, or null when it is not a valid UTC ISO string.
export function instantMs (v) {
  if (typeof v !== 'string' || !ISO.test(v)) return null
  const ms = Date.parse(v)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== v) return null
  return ms >= MIN_MS && ms <= MAX_MS ? ms : null
}

// The card of one event value, or null when anything is off.
export function eventCard (ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null
  const { title, start, end, place } = ev
  if (typeof title !== 'string' || points(title) < 1 || points(title) > TITLE_MAX) return null
  if (typeof place !== 'string' || points(place) > PLACE_MAX) return null
  const startMs = instantMs(start)
  if (startMs === null) return null
  let endMs = null
  if (end !== null && end !== undefined) {
    endMs = instantMs(end)
    if (endMs === null || endMs <= startMs) return null
  }
  return { title, start, end: end === undefined ? null : end, place, startMs, endMs }
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const timeText = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes())
const dayText = (d) => WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' de ' + MONTHS[d.getMonth()] + ' de ' + d.getFullYear()

// pt-BR text in the device's local time, e.g. 'sáb, 3 de mai de 2025, 19:30'.
// With an end: same day gives 'dia, 19:30 às 22:00', else both days.
export function whenText (card) {
  if (!card) return ''
  const s = new Date(card.startMs)
  const head = dayText(s) + ', ' + timeText(s)
  if (card.endMs === null) return head
  const e = new Date(card.endMs)
  return sameDay(s, e) ? head + ' às ' + timeText(e) : head + ' até ' + dayText(e) + ', ' + timeText(e)
}

// An event is over once its end (or, with no end, its start) has passed.
export function isPast (card, now = Date.now()) {
  if (!card) return false
  return (card.endMs === null ? card.startMs : card.endMs) < now
}

// items: [{ card, ... }] -> { upcoming (soonest first), past (latest first) }.
export function splitEvents (items, now = Date.now()) {
  const upcoming = []
  const past = []
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.card) continue
    ;(isPast(it.card, now) ? past : upcoming).push(it)
  }
  upcoming.sort((a, b) => a.card.startMs - b.card.startMs)
  past.sort((a, b) => b.card.startMs - a.card.startMs)
  return { upcoming, past }
}

// Row model for a list: a gone event carries only the 'cancelado' status.
export function eventRow ({ ref, event, gone = false } = {}, now = Date.now()) {
  if (gone) return { ref, card: null, cancelled: true, status: CANCELLED_TEXT, when: '' }
  const card = eventCard(event)
  if (card === null) return null
  return { ref, card, cancelled: false, status: isPast(card, now) ? 'já passou' : '', when: whenText(card) }
}
