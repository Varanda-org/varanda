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
  const { frameProps } = await import('../src/ui/EmbedFrame.web.js')
  const { EMBED_SANDBOX } = await import('../src/musicEmbed.js')
  const props = frameProps({
    embedUrl: 'https://w.soundcloud.com/player/?url=x',
    html: '<script>bad()</script>',
    baseUrl: 'https://app.varanda',
    allowTop: () => true,
    height: 166,
    title: 'Player do SoundCloud'
  })
  t.ok(/return createElement\('iframe', \{ \.\.\.props, ref: frame, onLoad \}\)/.test(webSrc), 'the component draws an iframe from frameProps')
  t.is(props.src, 'https://w.soundcloud.com/player/?url=x')
  t.is(props.height, 166)
  t.is(props.title, 'Player do SoundCloud')
  t.is(props.allowFullScreen, true)
  t.is(props.referrerPolicy, 'strict-origin-when-cross-origin')
  t.is(props.sandbox, EMBED_SANDBOX)
  for (const token of props.sandbox.split(' ')) {
    t.absent(/^allow-(top-navigation|forms|downloads|modals|popups-to-escape-sandbox)/.test(token), 'no ' + token)
  }
  t.ok(props.sandbox.split(' ').includes('allow-popups'), 'a link in the player opens a sandboxed tab')
  t.ok(props.sandbox.includes('allow-scripts'), 'the player still runs')
  t.alike(Object.keys(props).sort(), ['allow', 'allowFullScreen', 'height', 'referrerPolicy', 'sandbox', 'src', 'style', 'title', 'width'])
  t.is(frameProps({ embedUrl: 'http://w.soundcloud.com/player/', height: 166, title: 'x' }), null, 'http is not framed')
  t.is(frameProps({ embedUrl: 'javascript:alert(1)', height: 166, title: 'x' }), null, 'javascript: is not framed')
})

test('web: the component adds only ref and onLoad to frameProps', (t) => {
  const draws = webSrc.match(/createElement\([^)]*\)/g) || []
  t.alike(draws, ["createElement('iframe', { ...props, ref: frame, onLoad })"], 'one iframe, frameProps plus ref and onLoad')
  t.ok(/const props = frameProps\(\{ embedUrl, height, title, parked \}\)\n\s+if \(props === null\) return null/.test(webSrc), 'no iframe for an address frameProps refuses')
  t.absent(/\bsrcDoc\b|\bsrcdoc\b/.test(webSrc), 'no srcdoc')
  t.absent(/postMessage|addEventListener\('message'/.test(webSrc), 'no message channel with the player')
  t.ok(/window\.removeEventListener\('blur', check\)/.test(webSrc) && /clearInterval\(poll\)/.test(webSrc), 'the focus watch stops')
  t.ok(/useEffect\(\(\) => \(\) => clearTimeout\(settle\.current\), \[\]\)/.test(webSrc), 'the settle timer is cleared on unmount')
  t.absent(/Platform\.OS/.test(webSrc), 'no Platform.OS')
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
  t.ok(/<View\n\s+style=\{\{ height, width: '100%' \}\}\n\s+\{\.\.\.parkedA11y\(parked\)\}\n\s+onTouchStart=\{onTouchStart\}\n\s+onTouchEnd=\{onTouchEnd\}\n\s+onTouchCancel=\{onTouchCancel\}\n\s+>/.test(nativeSrc), 'the wrapper View takes them, with no visual change')
})

test('web: a parked frame stays loaded but hidden', async (t) => {
  const { frameProps } = await import('../src/ui/EmbedFrame.web.js')
  const props = { embedUrl: 'https://w.soundcloud.com/player/?url=x', height: 166, title: 'Player do SoundCloud' }
  const shown = frameProps(props)
  const parked = frameProps({ ...props, parked: true, onGone: () => {} })
  t.is(parked.style.visibility, 'hidden')
  t.is(parked.style.display, 'block', 'not display none')
  t.is(parked.src, shown.src, 'same src')
  t.absent('visibility' in shown.style, 'no visibility key when not parked')
  t.absent('visibility' in frameProps({ ...props, parked: false }).style, 'nor when parked is false')
  t.alike(Object.keys(parked).sort(), Object.keys(shown).sort(), 'no new iframe prop')
  t.alike(Object.keys(parked).sort(), ['allow', 'allowFullScreen', 'height', 'referrerPolicy', 'sandbox', 'src', 'style', 'title', 'width'])
})

test('native: touchStep follows one frame\'s touches', (t) => {
  const touchStep = lift('touchStep')
  const fresh = { ended: false }

  const started = touchStep(fresh, 'start')
  t.is(started.engage, true, 'a touch start engages')
  const ended = touchStep(started.state, 'end')
  t.is(ended.engage, null, 'the end reports nothing new')
  t.alike(ended.state, { ended: true }, 'and is kept for good')
  t.alike(touchStep(ended.state, 'start').state, { ended: true }, 'a later start keeps it')

  const dragged = touchStep(touchStep(fresh, 'start').state, 'cancel')
  t.is(dragged.engage, false, 'the list took the drag before any touch ended: not engaged')
  t.alike(dragged.state, { ended: false })

  const later = touchStep(touchStep(ended.state, 'start').state, 'cancel')
  t.is(later.engage, null, 'a drag after an earlier tap takes nothing back')
  t.alike(later.state, { ended: true })

  for (const kind of [undefined, null, '', 'START', 'move', 42, {}]) {
    const step = touchStep(ended.state, kind)
    t.is(step.state, ended.state, 'unknown kind keeps the state: ' + JSON.stringify(kind))
    t.is(step.engage, null, 'and reports nothing: ' + JSON.stringify(kind))
  }
  for (const state of [undefined, null, 'ended', 42, { ended: 'true' }]) {
    t.is(touchStep(state, 'cancel').engage, false, 'a bad state counts as no touch ended: ' + JSON.stringify(state))
    t.alike(touchStep(state, 'end').state, { ended: true }, 'and an end still sticks: ' + JSON.stringify(state))
  }
})

