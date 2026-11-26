// Native: the system photo picker (no permission needed on Android; the
// photo library prompt on iOS). Assets come back as plain
// { uri, mimeType, width, height }; EXIF is not requested, and encode.native.js
// re-encodes the pixels anyway. pickImages resolves [] when cancelled and
// pickImage null. pickVideo offers videos only, one at a time, and resolves
// null when cancelled; ./videoPrep re-encodes what it picks, so its size and
// length are never taken from here.

import * as ImagePicker from 'expo-image-picker'
import { Directory, File, Paths } from 'expo-file-system'
import * as CameraCapture from '../../modules/camera-capture'
import { captureError } from '../cameraChoice.js'
import { MAX_MEDIA_PER_POST } from './plan.js'

export function discardCapture (uri) {
  try {
    if (typeof uri !== 'string' || !uri.startsWith('file://')) return
    const cache = Paths.cache.uri
    if (typeof cache !== 'string' || !cache.startsWith('file://')) return
    const folder = cache.replace(/\/+$/, '') + '/CameraCapture/'
    if (!uri.startsWith(folder) || !/^[0-9a-f]{32}\.(jpg|mp4)$/.test(uri.slice(folder.length))) return
    const file = new File(uri)
    if (file.exists) file.delete()
  } catch {}
}

export function sweepCaptures () {
  try {
    const dir = new Directory(Paths.cache, 'CameraCapture')
    if (!dir.exists) return
    const folder = dir.uri.replace(/\/+$/, '') + '/'
    const cutoff = Date.now() - 24 * 60 * 60 * 1000
    for (const file of dir.list()) {
      try {
        if (!(file instanceof File) || !/^[0-9a-f]{32}\.(jpg|mp4)$/.test(file.name)) continue
        if (file.uri !== folder + file.name) continue
        const time = file.modificationTime
        if (typeof time === 'number' && time > 0 && time < cutoff) file.delete()
      } catch {}
    }
  } catch {}
}

// Every Android binary ships the module, with no OTA JS updates, so Android
// never reaches Expo; a present module with no camera never falls back.
export async function canCapture () {
  try {
    if (CameraCapture.isAvailable()) {
      sweepCaptures()
      return await CameraCapture.canCapture()
    }
    const available = typeof ImagePicker.launchCameraAsync === 'function'
    return { photo: available, video: available }
  } catch {
    return { photo: false, video: false }
  }
}

async function capture (kind, options) {
  if (CameraCapture.isAvailable()) {
    try {
      return plain(await CameraCapture.capture(kind, options))
    } catch (err) {
      const code = err && err.code
      throw captureError(code === 'UNAVAILABLE' ? 'CAMERA_UNAVAILABLE' : code === 'BUSY' ? 'CAMERA_BUSY' : 'CAMERA_FAILED')
    }
  }
  if (typeof ImagePicker.launchCameraAsync !== 'function') throw captureError('CAMERA_UNAVAILABLE')
  let perm
  try {
    perm = await ImagePicker.requestCameraPermissionsAsync()
  } catch {
    throw captureError('CAMERA_FAILED')
  }
  if (!perm || !perm.granted) throw captureError('CAMERA_DENIED')
  try {
    const res = await ImagePicker.launchCameraAsync(kind === 'photo'
      ? { mediaTypes: ['images'], exif: false }
      : { mediaTypes: ['videos'], exif: false, videoMaxDuration: Math.ceil(options.maxMs / 1000) })
    if (!res || res.canceled || !Array.isArray(res.assets)) return null
    return plain(res.assets[0])
  } catch {
    throw captureError('CAMERA_FAILED')
  }
}

export function capturePhoto () {
  return capture('photo')
}

export function captureVideo ({ maxMs }) {
  return capture('video', { maxMs })
}

function plain (asset) {
  if (!asset || typeof asset.uri !== 'string') return null
  return {
    uri: asset.uri,
    mimeType: typeof asset.mimeType === 'string' ? asset.mimeType : '',
    width: asset.width,
    height: asset.height
  }
}

async function launch (options) {
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], exif: false, ...options })
  if (!res || res.canceled || !Array.isArray(res.assets)) return []
  return res.assets.map(plain).filter(Boolean)
}

// The default is a diary post. Chat and Feira pass a smaller cap so the
// system picker stops there instead of offering ten.
export function pickImages (limit = MAX_MEDIA_PER_POST) {
  return launch({ allowsMultipleSelection: true, selectionLimit: limit })
}

export async function pickImage () {
  const assets = await launch({ allowsMultipleSelection: false })
  return assets[0] || null
}

export async function pickVideo () {
  const assets = await launch({ mediaTypes: ['videos'], allowsMultipleSelection: false })
  return assets[0] || null
}
