export const FOLLOW_LABEL = 'Seguir'
export const FOLLOWING_LABEL = 'Seguindo'
export const UNFOLLOW_LABEL = 'Deixar de seguir'
export const UNFOLLOW_NOTE = 'As publicações dessa pessoa deixam de aparecer na sua Rua. Você pode seguir de novo quando quiser.'

export function unfollowQuestion (title) {
  return 'Deixar de seguir ' + (typeof title === 'string' && title.trim() ? title.trim() : 'esta pessoa') + '?'
}
