import { avatarOf, validAvatar } from './media/avatar.js'
import rpc from '@varanda/rpc'

const { MAX_MEDIA_BLOCKS, MAX_MEDIA_ITEM_BLOCKS, MEDIA_BLOCK_BYTES } = rpc
const HEX64 = /^[0-9a-f]{64}$/
const PRIVATE_KEYS = ['core', 'mime', 'start', 'blocks', 'bytes', 'sha256', 'key', 'nonce', 'plainMime', 'plainSha256', 'w', 'h', 'ms']

export function validPrivateGroupImage (image) {
  if (!image || typeof image !== 'object' || Array.isArray(image) ||
    Object.keys(image).length !== PRIVATE_KEYS.length || !PRIVATE_KEYS.every((key) => Object.hasOwn(image, key))) return false
  return ['core', 'sha256', 'key', 'plainSha256'].every((key) => typeof image[key] === 'string' && HEX64.test(image[key])) &&
    image.mime === 'application/octet-stream' && image.plainMime === 'image/jpeg' &&
    typeof image.nonce === 'string' && /^[0-9a-f]{48}$/.test(image.nonce) &&
    Number.isSafeInteger(image.start) && image.start >= 1 &&
    Number.isSafeInteger(image.blocks) && image.blocks >= 1 && image.blocks <= MAX_MEDIA_ITEM_BLOCKS &&
    image.start + image.blocks <= MAX_MEDIA_BLOCKS && image.bytes === image.blocks * MEDIA_BLOCK_BYTES &&
    image.w === 512 && image.h === 512 && image.ms === 0
}

export function validGroupImage (image) {
  return (validAvatar(image) && image.mime === 'image/jpeg') || validPrivateGroupImage(image)
}

// Older nodes omit these fields. Never substitute the group's key for the
// diary that owns the media, including in kept-only mode.
export function pictureProps (row) {
  if (!row || !validGroupImage(row.image) ||
    typeof row.imageAuthor !== 'string' || !HEX64.test(row.imageAuthor)) {
    return { picture: null, mediaAuthor: null }
  }
  if (validPrivateGroupImage(row.image)) return { privateItem: { ...row.image }, mediaAuthor: row.imageAuthor }
  if (row.visibility === 'private') return { picture: null, mediaAuthor: null }
  return { picture: avatarOf(row.image), mediaAuthor: row.imageAuthor }
}

export function canEdit (info, node) {
  // Communities have no visibility field; an unknown group's visibility
  // grants nothing.
  const knownRoot = info && (info.visibility === 'public' || info.visibility === 'private' ||
    (info.visibility === undefined && !info.group && typeof info.community === 'string' && HEX64.test(info.community)))
  // Absent charterHere is an older node, so the root still decides. A
  // boolean false does not fall back: the charter is waiting or has ended.
  // Repair stays its own field and is not folded into charterHere.
  const charter = typeof info?.charterHere === 'boolean' ? info.charterHere : null
  const authority = knownRoot && (info.group
    ? (charter === null ? info.rootHere === true : charter)
    : info.repair === true || (charter === null ? info.rootHere === true && info.rootAuthority === true : charter))
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
