export const FOLLOW_LABEL = 'Seguir'
export const FOLLOWING_LABEL = 'Seguindo'
export const UNFOLLOW_LABEL = 'Deixar de seguir'
export const UNFOLLOW_NOTE = 'As publicações dessa pessoa deixam de aparecer na sua Rua. Você pode seguir de novo quando quiser.'

export function unfollowQuestion (title) {
  return 'Deixar de seguir ' + (typeof title === 'string' && title.trim() ? title.trim() : 'esta pessoa') + '?'
}

// `intent` is the person's own press (true for Seguir, false for a confirmed
// Deixar de seguir, null for none). It is shown at once and holds the pill
// until the caller's request settles; after that `following`, which the
// caller re-reads on a failure, is the truth again.
export function followView ({ following, pending, intent }) {
  const pressed = intent === true || intent === false
  return {
    following: pressed ? intent : following,
    busy: pending === true || pressed
  }
}
