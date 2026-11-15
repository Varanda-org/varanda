'use strict'

// How the splash draws its scene, read from the source: the components need
// React Native, so these tests check the wiring the device checks rely on.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const APP = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8')

// String literals are kept whole, so a '//' inside a URL never hides the
// rest of its line.
function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

// The scene component is SplashSceneView.js, not SplashScene.js: on a
// case-insensitive disk that name is the same file as the pure splashScene.js.
const SCENE = 'src/ui/SplashSceneView.js'
const SPLASH = 'src/ui/Splash.js'

test('splash wiring: react-native-svg is pinned exactly', (t) => {
  const pkg = JSON.parse(read('package.json'))
  t.is(pkg.dependencies['react-native-svg'], '15.15.3')
})

test('splash wiring: the scene draws with plain react-native-svg shapes', (t) => {
  const src = withoutComments(read(SCENE))
  t.ok(/from 'react-native-svg'/.test(src), 'imports react-native-svg')
  t.absent(src.includes('Platform.OS'), 'no Platform.OS')
  for (const name of ['Pattern', 'Use']) {
    t.absent(new RegExp('\\b' + name + '\\b').test(src), 'no ' + name)
  }
  t.ok(src.includes("pointerEvents='none'"), 'never takes a touch')
  t.ok(src.includes('renderToHardwareTextureAndroid'), 'strips slide as a compositor layer')
  t.ok(src.includes('shouldRasterizeIOS'), 'strips slide as a compositor layer on iOS')
})

test('splash wiring: gradients only for the sunset band and the sun', (t) => {
  const src = withoutComments(read(SCENE))
  t.ok(/import Svg, \{[^}]*\bLinearGradient\b[^}]*\bRadialGradient\b[^}]*\} from 'react-native-svg'/.test(src), 'imports LinearGradient and RadialGradient')
  t.is((src.match(/<LinearGradient\b/g) || []).length, 1, 'one linear gradient')
  t.is((src.match(/<RadialGradient\b/g) || []).length, 1, 'one radial gradient')
  t.is((src.match(/<Defs>/g) || []).length, 2, 'Defs only around those two')
  const fn = (name) => src.slice(src.indexOf('function ' + name + ' '), src.indexOf('\n}\n', src.indexOf('function ' + name + ' ')))
  t.ok(/<LinearGradient\b/.test(fn('skySvg')) && /SKY_STOPS\.map/.test(fn('skySvg')), 'the sky draws the linear gradient from SKY_STOPS')
  t.ok(/<RadialGradient\b/.test(fn('sunSvg')) && /SUN_STOPS\.map/.test(fn('sunSvg')), 'the sun draws the radial gradient from SUN_STOPS')
  t.absent(/<Defs>/.test(src.replace(fn('skySvg'), '').replace(fn('sunSvg'), '')), 'no Defs in the strips or the art')
  const ids = [...src.matchAll(/\bid='([^']*)'/g)].map((m) => m[1])
  t.alike(ids, ['splash-ceu', 'splash-sol'], 'gradient ids')
  for (const id of ids) t.ok(id.startsWith('splash-'), id + ' has the splash- prefix')
  const urls = [...src.matchAll(/url\(#([^)]*)\)/g)].map((m) => m[1])
  t.alike(urls.sort(), ids.slice().sort(), 'every url() names one of them')
  t.ok(/<View style=\{\[styles\.band, \{ top: sky\.y, height: sky\.height \}\]\}>\{art\.sky\}<\/View>/.test(src), 'the band draws the sky svg')
  t.ok(src.indexOf('{art.sun}') < src.indexOf('{art.tree}') && src.indexOf('{art.sun}') < src.indexOf('{art.varanda}'), 'the sun is drawn before the tree and the varanda')
})

test('splash wiring: Splash mounts the scene and keeps one accessible header', (t) => {
  const src = withoutComments(read(SPLASH))
  t.ok(/import \{[^}]*\bSplashScene\b[^}]*\} from '\.\/SplashSceneView'/.test(src), 'imports SplashScene')
  t.ok(/import \{[^}]*\bsceneLayout\b[^}]*\bscenePalette\b[^}]*\} from '\.\/splashScene'/.test(src), 'imports sceneLayout and scenePalette')
  t.ok(/import \{[^}]*\bslideMotion\b[^}]*\} from '\.\/splashMotion'/.test(src), 'imports slideMotion')
  t.absent(src.includes('cadeira.png'), 'no raster chair')
  t.absent(/\bImage\b/.test(src), 'no Image')
  t.is((src.match(/<SplashScene\b/g) || []).length, 1, 'one scene')
  t.ok(/\{!underShell && \([\s\S]{0,400}<SplashScene\b/.test(src), 'mounted only when not under the web overlay')
  t.is((src.match(/\{SPLASH_LABEL\}/g) || []).length, 1, 'one accessible label in the JSX')
  t.is((src.match(/Animated\.loop\(Animated\.timing\(slide(Near|Far)\.current, loopTiming\(\{ toValue: 1, duration: [^,]+, easing: Easing\.linear, useNativeDriver: native \}\)\)\)/g) || []).length, 2, 'both slide loops are linear and go through loopTiming')
})

