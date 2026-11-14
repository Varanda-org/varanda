'use strict'

// The app shell hiding the bars while A Rua scrolls down (App.js), on top of
// the pure decision in src/chromeScroll.js.
const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/chromeScroll.js')
const app = readFileSync(join(__dirname, '..', 'App.js'), 'utf8')

// The shell's frame loop: the whole result goes back in, userScrolled comes
// from onUserScroll, and the screen reader is read on each frame.
function frames (M, state, ys, opts = {}) {
  for (const y of ys) {
    state = M.nextChrome(state, { y, userScrolled: opts.userScrolled !== false, reduceMotion: !!opts.reduceMotion, screenReader: !!opts.screenReader, top: 52 })
  }
  return state
}

function between (src, from, to) {
  const a = src.indexOf(from)
  const b = src.indexOf(to, a + from.length)
  return a === -1 || b === -1 ? '' : src.slice(a, b)
}

test('a downward scroll past the top bar hides, a short way up shows again', async (t) => {
  const M = await load()
  const down = frames(M, M.initialChrome(), [10, 40, 80, 120])
  t.is(down.hidden, true)
  t.is(frames(M, M.chromeGesture(down), [118, 110]).hidden, false)
})

test('the bars stay shown with a screen reader or reduced motion', async (t) => {
  const M = await load()
  t.is(frames(M, M.initialChrome(), [10, 80, 200, 400], { screenReader: true }).hidden, false)
  t.is(frames(M, M.initialChrome(), [10, 80, 200, 400], { reduceMotion: true }).hidden, false)
  const hidden = frames(M, M.initialChrome(), [10, 80, 200])
  t.is(hidden.hidden, true)
  t.is(frames(M, hidden, [210], { screenReader: true }).hidden, false, 'a screen reader turned on shows them at the next frame')
})

test('programmatic frames after a reset never hide', async (t) => {
  const M = await load()
  t.is(frames(M, M.initialChrome(), [400, 200, 0], { userScrolled: false }).hidden, false)
  t.is(frames(M, M.initialChrome(), [-30, 200, 600], { userScrolled: false }).hidden, false)
})

