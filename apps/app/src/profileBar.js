// Finish the handoff before the header's controls leave the viewport.
export function profileBarState (y, bandHeight, reduce, controlsBottom = bandHeight) {
  if (!Number.isFinite(y) || !Number.isFinite(bandHeight) || bandHeight <= 0 || !Number.isFinite(controlsBottom) || controlsBottom <= 0) {
    return { opacity: 0, interactive: false }
  }
  const to = Math.min(0.85 * bandHeight, Math.max(1, controlsBottom - 4))
  const from = Math.max(0, to - 0.4 * bandHeight)
  const interactive = y >= to
  const opacity = reduce
    ? (interactive ? 1 : 0)
    : Math.max(0, Math.min(1, (y - from) / (to - from)))
  return { opacity, interactive }
}

// The list's own tabs pin under the bar once their top would pass under it.
// tabsTop is in list-content coordinates; an unmeasured header never pins.
export function tabsPinned (y, tabsTop, barHeight) {
  if (!Number.isFinite(y) || !Number.isFinite(tabsTop) || tabsTop <= 0 || !Number.isFinite(barHeight) || barHeight <= 0) return false
  return y >= tabsTop - barHeight
}

// A tab picked from the pinned copy reopens the list at the pin boundary, so
// the new tab starts at its first item with the tabs still pinned. null: no
// scroll (unmeasured, or the tabs are not pinned).
export function pinnedTabOffset (y, tabsTop, barHeight) {
  if (!tabsPinned(y, tabsTop, barHeight)) return null
  return Math.max(0, tabsTop - barHeight)
}

// The list's content style with its minHeight raised, once the tabs are
// measured, to the viewport plus the pin offset: a pinned switch to a short
// tab could otherwise not scroll to the boundary and the tabs would drop back
// into the header. Never below the caller's own minimum. Rounded up, plus a
// point, so sub-pixel layout cannot clamp the scroll just short of it.
export function pinnedContentStyle (style, viewport, tabsTop, barHeight) {
  const base = style.minHeight
  if (!Number.isFinite(viewport) || viewport <= 0 || !Number.isFinite(tabsTop) || tabsTop <= 0 || !Number.isFinite(barHeight) || barHeight <= 0) return style
  const floor = Math.ceil(viewport + Math.max(0, tabsTop - barHeight)) + 1
  return Number.isFinite(base) && base >= floor ? style : { ...style, minHeight: floor }
}
