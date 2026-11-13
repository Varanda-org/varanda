import { useEffect, useRef, useState } from 'react'
import { audiusArt } from '../account'
import { registerLocalCache } from '../localCaches'
import { coverUri, createCoverCache } from '../musicCover'

// One cache for the whole app, in memory only (src/musicCover.js says why).
// A cover belongs to the signed-in person's session, so sign-out, lock and an
// account change empty it with every other local cache.
// A refusal that holds for the session (noCover, from audiusArt) is kept as
// no cover; any other failure rejects, so the next mount may ask again.
const cache = createCoverCache({
  load: async (kind, id, session) => {
    try {
      const { mime, base64 } = await audiusArt(kind, id, session)
      return coverUri(mime, base64)
    } catch (err) {
      if (err && err.noCover === true) return null
      throw err
    }
  }
})
registerLocalCache({ wipe: () => cache.clear() })

// session: { member, origin, request }. -> a data: URI, or null while it
// loads, on a failure and for an item without a cover.
export function useMusicCover (kind, item, session, enabled = true) {
  const [uri, setUri] = useState(null)
  // Callers build a new session object on every render: the effect keys on
  // its primitives and reads the latest object (and its request) from here.
  const sessionRef = useRef(session)
  sessionRef.current = session
  const id = item ? item.id : undefined
  const cover = item ? item.cover : undefined
  const member = session ? session.member : undefined
  const origin = session ? session.origin : undefined

  useEffect(() => {
    setUri(null)
    if (!enabled || cover !== true || typeof member !== 'string' || typeof id !== 'string') return
    let live = true
    const s = sessionRef.current
    // Leaving drops a load that has not started, so a row scrolled or
    // searched away never spends one of the member's daily art uses.
    const ctl = new AbortController()
    cache.get(kind, id, { member, origin, request: s && s.request }, { signal: ctl.signal }).then((value) => {
      if (live) setUri(value)
    })
    return () => {
      live = false
      ctl.abort()
    }
  }, [kind, id, cover, member, origin, enabled])

  return uri
}
