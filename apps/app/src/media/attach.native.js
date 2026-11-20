// Native: the system photo picker (no permission needed on Android; the
// photo library prompt on iOS). Assets come back as plain
// { uri, mimeType, width, height }; EXIF is not requested, and encode.native.js
// re-encodes the pixels anyway. pickImages resolves [] when cancelled and
// pickImage null. pickVideo offers videos only, one at a time, and resolves
// null when cancelled; ./videoPrep re-encodes what it picks, so its size and
// length are never taken from here.

import * as ImagePicker from 'expo-image-picker'
import { MAX_MEDIA_PER_POST } from './plan.js'

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
