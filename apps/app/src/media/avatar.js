/* global Blob, URL */

// Profile photos (avatars) for the hosted web app. An avatar is a media
// descriptor with stricter rules (a still 512x512 JPEG or WebP of at most 8
// blocks), fetched and SHA-256 checked like a post photo (./fetch.js) and
// then checked again here: the bytes must be a still image whose header says
// exactly the descriptor's width and height, so an animated or mislabelled
// file is never drawn as someone's face. Pure: no React, no Node built-ins.

import { fetchMedia, validDescriptor } from './fetch.js'

// Same values as packages/core/lib/records.js and still-image.js; pinned by
// apps/app/test/avatarParity.test.js.
export const AVATAR_SIDE = 512
export const MAX_AVATAR_BLOCKS = 8
export const MAX_AVATAR_BYTES = 262144
export const AVATAR_MIMES = Object.freeze(['image/jpeg', 'image/webp'])

const FIELDS = ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'width', 'height']

// Never throws.
export function validAvatar (d) {
  return validDescriptor(d) &&
    AVATAR_MIMES.includes(d.mime) &&
    d.width === AVATAR_SIDE &&
    d.height === AVATAR_SIDE &&
    d.blocks <= MAX_AVATAR_BLOCKS &&
    d.bytes <= MAX_AVATAR_BYTES
}

// A fresh copy of a valid avatar, or null: callers never keep a peer object.
export function avatarOf (v) {
  if (!validAvatar(v)) return null
  const out = {}
  for (const k of FIELDS) out[k] = v[k]
  return out
}

export function sameAvatar (a, b) {
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  return FIELDS.every((k) => a[k] === b[k])
}

// The author is part of the key: the same bytes are trusted per author, and
// the mime is part of it because the Blob is typed with it.
export function avatarKey (author, d) {
  return String(author).toLowerCase() + ':' + FIELDS.map((k) => d[k]).join(':')
}

const be16 = (b, i) => (b[i] << 8) | b[i + 1]
const le16 = (b, i) => b[i] | (b[i + 1] << 8)
const le24 = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
const le32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
const fourcc = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3])
const size = (width, height) => (width >= 1 && height >= 1 ? { width, height } : null)

const isSof = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc

// At most this many JPEG segments or WebP chunks are walked.
const MAX_PARTS = 64

function jpegSize (b) {
  const n = b.length
  if (n < 3 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null
  let p = 2
  for (let count = 0; count < MAX_PARTS; count++) {
    if (p + 1 >= n || b[p] !== 0xff) return null
    while (p + 1 < n && b[p + 1] === 0xff) p++
    if (p + 1 >= n) return null
    const marker = b[p + 1]
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) return null
    if (p + 4 > n) return null
    const len = be16(b, p + 2)
    if (len < 2 || p + 2 + len > n) return null
    if (isSof(marker)) {
      // A frame header is 8 bytes plus 3 per component, so a short or
      // inconsistent one is not trusted for its size fields.
      if (len < 11) return null
      const nf = b[p + 9]
      if (nf < 1 || nf > 4 || len !== 8 + 3 * nf) return null
      return size(be16(b, p + 7), be16(b, p + 5))
    }
    p += 2 + len
  }
  return null
}

// The whole RIFF body is walked, never stopping at the image chunk, so an
// animation chunk or a second image anywhere makes the file null.
function webpSize (b) {
  const n = b.length
  if (n < 12 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP') return null
  const riffSize = le32(b, 4)
  if (riffSize < 4 || 8 + riffSize > n) return null
  const end = 8 + riffSize
  let p = 12
  let canvas = null
  let frame = null
  for (let count = 0; p + 8 <= end; count++) {
    if (count >= MAX_PARTS) return null
    const id = fourcc(b, p)
    const len = le32(b, p + 4)
    const at = p + 8
    if (len > end - at) return null
    if (id === 'ANIM' || id === 'ANMF') return null
    if (id === 'VP8X') {
      if (canvas !== null || frame !== null || len < 10) return null
      if ((b[at] & 0x02) !== 0) return null
      canvas = { width: 1 + le24(b, at + 4), height: 1 + le24(b, at + 7) }
    } else if (id === 'VP8 ') {
      if (frame !== null || len < 10) return null
      if (b[at + 3] !== 0x9d || b[at + 4] !== 0x01 || b[at + 5] !== 0x2a) return null
      frame = size(le16(b, at + 6) & 0x3fff, le16(b, at + 8) & 0x3fff)
      if (frame === null) return null
    } else if (id === 'VP8L') {
      if (frame !== null || len < 5 || b[at] !== 0x2f) return null
      const v = le32(b, at + 1)
      frame = { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }
    }
    p = at + len + (len & 1)
  }
  // Stray bytes or a missing pad byte at the end mean a malformed container.
  if (p !== end) return null
  if (frame === null) return null
  if (canvas !== null && (canvas.width !== frame.width || canvas.height !== frame.height)) return null
  return frame
}

// -> { width, height } read from the header, or null for anything that is
// not a still JPEG or WebP of that mime. It decodes no pixels. Never throws.
export function stillImageSize (bytes, mime) {
  try {
    if (!(bytes instanceof Uint8Array)) return null
    if (mime === 'image/jpeg') return jpegSize(bytes)
    if (mime === 'image/webp') return webpSize(bytes)
    return null
  } catch {
    return null
  }
}

export function checkAvatarBytes (bytes, d) {
  const s = stillImageSize(bytes, d.mime)
  return s !== null && s.width === d.width && s.height === d.height
}

// A names-cache value comes from the whole local log (docs/rpc.md 5.21), so
// a defined one, null included, beats what a peek window row carries.
export function pickAvatar (cached, row) {
  return cached && cached.avatar !== undefined ? avatarOf(cached.avatar) : avatarOf(row ? row.avatar : null)
}

// -> a blob: URL of the verified avatar bytes. A bad descriptor or bad bytes
// is 'foto inválida' and never retryable; fetchMedia's own errors (a 404 or a
// network error is retryable) pass through unchanged.
export async function loadAvatarUrl (author, d, deps = {}) {
  if (!validAvatar(d)) throw new Error('foto inválida')
  const bytes = await fetchMedia(author, d, deps)
  if (!checkAvatarBytes(bytes, d)) throw new Error('foto inválida')
  const MakeBlob = deps.Blob || Blob
  const create = deps.createObjectURL || ((blob) => URL.createObjectURL(blob))
  return create(new MakeBlob([bytes], { type: d.mime }))
}
