'use strict'

// EmbedFrame: the third-party player frame. The native WebView cannot load
// under Node, so its source is read as text, and its navigation rule is
// lifted out of the source and run on its own.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const UI = path.join(__dirname, '../src/ui')
const NATIVE = path.join(UI, 'EmbedFrame.native.js')
const WEB = path.join(UI, 'EmbedFrame.web.js')

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line. Regex literals are not, so code is run from the raw text.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

const nativeRaw = fs.readFileSync(NATIVE, 'utf8')
const nativeSrc = withoutComments(nativeRaw)
const webSrc = withoutComments(fs.readFileSync(WEB, 'utf8'))

function navDecision () {
  const https = nativeRaw.match(/^const HTTPS = .*$/m)
  const start = nativeRaw.indexOf('export function navDecision')
  const end = nativeRaw.indexOf('\n}\n', start)
  if (!https || start === -1 || end === -1) throw new Error('navDecision not found in EmbedFrame.native.js')
  const fn = nativeRaw.slice(start, end + 2).replace('export ', '')
  return new Function(https[0] + '\n' + fn + '\nreturn navDecision')() // eslint-disable-line no-new-func
}

test('native: the page gets no bridge into the app', (t) => {
  t.absent(/\bonMessage\b/.test(nativeSrc), 'no onMessage')
  t.absent(/injectedJavaScript/.test(nativeSrc), 'no injectedJavaScript')
  t.absent(/injectJavaScript/.test(nativeSrc), 'no injectJavaScript')
  const imports = nativeSrc.match(/^import .*$/gm)
  t.alike(imports.filter((l) => /musicEmbed/.test(l)), [], 'nothing from musicEmbed')
})

test('native: the WebView is locked down', (t) => {
  for (const prop of [
    /\n\s+incognito\n/,
    /sharedCookiesEnabled=\{false\}/,
    /thirdPartyCookiesEnabled=\{false\}/,
    /allowFileAccess=\{false\}/,
    /allowsLinkPreview=\{false\}/,
    /geolocationEnabled=\{false\}/,
    /mediaCapturePermissionGrantType='deny'/,
    /javaScriptCanOpenWindowsAutomatically=\{false\}/,
    /source=\{\{ html, baseUrl \}\}/,
    /onShouldStartLoadWithRequest=\{onShouldStartLoadWithRequest\}/,
    /onOpenWindow=\{onOpenWindow\}/,
    /accessibilityLabel=\{title\}/,
    /onStartShouldSetResponder=\{\(\) => true\}/
  ]) t.ok(prop.test(nativeSrc), String(prop))
  t.absent(/onResponderGrant/.test(nativeSrc), 'no responder grant that would block native responders')
  t.absent(/allowFileAccess=\{true\}|allowUniversalAccessFromFileURLs|allowFileAccessFromFileURLs/.test(nativeSrc), 'no file access')
  t.ok(/originWhitelist=\{\['\*'\]\}/.test(nativeSrc), 'every scheme reaches the handler, none is opened by the library')
  t.absent(/setSupportMultipleWindows=/.test(nativeRaw), 'multiple windows stay on, so an Android popup never replaces the top frame')
})

