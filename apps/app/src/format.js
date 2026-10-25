// Pure display helpers (short keys, avatar color, relative time,
// gradient sampling). No imports and no Node built-ins: Metro bundles it and
// the Node tests import it.

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
