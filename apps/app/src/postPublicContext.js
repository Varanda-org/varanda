// Whether the publish row ("Página pública na web") shows on the member's own
// posts, and how it opens the sheet. Post rows read it with usePostPublic().
// Off unless the node is hosted (only the browser node writes a post-share,
// docs/rpc.md 5.122) and the installation answers that public post pages are
// on (postPublicPolicy.js). Without a provider, the row stays hidden.

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { installationOrigin } from './installation'
import { postPublicEnabled } from './postPublicPolicy'

const OFF = Object.freeze({ enabled: false, open: null })

export const PostPublicContext = createContext(OFF)

// -> { enabled: boolean, open: ((ref) => void) | null }
export function usePostPublic () {
  return useContext(PostPublicContext)
}

// false until the policy answers true for `origin`, and again while a new
// origin or a change of `hosted` is being asked. postPublicEnabled keeps no
// answer from a timeout, a network error or a 5xx, so `awake` turning true
// again (back online, back in view) asks once more; a definite answer is
// cached and comes back at once.
export function usePostPublicEnabled (hosted, origin, awake = true) {
  const [answer, setAnswer] = useState({ hosted: null, origin: undefined, enabled: false })
  useEffect(() => {
    if (hosted !== true || awake !== true) return
    let live = true
    postPublicEnabled(origin).then((enabled) => {
      if (live) setAnswer({ hosted, origin, enabled: enabled === true })
    })
    return () => { live = false }
  }, [hosted, origin, awake])
  return hosted === true && answer.hosted === hosted && answer.origin === origin && answer.enabled
}

// `origin` defaults to the installation's (null on the hosted web app, which
// asks its own origin). `open(ref)` receives the post's colon ref. `online`
// and `visible` are the node's (node.js); only false counts as asleep.
export function PostPublicProvider ({ hosted, origin, online, visible, open, children }) {
  const where = origin === undefined ? installationOrigin() : origin
  const enabled = usePostPublicEnabled(hosted, where, online !== false && visible !== false)
  const value = useMemo(() => (enabled && typeof open === 'function' ? { enabled: true, open } : OFF), [enabled, open])
  return <PostPublicContext.Provider value={value}>{children}</PostPublicContext.Provider>
}
