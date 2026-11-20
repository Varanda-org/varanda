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

// Every key of follow.list, lower case, page by page. Null when any page
// fails: a half-read or empty set would show people already followed as
// strangers, so the caller keeps what it had.
export async function readFollowKeys (request, limit) {
  const keys = []
  try {
    for (let offset = 0; offset < 10000;) {
      const r = await request('follow.list', { offset, limit })
      const page = Array.isArray(r && r.follows) ? r.follows : []
      for (const k of page) if (typeof k === 'string') keys.push(k.toLowerCase())
      offset += page.length
      if (page.length === 0 || !(r && Number.isSafeInteger(r.total)) || offset >= r.total) break
    }
  } catch {
    return null
  }
  return new Set(keys)
}
