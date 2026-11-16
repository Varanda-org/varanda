// The EXIF orientation of a JPEG (tag 0x0112 of IFD0 in the first APP1
// "Exif" segment) -> 1 to 8, or 1 when there is none or it is malformed. Both
// native image decoders (expo-image-manipulator on iOS and Android) turn the
// pixels as it says before resizing, while the header size (rpc.mediaBounds)
// is the stored one: for 5 to 8 the sides swap. Other formats are left as
// stored.

const SOI = 0xd8
const APP1 = 0xe1
const SOS = 0xda
const EOI = 0xd9
const ORIENTATION = 0x0112
const SHORT = 3

export function jpegOrientation (bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return 1
  let at = 2
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return 1
    const marker = bytes[at + 1]
    if (marker === 0xff) { at++; continue }
    if (marker === SOS || marker === EOI) return 1
    const length = (bytes[at + 2] << 8) | bytes[at + 3]
    if (length < 2 || at + 2 + length > bytes.length) return 1
    if (marker === APP1 && isExif(bytes, at + 4, length - 2)) return tiffOrientation(bytes, at + 10, at + 2 + length)
    at += 2 + length
  }
  return 1
}

// { width, height } as the decoders turn it.
export function orientedSize (bytes, mime, size) {
  if (mime !== 'image/jpeg' || jpegOrientation(bytes) < 5) return size
  return { width: size.height, height: size.width }
}

function isExif (b, at, n) {
  return n >= 6 && b[at] === 0x45 && b[at + 1] === 0x78 && b[at + 2] === 0x69 && b[at + 3] === 0x66 && b[at + 4] === 0 && b[at + 5] === 0
}

// A TIFF header at `start`, offsets relative to it, nothing read past `end`.
function tiffOrientation (b, start, end) {
  if (start + 8 > end) return 1
  const little = b[start] === 0x49 && b[start + 1] === 0x49
  if (!little && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return 1
  const u16 = (i) => little ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]
  const u32 = (i) => little
    ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
    : ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
  if (u16(start + 2) !== 42) return 1
  const ifd = start + u32(start + 4)
  if (ifd < start + 8 || ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return 1
    if (u16(entry) !== ORIENTATION) continue
    if (u16(entry + 2) !== SHORT || u32(entry + 4) !== 1) return 1
    const value = u16(entry + 8)
    return value >= 1 && value <= 8 ? value : 1
  }
  return 1
}
