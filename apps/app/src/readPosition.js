// How many older pages a chat opening may fetch while looking for the first
// unread message before it settles for the oldest loaded row.
export const OPEN_OLDER_PAGES = 3
// How many layout passes the opening scroll may retry while rows are measured.
export const SETTLE_TRIES = 6
// How many content-size frames may place the opening row again. They spend no
// try (the first batches grow the list many times in a row), but stay bounded.
export const GROWTH_PLACES = 24

// The DM row key of the first unread message: the node's message id.
export function dmTarget (firstUnread) {
  return typeof firstUnread === 'string' && firstUnread !== '' ? firstUnread : null
}

// The group row key to open at. `items` are newest-first; some are not painted
// as rows (a reply inside a topic), so walk toward newer items to a painted,
// not own one. An older-than-loaded firstUnread returns its key so openPlan
// can ask for older pages.
export function groupTarget ({ items, rowKeys, firstUnread, keyOf = (it) => it.writer + ':' + it.seq, isOwn = () => false }) {
  if (firstUnread === null || firstUnread === undefined) return null
  const list = Array.isArray(items) ? items : []
  const f = list.findIndex((it) => it && it.writer === firstUnread.writer && it.seq === firstUnread.seq)
  if (f < 0) return keyOf(firstUnread)
  const keys = new Set(rowKeys)
  for (let i = f; i >= 0; i--) {
    if (keys.has(keyOf(list[i])) && !isOwn(list[i])) return keyOf(list[i])
  }
  return null
}

// What the opening does next: stay at the end, scroll to a row, or load an
// older page first (bounded, so a long unread run cannot page forever).
// `olderPagesLoaded` counts the pages the opening asked for: while one is in
// flight (`loading`) the plan waits for it, and a failed page ends the walk.
export function openPlan ({ targetKey, rowKeys, hasOlder, olderPagesLoaded, loading = false, failed = false, max = OPEN_OLDER_PAGES }) {
  if (targetKey === null || targetKey === undefined) return { kind: 'end' }
  if (rowKeys.includes(targetKey)) return { kind: 'row', key: targetKey }
  if (hasOlder && !failed && (loading || olderPagesLoaded < max)) return { kind: 'older' }
  if (rowKeys.length > 0) return { kind: 'row', key: rowKeys[0] }
  return { kind: 'end' }
}

// Keeps the first answer for a chat: the reread after a seen call must not
// move the opening target.
export function latchOpen (prev, { scope, value }) {
  if (prev !== null && prev !== undefined && prev.scope === scope) return prev
  return { scope, value: value === undefined ? null : value }
}

// The newest row the person has seen: the highest viewable row, forward only.
export function readCursor (prev, { rowKeys, viewableKeys }) {
  let best = -1
  for (const key of viewableKeys) {
    const i = rowKeys.indexOf(key)
    if (i > best) best = i
  }
  const prevIndex = prev === null || prev === undefined ? -1 : rowKeys.indexOf(prev)
  if (best < 0) return prev === undefined ? null : prev
  if (prevIndex >= best) return prev
  return rowKeys[best]
}

// How far above the end a frame still counts as at the end: a row still
// growing or a rounded offset leaves a few pixels.
export const END_SLOP = 48

// Whether a scroll frame shows the end of the list. An unmeasured frame does not.
export function atEnd ({ y, contentHeight, layoutHeight }) {
  if (![y, contentHeight, layoutHeight].every(Number.isFinite)) return false
  return y + layoutHeight >= contentHeight - END_SLOP
}

// Whether the view is away from the end after a scroll frame; the jump
// button shows while it is, and the end follows new rows only while it is not.
// `heading`: the opening is still on its way to an unread row. Its estimate
// scrolls can clamp at the end, which is not the person reaching it, so a
// row arriving then must not pull the view down.
// `resized`: only the list or its content changed size (the keyboard, a
// sheet closing, a new row). Only a scroll leaves the end.
export function awayAfterFrame ({ away, pinned, bottom, resized = false, heading = false }) {
  if (heading) return true
  if (bottom) return false
  if (resized) return away
  return away || !pinned
}

// Whether a landing on an unread row left the view away from the end, read
// from the sizes while no scroll frame has followed it (the web lands at the
// top with none). A list not laid out yet counts as away: its zero sizes
// would read as the end and hide the jump button.
export function landingAway ({ y, contentHeight, layoutHeight }) {
  if (!(contentHeight > 0) || !(layoutHeight > 0)) return true
  return !atEnd({ y, contentHeight, layoutHeight })
}

// The unread messages below what the person read: the other side's rows after
// the read cursor. Before the landing there is no cursor yet, so they count
// from the row the opening heads for (all loaded rows when it is on a page
// not loaded yet).
export function unreadBelow ({ rows, cursorKey, openKey }) {
  const list = Array.isArray(rows) ? rows : []
  let from
  if (cursorKey !== null && cursorKey !== undefined) {
    const i = list.findIndex((row) => row.key === cursorKey)
    if (i < 0) return 0
    from = i + 1
  } else if (openKey !== null && openKey !== undefined) {
    const i = list.findIndex((row) => row.key === openKey)
    from = i < 0 ? 0 : i
  } else {
    return 0
  }
  let n = 0
  for (let i = from; i < list.length; i++) if (list[i] && list[i].mine !== true) n++
  return n
}

// The jump button: shown while the view is away from the end, with the
// unread count below (99+ past that). The spoken hint says the same.
export function jumpState ({ away, unread }) {
  if (away !== true) return { show: false, count: 0, text: '', hint: undefined }
  const count = Number.isSafeInteger(unread) && unread > 0 ? unread : 0
  const text = count === 0 ? '' : count > 99 ? '99+' : String(count)
  const hint = count === 0 ? undefined : count === 1 ? '1 mensagem nova' : count > 99 ? 'mais de 99 mensagens novas' : count + ' mensagens novas'
  return { show: true, count, text, hint }
}

// Bounded retry counter for the opening scroll. The wait doubles: on the web
// the list measures no row until the screen's first layout, which can take
// longer than a few fixed short retries.
export function settleStep (count, max = SETTLE_TRIES) {
  return { again: count < max, next: count + 1, wait: Math.min(1000, 50 * 2 ** count) }
}
