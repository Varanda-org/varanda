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

import { createElement } from 'react'
import { EMBED_SANDBOX } from '../musicEmbed.js'

const HTTPS = /^https:\/\//i

export function EmbedFrame ({ embedUrl, height, title, parked }) {
  if (typeof embedUrl !== 'string' || !HTTPS.test(embedUrl)) return null
  return createElement('iframe', {
    src: embedUrl,
    title,
    width: '100%',
    height,
    style: parked === true ? { border: 0, display: 'block', visibility: 'hidden' } : { border: 0, display: 'block' },
    allow: 'clipboard-write; encrypted-media; fullscreen; picture-in-picture',
    allowFullScreen: true,
    referrerPolicy: 'strict-origin-when-cross-origin',
    sandbox: EMBED_SANDBOX
  })
}

export default EmbedFrame
