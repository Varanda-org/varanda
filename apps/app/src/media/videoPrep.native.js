// Native: turns a picked video ({ uri } from ./attach pickVideo) into the
// bytes that are uploaded. modules/video-prep re-encodes it in the app cache
// (H.264 and AAC, long side at most 960, no metadata) and writes a poster
// frame beside it. The output is then checked here as a peer would check it,
// with the metadata allowance only the sender gets: rpc.videoBounds, then
// rpc.stripVideoMetadata, then the strict videoBounds on the stripped bytes.
// Width, height and length come from those bytes, never from the picker nor
// from the module. The poster goes through the photo encoder like any photo.
// Both files the module wrote are deleted on every path, and so is the
// picker's own copy of the video (expo-image-picker copies the original,
// location and device metadata included, into <cache>/ImagePicker/): only a
// file:// URI directly inside that folder is ever deleted. One attempt: a
// refused output is never encoded again.
// prepareVideo(asset, { maxMs, maxBytes, signal }) -> { bytes, mime, width,
// height, ms, poster: { bytes, mime, width, height } }, or null when
// `signal.aborted` (the screen went away or the person cancelled): the late
// result is dropped. Throws an Error with a message for the person; no path
// and no native text reaches it.

import rpc from '@varanda/rpc'
import { File, Paths } from 'expo-file-system'
import * as VideoPrep from '../../modules/video-prep'
import { encodeFile } from './encode'
import { VIDEO_MIME } from './plan.js'

const MAX_SIDE = 960
const MAX_BITRATE = 1400000

function seconds (ms) {
  return Math.floor(ms / 1000)
}

function tooLong (maxMs) {
  return new Error('Escolha um vídeo de até ' + seconds(maxMs) + ' segundos.')
}

function refused () {
  return new Error('Este vídeo não cabe no formato aceito.')
}

function discard (uri, keep) {
  if (typeof uri !== 'string' || uri === keep) return
  try {
    const file = new File(uri)
    if (file.exists) file.delete()
  } catch {}
}

// The picker names its copies <uuid>.<ext> directly in the folder, so one
// plain segment is required: no subfolder, no `..`, no percent escape that
// could decode into either.
function pickerCopy (uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return false
  let cache
  try {
    cache = Paths.cache.uri
  } catch {
    return false
  }
  if (typeof cache !== 'string' || !cache.startsWith('file://')) return false
  const folder = cache.replace(/\/+$/, '') + '/ImagePicker/'
  if (!uri.startsWith(folder)) return false
  const name = uri.slice(folder.length)
  return /^[^/\\%?#]+$/.test(name) && name !== '.' && name !== '..'
}

function discardPick (uri) {
  if (pickerCopy(uri)) discard(uri)
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

export async function prepareVideo (asset, { maxMs, maxBytes, signal } = {}) {
  if (!(Number.isInteger(maxMs) && maxMs > 0 && Number.isInteger(maxBytes) && maxBytes > 0)) throw new TypeError('Expected maxMs and maxBytes')
  if (!asset || typeof asset.uri !== 'string') throw refused()
  let out = null
  try {
    if (aborted(signal)) return null
    try {
      out = await VideoPrep.prepare(asset.uri, { maxMs, maxBytes, maxSide: MAX_SIDE, maxBitrate: MAX_BITRATE })
    } catch (err) {
      // A preparation dropped meanwhile ends in null, never in an error.
      if (aborted(signal)) return null
      if (err && err.code === 'TOO_LONG') throw tooLong(maxMs)
      throw refused()
    }
    if (aborted(signal)) return null
    if (!out || typeof out.uri !== 'string' || typeof out.posterUri !== 'string') throw refused()
    let raw
    try {
      const file = new File(out.uri)
      // Checked before reading: the module's own count is not trusted.
      if (!(file.size >= 1 && file.size <= maxBytes)) throw refused()
      raw = await file.bytes()
    } catch {
      if (aborted(signal)) return null
      throw refused()
    }
    if (aborted(signal)) return null
    const video = preflight(raw, { maxMs, maxBytes })
    if (video === null) throw refused()
    let poster
    try {
      poster = await encodeFile({ uri: out.posterUri, mimeType: 'image/jpeg', width: video.width, height: video.height })
    } catch {
      if (aborted(signal)) return null
      throw refused()
    }
    if (aborted(signal)) return null
    return { bytes: video.bytes, mime: VIDEO_MIME, width: video.width, height: video.height, ms: video.ms, poster }
  } finally {
    if (out) {
      discard(out.uri, asset.uri)
      discard(out.posterUri, asset.uri)
    }
    discardPick(asset.uri)
  }
}
