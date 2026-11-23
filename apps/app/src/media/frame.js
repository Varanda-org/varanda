const portrait = Object.freeze({ id: 'portrait', label: 'Retrato', ratio: 4 / 5 })
const square = Object.freeze({ id: 'square', label: 'Quadrado', ratio: 1 })
const landscape = Object.freeze({ id: 'landscape', label: 'Paisagem', ratio: 16 / 9 })

export const FRAMES = Object.freeze([portrait, square, landscape])

// 4:3 is halfway between 1:1 and 16:9 on a log scale. Explicit cut points
// keep it square even when floating-point noise would flip the nearest frame.
export const PORTRAIT_BELOW = 0.9
export const LANDSCAPE_ABOVE = 1.34
export const COVER_MIN = 0.8

function positiveFinite (value) {
  return Number.isFinite(value) && value > 0
}

export function frameOf (width, height) {
  if (!positiveFinite(width) || !positiveFinite(height)) return square
  const ratio = width / height
  if (ratio < PORTRAIT_BELOW) return portrait
  if (ratio > LANDSCAPE_ABOVE) return landscape
  return square
}

export function frameById (id) {
  return FRAMES.find(frame => frame.id === id) ?? null
}

export function postFrame (media) {
  try {
    if (!Array.isArray(media) || media.length === 0) return square
    const item = media[0]
    return frameOf(item?.width, item?.height)
  } catch {
    return square
  }
}

export function fitInFrame (item, ratio) {
  if (!positiveFinite(ratio)) return 'cover'
  try {
    const { width, height } = item ?? {}
    if (!positiveFinite(width) || !positiveFinite(height)) return 'cover'
    const r = width / height
    return Math.min(r / ratio, ratio / r) >= COVER_MIN ? 'cover' : 'contain'
  } catch {
    return 'cover'
  }
}
