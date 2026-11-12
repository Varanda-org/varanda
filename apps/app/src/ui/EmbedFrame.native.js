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
//     popups, forms or downloads. navDecision also guards the top frame, but
//     Android allows a load when the answer takes over 250 ms and never asks
//     about a POST, so the sandbox, not this callback, is the boundary.
//
// Props: html, baseUrl, allowTop(url) -> boolean, height, title (accessibility
// label); embedUrl is for the web frame, which loads it directly. Nothing the
// player asks for leaves the app: the only way out is the card's own
// "Abrir no ..." link, which opens the checked card URL on a real tap.

import { View } from 'react-native'
import { WebView } from 'react-native-webview'

const HTTPS = /^https:\/\//i

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

// Setting this makes the library cancel a popup's navigation instead of
// loading it into this WebView; nothing is handed out. On Android this holds
// only because multiple windows are on (the library default): a popup gets a
// detached WebView whose navigation the library cancels. Never set
// setSupportMultipleWindows to false, or the popup replaces the top frame.
function onOpenWindow () {}

// The library's default error view is English text; a failed player just
// stays an empty slot, and the caller's "Abrir no..." link still works.
const blank = () => <View />

export function EmbedFrame ({ html, baseUrl, allowTop, height, title }) {
  if (typeof html !== 'string' || typeof baseUrl !== 'string') return null

  const onShouldStartLoadWithRequest = (request) => navDecision(request, allowTop) === 'allow'

  return (
    <View style={{ height, width: '100%' }}>
      <WebView
        source={{ html, baseUrl }}
        // Every scheme reaches onShouldStartLoadWithRequest: anything outside
        // this list would be opened by the library through Linking on its own,
        // with no tap, so an intent:, market: or app deep link from the player
        // would leave the app. navDecision is the only gate.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onOpenWindow={onOpenWindow}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
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
        accessibilityLabel={title}
        style={{ height, backgroundColor: 'transparent' }}
      />
    </View>
  )
}

export default EmbedFrame
