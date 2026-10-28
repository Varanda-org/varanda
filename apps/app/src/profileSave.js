// What one Salvar in Perfil sends. The photo draft is undefined (unchanged),
// null (remove) or { encoded, previewUrl, descriptor } where descriptor is
// null until the encoded bytes are uploaded. An unchanged photo sends no
// avatar key, so a name-only save never erases a known photo. Pure: no React.

import { sameAvatar } from './media/avatar.js'

// -> { firstPlain, needsUpload, params }. firstPlain: the own diary has no
// profile yet and the photo still needs uploading; the first upload appends
// a media-core declaration to the diary, which would push the first profile
// out of the head that Espiadinha and follow notices read, so a plain
// profile.set { name, bio } goes first.
export function planSave ({ name, bio, draft, current }) {
  const known = current && current.avatar ? current.avatar : null
  const params = { name, bio }
  const needsUpload = !!draft && typeof draft === 'object' && !draft.descriptor
  if (draft === null) {
    if (known !== null) params.avatar = null
  } else if (draft && typeof draft === 'object' && draft.descriptor && !sameAvatar(draft.descriptor, known)) {
    params.avatar = draft.descriptor
  }
  const firstPlain = needsUpload && !(current && current.name)
  return { firstPlain, needsUpload, params }
}

// Whether the own profile read back (profile.read) shows `sent` as saved.
export function confirmSaved (sent, mine) {
  if (!mine || typeof mine !== 'object' || !sent) return false
  if (mine.name !== sent.name || (mine.bio || '') !== sent.bio) return false
  if (Object.hasOwn(sent, 'avatar')) return sameAvatar(mine.avatar == null ? null : mine.avatar, sent.avatar)
  return true
}
