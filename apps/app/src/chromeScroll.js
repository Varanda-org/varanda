export const CHROME_HIDE_AFTER = 24
export const CHROME_SHOW_AFTER = 8

export function initialChrome () {
  return { hidden: false, anchorY: 0 }
}

// A new gesture by the person (a drag, a touch, a wheel after a pause) ends
// the hold a flip leaves behind.
export function chromeGesture (state) {
  return state.hold ? { ...state, hold: false } : state
}

// Keyboard focus reaching a hidden bar (the web keeps them in the tab order)
// shows them where the feed is, holding like a flip.
export function chromeShow (state) {
  if (!state.hidden) return state
  const y = Number.isFinite(state.lastY) ? state.lastY : state.anchorY
  return { hidden: false, anchorY: y, lastY: y, dir: 0, hold: true }
}

// Hidden bars leave the accessibility tree on every platform: react-native-web
// maps only aria-hidden, and focus that still lands on them calls `show`.
export function chromeHiddenProps (show) {
  return { 'aria-hidden': true, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', onFocus: show }
}

// Rows merged above the visible one (keepVisiblePosition) push the offset
// down by about their height with no gesture, and rows removed there pull it
// up, so a frame that moves with the content, by no more, is not the person.
export function contentShift ({ y, lastY, grew }) {
  if (!Number.isFinite(grew) || grew === 0 || !Number.isFinite(lastY)) return false
  const dy = y - lastY
  return Math.sign(dy) === Math.sign(grew) && Math.abs(dy) <= Math.abs(grew) + 1
}

// lastY and dir are extra bookkeeping so a direction change can re-anchor
// at the turning point; callers only read hidden and anchorY. Without a lastY
// (after a reset, with the feed anywhere) the first frame only anchors.
// `below` is the distance left under the viewport and `grow` how much the
// viewport gains while the bars are away. Hiding with less room below would
// clamp the offset back, which reads as an upward scroll and shows them again.
// `hold`: the bars slide the list under a finger that stays put, and Android
// moves the offset by up to their height at that finger's next move, so after
// a flip the rest of the gesture only moves the anchor.
export function nextChrome (state, { y, userScrolled, reduceMotion, screenReader, top = 52, below = Infinity, grow = 0 }) {
  if (typeof y !== 'number' || !Number.isFinite(y)) return state
  if (reduceMotion || screenReader) return { hidden: false, anchorY: y, lastY: y, dir: 0 }
  if (y <= 0) return { hidden: false, anchorY: 0, lastY: y, dir: 0, hold: !!(state.hidden || state.hold) }
  if (!userScrolled || state.hold || !Number.isFinite(state.lastY)) return { hidden: state.hidden, anchorY: y, lastY: y, dir: 0, hold: !!state.hold }
  const prev = state.lastY
  const dir = y > prev ? 1 : y < prev ? -1 : (state.dir || 0)
  const anchorY = dir !== 0 && dir !== state.dir ? prev : state.anchorY
  let hidden = state.hidden
  if (dir > 0 && y - anchorY >= CHROME_HIDE_AFTER && y > top && !(below < grow)) hidden = true
  else if (dir < 0 && anchorY - y >= CHROME_SHOW_AFTER) hidden = false
  return { hidden, anchorY, lastY: y, dir, hold: hidden !== state.hidden }
}
