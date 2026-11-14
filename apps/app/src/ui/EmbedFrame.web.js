// A third-party player in the browser: the provider's own embed URL in a
// sandboxed iframe, with the same sandbox as the native wrapper. It keeps
// scripts and the provider's own origin (players need both). A link in the
// player opens a new tab that keeps the sandbox, so it cannot move this tab
// through opener.top; the escape token stays out because the site sends no
// Cross-Origin-Opener-Policy, and an escaped tab could. The app cannot see or
// filter that tab's address: the browser alone decides where it goes. The
// page itself sends Referrer-Policy: no-referrer, and the video player
// refuses to play without a Referer, so this frame alone sends the origin.
//
// Props: embedUrl, height, title, parked. html, baseUrl, allowTop and onOpen
// belong to the native WebView and are ignored here, and so is onGone: an
// iframe raises no event when its document's process dies. A parked frame is
// hidden with visibility rather than display or a new src, so its document
// stays loaded (and keeps playing) while it leaves the Tab order and the
// accessibility tree.
//
// onReady() (optional) is called once, SETTLE_MS after the iframe first
// reports a load: the provider page has loaded, which is not a proof that
// the provider drew its player. onEngage(true) (optional) is called once
// when focus moves into this iframe, the only sign a cross-origin frame gives
// of a click inside it: a window blur, or a FOCUS_POLL_MS check for the
// focus that came without one. The component adds only ref and onLoad to
// frameProps, so the iframe itself is as before.

import { createElement, useEffect, useRef } from 'react'
import { EMBED_SANDBOX } from '../musicEmbed.js'

const HTTPS = /^https:\/\//i
const SETTLE_MS = 500
const FOCUS_POLL_MS = 500

// The iframe's props, or null for an address that is not framed.
export function frameProps ({ embedUrl, height, title, parked }) {
  if (typeof embedUrl !== 'string' || !HTTPS.test(embedUrl)) return null
  return {
    src: embedUrl,
    title,
    width: '100%',
    height,
    style: parked === true ? { border: 0, display: 'block', visibility: 'hidden' } : { border: 0, display: 'block' },
    allow: 'clipboard-write; encrypted-media; fullscreen; picture-in-picture',
    allowFullScreen: true,
    referrerPolicy: 'strict-origin-when-cross-origin',
    sandbox: EMBED_SANDBOX
  }
}

// The caller must hear of a ready frame only once, and a throwing caller must
// not reach React's event dispatch.
function callOnce (fired, fn, ...args) {
  if (typeof fn !== 'function' || !fired || fired.current === true) return
  fired.current = true
  try { fn(...args) } catch {}
}

// Starts the one settle timer after a load of the iframe; later loads (the
// player moving to another page of its own) neither restart it nor call
// onReady again.
export function settleReady (timer, fired, onReady) {
  if (!timer || timer.current != null || !fired || fired.current === true || typeof onReady !== 'function') return
  timer.current = setTimeout(() => {
    timer.current = null
    callOnce(fired, onReady)
  }, SETTLE_MS)
}

export function EmbedFrame ({ embedUrl, height, title, parked, onReady, onEngage }) {
  const frame = useRef(null)
  const ready = useRef(false)
  const settle = useRef(null)
  const engaged = useRef(false)
  const engage = useRef(onEngage)
  engage.current = onEngage
  const listens = typeof onEngage === 'function'
  useEffect(() => () => clearTimeout(settle.current), [])
  useEffect(() => {
    if (!listens || engaged.current || typeof document === 'undefined' || typeof window === 'undefined') return
    let poll = null
    const stop = () => {
      window.removeEventListener('blur', check)
      clearInterval(poll)
    }
    const check = () => {
      if (frame.current === null || document.activeElement !== frame.current) return
      stop()
      callOnce(engaged, engage.current, true)
    }
    window.addEventListener('blur', check)
    poll = setInterval(check, FOCUS_POLL_MS)
    return stop
  }, [listens])

  const props = frameProps({ embedUrl, height, title, parked })
  if (props === null) return null
  const onLoad = () => { settleReady(settle, ready, onReady) }
  return createElement('iframe', { ...props, ref: frame, onLoad })
}

export default EmbedFrame
