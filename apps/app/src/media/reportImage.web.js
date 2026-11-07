/* global document, Image */

// Web: re-encodes the image a report carries (src/report.js prepareAnexo).
// The source is the blob: URL the chat already shows (media/chatMedia.js), so
// nothing is fetched: an <img> decodes it, a canvas draws it on white and
// exports JPEG. The re-encode drops every metadata block, and a GIF keeps only
// its first frame. Steps down in quality, then in size, until the bytes fit
// `maxBytes`; the last (smallest) try is returned and the caller checks the
// cap. -> { bytes, mime: 'image/jpeg', width, height }; throws when the image
// cannot be opened.

import { MAX_IMAGE_SIDE, fitWithin } from './plan.js'
import { REPORT_QUALITIES, REPORT_SHRINK, REPORT_SHRINKS } from '../report.js'

function toBlob (canvas, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob || null), 'image/jpeg', quality)
    } catch {
      resolve(null)
    }
  })
}

export async function encodeReportImage (entry, maxBytes) {
  if (!entry || typeof entry.uri !== 'string' || !entry.uri.startsWith('blob:')) throw new Error('imagem indisponível')
  const img = new Image()
  try {
    img.src = entry.uri
    await img.decode()
  } catch {
    img.src = ''
    throw new Error('não foi possível abrir a imagem')
  }
  const canvas = document.createElement('canvas')
  try {
    if (!(img.naturalWidth >= 1 && img.naturalHeight >= 1)) throw new Error('não foi possível abrir a imagem')
    let { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, MAX_IMAGE_SIDE)
    let last = null
    for (let s = 0; s <= REPORT_SHRINKS; s++) {
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('não foi possível preparar a imagem')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      for (const q of REPORT_QUALITIES) {
        const blob = await toBlob(canvas, q)
        if (!blob || blob.type !== 'image/jpeg') throw new Error('não foi possível preparar a imagem')
        last = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', width, height }
        if (last.bytes.byteLength <= maxBytes) return last
      }
      width = Math.max(1, Math.round(width * REPORT_SHRINK))
      height = Math.max(1, Math.round(height * REPORT_SHRINK))
    }
    return last
  } finally {
    canvas.width = 0
    canvas.height = 0
    img.src = ''
  }
}
