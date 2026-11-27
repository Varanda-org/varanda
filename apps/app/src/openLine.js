const OPEN = 'abertura: identidade '
const WIPED = 'cópias locais apagadas ao abrir'
const LISTS = 'listas '

export const OPEN_PREFIXES = [OPEN, WIPED, LISTS].map((prefix) => 'aviso: ' + prefix)

function elapsed (startedAt, endedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || startedAt < 0 || endedAt < startedAt) return null
  return endedAt - startedAt
}

export function openLines ({ startedAt, statusAt, readyAt, wiped }) {
  const lines = []
  const identity = elapsed(startedAt, statusAt)
  const ready = elapsed(startedAt, readyAt)
  if (identity !== null && ready > 1000) {
    lines.push(OPEN + Math.round(identity) + ' ms, pronto ' + Math.round(ready) + ' ms')
  }
  if (wiped === true) lines.push(WIPED)
  return lines
}

export function listsLine (startedAt, answeredAt) {
  const elapsedMs = elapsed(startedAt, answeredAt)
  if (elapsedMs === null) return null
  const ms = Math.round(elapsedMs)
  return LISTS + ms + ' ms'
}

function isOpenLine (line) {
  return OPEN_PREFIXES.some((prefix) => line.startsWith(prefix))
}

export function trimLines (lines, max) {
  if (max <= 0) return []
  const pinned = []
  const others = []
  for (let i = 0; i < lines.length; i++) {
    if (isOpenLine(lines[i])) pinned.push(i)
    else others.push(i)
  }
  const keep = new Set(pinned.slice(-Math.min(3, max)))
  const otherSlots = max - keep.size
  if (otherSlots > 0) {
    for (const i of others.slice(-otherSlots)) keep.add(i)
  }
  return lines.filter((line, i) => keep.has(i))
}

export function withoutOpenLines (lines) {
  return lines.filter((line) => !isOpenLine(line))
}
