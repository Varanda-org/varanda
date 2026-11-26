/* global Blob, document, URL, setTimeout, clearTimeout */

// Web: a browser has no encoder this app can count on, so the chosen file is
// never re-encoded: it is taken only when it already fits. A file larger than
// maxBytes is refused before it is read, unless the caller's limits are
// stricter than a post and the file is no larger than a post: then it is
// read, and a clip a post could take is refused with code OVER_LIMIT.
// The bytes then pass the same checks
// as on a phone (./videoPrep.native.js): rpc.videoBounds with the sender's
// metadata allowance, rpc.stripVideoMetadata, then the strict videoBounds on
// the stripped bytes, which give width, height and length. The poster is the
// first frame of the STRIPPED bytes drawn on a canvas (long side at most
// 960) and saved as JPEG. Every object URL, element and canvas made here is
// released before returning.
// prepareVideo(file, { maxMs, maxBytes, signal }) -> { bytes, mime, width,
// height, ms, poster: { bytes, mime, width, height } }, or null when
// `signal.aborted`. Throws an Error with a message for the person. OVER_LIMIT
// (limitMs is the cap asked for) is the only coded refusal: the clip misses
// this caller's cap and still fits a post.

import rpc from '@varanda/rpc'
import { MAX_VIDEO_BYTES, MAX_VIDEO_MS, VIDEO_MIME, checkFile, fitWithin } from './plan.js'

const POSTER_SIDE = 960
const POSTER_QUALITY = 0.85
// A browser that cannot decode the file may never answer.
const FRAME_TIMEOUT_MS = 10000

function refused (maxMs, maxBytes) {
  const mb = Math.floor(maxBytes / (1024 * 1024))
  return new Error('Neste navegador o vídeo precisa ser MP4 (H.264), com até ' + Math.floor(maxMs / 1000) + ' segundos e ' + mb + ' MB. Pelo app do celular ele é ajustado sozinho.')
}

function overLimit (maxMs, maxBytes) {
  const err = refused(maxMs, maxBytes)
  err.code = 'OVER_LIMIT'
  err.limitMs = maxMs
  return err
}

const aborted = (signal) => signal != null && signal.aborted === true

// -> { bytes, width, height, ms } of the stripped file, or null.
export function preflight (raw, { maxMs, maxBytes }) {
  if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > maxBytes) return null
  if (rpc.videoBounds(raw, { maxMs, metadata: true }) === null) return null
  const bytes = rpc.stripVideoMetadata(raw)
  if (bytes === null) return null
  const bounds = rpc.videoBounds(bytes, { maxMs })
  if (bounds === null) return null
  return { bytes, width: bounds.width, height: bounds.height, ms: bounds.ms }
}

// A momento cap can refuse a clip a post would take. That refusal is
// OVER_LIMIT so the caller can offer it as a post; every other refusal stays
// untagged. null means the signal aborted while the bytes were read for the
// post check.
async function limitError (file, raw, maxMs, maxBytes, signal) {
  const stricter = maxMs < MAX_VIDEO_MS || maxBytes < MAX_VIDEO_BYTES
  if (stricter && file.size <= MAX_VIDEO_BYTES) {
    let bytes = raw
    if (!(bytes instanceof Uint8Array)) {
      if (aborted(signal)) return null
      try {
        bytes = new Uint8Array(await file.arrayBuffer())
      } catch {
        if (aborted(signal)) return null
        return refused(maxMs, maxBytes)
      }
      if (aborted(signal)) return null
    }
    if (preflight(bytes, { maxMs: MAX_VIDEO_MS, maxBytes: MAX_VIDEO_BYTES }) !== null) return overLimit(maxMs, maxBytes)
  }
  return refused(maxMs, maxBytes)
}

// Resolves once the element has its first frame, rejects on an error or
// after FRAME_TIMEOUT_MS. Safari on iOS may load only the metadata of an
// element that is not playing, so once the metadata is in, a seek to the
// start is asked for and a muted inline play is tried (paused again when the
// frame is there): either makes the browser decode a frame.
function firstFrame (video) {
  return new Promise((resolve, reject) => {
    let timer = null
    const done = (ok) => {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onMeta)
      video.removeEventListener('loadeddata', onData)
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
      try {
        if (typeof video.pause === 'function') video.pause()
      } catch {}
      if (ok) resolve()
      else reject(new Error('no frame'))
    }
    const onMeta = () => {
      try {
        video.currentTime = 0.001
      } catch {}
      try {
        const playing = typeof video.play === 'function' ? video.play() : null
        if (playing && typeof playing.catch === 'function') playing.catch(() => {})
      } catch {}
    }
    const onData = () => done(true)
    // HAVE_CURRENT_DATA: a frame is there to draw.
    const onSeeked = () => { if (video.readyState >= 2) done(true) }
    const onError = () => done(false)
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('loadeddata', onData)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    timer = setTimeout(() => done(false), FRAME_TIMEOUT_MS)
  })
}

function toJpeg (canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), 'image/jpeg', POSTER_QUALITY)
    } catch {
      resolve(null)
    }
  })
}

// -> { bytes, mime, width, height } or null.
async function drawPoster (bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: VIDEO_MIME }))
  const video = document.createElement('video')
  const canvas = document.createElement('canvas')
  try {
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    const ready = firstFrame(video)
    video.src = url
    await ready
    if (!(video.videoWidth >= 1 && video.videoHeight >= 1)) return null
    const { width, height } = fitWithin(video.videoWidth, video.videoHeight, POSTER_SIDE)
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, width, height)
    const blob = await toJpeg(canvas)
    if (!blob || blob.type !== 'image/jpeg') return null
    const out = new Uint8Array(await blob.arrayBuffer())
    if (checkFile({ mime: 'image/jpeg', bytes: out.byteLength, width, height }) !== null) return null
    return { bytes: out, mime: 'image/jpeg', width, height }
  } catch {
    return null
  } finally {
    try {
      video.removeAttribute('src')
      video.load()
    } catch {}
    URL.revokeObjectURL(url)
    canvas.width = 0
    canvas.height = 0
  }
}

export async function prepareVideo (file, { maxMs, maxBytes, signal } = {}) {
  if (!(Number.isInteger(maxMs) && maxMs > 0 && Number.isInteger(maxBytes) && maxBytes > 0)) throw new TypeError('Expected maxMs and maxBytes')
  if (!file || typeof file.size !== 'number' || typeof file.arrayBuffer !== 'function') throw refused(maxMs, maxBytes)
  if (!(file.size >= 1 && file.size <= maxBytes)) {
    const err = await limitError(file, null, maxMs, maxBytes, signal)
    if (err === null) return null
    throw err
  }
  if (aborted(signal)) return null
  let raw
  try {
    raw = new Uint8Array(await file.arrayBuffer())
  } catch {
    // A preparation dropped meanwhile ends in null, never in an error.
    if (aborted(signal)) return null
    throw refused(maxMs, maxBytes)
  }
  if (aborted(signal)) return null
  const video = preflight(raw, { maxMs, maxBytes })
  if (video === null) throw await limitError(file, raw, maxMs, maxBytes, signal)
  const poster = await drawPoster(video.bytes)
  if (aborted(signal)) return null
  if (poster === null) throw refused(maxMs, maxBytes)
  return { bytes: video.bytes, mime: VIDEO_MIME, width: video.width, height: video.height, ms: video.ms, poster }
}
