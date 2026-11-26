import { sha256 } from '@noble/hashes/sha2.js'
import { THUMB_MAX_BYTES, THUMB_SIDE, kindOf, toHex, videoPair } from './media/plan.js'

// `media` holds the uploaded photo descriptors; `held` holds their encoded
// { bytes, mime } in the same order. The caller supplies encodeThumbnail and
// the same upload(built) -> descriptor used for photos. Missing thumbnails
// keep their position; an all-null list is omitted because the node refuses it.
// No platform imports or fetching.
//
// Like an original, a thumbnail whose upload ended unknown (`uncertain`) is
// not given up: it stops the send ({ stopped: true }) and its retry is kept,
// so the next tap resends the same signed upload instead of signing a new
// one. `kept[i]` is what `keep(i, entry)` stored for photo i last time:
// { image } (already uploaded, never uploaded again) or { retry, expect }.
// `resend(retry)` -> descriptor runs a kept retry. Any other failure (encode,
// size, a refusal) just leaves null and never blocks the post.
// -> { thumbs: list | null, stopped }
export async function buildPostThumbs (input) {
  try {
    const { media, held, encodeThumbnail, upload, kept, keep = () => {}, resend = (retry) => retry() } = input
    if (!Array.isArray(media) || !Array.isArray(held) || videoPair(media)) return { thumbs: null, stopped: false }
    const thumbs = []
    for (let i = 0; i < media.length; i++) {
      const state = Array.isArray(kept) ? kept[i] : null
      const out = await buildThumb(media[i], held[i], state, i, { encodeThumbnail, upload, keep, resend })
      if (out.stopped) return { thumbs: null, stopped: true }
      thumbs.push(out.image)
    }
    return { thumbs: thumbs.some(thumb => thumb !== null) ? thumbs : null, stopped: false }
  } catch {
    return { thumbs: null, stopped: false }
  }
}

function withinCaps (bytes, width, height) {
  return Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= THUMB_MAX_BYTES &&
    [width, height].every(n => Number.isInteger(n) && n >= 1 && n <= THUMB_SIDE)
}

const matches = (image, expect) => !!image && !!expect && image.mime === expect.mime && image.bytes === expect.bytes &&
  image.width === expect.width && image.height === expect.height && image.sha256 === expect.sha256

async function buildThumb (original, held, state, i, { encodeThumbnail, upload, keep, resend }) {
  const skip = { image: null, stopped: false }
  try {
    if (state && state.image) return { image: state.image, stopped: false }
    if (!original || kindOf(original.mime) !== 'image') return skip
    if (withinCaps(original.bytes, original.width, original.height)) return skip
    if (!held || held.mime !== original.mime || !(held.bytes instanceof Uint8Array) || held.bytes.byteLength !== original.bytes) return skip
    let expect
    let run
    if (state && typeof state.retry === 'function' && state.expect) {
      // The same signed upload, not another encode and signature.
      expect = state.expect
      run = () => resend(state.retry)
    } else {
      const built = await encodeThumbnail(held.bytes, held.mime, { side: THUMB_SIDE, maxBytes: THUMB_MAX_BYTES })
      if (!built || built.mime !== 'image/jpeg' || !(built.bytes instanceof Uint8Array) || !withinCaps(built.bytes.byteLength, built.width, built.height)) return skip
      expect = { mime: built.mime, bytes: built.bytes.byteLength, width: built.width, height: built.height, sha256: toHex(sha256(built.bytes)) }
      run = () => upload(built)
    }
    let image
    try {
      image = await run()
    } catch (err) {
      // After an unknown outcome the next tap resends; a kept retry that
      // failed again is replaced by the new one or dropped.
      if (err && err.uncertain === true) {
        keep(i, typeof err.retry === 'function' ? { retry: err.retry, expect } : null)
        return { image: null, stopped: true }
      }
      keep(i, null)
      return skip
    }
    if (!matches(image, expect)) {
      keep(i, null)
      return skip
    }
    keep(i, { image })
    return { image, stopped: false }
  } catch {
    return skip
  }
}
