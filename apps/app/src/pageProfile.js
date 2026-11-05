// The profile a page's Salvar signs: the fields the person edited, and for
// every other field the page's profile as read right before signing. A save
// built on the screen's first snapshot would put back an old name or photo
// another administrator (or a fresher replica) already changed. Pure.

export const FRESH_FAILED = 'Não deu para conferir o perfil atual. Tente de novo.'

const text = (v) => (typeof v === 'string' ? v : '')

// base: the snapshot the form started from ({ name, bio, avatar }).
// form: { name, bio } as edited. draft: undefined (photo untouched), null
// (photo removed) or an object (a new photo, uploaded on its own).
// fresh: the profile read right before signing, or null when that read
// failed. -> { name, bio, avatar } (avatar null: none), or throws
// FRESH_FAILED when there is no fresh read.
export function mergeProfile ({ base, form, draft, fresh }) {
  if (!fresh || typeof fresh !== 'object' || typeof fresh.name !== 'string') throw new Error(FRESH_FAILED)
  const was = base && typeof base === 'object' ? base : { name: '', bio: '', avatar: null }
  const name = form.name !== text(was.name) ? form.name : fresh.name
  const bio = form.bio !== text(was.bio) ? form.bio : text(fresh.bio)
  const avatar = draft === undefined ? (fresh.avatar || null) : null
  return { name, bio, avatar }
}

// The 'profile' statement op of a merge (no new photo): the avatar rides
// only when there is one.
export function profileOp (merged) {
  const op = { name: merged.name, bio: merged.bio }
  if (merged.avatar) op.avatar = merged.avatar
  return op
}
