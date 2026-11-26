import { validDescriptor } from './fetch.js'
import { MAX_MEDIA_PER_POST, VIDEO_MIME, kindOf } from './plan.js'

// Protocol section 2, "Thumbnails" (MAX_THUMB_SIDE, MAX_THUMB_BYTES in core
// records.js).
export const MAX_THUMB_SIDE = 640
export const MAX_THUMB_BYTES = 65536

// One thumbnail, as core records.js validThumbDescriptor: a descriptor of the
// strict media shape, a JPEG, at most 640 px a side and 65536 bytes.
export function validThumb (d) {
  return validDescriptor(d) && d.mime === 'image/jpeg' &&
    d.width <= MAX_THUMB_SIDE && d.height <= MAX_THUMB_SIDE && d.bytes <= MAX_THUMB_BYTES
}

// A `thumbs` list beside `media` (a read or a saved row): core's
// validThumbList plus the reader rule's alignment, and never beside a video.
// By index, never every(): a hole in a sparse array is undefined and invalid.
export function validThumbs (thumbs, media) {
  if (!Array.isArray(thumbs) || !Array.isArray(media)) return false
  if (thumbs.length < 1 || thumbs.length > MAX_MEDIA_PER_POST || thumbs.length !== media.length) return false
  if (media.some((d) => d && d.mime === VIDEO_MIME)) return false
  let some = false
  for (let i = 0; i < thumbs.length; i++) {
    const d = thumbs[i]
    if (d === null) continue
    if (!validThumb(d)) return false
    some = true
  }
  return some
}

// The reader rule (packages/core/lib/feed.js postThumbsOf), fail-closed: a
// slot's thumbnail is usable only when the list lines up with media, the
// post is not a video pair, the slot is a valid still (never a GIF, whose
// motion a JPEG would lose) and the thumbnail is valid and not the full size
// itself. -> the thumbnail, or null.
export function usableThumb (media, thumbs, index) {
  if (!Array.isArray(media) || !Array.isArray(thumbs) || thumbs.length !== media.length) return null
  const full = media[index]
  const thumb = thumbs[index]
  if (!validDescriptor(full) || kindOf(full.mime) !== 'image') return null
  if (media.some((d) => d && d.mime === VIDEO_MIME)) return null
  // A thumbnail under the key of any photo of the post would share that
  // photo's cache and kept entries, loaded without the thumbnail checks.
  if (!validThumb(thumb) || media.some((d) => d && sameBytes(thumb, d))) return null
  return thumb
}

// As cache.js mediaKey: the same bytes under the same key.
function sameBytes (a, b) {
  return a.core === b.core && a.start === b.start && a.blocks === b.blocks && a.sha256 === b.sha256
}

function physicalOf (widthPx, dpr) {
  const physical = widthPx * dpr
  return Number.isFinite(physical) && physical > 0 ? physical : null
}

// -> the descriptors to try, in order: the thumbnail first when the slot is
// no wider than 640 physical pixels, then the full size.
export function pickVariant ({ media, thumbs, index, widthPx, dpr }) {
  const full = media[index]
  const thumb = usableThumb(media, thumbs, index)
  const physical = physicalOf(widthPx, dpr)
  if (thumb !== null && physical !== null && physical <= MAX_THUMB_SIDE) return [thumb, full]
  return [full]
}

// A slot wider than 640 physical pixels (a phone's full-width row) loads the
// full size, and its thumbnail is painted beneath while that loads.
// -> the thumbnail to underlay, or null.
export function underlayFor ({ media, thumbs, index, widthPx, dpr }) {
  const physical = physicalOf(widthPx, dpr)
  if (physical === null || physical <= MAX_THUMB_SIDE) return null
  return usableThumb(media, thumbs, index)
}

// A row tile's load order. Null while its width is not measured yet and a
// thumbnail could apply: nothing is fetched until the tile knows which one
// it needs, so a small tile never starts the full size first.
export function rowVariants ({ media, thumbs, index, widthPx, dpr }) {
  if (!Array.isArray(media)) return [undefined]
  if (Number.isFinite(widthPx) && widthPx > 0) return pickVariant({ media, thumbs, index, widthPx, dpr })
  const small = pickVariant({ media, thumbs, index, widthPx: 1, dpr: 1 })
  return small.length > 1 ? null : small
}

// After the descriptor at `step` of `order` failed: the next step, or null.
// One fallback (thumbnail to full size), never back.
export function nextVariant (order, step) {
  return Array.isArray(order) && Number.isInteger(step) && step >= 0 && step + 1 < order.length ? step + 1 : null
}

// The fallback state { key, step }: the step of the order named by key.
// A new order (another width or post) starts again at its first step.
export function currentStep (fallback, key) {
  return fallback && fallback.key === key && Number.isInteger(fallback.step) && fallback.step >= 0 ? fallback.step : 0
}

// The state after the step `from` of `order` failed (a load error or a
// bitmap that does not decode). A stale failure, of a step already left,
// changes nothing, and the last step stays.
export function failStep (fallback, key, order, from) {
  if (currentStep(fallback, key) !== from) return fallback
  const next = nextVariant(order, from)
  return next === null ? fallback : { key, step: next }
}

// The main load of a row tile: the descriptor at `step` (null while the
// order waits for a width). final: a thumbnail step ends on its first error
// of any kind, so the full size starts at once and a tile climbs one retry
// ladder at most, as before thumbnails.
export function mainRequest (order, step) {
  if (!Array.isArray(order) || !Number.isInteger(step) || step < 0 || step >= order.length) return { d: null, final: false }
  return { d: order[step], final: nextVariant(order, step) !== null }
}

// The underlay load: the thumbnail only while the full size is not at hand
// (no memory or kept hit when the tile mounted) and not loaded yet, kept
// while it shows under a full size still fading in, dropped once that fade
// ended. -> the descriptor to request, or null.
export function underRequest ({ underlay, fullAtHand, fullOk, underShown, faded }) {
  if (!underlay || fullAtHand === true || faded === true) return null
  if (fullOk === true && underShown !== true) return null
  return underlay
}

// -> true when a load error ends the load at once, with no retry ladder:
// every error of a thumbnail (a step before the full size, or an underlay).
export function errorIsFinal (err, thumb) {
  return thumb === true && err != null
}

// Decoded headers of a thumbnail (rpc.mediaBounds): no side over 640 px,
// whatever its descriptor says.
export function thumbBoundsOk (bounds) {
  return bounds != null && Number.isInteger(bounds.width) && Number.isInteger(bounds.height) &&
    bounds.width > 0 && bounds.height > 0 && bounds.width <= MAX_THUMB_SIDE && bounds.height <= MAX_THUMB_SIDE
}

// Kept-only mode (no fetch): the first step of `order` the kept store has
// (has(d) true), or null.
export function firstKept (order, has) {
  if (!Array.isArray(order)) return null
  for (let i = 0; i < order.length; i++) {
    if (validDescriptor(order[i]) && has(order[i])) return i
  }
  return null
}
