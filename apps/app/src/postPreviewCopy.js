// The words of the shared post preview before sign-in (ui/PostLinkOpen.js,
// ui/PostLinkPreviewRow.js, ui/PostLinkSheet.js) and the photo tiles' load
// order. Pure ES module: no React and no Node built-ins, so the tests load it
// with import().

export const PREVIEW_BAR_TITLE = 'Varanda'
export const POST_LINK_TITLE = 'Você abriu o link de uma publicação'
export const SEE_MORE_LABEL = 'Ver mais'
export const SHEET_TITLE = 'Entre para ver mais'
export const SHEET_BODY = 'Para ver mais, entre na Varanda ou crie sua conta. Pode ser preciso um convite.'
export const REPLY_LINE = 'Em resposta a outra publicação'
export const QUOTE_LINE = 'Cita outra publicação'
export const VIDEO_LINE = 'Vídeo disponível na Varanda'

export const A11Y_OPEN = 'Abrir publicação'
export const A11Y_PROFILE = 'Ver perfil'
export const A11Y_REPLY = 'Responder'
export const A11Y_REPOST = 'Republicar'
export const A11Y_LIKE = 'Curtir'
export const A11Y_MORE = 'Mais opções'
export const A11Y_CARD = 'Abrir link'
export const A11Y_VIDEO_COVER = 'Capa do vídeo'

// '' for anything but a whole number above 0.
export function morePhotosLine (n) {
  if (!Number.isInteger(n) || n <= 0) return ''
  return n === 1 ? 'Mais 1 foto na Varanda' : 'Mais ' + n + ' fotos na Varanda'
}

export function relationLine (relation) {
  if (relation === 'reply') return REPLY_LINE
  if (relation === 'quote') return QUOTE_LINE
  return ''
}

export function photoLabel (n, video) {
  return video === true ? A11Y_VIDEO_COVER : 'Foto ' + n
}

// The seeder serves at most 4 photo requests at once for every visitor and
// answers 503 past that, so the tiles of one preview load one after another:
// a tile asks only once every tile before it has loaded or given up. A failed
// tile tries once more after PHOTO_RETRY_MS, then shows a placeholder. A load
// that neither ends nor fails within PHOTO_STALL_MS stops holding the next
// tile back (it keeps loading).
export const PHOTO_RETRY_MS = 1000
export const PHOTO_STALL_MS = 10000

export const TILE_START = Object.freeze({ attempt: 0, phase: 'loading', stalled: false })

// events: 'load' | 'error' | 'retry' (the retry timer fired) | 'stall'.
export function tileStep (tile, event) {
  if (tile.phase === 'loaded' || tile.phase === 'failed') return tile
  if (event === 'load' && tile.phase === 'loading') return { ...tile, phase: 'loaded' }
  if (event === 'error' && tile.phase === 'loading') {
    return tile.attempt === 0 ? { ...tile, phase: 'waiting' } : { ...tile, phase: 'failed' }
  }
  if (event === 'retry' && tile.phase === 'waiting') return { ...tile, attempt: tile.attempt + 1, phase: 'loading' }
  if (event === 'stall' && tile.phase === 'loading') return { ...tile, stalled: true }
  return tile
}

// Whether the next tile may start.
export function tileSettled (tile) {
  return tile.phase === 'loaded' || tile.phase === 'failed' || tile.stalled === true
}

// Tile `index` (0-based) may ask once `settled` tiles before it are done.
export function tileMayLoad (index, settled) {
  return Number.isInteger(index) && index >= 0 && index <= settled
}
