import { validGroupImage, validPrivateGroupImage } from './groupImage.js'
import { AVATAR_SIDE } from './media/avatar.js'

export async function imageAfterCreate ({ key, kind, visibility, picked, upload, setImage } = {}) {
  if (!picked || !key) return 'none'
  try {
    if (kind !== 'group' && kind !== 'community') return 'failed'
    if (kind === 'group' && visibility !== 'public' && visibility !== 'private') return 'failed'
    const sealed = kind === 'group' && visibility === 'private'
    const image = await upload({
      bytes: picked.bytes,
      mime: picked.mime,
      width: AVATAR_SIDE,
      height: AVATAR_SIDE,
      ...(sealed ? { sealed: true } : {})
    })
    if (!validGroupImage(image) || validPrivateGroupImage(image) !== sealed) return 'failed'
    await setImage(kind + '.image', { [kind]: key, image })
    return 'set'
  } catch (err) {
    return err?.uncertain === true ? 'uncertain' : 'failed'
  }
}

export const words = Object.freeze({
  groupLabel: 'Foto do grupo (opcional)',
  communityLabel: 'Foto da comunidade (opcional)',
  groupPublic: 'A foto do grupo é pública, como o nome.',
  communityPublic: 'A foto da comunidade é pública, como o nome.',
  groupPrivate: 'Só quem participa do grupo vê a foto.',
  groupFailed: 'Grupo criado. A foto não foi salva. Você pode adicioná-la nos ajustes.',
  communityFailed: 'Comunidade criada. A foto não foi salva. Você pode adicioná-la nos ajustes.'
})
