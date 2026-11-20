// A third-party player (YouTube, Spotify, SoundCloud...) inside the app,
// drawn from the static html the caller builds around the provider's iframe.
// The player is untrusted page content, so the frame keeps it away from the
// app and from the person's data:
//   - incognito with no shared or third-party cookies: on Android, mounting
//     removes earlier cookies and turns the cache off, but localStorage and
//     IndexedDB stay (domStorageEnabled is on because the players need it);
//     on iOS the frame uses a data store that is never written to disk;
//   - no onMessage and no injected script: the page has no bridge into the
//     app, so it cannot call anything here;
//   - no file access, geolocation, camera or microphone, no link previews;
//   - the provider frame is sandboxed (embedHtml) with no top navigation,
//     forms or downloads. navDecision also guards the top frame, but
//     Android allows a load when the answer takes over 250 ms and never asks
//     about a POST, so the sandbox, not this callback, is the boundary;
//   - a popup (a link in the player) is cancelled by the library and only its
//     address is reported to onOpen. This frame opens nothing itself: the
//     report carries no sign of a tap, so the caller's allowlist decides
//     whether that address may leave the app.
//
// Props: html, baseUrl, allowTop(url) -> boolean, height, title (accessibility
// label), onOpen(url) (optional); embedUrl is for the web frame, which loads
// it directly. onGone() (optional) is called once when the system kills the
// page's content process: the frame is then blank or frozen and never
// recovers on its own, so the caller drops it and can load the player again.
// parked (optional) keeps a loaded frame whose list row is gone out of the
// screen reader: it stays loaded, so playback goes on, but nothing reads or
// focuses a player the person cannot see.
// onReady() (optional) is called once, SETTLE_MS after the wrapper document
// first reports a load: the provider page has loaded, which is not a proof
// that the provider drew its player. The load event is a navigation callback
// of the wrapper document, read with no argument, so it is no bridge either.
// onEngage(boolean) (optional) follows touches on the wrapper View, which
// listens without claiming the responder: true when a touch starts, false
// when the list takes it over as a drag before any touch on this frame
// ended (touchStep).

import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { WebView } from 'react-native-webview'

const HTTPS = /^https:\/\//i
const SETTLE_MS = 500

// What happens to one navigation the WebView asks about: 'allow' or 'refuse',
// never a hand-off to the system browser. With the sandbox nothing in the
// player can move the top frame, so such a request means the sandbox failed
// and must not send the reader to a page (or, through a universal link, an
// app) the player chose, and iOS gives no sign of a user gesture. about:blank
// is allowed in a subframe: it loads nothing, and a player may create an
// empty helper frame. Android's callback carries no isTopFrame and is never
// raised for an http(s) subframe load, so such an event is treated as top
// frame: a provider page there would run unsandboxed, with the app's
// microphone grant.
export function navDecision (request, allowTop) {
  const url = request && typeof request.url === 'string' ? request.url : ''
  const isTopFrame = request ? request.isTopFrame : true
  if (isTopFrame === false) return HTTPS.test(url) || url === 'about:blank' ? 'allow' : 'refuse'
  let allowed = false
  try { allowed = typeof allowTop === 'function' && allowTop(url) === true } catch {}
  return allowed ? 'allow' : 'refuse'
}

// The address a popup event reports, or ''. The event comes from the player
// page, so nothing about its shape is trusted.
export function popupTarget (event) {
  try {
    const url = event && event.nativeEvent ? event.nativeEvent.targetUrl : undefined
    return typeof url === 'string' ? url : ''
  } catch {
    return ''
  }
}

// The caller must drop the frame only once, and a second event can arrive
// before the frame unmounts; a throwing caller must not reach the library's
// event dispatch.
export function goneOnce (fired, onGone) {
  if (typeof onGone !== 'function' || !fired || fired.current === true) return
  fired.current = true
  try { onGone() } catch {}
}

// Starts the one settle timer after a load of the wrapper document; later
// loads (a reload, a second report) neither restart it nor call onReady again.
export function settleReady (timer, fired, onReady) {
  if (!timer || timer.current != null || !fired || fired.current === true || typeof onReady !== 'function') return
  timer.current = setTimeout(() => {
    timer.current = null
    goneOnce(fired, onReady)
  }, SETTLE_MS)
}

