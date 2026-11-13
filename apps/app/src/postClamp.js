// Caption clamp: how many lines to keep, and which control to show.
// The web build has no onTextLayout, so it uses this estimate alone.
// Native passes the measured line count to refine, which can lift a clamp
// the estimate drew but never adds one.

export const LIMIT_MEDIA = 3
export const LIMIT_TEXT = 9

// Same 1.3 cap as Sheet TEXT_CAP. A system scale above it must not change
// the decision, so the estimate stops there on purpose.
const SCALE_CAP = 1.3

// Average Latin glyph width, as a fraction of the font size. Enough to
// choose a clamp before layout; refine corrects it once lines are measured.
const GLYPH_WIDTH = 0.5

// lines 0 means the caption is not capped. Clamp only when the estimate
// exceeds the limit by 2 or more, so a line or two of error stays quiet.
export function clampPlan ({ text, hasMedia, width, fontSize, fontScale = 1, expanded = false } = {}) {
  const limit = hasMedia ? LIMIT_MEDIA : LIMIT_TEXT
  const estimated = estimateLines(text, width, fontSize, fontScale)
  if (estimated < limit + 2) return { lines: 0, control: null }
  if (expanded) return { lines: 0, control: 'menos' }
  return { lines: limit, control: hasMedia ? 'mais' : 'ver mais' }
}

// A finite count that fits in the cap lifts the clamp: the caption shows in
// full with no control, so its links and mentions work. NaN or 0 is not a
// measurement (a caption always lays out a line): treating it as a fit would
// drop a control the text still needs.
export function refine (plan, measuredLines) {
  if (!plan || typeof plan !== 'object' || typeof plan.lines !== 'number') return plan
  if (typeof measuredLines !== 'number' || !Number.isFinite(measuredLines) || measuredLines < 1) return plan
  if (measuredLines > plan.lines) return plan
  return { lines: 0, control: null }
}

export function acceptMeasurement ({ prev, count, renderedCap }) {
  // A layout before the text has lines reports none; it is not a fit.
  if (!Number.isFinite(count) || count < 1) return prev
  // A cut layout cannot prove the caption fits or replace its full count.
  if (renderedCap > 0 && count === renderedCap) return prev
  if (typeof prev === 'number' && count < prev) return prev
  return count
}

// One line per LF paragraph at minimum, so a blank line still takes space.
// A width or font size that is not laid out yet estimates 0: that must not
// hide the caption before the row has a width.
function estimateLines (text, width, fontSize, fontScale) {
  if (typeof text !== 'string') return 0
  if (!Number.isFinite(width) || width <= 0) return 0
  if (!Number.isFinite(fontSize) || fontSize <= 0) return 0
  const scale = Math.min(Number.isFinite(fontScale) ? fontScale : 1, SCALE_CAP)
  let total = 0
  for (const paragraph of text.split('\n')) {
    const count = Array.from(paragraph).length
    total += Math.max(1, Math.ceil(count * GLYPH_WIDTH * fontSize * scale / width))
  }
  return total
}
