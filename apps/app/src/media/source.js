// Pure decisions about a picked native asset, shared by encode.native.js and
// avatarEncode.native.js so they can be tested without the native modules.

// A source is only decoded and re-encoded, so any image type the system can
// open is fine (iOS hands out HEIC/HEIF for ordinary camera photos). An
// empty type is allowed: the manipulator fails cleanly if it cannot decode.
export function acceptedSource (mimeType) {
  if (typeof mimeType !== 'string') return false
  const mime = mimeType.toLowerCase()
  return mime === '' || mime.startsWith('image/')
}

// Types that can carry transparency. Saving them as JPEG would turn the
// transparent pixels black (the web fills white first, but the native
// manipulator has no background fill outside the web).
export function canHaveAlpha (mimeType) {
  if (typeof mimeType !== 'string') return false
  const mime = mimeType.toLowerCase()
  return mime === 'image/png' || mime === 'image/webp'
}

// A GIF over the cap is refused from its known size, before any read.
export function gifOverCap (size, cap) {
  return size > cap
}
