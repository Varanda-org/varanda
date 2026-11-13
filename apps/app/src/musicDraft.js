import { musicCardFields, MUSIC_NEEDS_TEXT } from './music.js'
import { isAudiusLink } from './musicEmbed.js'
import { findLinks } from './links.js'

export const MUSIC_PHOTOS_TEXT = 'A música vai só com texto: remova as fotos'
export const MUSIC_VIDEO_TEXT = 'A música vai só com texto: remova o vídeo'
export const MUSIC_MOMENT_VIDEO_TEXT = 'A música vai só com foto: remova a música'

export function musicSnapshot (draft) {
  if (!draft) return null
  const fields = musicCardFields(draft.item, draft.ref)
  return fields === null ? null : Object.freeze({ ...fields, thumb: null })
}

export function musicBlocks ({ hasMedia, hasVideo = false, asPage, online, textLength }) {
  if (hasVideo) return MUSIC_VIDEO_TEXT
  if (hasMedia) return MUSIC_PHOTOS_TEXT
  if (asPage !== null) return 'A música não vai em publicações de página'
  if (textLength < 1) return MUSIC_NEEDS_TEXT
  if (online === false) return 'Sem conexão: a música precisa de conexão'
  return ''
}

export function momentChoiceOf (music) {
  return music === null ? null : { ref: { kind: 'snippet', id: music.ref.id, start: music.ref.start }, item: music.item }
}

export function resolveTarget (text, tried) {
  return findLinks(text).find(({ href }) => isAudiusLink(href) && !href.includes('#') && !tried.has(href))?.href ?? null
}