test('splash wiring: the word is the logo lettering, not text', async (t) => {
  const src = withoutComments(read(SPLASH))
  const view = withoutComments(read(SCENE))
  t.ok(/import \{[^}]*\bSplashLettering\b[^}]*\} from '\.\/SplashSceneView'/.test(src), 'Splash imports SplashLettering')
  t.ok(/export function SplashLettering\b/.test(view), 'SplashSceneView exports SplashLettering')
  t.is((src.match(/<SplashLettering palette=\{palette\} letters=\{letters\.current\} \/>/g) || []).length, 1, 'one lettering, driven by the letter values')
  t.ok(/accessibilityRole='header' accessibilityLabel=\{SPLASH_LABEL\}[^>]*>\s*<SplashLettering\b/.test(src), 'inside the one readable header')
  t.absent(/\bSPLASH_WORD\b/.test(src), 'no SPLASH_WORD characters rendered')
  t.absent(/Animated\.Text|<Text\b/.test(src), 'no Text in the splash')
  t.ok(/<View \{\.\.\.hiddenFromReaders\}/.test(view.slice(view.indexOf('function SplashLettering'))), 'the lettering box is hidden from readers')
  const { LETTERING } = await import('../src/ui/splashScene.js')
  const { SPLASH_WORD } = await import('../src/ui/splashMotion.js')
  t.is(LETTERING.letters.length, SPLASH_WORD.length, 'one drawn letter per animated letter')
})

test('splash wiring: the flyers loop in the pinned form and settle stops them', (t) => {
  const src = withoutComments(read(SPLASH))
  const view = withoutComments(read(SCENE))
  t.is((src.match(/Animated\.loop\(Animated\.timing\((b|v\.flap|v\.drift), loopTiming\(\{ toValue: 1, duration: [^,]+, easing: Easing\.linear, useNativeDriver: native \}\)\)\)/g) || []).length, 3, 'birds, flap and drift loops go through loopTiming on the native driver')
  t.ok(/if \(!f\) return/.test(src) && /flyerMotion\(reduced\)/.test(src), 'reduced motion starts no flyer')
  const stopAll = /const stopAll = \(\) => \{([\s\S]*?)\n {4}\}/.exec(src)
  t.ok(stopAll && stopAll[1].includes('flights.forEach((f) => f.stop())'), 'stopAll stops every flyer loop')
  const settle = /const settle = \(\) => \{([\s\S]*?)\n {4}\}/.exec(src)
  t.ok(settle && settle[1].includes('stopAll()'), 'settle stops them')
  t.ok(settle && /birds\.forEach\(\(v\) => v\.setValue\(0\)\)/.test(settle[1]) && settle[1].includes('flap.setValue(0)') && settle[1].includes('drift.setValue(0)'), 'and leaves each flyer at rest')
  t.is((src.match(/startFlyers\(\)/g) || []).length, 2, 'started with the entrance and again after the overlay expires')
  t.ok(src.includes('flyers={flyers.current}'), 'the scene gets the values')
  t.absent(/daylight/.test(src + view), 'the sun and the flyers show in both schemes')
  t.ok(view.indexOf('art.tree') < view.indexOf('art.varanda}'), 'the tree is drawn before the varanda')
})

test('splash wiring: the splash reports its presentation once, never after unmount', (t) => {
  const src = withoutComments(read(SPLASH))
  t.ok(/export function Splash \(\{[^}]*\bonPresented\b/.test(src), 'onPresented is a prop')
  t.ok(src.includes('overlayRemainingMs('), 'the web overlay is measured on its own clock')
  t.ok(src.includes('PRESENTATION_MS'), 'the reduced and shell paths use the floor')
  t.ok(/finished !== true \|\| cancelled\) return\s+presentIn\(REST_MS\)/.test(src), 'the finish callback rests REST_MS')
  t.ok(/if \(presented \|\| cancelled\) return/.test(src), 'no report after unmount or twice')
  t.ok(src.includes('clearTimeout(presentTimer)'), 'cleanup clears the timer')
  t.ok(/\bentered\b/.test(src.match(/export function Splash \(\{[^}]*\}/)[0]), 'entered is a prop')
  t.ok(src.includes('useRef(entered === true)'), 'entered is read once into a ref')
  const entered = src.slice(src.indexOf('else if (enteredRef.current)'), src.indexOf('watchReduceMotion()', src.indexOf('else if (enteredRef.current)')))
  t.ok(entered.includes('resumeMoving()'), 'the entered path moves on')
  const resume = src.slice(src.indexOf('const resumeMoving'), src.indexOf('const skip'))
  t.ok(resume.includes('startPulse()') && resume.includes('startSlides()') && resume.includes('startFlyers()'), 'resumeMoving pulses, slides and flies')
  t.absent(entered.includes('play()'), 'the entered path never replays the entrance')
  t.ok(entered.includes('cancelled || motionOff || reduce === true'), 'a stale answer never resumes motion')
  const listener = src.slice(src.indexOf("addEventListener('reduceMotionChanged'"), src.indexOf('let sub = null'))
  t.ok(listener.includes('motionOff = true'), 'the listener marks Reduce Motion switched on')
  t.ok(src.includes('if (cancelled || motionOff) return'), 'a stale answer never starts the entrance')
})

test('splash wiring: the bar slides a full-width fill by translateX on the native driver', (t) => {
  const src = withoutComments(read(SPLASH))
  t.ok(/Animated\.timing\(fill\.current,.*useNativeDriver: native\b/.test(src), 'the bar timing uses the native flag')
  t.absent(/Animated\.timing\(fill\.current,.*useNativeDriver: false/.test(src), 'never the JS driver')
  t.ok(/translateX: fill\.current\.interpolate\(\{ inputRange: \[0, 1\], outputRange: \[-BAR_WIDTH, 0\] \}\)/.test(src), 'the fill moves by translateX')
  t.absent(/width: fill\.current/.test(src), 'the width is not animated')
  t.absent(/scaleX/.test(src), 'no scaleX')
  const fillStyle = src.slice(src.indexOf('barFill: {'))
  t.ok(/width: BAR_WIDTH/.test(fillStyle.slice(0, fillStyle.indexOf('}'))), 'the fill is full width inside the clipped track')
})
