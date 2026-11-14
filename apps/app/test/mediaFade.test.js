'use strict'

// The photo fades in when its bitmap loads. Load, keep and retry stay put:
// this file only pins the fade, and the strings the loader already had.

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const src = fs.readFileSync(path.join(__dirname, '../src/ui/MediaView.js'), 'utf8')

test('a photo fades from 0 to 1 over motion.fast when it loads', (t) => {
  t.absent(src.includes('\u2014'), 'no em dash')
  t.ok(src.includes("import { motion } from './theme'"), 'duration comes from the motion tokens')
  t.ok(src.includes("import { useReduceMotion } from './StackLayer'"), 'reduced motion uses the shared hook')
  const fade = src.slice(src.indexOf('function startImageFade'), src.indexOf('function FadingPhoto'))
  t.ok(fade.includes('const duration = reduceMotion ? 0 : motion.fast'), 'motion.fast, instant under reduce motion')
  t.ok(fade.includes('const toValue = 1'), 'fades to 1')
  t.ok(fade.includes('opacity.setValue(toValue)'), 'reduced motion sets 1 at once')
  t.ok(fade.includes('toValue,'), 'timing target is 1')
  t.ok(fade.includes('duration,'), 'timing uses that duration')
  t.ok(fade.includes('useNativeDriver: false'), 'web has no native driver')
  t.ok(fade.includes('isInteraction: false'), 'a feed of fades does not hold the list window')
  t.ok(fade.includes('run.start()'), 'the timing runs')
  t.ok(fade.includes('react-native-web has no native driver'), 'the JS driver names the missing API')
  const child = src.slice(src.indexOf('function FadingPhoto'), src.indexOf('export function MediaView'))
  t.ok(child.includes('new Animated.Value(reduceMotion ? 1 : 0)'), 'starts at 0')
  t.ok(child.includes('new Animated.Value(reduceMotion ? 1 : 0)'), 'a new photo is hidden unless motion is reduced')
  t.ok(src.includes('opacity.setValue(1)'), 'a late reduced-motion setting snaps to 1')
  t.ok(child.includes('onLoad={reveal}'), 'the fade starts when the bitmap loads')
  t.ok(src.includes("Platform.OS === 'android' ? { fadeDuration: 0 } : null"), 'Android\'s own fade stays off')
  t.ok(src.includes('the web warns if it is passed through'), 'the Platform.OS check names the web warning')
  t.ok(child.includes('<Animated.Image'), 'the photo is the faded node')
  t.ok(child.includes('style={[styles.fill, { opacity }]}'), 'opacity is the fade')
  t.ok(child.indexOf('styles.loading') < child.indexOf('<Animated.Image'), 'the placeholder stays behind the photo')
  const view = src.slice(src.indexOf('export function MediaView'), src.indexOf('const makeStyles'))
  t.ok(view.includes('<FadingPhoto key={url}'), 'a new url mounts a new image so onLoad fires again')
  t.ok(view.includes('reduceMotion={reduceMotion}'), 'a new url keeps the reduce-motion setting already known')
  t.absent(/useNativeDriver:\s*true/.test(src), 'the driver is not unconditional')
})

test('fade does not change load, keep or retry', (t) => {
  const loader = src.slice(src.indexOf('function useMedia'), src.indexOf('function startImageFade'))
  t.absent(loader.includes('Animated'), 'the loader does not fade')
  t.absent(loader.includes('opacity'), 'the loader does not fade')
  t.absent(loader.includes('motion.fast'), 'the loader does not time the fade')
  t.ok(src.includes('const canFetch = !keptOnly && node !== null && node.hosted === true'))
  t.ok(src.includes('keptStore.keptUrl(kind, author, d)'))
  t.ok(src.includes("keptOnlyUrl('posts', author, descriptor, persist)"))
  t.ok(src.includes("if (keptOnly) return kept !== null ? { state: 'ok', url: kept, retry: undefined } : { state: 'loading', url: null, retry: undefined }"))
  t.ok(src.includes('cache.get(key, load).then('))
  t.ok(src.includes('const delay = retryDelay(err, autoRef.current.done)'))
  t.ok(src.includes('const retry = () => setAttempt((n) => n + 1)'))
  t.ok(src.includes('const press = failed ? (tapRetry ? retry : undefined) : onPress'))
  t.ok(src.includes('fetchBytes: (d) => fetchMedia(author, d, { ...mediaHashDeps(), fresh, persist, fetch: mediaFetch() })'))
  t.ok(src.includes('registerKeptStore({ onRevokedRanges, bumpCacheGeneration, registerLocalCache, store: keptStore, cache })'))
})

