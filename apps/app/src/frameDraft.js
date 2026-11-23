import { frameById, frameOf } from './media/frame.js'

export const GIF_MIME = 'image/gif'

const INITIAL_CROP = { zoom: 1, cx: 0.5, cy: 0.5 }

// Ready, or failed for good with its bytes kept: the next Publicar uploads it
// again, so it must follow the frame like a ready photo.
export function framable (item) {
  return item?.status === 'ready' ||
    (item?.status === 'failed' && !!item.encoded && !item.descriptor && typeof item.retry !== 'function')
}

export function isFixed (item) {
  return item?.encoded?.mime === GIF_MIME
}

export function seedFrame (frame, dims) {
  return frame ?? { id: frameOf(dims?.width, dims?.height).id, chosen: false }
}

export function frameRatioOf (frame) {
  return frameById(frame?.id)?.ratio ?? 1
}

export function frameLabel (frame) {
  return frameById(frame?.id)?.label ?? ''
}

export function canFrame (items, flags) {
  if (!Array.isArray(items) || flags?.held || flags?.busy || flags?.frozen) return false
  const locked = items.some(item =>
    item?.status === 'encoding' || item?.status === 'uploading' || item?.descriptor || typeof item?.retry === 'function'
  )
  return !locked && items.some(item => framable(item) && !isFixed(item))
}

export function editorPhotos (items) {
  if (!Array.isArray(items)) return []
  const photos = []
  for (const item of items) {
    if (!framable(item)) continue
    const cropBase = item.cropBase === 'encoded' ? 'encoded' : 'full'
    const whole = cropBase === 'full' ? item.whole : null
    const uri = whole ? whole.uri : item.thumb
    const { width, height } = (whole || item.encoded) ?? {}
    if (typeof uri !== 'string' || !uri.trim()) continue
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) continue
    photos.push({ id: item.id, uri, width, height, crop: item.crop ?? { ...INITIAL_CROP }, cropBase, fixed: isFixed(item) })
  }
  return photos
}

export function reframeIds (items, prevFrameId, nextFrameId, crops) {
  if (!Array.isArray(items)) return []
  const ids = []
  for (const item of items) {
    if (!framable(item) || isFixed(item)) continue
    const { id } = item
    if (typeof id !== 'string' && typeof id !== 'number') continue
    if (prevFrameId !== nextFrameId) {
      ids.push(id)
      continue
    }
    if (crops == null || !Object.hasOwn(crops, id)) continue
    const next = crops[id]
    if (next == null) continue
    const prev = item.crop ?? INITIAL_CROP
    if (next.zoom !== prev.zoom || next.cx !== prev.cx || next.cy !== prev.cy) ids.push(id)
  }
  return ids
}

export function keepsFrame (frame, items) {
  if (!frame || !Array.isArray(items) || items.length === 0) return false
  return frame.chosen === true || items.some(item => {
    const status = item?.status
    return status === 'encoding' || status === 'ready' || status === 'uploading' || status === 'failed' || status === 'done'
  })
}

export function leadFrame (items) {
  const item = Array.isArray(items) ? items[0] : null
  if (item?.status !== 'ready' || !isFixed(item)) return null
  return frameOf(item.encoded.width, item.encoded.height).id
}
