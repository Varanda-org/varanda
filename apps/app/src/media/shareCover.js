// Which photo a public share can hand to a link crawler, and when that photo
// has to be re-encoded first. Crawlers such as WhatsApp drop AVIF and often
// drop a file past a few hundred kilobytes, so a JPEG, PNG or WebP already
// inside the byte cap is left alone and everything else is planned as a
// JPEG inside SHARE_COVER_SIDE. Pure: no React, no browser, no Node
// built-ins. The constants stay local so this module does not import
// @varanda/rpc; the caller compares them and chooses the bytes.

// Same still list as plan.js MEDIA_MIMES. A video is not in it, so a video
// post's JPEG poster (records.js stores it ahead of the video) is the first
// still, and a video alone has no source.
const STILL_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
// The three a crawler will render. GIF is a still, but not one of these.
const READY_MIMES = ['image/jpeg', 'image/png', 'image/webp']
// Same cap as plan.js MAX_MEDIA_PER_POST. A longer list is not a post.
const MAX_MEDIA_ITEMS = 10

export const SHARE_COVER_SIDE = 1200
export const MAX_SHARE_COVER_BYTES = 262144
export const COVER_TARGET_BYTES = 204800

function mimeOf (item) {
  if (!item || typeof item !== 'object') return ''
  return typeof item.mime === 'string' ? item.mime : ''
}

// A descriptor counts bytes as a number. The bytes the caller fetched, or
// the encoder returned, are a Uint8Array. Both answer the same cap.
function byteSize (bytes) {
  if (bytes instanceof Uint8Array) return bytes.byteLength
  return bytes
}

function sideOk (n) {
  return Number.isInteger(n) && n >= 1 && n <= SHARE_COVER_SIDE
}

// Already small enough to name as the preview. An empty count is not: there
// is nothing for the crawler to fetch, so the caller still plans an encode.
function readyAsIs (item) {
  if (!READY_MIMES.includes(item.mime)) return false
  const n = byteSize(item.bytes)
  return Number.isSafeInteger(n) && n >= 1 && n <= MAX_SHARE_COVER_BYTES
}

// The first still in media order, or null. Never throws.
export function coverSource (postRecord) {
  try {
    if (!postRecord || typeof postRecord !== 'object') return null
    const media = postRecord.media
    if (!Array.isArray(media) || media.length < 1 || media.length > MAX_MEDIA_ITEMS) return null
    for (let i = 0; i < media.length; i++) {
      const item = media[i]
      if (STILL_MIMES.includes(mimeOf(item))) return item
    }
    return null
  } catch {
    return null
  }
}

// False when there is nothing to show, or the source is already a JPEG, PNG
// or WebP of at most MAX_SHARE_COVER_BYTES. True for AVIF, GIF and anything
// larger. Never throws.
export function needsCover (postRecord) {
  try {
    const src = coverSource(postRecord)
    if (!src) return false
    return !readyAsIs(src)
  } catch {
    return false
  }
}

// A cover the post-cover record accepts: JPEG only (records.js
// validShareCover; a PNG or WebP cover is refused there), at least one byte,
// at most the cap, each side at most SHARE_COVER_SIDE. `bytes` may be the
// count on a descriptor or the Uint8Array itself. A wide photo under the
// byte cap needs no new encode (needsCover) and still fails here. Never throws.
export function validShareCover (d) {
  try {
    if (!d || typeof d !== 'object') return false
    if (d.mime !== 'image/jpeg') return false
    const n = byteSize(d.bytes)
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_SHARE_COVER_BYTES) return false
    if (!sideOk(d.width) || !sideOk(d.height)) return false
    return true
  } catch {
    return false
  }
}

// Re-encode the caller's bytes. encodeThumbnail already refuses a header
// outside the photo bounds, on both platforms, before it decodes. The target
// sits under the cap so the file the crawler fetches is a whole image.
// -> { bytes, mime, width, height } or null. Never throws.
export async function buildCover (input) {
  try {
    // null is not the default parameter's {}, and a poisoned field must not
    // escape as a throw: the caller treats null as "no cover".
    if (!input || typeof input !== 'object') return null
    const encodeThumbnail = input.encodeThumbnail
    if (typeof encodeThumbnail !== 'function') return null
    const out = await encodeThumbnail(input.bytes, input.mime, {
      side: SHARE_COVER_SIDE,
      maxBytes: COVER_TARGET_BYTES
    })
    // A count with no bytes cannot be uploaded. The encoder returns the bytes.
    if (!validShareCover(out) || !(out.bytes instanceof Uint8Array)) return null
    return { bytes: out.bytes, mime: out.mime, width: out.width, height: out.height }
  } catch {
    return null
  }
}
