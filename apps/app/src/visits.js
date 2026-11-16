// Pure model for Visitas: the consent sheet, the list grouped by day and the
// notices. Every listed visitor had their own switch on (mutual by design).
// No I/O, no clock of its own (callers pass `now`).

// Same values as the core limits (VISIT_DAILY_MAX, VISIT_LIST_MAX).
export const VISIT_DAILY_MAX = 10
export const VISIT_LIST_MAX = 50

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

function dayStart (ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// 'hoje', 'ontem' or '12 out' (with the year when it is not the current one).
export function dayLabel (ms, now) {
  const today = dayStart(now)
  const day = dayStart(ms)
  const diff = Math.round((today - day) / 86400000)
  if (diff === 0) return 'hoje'
  if (diff === 1) return 'ontem'
  const d = new Date(ms)
  const base = d.getDate() + ' ' + MONTHS[d.getMonth()]
  return d.getFullYear() === new Date(now).getFullYear() ? base : base + ' ' + d.getFullYear()
}

// A visit's `at` is UTC midnight of its day. Read it as that same calendar day
// on the local clock, so a visit from 5 nov never shows as 4 nov west of UTC.
export function visitLocalMs (ms) {
  const d = new Date(ms)
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime()
}

// Rows ({ at, ... }, at a UTC day) newest first, capped, grouped by day:
// [{ key, label, rows }].
export function groupByDay (rows, now) {
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number.isFinite(r.at))
    .sort((a, b) => b.at - a.at)
    .slice(0, VISIT_LIST_MAX)
  const groups = []
  for (const row of sorted) {
    const key = visitLocalMs(row.at)
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) {
      g = { key, label: dayLabel(key, now), rows: [] }
      groups.push(g)
    }
    g.rows.push(row)
  }
  return groups
}

// Consent sheet: opens with the choice off; the person must switch it on.
export function initialConsent () {
  return { open: false, visible: false, busy: false }
}
export function openConsent () {
  return { open: true, visible: false, busy: false }
}
export function toggleConsent (state) {
  return state.busy ? state : { ...state, visible: !state.visible }
}
export function startConsent (state) {
  return { ...state, busy: true }
}
export function closeConsent () {
  return initialConsent()
}

export const DMS_OFF_NOTICE = 'Ative as mensagens privadas para registrar visitas.'

export function dmsOffNotice (dmsOn) {
  return dmsOn ? null : DMS_OFF_NOTICE
}

export function dailyLimitNotice (sentToday) {
  if (!(sentToday >= VISIT_DAILY_MAX)) return null
  return 'Você atingiu o limite de ' + VISIT_DAILY_MAX + ' visitas por dia. Volte amanhã.'
}
