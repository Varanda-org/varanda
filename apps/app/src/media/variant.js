import { VIDEO_MIME } from './plan.js'

// The reader rule (packages/core/lib/feed.js postThumbsOf), fail-closed: a
// thumbnail is used only when the list lines up with media, the post is not a
// video pair and the slot is a still image no wider than 640 physical pixels.
// -> the descriptors to try, in order.
export function pickVariant ({ media, thumbs, index, widthPx, dpr }) {
  const full = media[index]
  const thumb = thumbs?.[index]
  const physical = widthPx * dpr
  const lined = Array.isArray(thumbs) && thumbs.length === media.length
  const still = full && typeof full.mime === 'string' && full.mime.startsWith('image/')
  const video = media.some((d) => d && d.mime === VIDEO_MIME)
  if (thumb && lined && still && !video && Number.isFinite(physical) && physical <= 640) return [thumb, full]
  return [full]
}
