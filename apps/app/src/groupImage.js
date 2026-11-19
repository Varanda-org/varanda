import { avatarOf, validAvatar } from './media/avatar.js'

const HEX64 = /^[0-9a-f]{64}$/

export function validGroupImage (image) {
  return validAvatar(image) && image.mime === 'image/jpeg'
}

// Older nodes omit these fields. Never substitute the group's key for the
// diary that owns the media, including in kept-only mode.
export function pictureProps (row) {
  if (!row || row.visibility === 'private' || !validGroupImage(row.image) ||
    typeof row.imageAuthor !== 'string' || !HEX64.test(row.imageAuthor)) {
    return { picture: null, mediaAuthor: null }
  }
  return { picture: avatarOf(row.image), mediaAuthor: row.imageAuthor }
}

export function canEdit (info, node) {
  // Communities have no visibility field: a community key identifies that
  // public root; an unknown group's visibility grants nothing.
  const publicRoot = info && (info.visibility === 'public' ||
    (info.visibility === undefined && !info.group && typeof info.community === 'string' && HEX64.test(info.community)))
  const authority = publicRoot && (info.group
    ? info.rootHere === true
    : info.repair === true || (info.rootHere === true && info.rootAuthority === true))
  return !!(authority && info.role === 'creator' && node &&
    node.media && typeof node.media.upload === 'function')
}

export const words = Object.freeze({
  add: 'Adicionar imagem',
  change: 'Trocar imagem',
  remove: 'Remover imagem',
  title: 'Imagem',
  save: 'Salvar',
  cancel: 'Cancelar',
  failed: 'Não foi possível salvar a imagem. Tente de novo.',
  uncertain: 'Não foi possível confirmar a alteração. Confira a imagem antes de tentar de novo.'
})
