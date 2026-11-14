// Pure display helpers (short keys, avatar color, relative time,
// compact counts, gradient sampling). No imports and no Node built-ins: Metro
// bundles it and the Node tests import it.

export const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export function shortKey (key) {
  return String(key).toLowerCase().slice(0, 8)
}

export function avatarColorOf (key) {
  const n = parseInt(String(key).slice(0, 2), 16)
  return Number.isNaN(n) ? 0 : n % 5
}

export function relativeTime (at, now = Date.now()) {
  const date = new Date(String(at))
  const t = date.getTime()
  if (Number.isNaN(t)) return null
  const diff = now - t
  if (diff < 60000 && diff >= -60000) return 'agora'
  if (diff >= 0 && diff < 3600000) return Math.floor(diff / 60000) + ' min'
  if (diff >= 0 && diff < 86400000) return Math.floor(diff / 3600000) + ' h'
  const today = new Date(now)
  if (diff >= 0) {
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
    if (date.getFullYear() === yesterday.getFullYear() && date.getMonth() === yesterday.getMonth() && date.getDate() === yesterday.getDate()) {
      return 'ontem'
    }
  }
  const short = date.getDate() + ' ' + MONTHS[date.getMonth()]
  return date.getFullYear() === today.getFullYear() ? short : short + ' ' + date.getFullYear()
}

// The heading of a day separator, by the device's local calendar day.
export function dayHeading (at, now = Date.now()) {
  const date = new Date(String(at))
  if (Number.isNaN(date.getTime())) return null
  const today = new Date(now)
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const gap = Math.round((day(today) - day(date)) / 86400000)
  if (gap === 0) return 'hoje'
  if (gap === 1) return 'ontem'
  const short = date.getDate() + ' ' + MONTHS[date.getMonth()]
  return date.getFullYear() === today.getFullYear() ? short : short + ' ' + date.getFullYear()
}

export function sinceText (ms, now = Date.now()) {
  const diff = now - ms
  if (diff < 60000) return 'agora'
  if (diff < 3600000) return 'há ' + Math.floor(diff / 60000) + ' min'
  if (diff < 86400000) return 'há ' + Math.floor(diff / 3600000) + ' h'
  const days = Math.floor(diff / 86400000)
  return days === 1 ? 'há 1 dia' : 'há ' + days + ' dias'
}

export function countChars (s) {
  return Array.from(String(s)).length
}

// Hand-built: Hermes and Node disagree on Intl compact spaces and suffixes.
const COUNT_SUFFIX = ['', 'mil', 'mi', 'bi', 'tri']

export function formatCount (n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  const tenths = (unit) => Math.round((n / unit) * 10)
  let tier = 0
  let unit = 1
  while (tier < COUNT_SUFFIX.length - 1 && tenths(unit) >= 10000) {
    unit *= 1000
    tier++
  }
  const scaled = tenths(unit)
  const whole = Math.floor(scaled / 10)
  const frac = scaled % 10
  const body = frac === 0 ? String(whole) : whole + ',' + frac
  const suffix = COUNT_SUFFIX[tier]
  return suffix ? body + ' ' + suffix : body
}

// Date stringification differs by engine, so a Date uses getTime.
// Numbers are epoch milliseconds. Anything else is parsed like relativeTime.
function instantMs (value) {
  if (typeof value === 'number') return value
  if (value instanceof Date) return value.getTime()
  return new Date(String(value)).getTime()
}

// Under a minute, in the future, or not a time: the caller keeps its own fallback.
export function compactTime (at, now = Date.now()) {
  const diff = instantMs(now) - instantMs(at)
  if (!Number.isFinite(diff) || diff < 60000) return null
  if (diff < 3600000) return Math.floor(diff / 60000) + 'min'
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h'
  return Math.floor(diff / 86400000) + 'd'
}

// n colors '#rrggbb' sampled evenly along [hex, position] stops.
export function interpolateStops (stops, n) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const parsed = stops.map(([hex, pos]) => [rgb(hex), pos])
  const out = []
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1)
    let k = 0
    while (k < parsed.length - 2 && t > parsed[k + 1][1]) k++
    const [a, pa] = parsed[k]
    const [b, pb] = parsed[k + 1]
    const f = pb === pa ? 0 : Math.min(1, Math.max(0, (t - pa) / (pb - pa)))
    const c = a.map((v, j) => Math.round(v + (b[j] - v) * f))
    out.push('#' + c.map((v) => v.toString(16).padStart(2, '0')).join(''))
  }
  return out
}