test('App: the motion context wraps the bars, the button and the content', (t) => {
  t.ok(app.includes("import { ChromeMotion } from './src/ui/chromeMotion'"))
  t.ok(app.includes("import { chromeGesture, chromeHiddenProps, chromeShow, contentShift, initialChrome, nextChrome } from './src/chromeScroll'"))
  t.ok(app.includes('<ChromeMotion.Provider value={chromeMotion}>'), 'the provider is mounted')
  t.ok(/const chromeMotion = useMemo\(\(\) => \(\{ progress: chromeProgress, hidden: chromeHidden, show: showChrome \}\)/.test(app), 'its value is memoized')
  const wrapped = between(app, '<ChromeMotion.Provider value={chromeMotion}>', '</ChromeMotion.Provider>')
  t.ok(wrapped.includes('{content}'), 'the shell content sits inside it')
  const shell = between(app, '      <View style={[styles.shell, wide && styles.shellWide]}>\n        <Animated.View', '\n    )\n  }\n')
  for (const part of ['<TopBar', '<OfflineNote', '<ARua', '<Fab onPress={openComposer} />', '<TabBar current=', 'styles.toast']) {
    t.ok(shell.includes(part), part + ' is in the moving shell')
  }
})

test('App: one progress value and a state flipped only when hidden changes', (t) => {
  t.ok(app.includes('const chromeProgress = useRef(new Animated.Value(0)).current'))
  t.ok(app.includes('const chromeState = useRef(initialChrome())'))
  const frame = between(app, 'const onRuaScrollFrame = useCallback(', '}, [])')
  t.ok(frame.includes('if (!chromeMayHideRef.current) return'), 'only while hiding is allowed')
  t.ok(frame.includes('screenReader: screenReaderOn()'), 'the screen reader is read on every frame')
  t.ok(frame.includes('reduceMotion: reduceMotionRef.current'))
  t.ok(frame.includes('userScrolled: chromeUserScrolled.current'))
  t.ok(frame.includes('top: layout.topBar'))
  t.ok(frame.includes('chromeState.current = next'), 'the whole result is kept')
  t.ok(frame.includes('if (next.hidden === prev.hidden) return'), 'no state update per frame')
  const gesture = between(app, 'const onRuaUserScroll = useCallback(() => {', '}, [])')
  t.ok(gesture.includes('chromeUserScrolled.current = true'))
  t.ok(gesture.includes('chromeState.current = chromeGesture(chromeState.current)'), 'a new gesture ends the hold a flip left')
})

test('App: near the end and on a list resize the bars do not flip back', (t) => {
  const frame = between(app, 'const onRuaScrollFrame = useCallback(', '}, [])')
  t.ok(frame.includes('below: contentHeight - layoutHeight - y'), 'the room left below is passed')
  t.ok(frame.includes('grow: chromeTopRef.current'), 'the measured bar height is what the list gains')
  t.ok(frame.includes('userScrolled: chromeUserScrolled.current && !resized'), 'a frame that resized the list is not the person')
  t.ok(frame.includes('layoutHeight !== chromeListHeight.current'))
  t.ok(app.includes('chromeTopRef.current = chromeTop'))
})

test('App: rows merged above the feed and a reset leave the bars alone', (t) => {
  const frame = between(app, 'const onRuaScrollFrame = useCallback(', '}, [])')
  t.ok(frame.includes('const grew = chromeContentHeight.current === null ? 0 : contentHeight - chromeContentHeight.current'), 'the growth since the last frame')
  t.ok(frame.includes('chromeContentHeight.current = contentHeight'))
  t.ok(frame.includes('const shifted = contentShift({ y, lastY: prev.lastY, grew })'), 'keepVisiblePosition moving the offset is not the person')
  t.ok(frame.includes('&& !shifted &&'))
  const reset = between(app, 'const resetChrome = useCallback(() => {', '}, [])')
  t.ok(reset.includes('chromeMoving.current = false'), 'a reset never leaves the slide token set')
})

test('App: frames while the bars slide only move the anchor', (t) => {
  const frame = between(app, 'const onRuaScrollFrame = useCallback(', '}, [])')
  t.ok(frame.includes('userScrolled: chromeUserScrolled.current && !resized && !shifted && !chromeMoving.current,'), 'a frame during the slide is not the person')
  t.ok(frame.includes('chromeMoving.current = true\n'), 'a flip from a frame starts the guard')
  const anim = between(app, 'chromeProgress.stopAnimation()', '}, [chromeHidden, reduceMotion, chromeProgress])')
  t.ok(anim.includes('if (chromeMoving.current) chromeMoving.current = slide'), 'only a flip holds it, not the first run')
  t.ok(anim.includes('if (chromeMoving.current === slide) chromeMoving.current = false'), 'only this run clears it')
  t.ok(/if \(reduceMotion\) \{\s*chromeMoving\.current = false/.test(anim), 'reduced motion never leaves it set')
  t.ok(app.includes("import { chromeGesture, chromeHiddenProps, chromeShow, contentShift, initialChrome, nextChrome } from './src/chromeScroll'"))
})

test('App: A Rua feeds the scroll callbacks', (t) => {
  const rua = between(app, '<ARua\n', '/>')
  t.ok(rua.includes('onUserScroll={onRuaUserScroll}'))
  t.ok(rua.includes('onScrollFrame={onRuaScrollFrame}'))
})

test('App: everything but A Rua alone forces the bars shown', (t) => {
  const may = app.slice(app.indexOf('const chromeMayHide = '), app.indexOf('\n', app.indexOf('const chromeMayHide = ')))
  t.ok(may.includes("tab === 'rua'"), 'other tabs never hide')
  t.ok(may.includes('nav.depth(stack) === 0') && may.includes('!stackMotion.leaving'), 'a pushed or leaving screen keeps them')
  t.ok(may.includes('!composer.open'), 'the composer keeps them')
  t.ok(may.includes('!(toast && toast.onAction)'), 'an action toast keeps them')
  t.ok(may.includes('!reduceMotion'), 'reduced motion keeps them')
  t.ok(may.includes('!screenReaderOn()'), 'a screen reader keeps them')
  t.ok(app.includes('const reduceMotion = useReduceMotion()'))
  const reset = between(app, 'const resetChrome = useCallback(() => {', '}, [])')
  t.ok(reset.includes('chromeState.current = initialChrome()') && reset.includes('chromeUserScrolled.current = false') && reset.includes('setChromeHidden(false)'))
  t.ok(app.includes('useEffect(() => { resetChrome() }, [chromeMayHide, tab, stack.length, scrollSignal.rua, resetChrome])'), 'tab change, push, pop and reselect reset')
})

test('App: translate only, the navigation hidden state stays apart', (t) => {
  t.ok(app.includes('const barsHidden = stacked || viewerLeaving'))
  t.ok(app.includes('<TabBarShown.Provider value={!barsHidden}>'))
  t.ok(app.includes('{barsHidden ? null : <TabBar '))
  t.ok(app.includes('const chromeShift = chromeProgress.interpolate({ inputRange: [0, 1], outputRange: [0, -chromeTop] })'))
  t.ok(app.includes('onLayout={onChromeLayout}'), 'the header is measured')
  t.ok(app.includes('style={{ transform: [{ translateY: chromeShift }] }}'), 'the header slides up')
  t.ok(app.includes('<Animated.View style={[styles.flex, { marginBottom: chromeRoom ? -chromeTop : 0, transform: [{ translateY: chromeShift }] }]}>'), 'the content slides with it and keeps its size')
  t.absent(/Animated\.timing\([^)]*height/.test(app), 'no height animation')
  const anim = between(app, 'chromeProgress.stopAnimation()', '}, [chromeHidden, reduceMotion, chromeProgress])')
  t.ok(anim.includes('chromeProgress.setValue(chromeHidden ? 1 : 0)'), 'reduced motion jumps')
  t.ok(anim.includes('Animated.timing(chromeProgress, { toValue: chromeHidden ? 1 : 0, duration: CHROME_MS, useNativeDriver: CHROME_NATIVE_DRIVER })'))
})

test('App: the toast drops to the edge while the bars are away', (t) => {
  t.ok(app.includes('bottom: fabShown ? insets.bottom + layout.tabBar + layout.fabAboveTabs + layout.fabSize + 12 : (barsHidden ? 0 : layout.tabBar) + insets.bottom + 12 }, chromeHidden && { bottom: insets.bottom + 12 }]}'))
})

test('A Rua: the new-posts pill moves below the status strip while the bars are away', (t) => {
  const rua = readFileSync(join(__dirname, '..', 'src', 'screens', 'ARua.js'), 'utf8')
  t.ok(rua.includes("import { useChromeMotion } from '../ui/chromeMotion'"))
  t.ok(rua.includes('const newItemsTop = chrome.hidden && insets.top > 0 ? insets.top + 8 : undefined'))
  const list = between(rua, "newItems={{ label: 'ver novidades'", '/>')
  t.ok(list.includes('newItemsTop={newItemsTop}'), 'the member list passes it')
})

test('App: hidden bars use the shared props and focus on them shows them', (t) => {
  t.ok(app.includes("{...(chromeHidden ? { pointerEvents: 'none', ...chromeHiddenProps(showChrome) } : null)}"), 'the header wrapper')
  const show = between(app, 'const showChrome = useCallback(() => {', '}, [])')
  t.ok(show.includes('const next = chromeShow(chromeState.current)'))
  t.ok(show.includes('setChromeHidden(false)'))
  t.ok(app.includes('({ progress: chromeProgress, hidden: chromeHidden, show: showChrome })'), 'the bars get show through the context')
})
