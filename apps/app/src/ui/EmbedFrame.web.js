// A third-party player in the browser: the provider's own embed URL in a
// sandboxed iframe, with the same sandbox as the native wrapper. It keeps
// scripts and the provider's own origin (players need both) but grants no
// popups: a popup that escapes the sandbox has the frame as opener and can
// move this tab through opener.top (the site sends no
// Cross-Origin-Opener-Policy). The card's own "Abrir no ..." link is the way
// out to the provider. The page itself sends Referrer-Policy: no-referrer,
// and the video player refuses to play without a Referer, so this frame
// alone sends the origin.
//
// Props: embedUrl, height, title. html, baseUrl and allowTop belong to the
// native WebView and are ignored here.

import { createElement } from 'react'
import { EMBED_SANDBOX } from '../musicEmbed.js'

const HTTPS = /^https:\/\//i

export function EmbedFrame ({ embedUrl, height, title }) {
  if (typeof embedUrl !== 'string' || !HTTPS.test(embedUrl)) return null
  return createElement('iframe', {
    src: embedUrl,
    title,
    width: '100%',
    height,
    style: { border: 0, display: 'block' },
    allow: 'clipboard-write; encrypted-media; fullscreen; picture-in-picture',
    allowFullScreen: true,
    referrerPolicy: 'strict-origin-when-cross-origin',
    sandbox: EMBED_SANDBOX
  })
}

export default EmbedFrame
