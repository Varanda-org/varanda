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
