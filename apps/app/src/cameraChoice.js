// Pure so a post or momento can offer gallery or camera without React.
// The caller opens the library itself when capture is off.

export const CAPTURE_TEXT = Object.freeze({
  CAMERA_DENIED: 'sem permissão para usar a câmera. Libere nos Ajustes do aparelho',
  CAMERA_UNAVAILABLE: 'nenhum app de câmera foi encontrado',
  CAMERA_BUSY: 'a câmera já está aberta',
  CAMERA_FAILED: 'não foi possível usar a câmera'
})

export function captureError (code) {
  const known = Object.hasOwn(CAPTURE_TEXT, code) ? code : 'CAMERA_FAILED'
  const err = new Error(CAPTURE_TEXT[known])
  err.code = known
  return err
}

export function captureErrorText (err) {
  const code = err && err.code
  return Object.hasOwn(CAPTURE_TEXT, code) ? CAPTURE_TEXT[code] : null
}

// ui/Icon.js names the gallery glyph 'imagem', not 'image'.
export function sourceActions ({ cap, kind, maxMs, onGallery, onCamera }) {
  if (!cap || cap[kind] !== true) return []
  const camera = { icon: kind === 'video' ? 'video' : 'camera', label: 'Câmera' }
  if (kind === 'video' && Number.isInteger(maxMs) && maxMs > 0) {
    camera.description = 'até ' + Math.floor(maxMs / 1000) + ' segundos'
  }
  camera.onPress = onCamera
  return [
    { icon: 'imagem', label: 'Galeria', onPress: onGallery },
    camera
  ]
}

export function sourceTitle (kind) {
  if (kind === 'photo') return 'Foto'
  if (kind === 'video') return 'Vídeo'
}