// Writing an Animated.Value during MediaView's render calls scheduleUpdate on
// the nodes already listening (react-native-web). The value is born with the
// child, and later writes stay in an effect or the fade helper.
test('no setValue call happens in the MediaView render body', (t) => {
  const code = withoutComments(src)
  const fadeStart = code.indexOf('function startImageFade')
  const childStart = code.indexOf('function FadingPhoto')
  const viewStart = code.indexOf('export function MediaView')
  const stylesStart = code.indexOf('const makeStyles')
  t.ok(fadeStart !== -1 && childStart > fadeStart && viewStart > childStart && stylesStart > viewStart, 'fade helper, then the keyed child, then MediaView')
  const viewRender = stripCalls(code.slice(viewStart, stylesStart), 'useEffect(')
  t.absent(viewRender.includes('.setValue('), 'no setValue call happens in the MediaView render body')
  t.absent(code.includes('seenUrl'), 'the render-time url ref is gone')
  const child = code.slice(childStart, viewStart)
  t.ok(child.includes('useRef(new Animated.Value(reduceMotion ? 1 : 0))'), 'the child initial value is the value for this url')
  const childRender = stripCalls(stripInitialValue(child), 'useEffect(')
  t.absent(childRender.includes('.setValue('), 'the child render does not call setValue')
  t.ok(code.slice(fadeStart, childStart).includes('opacity.setValue(toValue)'), 'the fade helper may set the value')
  t.ok(child.includes('opacity.setValue(1)'), 'the late reduce-motion snap may set the value')
  const stripped = stripCalls(stripInitialValue(code.slice(0, fadeStart) + code.slice(childStart)), 'useEffect(')
  t.absent(stripped.includes('.setValue('), 'the only setValue calls are inside effects, the fade helper or the child initial value')
})

// Runs the fade helper and FadingPhoto with a stand-in Animated, so the load
// handler itself has to bring the photo to full opacity.
function loadFadingPhoto () {
  const { transformSync } = require('@babel/core')
  const body = src.slice(src.indexOf('function startImageFade'), src.indexOf('export function MediaView'))
  const code = transformSync(body, {
    configFile: false,
    babelrc: false,
    plugins: [[require.resolve('@babel/plugin-transform-react-jsx'), { runtime: 'classic' }]]
  }).code
  const timings = []
  class Value {
    constructor (v) { this.value = v }
    setValue (v) { this.value = v }
    interpolate (config) { return { interpolate: config, of: this } }
  }
  const Animated = {
    Value,
    View: 'Animated.View',
    Image: 'Animated.Image',
    timing (value, config) {
      timings.push(config)
      return { start: () => value.setValue(config.toValue), stop () {} }
    }
  }
  const deps = {
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), Fragment: 'Fragment' },
    Animated,
    motion: { fast: 150 },
    imageFadeOff: null,
    useStyles: () => ({}),
    makeStyles: () => ({}),
    useRef: (init) => ({ current: init }),
    useEffect: () => {},
    useMemo: (make) => make()
  }
  // eslint-disable-next-line no-new-func
  const FadingPhoto = new Function(...Object.keys(deps), code + '\nreturn FadingPhoto')(...Object.values(deps))
  return { FadingPhoto, timings }
}

function findType (node, type) {
  if (!node || typeof node !== 'object') return null
  if (node.type === type) return node
  for (const child of node.children || []) {
    const hit = findType(child, type)
    if (hit) return hit
  }
  return null
}

test('loading the bitmap brings the photo to full opacity', (t) => {
  const { FadingPhoto, timings } = loadFadingPhoto()
  const image = findType(FadingPhoto({ url: 'blob:a', fit: 'cover', reduceMotion: false }), 'Animated.Image')
  const opacity = image.props.style[1].opacity
  t.is(opacity.value, 0, 'hidden before the bitmap loads')
  image.props.onLoad()
  t.is(timings.length, 1, 'one fade per load')
  t.is(timings[0].duration, 150, 'the fade lasts motion.fast')
  t.is(opacity.value, 1, 'the load handler reveals the photo')
  const reduced = loadFadingPhoto()
  const still = findType(reduced.FadingPhoto({ url: 'blob:b', fit: 'cover', reduceMotion: true }), 'Animated.Image')
  t.is(still.props.style[1].opacity.value, 1, 'reduced motion starts visible')
  still.props.onLoad()
  t.is(reduced.timings.length, 0, 'reduced motion never times a fade')
  t.is(still.props.style[1].opacity.value, 1, 'and stays visible after load')
})

// Strings stay, so a quote inside a comment never hides the code after it.
function withoutComments (text) {
  return text.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

function endOfString (text, i) {
  const q = text[i]
  i++
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2
      continue
    }
    if (text[i] === q) return i
    i++
  }
  return i
}

// Index just after the call whose opening parenthesis is `open`.
function walkCall (text, open) {
  let depth = 0
  let i = open
  while (i < text.length) {
    const c = text[i]
    if (c === "'" || c === '"' || c === '`') {
      i = endOfString(text, i) + 1
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

function stripCalls (text, token) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const at = text.indexOf(token, i)
    if (at < 0) return out + text.slice(i)
    const prev = at > 0 ? text[at - 1] : ''
    if (prev && /[A-Za-z0-9_$]/.test(prev)) {
      out += text.slice(i, at + token.length)
      i = at + token.length
      continue
    }
    out += text.slice(i, at)
    const end = walkCall(text, at + token.length - 1)
    if (end < 0) return out + text.slice(at)
    i = end
  }
  return out
}

// The useRef that creates this url's Animated.Value. Its argument is the
// allowed initial write, evaluated once, before any node is listening.
function stripInitialValue (text) {
  const marker = 'useRef(new Animated.Value('
  const at = text.indexOf(marker)
  if (at < 0) return text
  const end = walkCall(text, at + 'useRef'.length)
  if (end < 0) return text
  return text.slice(0, at) + text.slice(end)
}