// One touch event on the wrapper: kind is 'start', 'end' or 'cancel', and
// engage is what to tell onEngage (null: nothing). A touch that ended inside
// the frame was the person's, for good; a cancel means the list took the
// touch as a scroll, which takes back the start only while no touch on this
// frame has ever ended.
export function touchStep (state, kind) {
  const ended = state !== null && typeof state === 'object' && state.ended === true
  if (kind === 'start') return { state: { ended }, engage: true }
  if (kind === 'end') return { state: { ended: true }, engage: null }
  if (kind === 'cancel') return { state: { ended }, engage: ended ? null : false }
  return { state, engage: null }
}

// Props for the wrapper of a parked frame: iOS reads accessibilityElementsHidden,
// Android importantForAccessibility, and each ignores the other. Nothing at
// all for a frame in view, so today's callers render as before.
export function parkedA11y (parked) {
  return parked === true
    ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' }
    : {}
}

// The library's default error view is English text; a failed player just
// stays an empty slot.
const blank = () => <View />

export function EmbedFrame ({ html, baseUrl, allowTop, height, title, onOpen, onGone, parked, onReady, onEngage }) {
  const gone = useRef(false)
  const ready = useRef(false)
  const settle = useRef(null)
  const touch = useRef({ ended: false })
  useEffect(() => () => clearTimeout(settle.current), [])
  if (typeof html !== 'string' || typeof baseUrl !== 'string') return null

  const onShouldStartLoadWithRequest = (request) => navDecision(request, allowTop) === 'allow'

  // Passed even without onOpen: having a handler is what makes the library
  // cancel a popup instead of loading it here. On iOS, with no handler, the
  // popup request loads into this WebView; with one, a navigation with no
  // target frame is cancelled and only reported. On Android the handler gives
  // the popup a detached WebView, built with default settings rather than
  // this frame's props, that cancels each navigation it is asked about and
  // reports every address it is sent to, not just the first; each report
  // still goes through the caller's allowlist. This holds only while multiple
  // windows stay on (the library default): turning them off would let the
  // popup replace the top frame.
  const onOpenWindow = (event) => {
    const url = popupTarget(event)
    if (url === '' || typeof onOpen !== 'function') return
    try { onOpen(url) } catch {}
  }

  // Returns nothing on purpose: on Android the library itself answers true to
  // the system, which is what keeps a dead renderer from taking the app down.
  const onProcessGone = () => { goneOnce(gone, onGone) }

  const onLoad = () => { settleReady(settle, ready, onReady) }

  // A throwing caller must not reach the library's event dispatch.
  const touched = (kind) => {
    const step = touchStep(touch.current, kind)
    touch.current = step.state
    if (step.engage === null || typeof onEngage !== 'function') return
    try { onEngage(step.engage) } catch {}
  }
  const onTouchStart = () => { touched('start') }
  const onTouchEnd = () => { touched('end') }
  const onTouchCancel = () => { touched('cancel') }

  return (
    // Plain touch listeners, never a responder claim: the list and the player
    // keep every touch they would get without them.
    <View
      style={{ height, width: '100%' }}
      {...parkedA11y(parked)}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <WebView
        source={{ html, baseUrl }}
        // Every scheme reaches onShouldStartLoadWithRequest: anything outside
        // this list would be opened by the library through Linking on its own,
        // with no tap, so an intent:, market: or app deep link from the player
        // would leave the app. navDecision is the only gate.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onOpenWindow={onOpenWindow}
        // iOS reports the first, Android the second; each platform ignores the other.
        onContentProcessDidTerminate={onProcessGone}
        onRenderProcessGone={onProcessGone}
        onLoad={onLoad}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        // The frame loads without a tap, so only a touch inside the player may start media.
        mediaPlaybackRequiresUserAction
        allowsFullscreenVideo
        incognito
        sharedCookiesEnabled={false}
        // The provider frame is third party to the wrapper document, so with
        // this off it stores no cookie a later player frame would send.
        // Incognito's process-wide cookie wipe spares the app: its own fetches use credentials 'omit' (account.js).
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        allowsLinkPreview={false}
        geolocationEnabled={false}
        mediaCapturePermissionGrantType='deny'
        javaScriptCanOpenWindowsAutomatically={false}
        renderError={blank}
        // Keeps a touch in the player from pressing a quote or a chat bubble
        // around it. The Android host view is not a ReactViewGroup, so this
        // claim intercepts nothing and drags stay in the player.
        onStartShouldSetResponder={() => true}
        accessibilityLabel={title}
        style={{ height, backgroundColor: 'transparent' }}
      />
    </View>
  )
}

export default EmbedFrame