test('native: a subframe loads only https (or about:blank)', (t) => {
  const decide = navDecision()
  const never = () => { throw new Error('allowTop is not asked about a subframe') }
  t.is(decide({ url: 'https://www.youtube-nocookie.com/embed/x', isTopFrame: false }, never), 'allow')
  t.is(decide({ url: 'about:blank', isTopFrame: false }, never), 'allow')
  for (const url of ['http://example.com/', 'intent://x#Intent;end', 'varanda://x', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/hosts', '']) {
    t.is(decide({ url, isTopFrame: false }, never), 'refuse', url || '(empty)')
  }
})

test('native: the top frame holds only what allowTop accepts (isTopFrame rule)', (t) => {
  const decide = navDecision()
  const allowTop = (url) => url === 'https://app.varanda/' || url === 'about:blank'
  t.is(decide({ url: 'https://app.varanda/', isTopFrame: true }, allowTop), 'allow')
  t.is(decide({ url: 'about:blank', isTopFrame: true }, allowTop), 'allow')
  t.is(decide({ url: 'https://open.spotify.com/track/x', isTopFrame: true }, allowTop), 'refuse', 'other https is refused, not handed to the browser')
  for (const url of ['http://example.com/', 'intent://x#Intent;end', 'varanda://x', 'javascript:alert(1)', 'file:///etc/hosts']) {
    t.is(decide({ url, isTopFrame: true }, allowTop), 'refuse', url + ' refused silently')
  }
})

test('native: without isTopFrame (Android) the event is a top-frame request: only allowTop loads, nothing is handed out', (t) => {
  const decide = navDecision()
  const allowTop = (url) => url === 'https://app.varanda/'
  const origin = 'https://open.spotify.com'
  // The origin is still offered as a third argument: it must widen nothing.
  t.is(decide({ url: 'https://app.varanda/' }, allowTop, origin), 'allow', 'the top document')
  for (const url of [
    origin,
    origin + '/',
    origin + '/embed/track/x',
    origin + '?x',
    origin + '#x',
    'about:blank',
    'https://open.spotify.com.evil.example/x',
    'https://open.spotify.com@evil.example/x',
    'https://www.youtube-nocookie.com/embed/x',
    'https://example.com/',
    'http://open.spotify.com/x',
    'intent://x#Intent;end',
    'javascript:alert(1)',
    ''
  ]) t.is(decide({ url }, allowTop, origin), 'refuse', (url || '(empty)') + ' refused silently, never external')
  t.is(decide({ url: 'https://open.spotify.com/x', isTopFrame: 'false' }, allowTop, origin), 'refuse', 'a non-boolean flag counts as missing')
  t.is(decide({ url: 'https://app.varanda/', isTopFrame: 'false' }, allowTop, origin), 'allow', 'and still loads the top document')
  t.is(decide(null, allowTop, origin), 'refuse')
})

test('native: navDecision takes no frame origin', (t) => {
  t.absent(/frameOrigin|embedFrameOrigin/.test(nativeSrc), 'no frame origin in the native frame')
  t.ok(/navDecision\(request, allowTop\) === 'allow'/.test(nativeSrc), 'the handler passes only the request and allowTop')
  t.ok(/export function navDecision \(request, allowTop\) \{/.test(nativeSrc), 'two parameters')
})

test('native: allowTop fails closed', (t) => {
  const decide = navDecision()
  t.is(decide({ url: 'https://app.varanda/', isTopFrame: true }, () => { throw new Error('x') }), 'refuse')
  t.is(decide({ url: 'https://app.varanda/', isTopFrame: true }, () => 'yes'), 'refuse', 'only true allows')
  t.is(decide({ url: 'https://app.varanda/', isTopFrame: true }, undefined), 'refuse')
})

test('native: navDecision never hands a navigation to the system browser', (t) => {
  const decide = navDecision()
  const origin = 'https://open.spotify.com'
  const urls = [
    'https://evil.example/',
    'https://open.spotify.com/track/x',
    origin,
    origin + '/embed/track/x',
    origin + '?x',
    'https://app.varanda/',
    'http://example.com/',
    'intent://x#Intent;scheme=https;end',
    'javascript:alert(1)',
    'data:text/html,x',
    'about:blank',
    ''
  ]
  const allowTops = [() => false, () => { throw new Error('x') }, () => 'yes', undefined]
  for (const url of urls) {
    for (const isTopFrame of [true, false, undefined, 'true']) {
      for (const allowTop of allowTops) {
        const request = isTopFrame === undefined ? { url } : { url, isTopFrame }
        const decision = decide(request, allowTop, origin)
        if (decision !== 'allow' && decision !== 'refuse') t.fail((url || '(empty)') + ' isTopFrame=' + JSON.stringify(isTopFrame) + ': ' + decision)
        if (isTopFrame !== false && decision !== 'refuse') t.fail((url || '(empty)') + ' isTopFrame=' + JSON.stringify(isTopFrame) + ' loaded without allowTop')
      }
    }
  }
  for (const request of [null, undefined, {}, { url: 42, isTopFrame: true }]) {
    t.is(decide(request, () => false), 'refuse', JSON.stringify(request) || 'undefined')
  }
  t.pass('every answer was allow or refuse')
})

function popupTarget () {
  const start = nativeRaw.indexOf('export function popupTarget')
  const end = nativeRaw.indexOf('\n}\n', start)
  if (start === -1 || end === -1) throw new Error('popupTarget not found in EmbedFrame.native.js')
  const fn = nativeRaw.slice(start, end + 2).replace('export ', '')
  return new Function(fn + '\nreturn popupTarget')() // eslint-disable-line no-new-func
}

test('native: a popup is cancelled and only its address is reported', (t) => {
  const target = popupTarget()
  t.is(target({ nativeEvent: { targetUrl: 'https://open.spotify.com/track/x' } }), 'https://open.spotify.com/track/x', 'a string targetUrl')
  t.is(target(undefined), '', 'no event')
  t.is(target(null), '', 'null event')
  t.is(target({}), '', 'no nativeEvent')
  t.is(target({ nativeEvent: null }), '', 'null nativeEvent')
  t.is(target({ nativeEvent: {} }), '', 'no targetUrl')
  for (const targetUrl of [42, null, { toString: () => 'https://x' }, ['https://x']]) {
    t.is(target({ nativeEvent: { targetUrl } }), '', 'non-string targetUrl ' + JSON.stringify(targetUrl))
  }
  const hostile = { get nativeEvent () { throw new Error('x') } }
  t.is(target(hostile), '', 'a throwing getter gives nothing')

  t.ok(/onOpenWindow=\{onOpenWindow\}/.test(nativeSrc), 'the handler is always passed')
  const start = nativeSrc.indexOf('const onOpenWindow = (event) => {')
  t.ok(start !== -1, 'the handler is defined in the component')
  const body = nativeSrc.slice(start, nativeSrc.indexOf('\n  }\n', start))
  const calls = (body.match(/\b[A-Za-z_$][\w$]*(?=\s*\()/g) || []).filter((name) => !['if', 'popupTarget'].includes(name))
  t.alike([...new Set(calls)], ['onOpen'], 'the handler calls only onOpen')
  t.absent(/\bLinking\b/.test(nativeSrc), 'no Linking')
  t.absent(/\bhandOff\b/.test(nativeSrc), 'no handOff')
  t.absent(/onOpenExternal/.test(nativeSrc), 'no onOpenExternal')
  t.absent(/openURL|openExternal/.test(nativeSrc), 'no way to open a URL outside')
  t.absent(/'external'/.test(nativeSrc), 'no external decision')
})

test('web: the iframe sandbox and referrer policy', (t) => {
  t.ok(webSrc.includes('sandbox: EMBED_SANDBOX'), 'the shared sandbox')
  t.ok(webSrc.includes("import { EMBED_SANDBOX } from '../musicEmbed.js'"), 'from musicEmbed')
  t.absent(/allow-/.test(webSrc), 'no sandbox token of its own')
  t.ok(webSrc.includes("referrerPolicy: 'strict-origin-when-cross-origin'"), 'referrerPolicy')
  t.absent(/react-native-webview/.test(webSrc), 'no webview import')
})

test('web: renders the iframe with the embed URL and nothing from the native props', async (t) => {
  const { EmbedFrame } = await import('../src/ui/EmbedFrame.web.js')
  const { EMBED_SANDBOX } = await import('../src/musicEmbed.js')
  const el = EmbedFrame({
    embedUrl: 'https://w.soundcloud.com/player/?url=x',
    html: '<script>bad()</script>',
    baseUrl: 'https://app.varanda',
    allowTop: () => true,
    height: 166,
    title: 'Player do SoundCloud'
  })
  t.is(el.type, 'iframe')
  t.is(el.props.src, 'https://w.soundcloud.com/player/?url=x')
  t.is(el.props.height, 166)
  t.is(el.props.title, 'Player do SoundCloud')
  t.is(el.props.allowFullScreen, true)
  t.is(el.props.referrerPolicy, 'strict-origin-when-cross-origin')
  t.is(el.props.sandbox, EMBED_SANDBOX)
  for (const token of el.props.sandbox.split(' ')) {
    t.absent(/^allow-(top-navigation|forms|downloads|modals|popups-to-escape-sandbox)/.test(token), 'no ' + token)
  }
  t.ok(el.props.sandbox.split(' ').includes('allow-popups'), 'a link in the player opens a sandboxed tab')
  t.ok(el.props.sandbox.includes('allow-scripts'), 'the player still runs')
  t.alike(Object.keys(el.props).sort(), ['allow', 'allowFullScreen', 'height', 'referrerPolicy', 'sandbox', 'src', 'style', 'title', 'width'])
  t.is(EmbedFrame({ embedUrl: 'http://w.soundcloud.com/player/', height: 166, title: 'x' }), null, 'http is not framed')
  t.is(EmbedFrame({ embedUrl: 'javascript:alert(1)', height: 166, title: 'x' }), null, 'javascript: is not framed')
})

test('embedFrame: playback needs a touch inside the player', async (t) => {
  t.ok(/\bmediaPlaybackRequiresUserAction\b/.test(nativeSrc), 'native sets mediaPlaybackRequiresUserAction')
  t.absent(/mediaPlaybackRequiresUserAction=\{false\}/.test(nativeSrc), 'native never turns it off')
  t.ok(/\n\s+mediaPlaybackRequiresUserAction\n/.test(nativeSrc), 'native sets the bare prop')
  const allow = (/allow: '([^']*)'/.exec(webSrc) || [])[1]
  t.is(allow, 'clipboard-write; encrypted-media; fullscreen; picture-in-picture', 'web allow list')
  t.absent(/autoplay/i.test(webSrc), 'web names no autoplay')
  const { embedOf, embedHtml } = await import('../src/musicEmbed.js')
  const html = embedHtml(embedOf('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'))
  t.ok(html.includes('<iframe'), 'Spotify track framed')
  t.absent(/autoplay/i.test(html), 'native wrapper names no autoplay')
})

test('react-native-webview is pinned exactly to 13.16.0', (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  t.is(pkg.dependencies['react-native-webview'], '13.16.0')
})

// A pure top-level function of EmbedFrame.native.js, run on its own.
function lift (name) {
  const start = nativeRaw.indexOf('export function ' + name + ' (')
  const end = nativeRaw.indexOf('\n}\n', start)
  if (start === -1 || end === -1) throw new Error(name + ' not found in EmbedFrame.native.js')
  const fn = nativeRaw.slice(start, end + 2).replace('export ', '')
  return new Function(fn + '\nreturn ' + name)() // eslint-disable-line no-new-func
}

test('native: one handler reports a dead content process on both platforms', (t) => {
  const ios = /onContentProcessDidTerminate=\{([A-Za-z_$][\w$]*)\}/.exec(nativeSrc)
  const android = /onRenderProcessGone=\{([A-Za-z_$][\w$]*)\}/.exec(nativeSrc)
  t.ok(ios, 'onContentProcessDidTerminate is passed a named handler')
  t.ok(android, 'onRenderProcessGone is passed a named handler')
  t.is(ios && ios[1], android && android[1], 'the same handler')
  t.ok(/const onProcessGone = \(\) => \{ goneOnce\(gone, onGone\) \}/.test(nativeSrc), 'the handler only runs the guard and returns nothing')
  t.ok(/const gone = useRef\(false\)/.test(nativeSrc), 'the guard is a ref, one per mounted frame')
  t.absent(/Platform\.OS/.test(nativeSrc), 'no Platform.OS')
})

test('native: goneOnce calls onGone once and never throws', (t) => {
  const goneOnce = lift('goneOnce')
  let calls = 0
  let argCount = -1
  const fired = { current: false }
  goneOnce(fired, function () {
    calls++
    argCount = arguments.length
  })
  goneOnce(fired, () => { calls++ })
  t.is(calls, 1, 'two deaths, one call')
  t.is(argCount, 0, 'onGone is called with zero arguments')

  const other = { current: false }
  goneOnce(other, () => { calls++ })
  t.is(calls, 2, 'another frame has its own guard')

  for (const onGone of [undefined, null, 'x', 42, {}]) {
    t.execution(() => goneOnce({ current: false }, onGone), 'no onGone: ' + JSON.stringify(onGone))
  }
  const late = { current: false }
  goneOnce(late, undefined)
  goneOnce(late, () => { calls++ })
  t.is(calls, 3, 'an event with no onGone does not use up the one call')

  const throwing = { current: false }
  t.execution(() => goneOnce(throwing, () => { throw new Error('x') }), 'a throwing onGone is caught')
  t.execution(() => goneOnce(throwing, () => { throw new Error('x') }), 'and stays caught')
  t.is(throwing.current, true)
  t.execution(() => goneOnce(null, () => { calls++ }), 'no ref')
  t.is(calls, 3, 'no ref, no call')
})

test('native: only a parked frame is hidden from accessibility', (t) => {
  const parkedA11y = lift('parkedA11y')
  t.alike(parkedA11y(true), { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' })
  for (const parked of [false, undefined, null, 'true', 1]) {
    t.alike(parkedA11y(parked), {}, 'not parked: ' + JSON.stringify(parked))
  }
  t.ok(/<View style=\{\{ height, width: '100%' \}\} \{\.\.\.parkedA11y\(parked\)\}>/.test(nativeSrc), 'the wrapper View takes them, with no visual change')
})

test('web: a parked frame stays loaded but hidden', async (t) => {
  const { EmbedFrame } = await import('../src/ui/EmbedFrame.web.js')
  const props = { embedUrl: 'https://w.soundcloud.com/player/?url=x', height: 166, title: 'Player do SoundCloud' }
  const shown = EmbedFrame(props)
  const parked = EmbedFrame({ ...props, parked: true, onGone: () => {} })
  t.is(parked.props.style.visibility, 'hidden')
  t.is(parked.props.style.display, 'block', 'not display none')
  t.is(parked.props.src, shown.props.src, 'same src')
  t.absent('visibility' in shown.props.style, 'no visibility key when not parked')
  t.absent('visibility' in EmbedFrame({ ...props, parked: false }).props.style, 'nor when parked is false')
  t.alike(Object.keys(parked.props).sort(), Object.keys(shown.props).sort(), 'no new iframe prop')
  t.alike(Object.keys(parked.props).sort(), ['allow', 'allowFullScreen', 'height', 'referrerPolicy', 'sandbox', 'src', 'style', 'title', 'width'])
})