test('native: touches are plain listeners whose caller cannot throw into the library', (t) => {
  for (const [prop, kind] of [['onTouchStart', 'start'], ['onTouchEnd', 'end'], ['onTouchCancel', 'cancel']]) {
    t.ok(new RegExp(prop + '=\\{' + prop + '\\}').test(nativeSrc), prop + ' on the wrapper')
    t.ok(new RegExp('const ' + prop + " = \\(\\) => \\{ touched\\('" + kind + "'\\) \\}").test(nativeSrc), prop + ' reports ' + kind)
  }
  t.absent(/onResponderGrant|onResponderRelease|onResponderTerminate|onMoveShouldSetResponder/.test(nativeSrc), 'no responder claim beyond the existing one')
  t.is((nativeSrc.match(/onStartShouldSetResponder/g) || []).length, 1, 'the only claim is the WebView\'s')
  t.ok(/try \{ onEngage\(step\.engage\) \} catch \{\}/.test(nativeSrc), 'a throwing onEngage is caught')
})

test('native: onReady comes from a load with no argument read, after a settle', (t) => {
  t.ok(/onLoad=\{onLoad\}/.test(nativeSrc), 'the WebView takes onLoad')
  t.ok(/const onLoad = \(\) => \{ settleReady\(settle, ready, onReady\) \}/.test(nativeSrc), 'the handler takes no parameter')
  t.absent(/onLoadStart|onLoadEnd|onLoadProgress|nativeEvent\.(url|title)/.test(nativeSrc), 'no other load callback, nothing read from the event')
  t.ok(/^const SETTLE_MS = 500$/m.test(nativeRaw), 'a local settle')
  t.ok(/useEffect\(\(\) => \(\) => clearTimeout\(settle\.current\), \[\]\)/.test(nativeSrc), 'the timer is cleared on unmount')
  const hooks = nativeSrc.slice(nativeSrc.indexOf('export function EmbedFrame'), nativeSrc.indexOf("if (typeof html !== 'string'"))
  for (const hook of ['const gone = useRef', 'const ready = useRef', 'const settle = useRef', 'const touch = useRef', 'useEffect(']) {
    t.ok(hooks.includes(hook), hook + ' is above the early return')
  }
})

function settleReadyNative () {
  const settle = nativeRaw.match(/^const SETTLE_MS = .*$/m)[0]
  const pieces = ['goneOnce', 'settleReady'].map((name) => {
    const start = nativeRaw.indexOf('export function ' + name + ' (')
    const end = nativeRaw.indexOf('\n}\n', start)
    if (start === -1 || end === -1) throw new Error(name + ' not found in EmbedFrame.native.js')
    return nativeRaw.slice(start, end + 2).replace('export ', '')
  })
  return new Function(settle + '\n' + pieces.join('\n') + '\nreturn settleReady')() // eslint-disable-line no-new-func
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (const [name, load] of [
  ['native', async () => settleReadyNative()],
  ['web', async () => (await import('../src/ui/EmbedFrame.web.js')).settleReady]
]) {
  test(name + ': ready fires once, after the settle', async (t) => {
    const settleReady = await load()
    const timer = { current: null }
    const fired = { current: false }
    let calls = 0
    let argCount = -1
    const onReady = function () {
      calls++
      argCount = arguments.length
    }
    settleReady(timer, fired, onReady)
    const first = timer.current
    t.ok(first !== null, 'a load starts the timer')
    settleReady(timer, fired, onReady)
    t.is(timer.current, first, 'a second load does not restart it')
    await wait(200)
    t.is(calls, 0, 'nothing before the settle')
    await wait(500)
    t.is(calls, 1, 'one call after it')
    t.is(argCount, 0, 'with no argument')
    t.is(timer.current, null)
    settleReady(timer, fired, onReady)
    t.is(timer.current, null, 'a load after ready starts nothing')
    await wait(600)
    t.is(calls, 1, 'still one call')

    const quiet = { current: null }
    settleReady(quiet, { current: false }, undefined)
    t.is(quiet.current, null, 'no onReady, no timer')
    const throwing = { current: null }
    settleReady(throwing, { current: false }, () => { throw new Error('x') })
    await wait(600)
    t.pass('a throwing onReady is caught')

    const cleared = { current: null }
    settleReady(cleared, { current: false }, () => { calls++ })
    clearTimeout(cleared.current)
    await wait(600)
    t.is(calls, 1, 'a cleared timer (unmount) calls nothing')
  })
}
