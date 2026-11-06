// Native: re-encodes the image a report carries (src/report.js prepareAnexo),
// like reportImage.web.js. The source is the file:// copy the node wrote for
// the chat (media/chatMedia.js); expo-image-manipulator decodes it and saves
// JPEG, which drops every metadata block (a GIF keeps its first frame). Steps
// down in quality, then in size, until the bytes fit `maxBytes`; the last
// (smallest) try is returned and the caller checks the cap. Every temporary
// file the module writes is deleted at once.
// -> { bytes, mime: 'image/jpeg', width, height }; throws when the image
// cannot be opened.

import { File } from 'expo-file-system'
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator'
import { MAX_IMAGE_SIDE, fitWithin } from './plan.js'
import { REPORT_QUALITIES, REPORT_SHRINK, REPORT_SHRINKS } from '../report.js'

function discard (file) {
  try { if (file.exists) file.delete() } catch {}
}

async function save (uri, actions, quality) {
  let result
  try {
    result = await manipulateAsync(uri, actions, { compress: quality, format: SaveFormat.JPEG })
  } catch {
    throw new Error('não foi possível preparar a imagem')
  }
  const out = new File(result.uri)
  try {
    return { bytes: await out.bytes(), mime: 'image/jpeg', width: result.width, height: result.height }
  } finally {
    discard(out)
  }
}

const isSide = (n) => Number.isInteger(n) && n >= 1

export async function encodeReportImage (entry, maxBytes) {
  if (!entry || typeof entry.uri !== 'string' || !entry.uri.startsWith('file://')) throw new Error('imagem indisponível')
  // The node may not report the size; the first save then tells it.
  let size = isSide(entry.w) && isSide(entry.h) ? fitWithin(entry.w, entry.h, MAX_IMAGE_SIDE) : null
  let last = null
  for (let s = 0; s <= REPORT_SHRINKS; s++) {
    const actions = size === null || (size.width === entry.w && size.height === entry.h) ? [] : [{ resize: { width: size.width, height: size.height } }]
    for (const q of REPORT_QUALITIES) {
      last = await save(entry.uri, actions, q)
      if (last.bytes.byteLength <= maxBytes) return last
    }
    const base = size === null ? fitWithin(last.width, last.height, MAX_IMAGE_SIDE) : size
    size = { width: Math.max(1, Math.round(base.width * REPORT_SHRINK)), height: Math.max(1, Math.round(base.height * REPORT_SHRINK)) }
  }
  return last
}
