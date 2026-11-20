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

// session: { member, origin, request }. large asks the 480 px cover. enabled
// 'cached' shows only a cover already in memory and starts no load. -> a
// data: URI, or null while it loads, on a failure and for an item without a
// cover.
export function useMusicCover (kind, item, session, enabled = true, large = false) {
  // The uri is kept with the inputs it was loaded for: the render after the
  // item, member or origin changes runs before the effect, and must not draw
  // the previous song's cover meanwhile.
  const [loaded, setLoaded] = useState(null)
  // Callers build a new session object on every render: the effect keys on
  // its primitives and reads the latest object (and its request) from here.
  const sessionRef = useRef(session)
  sessionRef.current = session
  const id = item ? item.id : undefined
  const cover = item ? item.cover : undefined
  const member = session ? session.member : undefined
  const origin = session ? session.origin : undefined
  const stamp = [kind, id, cover, member, origin, enabled, large]

  useEffect(() => {
    setLoaded(null)
    if (!enabled || enabled === 'cached' || cover !== true || typeof member !== 'string' || typeof id !== 'string') return
    let live = true
    const s = sessionRef.current
    // Leaving drops a load that has not started, so a row scrolled or
    // searched away never spends one of the member's daily art uses.
    const ctl = new AbortController()
    cache.get(kind, id, { member, origin, request: s && s.request, large }, { signal: ctl.signal }).then((value) => {
      if (live) setLoaded({ stamp, uri: value })
    })
    return () => {
      live = false
      ctl.abort()
    }
  }, [kind, id, cover, member, origin, enabled, large])

  // Read in render, so a cover already shown stays when the mode turns cached.
  if (enabled === 'cached') {
    return cover === true && typeof member === 'string' && typeof id === 'string' ? cache.peek(kind, id, { member, origin, large }) : null
  }
  return loaded !== null && loaded.stamp.every((v, i) => v === stamp[i]) ? loaded.uri : null
}
