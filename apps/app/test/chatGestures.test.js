'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { runInNewContext } = require('node:vm')
const source = (file) => readFileSync(join(__dirname, '../src', file), 'utf8')

test('swipePlan preserves the back edge, vertical scroll and right swipe thresholds', async (t) => {
  const { swipePlan } = await import('../src/chatGestures.js')
  for (const [dx, dy, x] of [[72, 0, 23], [8, 0, 24], [-72, 0, 100], [55, 28, 100], [56, -29, 100], [0, 0, 100], [NaN, 0, 100], [56, 0, undefined]]) {
    t.is(swipePlan(dx, dy, x), 'ignore')
  }
  t.is(swipePlan(9, 0, 24), 'track')
  t.is(swipePlan(55, 0, 100), 'track')
  t.is(swipePlan(56, 28, 24), 'reply')
  t.is(swipePlan(56, -28, 24), 'reply')
  t.is(swipePlan(100, 0, 100), 'reply')
})

test('jumpVisible requires more than one and a half measured viewports', async (t) => {
  const { jumpVisible } = await import('../src/chatGestures.js')
  t.absent(jumpVisible({ distanceFromEnd: 600, viewport: 400 }))
  t.ok(jumpVisible({ distanceFromEnd: 601, viewport: 400 }))
  t.absent(jumpVisible({ distanceFromEnd: -10, viewport: 400 }))
  t.absent(jumpVisible({ distanceFromEnd: 10, viewport: 0 }))
  t.absent(jumpVisible({ distanceFromEnd: Infinity, viewport: 400 }))
})

test('awayCount counts arrivals after the seen key without counting older pages', async (t) => {
  const { awayCount } = await import('../src/chatGestures.js')
  const rows = Object.freeze(['older', 'seen', 'new-a', 'new-b'].map((key) => Object.freeze({ key })))
  t.is(awayCount(rows, 'seen'), 2)
  t.is(awayCount(rows.slice(1), 'seen'), 2)
  t.is(awayCount(rows, 'new-b'), 0)
  t.is(awayCount(rows, null), 0)
  t.is(awayCount(rows, 'missing'), 0)
  t.is(awayCount([], 'seen'), 0)
})

test('SwipeReply uses the real PanResponder touch history through grant and release', async (t) => {
  const { swipePlan } = await import('../src/chatGestures.js')
  const PanResponder = require('react-native-web/dist/cjs/vendor/react-native/PanResponder')
  const src = source('ui/SwipeReply.js')
  const body = src.slice(src.indexOf('  const { colors }'), src.indexOf('  return ('))
  function mount ({ reduce = false, disabled = false, startX = 100, type = 'touch', pointerType, fingers = 1 } = {}) {
    const positions = []
    const haptics = []
    let replies = 0
    const env = {
      useTheme: () => ({ colors: {} }),
      useReduceMotion: () => reduce,
      useRef: (current) => ({ current }),
      useEffect: () => {},
      Animated: {
        Value: class {
          setValue (value) { positions.push(value) }
          stopAnimation () {}
        },
        timing: () => ({ start () {} })
      },
      PanResponder,
      swipePlan,
      tap: (kind) => haptics.push(kind),
      onReply: () => replies++,
      disabled
    }
    const { responder, latest } = runInNewContext(body + '\nconst mounted = { responder: responder.current, latest }\nmounted', env)
    const h = responder.panHandlers
    let stamp = 1
    let granted = false
    let claimed = false
    const track = {
      touchActive: true,
      startPageX: startX,
      startPageY: 100,
      startTimeStamp: stamp,
      currentPageX: startX,
      currentPageY: 100,
      currentTimeStamp: stamp,
      previousPageX: startX,
      previousPageY: 100,
      previousTimeStamp: stamp
    }
    const history = { touchBank: [track], numberActiveTouches: fingers, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: stamp }
    const event = (phase) => ({
      touchHistory: history,
      nativeEvent: { type: type + phase, pointerType, touches: Array.from({ length: history.numberActiveTouches }, () => ({ pageX: track.currentPageX, pageY: track.currentPageY })) }
    })
    t.absent(h.onStartShouldSetResponderCapture(event('start')), 'start capture leaves taps and long presses alone')
    t.absent(h.onStartShouldSetResponder(event('start')))
    return {
      positions,
      haptics,
      latest,
      get replies () { return replies },
      get claimed () { return claimed },
      move (x, y = 100) {
        track.previousPageX = track.currentPageX
        track.previousPageY = track.currentPageY
        track.previousTimeStamp = stamp
        track.currentPageX = x
        track.currentPageY = y
        track.currentTimeStamp = ++stamp
        history.mostRecentTimeStamp = stamp
        const e = event('move')
        if (!granted && (h.onMoveShouldSetResponderCapture(e) || h.onMoveShouldSetResponder(e))) {
          claimed = granted = true
          h.onResponderGrant(e)
        }
        if (granted) h.onResponderMove(e)
      },
      addFinger () {
        history.numberActiveTouches++
        if (granted) h.onResponderStart(event('start'))
      },
      terminate () {
        if (granted) h.onResponderTerminate(event('cancel'))
      },
      release () {
        history.numberActiveTouches = 0
        track.touchActive = false
        if (granted) {
          h.onResponderEnd(event('end'))
          h.onResponderRelease(event('end'))
        }
      }
    }
  }
  for (const reduce of [false, true]) {
    const h = mount({ reduce })
    h.move(172, 101)
    h.move(173, 101)
    t.ok(h.claimed, 'right swipe claims before x0 is assigned')
    t.is(h.positions.at(-1), 72, 'first post-grant move keeps the original displacement')
    t.alike(h.haptics, ['light'], 'haptic fires once when the move crosses the threshold')
    h.move(200, 102)
    t.is(h.replies, 0)
    h.release()
    h.release()
    t.is(h.replies, 1, 'start 100 to 200 replies exactly once')
    t.alike(h.haptics, ['light'])
    const icon = src.match(/opacity: (.+?) }\]/)[1]
    t.is(runInNewContext(icon, { reduce, x: { interpolate: () => 1 } }), 1, 'icon still gives feedback under reduced motion')
    const translate = src.match(/translateX: (.+?) }/)[1]
    t.is(runInNewContext(translate, { reduce, x: 72 }), reduce ? 0 : 72)
  }
  for (const options of [{ startX: 10 }, { type: 'mouse' }, { pointerType: 'mouse' }, { pointerType: 'pen' }, { fingers: 2 }, { disabled: true }]) {
    const h = mount(options)
    h.move((options.startX || 100) + 72)
    t.absent(h.claimed, JSON.stringify(options) + ' never claims')
    h.release()
    t.is(h.replies, 0)
  }
  const vertical = mount()
  vertical.move(120, 180)
  t.absent(vertical.claimed, 'vertical scrolling stays with the list')
  vertical.release()
  t.is(vertical.replies, 0)
  const fast = mount()
  fast.move(172)
  fast.release()
  t.is(fast.replies, 1)
  t.alike(fast.haptics, ['light'], 'a swipe that crosses on the grant event still taps once')
  const edge = mount()
  edge.move(172)
  edge.move(173)
  edge.move(150)
  t.alike(edge.haptics, ['light'], 'crossing is a haptic even if the release does not reply')
  const short = mount()
  short.move(172)
  short.move(173)
  short.move(130)
  t.alike(short.haptics, ['light'])
  const slow = mount()
  slow.move(130)
  slow.move(150)
  t.alike(slow.haptics, [], 'below the threshold stays silent')
  slow.release()
  short.move(130)
  short.release()
  t.is(short.replies, 0, 'ending at dx 30 does not reply')
  const backtrack = mount()
  backtrack.move(172)
  backtrack.move(105)
  t.is(backtrack.positions.at(-1), 5, 'below threshold keeps tracking')
  backtrack.move(99)
  t.is(backtrack.positions.at(-1), 0, 'translation never goes negative')
  backtrack.move(200)
  backtrack.release()
  t.is(backtrack.replies, 1, 'backtracking does not cancel')
  const diagonal = mount({ reduce: true })
  diagonal.move(172, 101)
  diagonal.move(160, 140)
  t.is(diagonal.positions.at(-1), 0, 'a diagonal move that can no longer reply lets go at once')
  diagonal.release()
  t.is(diagonal.replies, 0)
  for (const cancel of [(h) => h.terminate(), (h) => h.addFinger(), (h) => h.move(120, 180), (h) => { h.latest.current.disabled = true }]) {
    const h = mount()
    h.move(172)
    cancel(h)
    h.move(200)
    h.release()
    t.is(h.replies, 0, 'cancelled or disabled swipe never replies')
  }
})

test('chat scrolling keeps arrivals away, counts only new rows and clears the badge at the end', async (t) => {
  const { jumpVisible, awayCount } = await import('../src/chatGestures.js')
  const { pinToEnd } = await import('../src/dm-screen.js')
  const { olderInitial, olderStep } = await import('../src/olderTrigger.js')
  for (const file of ['Grupo', 'Mensagem']) {
    const src = source('screens/' + file + '.js')
    const start = src.indexOf('  const trackBottom =')
    let seen = 'b'
    let shown = false
    const env = {
      useCallback: (fn) => fn,
      pinToEnd,
      olderStep,
      olderState: { current: olderInitial() },
      userScrolled: { current: false },
      olderLive: { current: { hasNext: false, loading: false, failed: false, loadOlder: null } },
      jumpVisible,
      scrollFrame: { current: {} },
      setShowJump: (value) => { shown = value },
      endPin: { current: { pinned: false, newest: 'b', lastY: null } },
      lastY: { current: null },
      atBottom: { current: true },
      away: { current: false },
      latestKeyRef: { current: 'b' },
      setLastSeenKey: (value) => { seen = value }
    }
    const track = runInNewContext(src.slice(start, src.indexOf('  useEffect(', start)) + '\ntrackBottom', env)
    track({ y: 100, contentHeight: 1600, layoutHeight: 400 })
    t.ok(shown, file + ' shows jump while reading above')
    t.ok(env.away.current)
    env.latestKeyRef.current = 'c'
    env.endPin.current = pinToEnd(env.endPin.current, { kind: 'newest', newest: 'c' })
    let follows = 0
    const followStart = src.indexOf('  const followEnd =')
    const follow = runInNewContext(src.slice(followStart, src.indexOf('  const releaseEnd =', followStart)) + '\nfollowEnd', {
      ...env,
      listRef: { current: { scrollToEnd: () => follows++ } },
      opened: { current: true },
      settleTimer: { current: null },
      clearTimeout () {},
      setTimeout: () => 1
    })
    follow()
    t.is(follows, 0, file + ' does not follow an arrival while away')
    t.is(awayCount(['old', 'a', 'b', 'c'].map((key) => ({ key })), seen), 1)
    track({ y: 1300, contentHeight: 1700, layoutHeight: 400 })
    t.absent(shown)
    t.absent(env.away.current)
    t.is(seen, 'c')
    follow()
    t.is(follows, 1, file + ' follows again after returning')
    env.endPin.current.pinned = true
    track({ y: 1400, contentHeight: 2200, layoutHeight: 400 })
    t.absent(env.away.current, file + ' an automatic frame does not count as leaving')
  }
})

test('DM loads older pages near the top only after the person scrolled, once per visit, never after an error', async (t) => {
  const { jumpVisible } = await import('../src/chatGestures.js')
  const { pinToEnd } = await import('../src/dm-screen.js')
  const { olderInitial, olderStep } = await import('../src/olderTrigger.js')
  const src = source('screens/Mensagem.js')
  const start = src.indexOf('  const userScroll =')
  const end = src.indexOf('  useEffect(', start)
  t.ok(start > 0 && end > start)
  const body = src.slice(start, end)
  for (const call of ['send(', 'dm(', 'request(', 'setDraft', 'dm.seen']) t.absent(body.includes(call), 'the scroll path never ' + call)
  let loads = 0
  let releases = 0
  const env = {
    useCallback: (fn) => fn,
    pinToEnd,
    jumpVisible,
    olderStep,
    olderState: { current: olderInitial() },
    userScrolled: { current: false },
    olderLive: { current: { hasNext: true, loading: false, failed: false, loadOlder: () => { loads++ } } },
    releaseEnd: () => { releases++ },
    openRun: { current: { started: false } },
    settleOpen () {},
    scrollFrame: { current: {} },
    setShowJump () {},
    endPin: { current: { pinned: true, newest: 'b', lastY: null } },
    lastY: { current: null },
    atBottom: { current: true },
    away: { current: false },
    latestKeyRef: { current: 'b' },
    setLastSeenKey () {}
  }
  const { track, scroll } = runInNewContext(body + '\n;({ track: trackBottom, scroll: userScroll })', env)
  const frame = (y) => track({ y, contentHeight: 1600, layoutHeight: 400 })
  frame(0)
  t.is(loads, 0, 'the first layout at the top does not load')
  frame(120)
  frame(1200)
  t.is(loads, 0, 'the opening scroll to the end passes the top without loading')
  scroll()
  t.is(releases, 1, 'a user scroll still releases the end pin')
  t.ok(env.userScrolled.current)
  frame(600)
  t.is(loads, 0, 'away from the top nothing loads')
  frame(150)
  t.is(loads, 1, 'near the top after a scroll loads once')
  frame(90)
  frame(0)
  t.is(loads, 1, 'staying near the top does not load again')
  env.olderLive.current.loading = true
  frame(700)
  frame(100)
  t.is(loads, 1, 'no second page while one loads')
  env.olderLive.current.loading = false
  frame(700)
  env.olderLive.current.hasNext = false
  frame(100)
  t.is(loads, 1, 'nothing older, nothing to load')
  env.olderLive.current.hasNext = true
  frame(700)
  env.olderLive.current.failed = true
  frame(100)
  t.is(loads, 1, 'after an error only the pill retries')
  env.olderLive.current.failed = false
  frame(80)
  t.is(loads, 1, 'an error cleared near the top waits for the person to leave first')
  frame(700)
  frame(80)
  t.is(loads, 2, 'returning to the top loads again')
  t.ok(src.includes("<Pill label='mensagens anteriores' onPress={loadOlder} pending={loadingMore} />"), 'the pill stays as the manual load')
  t.ok(src.includes("olderLive.current = { hasNext: !!next, loading: loadingMore, failed: loadError !== '', loadOlder }"))
  t.ok(src.includes('onUserScroll={userScroll}'))
})

test('group loads older pages near the top only after the person scrolled, once per visit, never after an error', async (t) => {
  const { jumpVisible } = await import('../src/chatGestures.js')
  const { pinToEnd } = await import('../src/dm-screen.js')
  const { olderInitial, olderStep } = await import('../src/olderTrigger.js')
  const src = source('screens/Grupo.js')
  const start = src.indexOf('  const userScroll =')
  const end = src.indexOf('  useEffect(', start)
  t.ok(start > 0 && end > start)
  const body = src.slice(start, end)
  for (const call of ['send(', 'group(', 'request(', 'setDraft', 'markSeen', 'group.seen', 'typing']) t.absent(body.includes(call), 'the scroll path never ' + call)
  let loads = 0
  let releases = 0
  const env = {
    useCallback: (fn) => fn,
    pinToEnd,
    jumpVisible,
    olderStep,
    olderState: { current: olderInitial() },
    userScrolled: { current: false },
    olderLive: { current: { hasNext: true, loading: false, failed: false, loadOlder: () => { loads++ } } },
    releaseEnd: () => { releases++ },
    openRun: { current: { started: false } },
    settleOpen () {},
    scrollFrame: { current: {} },
    setShowJump () {},
    endPin: { current: { pinned: true, newest: 'b', lastY: null } },
    lastY: { current: null },
    atBottom: { current: true },
    away: { current: false },
    latestKeyRef: { current: 'b' },
    setLastSeenKey () {}
  }
  const { track, scroll } = runInNewContext(body + '\n;({ track: trackBottom, scroll: userScroll })', env)
  const frame = (y) => track({ y, contentHeight: 1600, layoutHeight: 400 })
  frame(0)
  t.is(loads, 0, 'the first layout at the top does not load')
  frame(0)
  t.is(loads, 0, 'a resize frame at the top does not load either')
  frame(120)
  frame(1200)
  t.is(loads, 0, 'the opening scroll to the end passes the top without loading')
  scroll()
  t.is(releases, 1, 'a user scroll still releases the end pin')
  t.is(loads, 0, 'the scroll gesture alone never loads')
  t.ok(env.userScrolled.current)
  frame(600)
  t.is(loads, 0, 'away from the top nothing loads')
  frame(150)
  t.is(loads, 1, 'near the top after a scroll loads once')
  frame(90)
  frame(0)
  t.is(loads, 1, 'staying near the top does not load again')
  env.olderLive.current.loading = true
  frame(700)
  frame(100)
  t.is(loads, 1, 'no second page while one loads')
  env.olderLive.current.loading = false
  frame(700)
  env.olderLive.current.hasNext = false
  frame(100)
  t.is(loads, 1, 'nothing older, nothing to load')
  env.olderLive.current.hasNext = true
  frame(700)
  env.olderLive.current.failed = true
  frame(100)
  t.is(loads, 1, 'after an error only the pill retries')
  env.olderLive.current.failed = false
  frame(80)
  t.is(loads, 1, 'an error cleared near the top waits for the person to leave first')
  frame(700)
  frame(80)
  t.is(loads, 2, 'returning to the top loads again')
  t.ok(src.includes("<Pill label='Mensagens anteriores' onPress={loadOlder} pending={loadingMore} />"), 'the pill stays as the manual load')
  t.ok(src.includes("olderLive.current = { hasNext: reader && !!store.next, loading: loadingMore, failed: moreError !== '', loadOlder }"))
  const list = src.slice(src.indexOf('<RefreshableList'), src.indexOf('\n      />', src.indexOf('<RefreshableList')))
  t.ok(list.includes('onUserScroll={userScroll}'))
})

test('quote jumps settle once, preserve the pin on failure and cancel on navigation or user scroll', async (t) => {
  const { pinToEnd } = await import('../src/dm-screen.js')
  const { olderInitial } = await import('../src/olderTrigger.js')
  for (const file of ['Mensagem', 'Grupo']) {
    const src = source('screens/' + file + '.js')
    const timers = new Map()
    const jumps = []
    const announcements = []
    let serial = 0
    let flash = null
    let toast = false
    const env = {
      rows: [{ key: 'one' }, { key: 'two' }],
      rowsRef: { current: [{ key: 'one' }, { key: 'two' }] },
      listRef: { current: { scrollToIndex: (options) => jumps.push(options) } },
      away: { current: false },
      endPin: { current: { pinned: true } },
      pinToEnd,
      jumpTimer: { current: null },
      quoteTimer: { current: null },
      setTimeout: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial },
      clearTimeout: (id) => timers.delete(id),
      setFlashKey: (key) => { flash = key },
      setQuoteToast: (value) => { toast = value },
      AccessibilityInfo: { announceForAccessibility: (text) => announcements.push(text) },
      indexJump: { current: null },
      useCallback: (fn) => fn
    }
    const fire = (id) => {
      const timer = timers.get(id)
      timers.delete(id)
      if (timer) timer.fn()
    }
    const start = src.indexOf('  const scrollToKey =')
    const end = src.indexOf(file === 'Mensagem' ? '  // The thread as offer input:' : '  const hide =', start)
    const jump = runInNewContext(src.slice(start, end) + '\nscrollToKey', env)
    jump('one')
    t.absent(env.endPin.current.pinned, file + ' releases after a successful scroll')
    t.ok(env.away.current)
    t.is(jumps[0].index, 0)
    t.is(flash, null, 'flash waits until the target has settled')
    t.is(timers.get(env.jumpTimer.current).ms, 120)
    fire(env.jumpTimer.current)
    t.is(jumps.length, 2, file + ' scrolls again even if the first estimated offset succeeded')
    t.is(jumps[1].index, 0)
    t.is(flash, 'one')
    t.is(timers.size, 1, 'only the flash timer remains, no scroll loop')
    fire(env.quoteTimer.current)
    t.is(flash, null)
    jump('missing')
    t.is(jumps.length, 2)
    t.ok(toast)
    t.is(announcements.at(-1), 'Mensagem fora do trecho carregado')
    fire(env.quoteTimer.current)
    t.absent(toast)
    const list = env.listRef.current
    env.listRef.current = { scrollToIndex: () => { throw new Error('not measured') } }
    env.away.current = false
    const pin = env.endPin.current = { pinned: true }
    jump('two')
    t.absent(env.away.current, file + ' failed jump leaves away untouched')
    t.is(env.endPin.current, pin, 'failed jump leaves the pin untouched')
    t.ok(toast)
    t.absent(timers.has(env.jumpTimer.current), 'no retry after a failed first scroll')
    env.listRef.current = list
    jump('two')
    const releaseStart = src.indexOf('  const releaseEnd =')
    const releaseEnd = src.indexOf('  }, [])', releaseStart) + '  }, [])'.length
    runInNewContext(src.slice(releaseStart, releaseEnd) + '\nreleaseEnd()', env)
    fire(env.jumpTimer.current)
    t.is(jumps.length, 3, 'user scrolling cancels the follow-up')
    jump('one')
    env.rowsRef.current = [{ key: 'older' }, { key: 'one' }, { key: 'two' }]
    fire(env.jumpTimer.current)
    t.is(jumps.at(-1).index, 1, file + ' the follow-up finds the row again after an older page landed')
    env.rowsRef.current = [{ key: 'one' }, { key: 'two' }]
    fire(env.quoteTimer.current)

    let deps = null
    let cleanup
    const context = {
      ...env,
      peer: 'peer',
      pageKey: null,
      ownKey: 'me',
      group: 'group',
      asPage: { key: null },
      ready: true,
      isTop: true,
      olderInitial,
      userScrolled: { current: true },
      olderState: { current: { fired: true } },
      openRun: { current: { started: true, placed: true, older: 2, tries: 3 } },
      openTimer: { current: null },
      cursorRef: { current: 'one' },
      viewableRef: { current: ['one'] },
      setPlaced: (value) => { context.placed = value },
      setOpenFailed: (value) => { context.failed = value },
      setCursor: (value) => { context.cursor = value },
      setLastSeenKey: (value) => { context.seen = value },
      setShowJump: (value) => { context.shown = value },
      useEffect: (effect, next) => {
        if (deps && next.every((value, i) => value === deps[i])) return
        if (cleanup) cleanup()
        deps = next
        cleanup = effect()
      }
    }
    const resetStart = src.indexOf('  useEffect(', src.indexOf('  const jumpTimer ='))
    const resetEnd = src.indexOf('  useEffect(', resetStart + 1)
    const reset = () => runInNewContext(src.slice(resetStart, resetEnd), context)
    reset()
    jump('one')
    context.seen = 'one'
    context.shown = true
    context.isTop = false
    context.ready = false
    reset()
    t.ok(env.away.current, file + ' covered screen keeps away state')
    t.is(context.seen, 'one')
    t.ok(context.shown)
    t.ok(timers.has(env.jumpTimer.current), 'covered screen keeps the quote follow-up')
    fire(env.jumpTimer.current)
    t.is(jumps.length, 7)
    jump('two')
    context.peer = 'other'
    context.group = 'other'
    reset()
    fire(env.jumpTimer.current)
    t.is(jumps.length, 8, 'changed conversation cancels the follow-up')
    t.absent(env.away.current)
    t.absent(context.userScrolled.current, file + ' another thread waits for a new scroll before loading older pages')
    t.alike(context.olderState.current, olderInitial())
    if (file === 'Mensagem') {
      t.is(JSON.stringify(context.openRun.current), JSON.stringify({ started: false, placed: false, older: 0, tries: 0, grown: 0 }), 'another thread lands again')
      t.is(context.cursorRef.current, null)
      t.is(context.placed, false)
    }
    t.is(context.seen, null)
    t.absent(context.shown)
    jump('one')
    cleanup()
    fire(env.jumpTimer.current)
    t.is(jumps.length, 9, 'unmount cancels the follow-up')
  }
})

test('new own DM returns to the end while incoming messages preserve the reading position', async (t) => {
  const { pinToEnd } = await import('../src/dm-screen.js')
  const src = source('screens/Mensagem.js')
  const start = src.indexOf('  useEffect(() => {\n    if (!loaded || newest')
  const end = src.indexOf('\n\n', start)
  const followStart = src.indexOf('  const followEnd =')
  const followEnd = src.indexOf('  const releaseEnd =', followStart)
  for (const mine of [false, true]) {
    let follows = 0
    let seen = 'old'
    const env = {
      loaded: true,
      newest: 'new',
      gestureRows: [{ key: 'new', mine }],
      useEffect: (fn) => fn(),
      useCallback: (fn) => fn,
      opened: { current: true },
      away: { current: true },
      endPin: { current: { pinned: false, newest: 'old' } },
      jumpTimer: { current: 1 },
      settleTimer: { current: null },
      latestKeyRef: { current: 'new' },
      pinToEnd,
      clearTimeout () {},
      setTimeout: () => 2,
      setLastSeenKey: (key) => { seen = key },
      setShowJump () {},
      openRun: { current: { started: true } },
      planRef: { current: { kind: 'row', key: 'x' } },
      releaseEnd () {},
      settleOpen () {},
      listRef: { current: { scrollToEnd: () => follows++ } }
    }
    runInNewContext(src.slice(followStart, followEnd) + src.slice(start, end), env)
    t.is(env.away.current, !mine)
    t.is(follows, mine ? 1 : 0)
    t.is(seen, mine ? 'new' : 'old')
    t.ok(env.endPin.current.pinned)
  }
})

test('DM open lands on the first unread: the first newest run skips followEnd on a row or older plan', async (t) => {
  const { pinToEnd } = await import('../src/dm-screen.js')
  const src = source('screens/Mensagem.js')
  const start = src.indexOf('  useEffect(() => {\n    if (!loaded || newest')
  const end = src.indexOf('\n\n', start)
  const followStart = src.indexOf('  const followEnd =')
  const followEnd = src.indexOf('  const releaseEnd =', followStart)
  for (const kind of ['end', 'row', 'older', null]) {
    let follows = 0
    let releases = 0
    let settles = 0
    const env = {
      loaded: true,
      newest: 'new',
      gestureRows: [{ key: 'new', mine: false }],
      useEffect: (fn) => fn(),
      useCallback: (fn) => fn,
      opened: { current: false },
      away: { current: false },
      endPin: { current: { pinned: true, newest: '' } },
      jumpTimer: { current: null },
      settleTimer: { current: null },
      latestKeyRef: { current: 'new' },
      pinToEnd,
      clearTimeout () {},
      setTimeout: () => 2,
      setLastSeenKey () {},
      setShowJump () {},
      openRun: { current: { started: false } },
      planRef: { current: kind === null ? null : { kind, key: 'new' } },
      releaseEnd: () => { releases++ },
      settleOpen: () => { settles++ },
      listRef: { current: { scrollToEnd: () => follows++ } }
    }
    runInNewContext(src.slice(followStart, followEnd) + src.slice(start, end), env)
    const lands = kind === 'row' || kind === 'older'
    t.ok(env.openRun.current.started)
    t.is(follows, lands ? 0 : 1, kind + ' open follows the end only without unread')
    t.is(env.away.current, lands)
    t.is(releases, lands ? 1 : 0)
    t.is(settles, lands ? 0 : 1, 'an end open is placed at once')
  }
})

test('DM marks seen only after the landing, and the viewability handler stays off the scroll path', (t) => {
  const src = source('screens/Mensagem.js')
  const effect = src.slice(src.indexOf('  const endShown ='), src.indexOf('  const userScroll ='))
  t.ok(effect.includes("newest === '' || !placed) {"), 'dm.seen waits for placed')
  t.ok(effect.includes('seenAt.current = { peer, upTo }'))
  t.ok(effect.includes('setTimeout(() => flushSeen.current(), 400)'))
  t.absent(src.includes("dm('dm.seen', { peer, upTo: null"), 'never a null upTo')
  const scroll = src.slice(src.indexOf('  const userScroll ='), src.indexOf('  useEffect(', src.indexOf('  const userScroll =')))
  t.absent(scroll.includes('const viewable ='), 'the viewability handler is outside the scroll path')
  t.ok(src.indexOf('  const viewable = useCallback(') > 0)
  t.ok(src.includes('onViewableItemsChanged={viewable}'))
  t.ok(src.includes('onScrollToIndexFailed={indexFailed}'))
  const cursor = src.slice(src.indexOf('  const moveCursor ='), src.indexOf('  const settleOpen ='))
  t.ok(cursor.includes('if (!openRun.current.placed) return'), 'the cursor ignores rows before the landing')
})

test('DM quote jump to an unmeasured row reports it through onScrollToIndexFailed and keeps the pin', async (t) => {
  const { pinToEnd } = await import('../src/dm-screen.js')
  const src = source('screens/Mensagem.js')
  const start = src.indexOf('  const scrollToKey =')
  const end = src.indexOf('  // The thread as offer input:', start)
  const announcements = []
  const env = {
    rows: [{ key: 'one' }],
    rowsRef: { current: [{ key: 'one' }] },
    away: { current: false },
    endPin: { current: { pinned: true } },
    pinToEnd,
    jumpTimer: { current: null },
    quoteTimer: { current: null },
    indexJump: { current: null },
    setTimeout: () => 1,
    clearTimeout () {},
    setFlashKey () {},
    setQuoteToast () {},
    AccessibilityInfo: { announceForAccessibility: (text) => announcements.push(text) }
  }
  const { jump, failed } = runInNewContext(src.slice(start, end) + '\n;({ jump: scrollToKey, failed: indexFailed })', env)
  env.listRef = { current: { scrollToIndex: ({ index }) => failed({ index, averageItemLength: 50 }) } }
  jump('one')
  t.is(announcements.at(-1), 'Mensagem fora do trecho carregado')
  t.ok(env.endPin.current.pinned, 'a failed jump puts the pin back')
  t.absent(env.away.current)
  t.is(env.indexJump.current, null)
})

test('group open lands on the first unread: the first newest run skips followEnd on a row or older plan', async (t) => {
  const { pinToEnd } = await import('../src/dm-screen.js')
  const src = source('screens/Grupo.js')
  const start = src.indexOf('  useEffect(() => {\n    if (lastId === null) return')
  const end = src.indexOf('\n\n', start)
  const followStart = src.indexOf('  const followEnd =')
  const followEnd = src.indexOf('  const releaseEnd =', followStart)
  const openStart = src.indexOf('  const startOpen = () => {')
  const openEnd = src.indexOf('  const last = rows', openStart)
  t.ok(start > 0 && openStart > 0 && openEnd > openStart)
  for (const kind of ['end', 'row', 'older', null]) {
    let follows = 0
    let releases = 0
    let settles = 0
    const env = {
      lastId: 'w:2',
      useEffect: (fn) => fn(),
      useCallback: (fn) => fn,
      useRef: (current) => ({ current }),
      away: { current: false },
      endPin: { current: { pinned: true, newest: null } },
      settleTimer: { current: null },
      pinToEnd,
      clearTimeout () {},
      setTimeout: () => 2,
      openRun: { current: { started: false } },
      planRef: { current: kind === null ? null : { kind, key: 'w:2' } },
      releaseEnd: () => { releases++ },
      settleOpen: () => { settles++ },
      listRef: { current: { scrollToEnd: () => follows++ } }
    }
    runInNewContext(src.slice(followStart, followEnd) + src.slice(openStart, openEnd) + src.slice(start, end), env)
    const lands = kind === 'row' || kind === 'older'
    t.is(env.openRun.current.started, kind !== null, 'not loaded yet: the driver starts it')
    t.is(follows, lands ? 0 : 1, kind + ' open follows the end only without unread')
    t.is(env.away.current, lands)
    t.is(releases, lands ? 1 : 0)
    t.is(settles, kind === 'end' ? 1 : 0, 'an end open is placed at once')
  }
})

test('group marks seen only after the landing, and the viewability handler stays off the scroll path', (t) => {
  const src = source('screens/Grupo.js')
  const cut = src.slice(src.indexOf('  const seenAt = seenCut(rawItems)'), src.indexOf('  const seenKey ='))
  t.ok(cut.includes('if (!placed) cutRef.current = null'), 'no cut-off before the landing')
  const effect = src.slice(src.indexOf('  const visible = node.visible !== false'), src.indexOf('  olderLive.current = {'))
  t.ok(effect.includes("loadError !== '' || !placed) {"), 'group.seen waits for placed')
  t.ok(effect.includes('setTimeout(() => flushSeen.current(), 400)'))
  t.is(src.split("request('group.seen'").length, 2, 'one group.seen call, in markSeen')
  const scroll = src.slice(src.indexOf('  const userScroll ='), src.indexOf('  useEffect(', src.indexOf('  const userScroll =')))
  t.absent(scroll.includes('const viewable ='), 'the viewability handler is outside the scroll path')
  t.ok(src.indexOf('  const viewable = useCallback(') > 0)
  t.ok(src.includes('onViewableItemsChanged={viewable}'))
  t.ok(src.includes('onScrollToIndexFailed={indexFailed}'))
  const cursor = src.slice(src.indexOf('  const moveCursor ='), src.indexOf('  const settleOpen ='))
  t.ok(cursor.includes('if (!openRun.current.placed) return'), 'the cursor ignores rows before the landing')
  const driver = src.slice(src.indexOf("    if (openKind === 'older') {"), src.indexOf("    if (openKind === 'end') {"))
  t.ok(driver.includes('walksRef.current.target() !== null'), 'no older page during a reload walk-back')
})

test('group quote jump to an unmeasured row reports it through onScrollToIndexFailed and keeps the pin', async (t) => {
  const { pinToEnd } = await import('../src/dm-screen.js')
  const src = source('screens/Grupo.js')
  const start = src.indexOf('  const scrollToKey =')
  const end = src.indexOf('  const hide = async', start)
  const announcements = []
  const env = {
    rows: [{ key: 'one' }],
    rowsRef: { current: [{ key: 'one' }] },
    away: { current: false },
    endPin: { current: { pinned: true } },
    pinToEnd,
    jumpTimer: { current: null },
    quoteTimer: { current: null },
    indexJump: { current: null },
    setTimeout: () => 1,
    clearTimeout () {},
    setFlashKey () {},
    setQuoteToast () {},
    AccessibilityInfo: { announceForAccessibility: (text) => announcements.push(text) }
  }
  const { jump, failed } = runInNewContext(src.slice(start, end) + '\n;({ jump: scrollToKey, failed: indexFailed })', env)
  env.listRef = { current: { scrollToIndex: ({ index }) => failed({ index, averageItemLength: 50 }) } }
  jump('one')
  t.is(announcements.at(-1), 'Mensagem fora do trecho carregado')
  t.ok(env.endPin.current.pinned, 'a failed jump puts the pin back')
  t.absent(env.away.current)
  t.is(env.indexJump.current, null)
})

test('JumpToEnd is a 36 pt button with a 44 pt target, a dot, the count as hint and a fade', (t) => {
  const src = source('ui/JumpToEnd.js')
  t.ok(src.includes('width: 36, height: 36'))
  t.ok(src.includes('hitSlop={4}'))
  t.ok(src.includes('{count > 0 ? <View style={styles.dotPosition}><Badge /></View> : null}') && src.includes("dotPosition: { position: 'absolute', top: 0, right: 0 }"))
  t.ok(src.includes("accessibilityHint={count > 0 ? count + ' novas' : undefined}"))
  t.ok(src.includes('duration: motion.fast'))
  t.ok(src.includes('useReduceMotion'))
})

test('JumpToEnd anchor has real bounds and lets the list through, so the button stays tappable on iOS and web', (t) => {
  const src = source('ui/JumpToEnd.js')
  t.absent(/anchor: \{ height: 0/.test(src), 'a zero-height parent clips touches outside its bounds')
  t.ok(/anchor: \{ height: [1-9]\d*,/.test(src))
  t.ok(src.includes("pointerEvents='box-none'"))
  t.absent(/button: \{ position: 'absolute'/.test(src), 'the button sits in the anchor flow, not outside it')
})

test('both chats show new arrivals even less than one and a half viewports away', async (t) => {
  const { awayCount } = await import('../src/chatGestures.js')
  for (const file of ['Mensagem', 'Grupo']) {
    const src = source('screens/' + file + '.js')
    const condition = src.match(/\{([^{}\n]+) \? <JumpToEnd/)[1]
    // inTopics: Grupo hides the cue on its Tópicos tab; Mensagem has no such tab.
    const env = { awayCount, rows: [{ key: 'seen' }, { key: 'new' }], lastSeenKey: 'seen', showJump: false, away: { current: true }, inTopics: false }
    t.ok(runInNewContext(condition, env), file + ' gives arrivals a cue near the end')
    t.absent(runInNewContext(condition, { ...env, away: { current: false } }), file + ' at the end, a row not yet marked seen shows no cue')
    t.absent(runInNewContext(condition, { ...env, lastSeenKey: 'new' }))
    t.ok(runInNewContext(condition, { ...env, lastSeenKey: 'new', showJump: true }))
  }
})

test('DM keeps the original quoted-preview condition and group capability wording', (t) => {
  const src = source('screens/Mensagem.js')
  const start = src.indexOf('  const quoted =')
  const end = src.indexOf('  const reply =', start)
  const env = { quoteAuthor: () => '', quoteMine: () => false, quoteMissing: () => false, quoteHandle: '', peer: 'peer', quoteTarget: () => ({ key: 'one' }), scrollToKey () {} }
  for (const replyTo of [null, undefined, '', 'quote']) {
    const quoted = runInNewContext(src.slice(start, end) + '\nquoted', { ...env, item: { key: 'two', replyTo } })
    if (replyTo == null) t.is(quoted, null)
    else {
      t.is(quoted.text, replyTo)
      t.is(typeof quoted.onPress, 'function')
    }
  }
  const missing = runInNewContext(src.slice(start, end) + '\nquoted', { ...env, quoteMissing: () => true, item: { key: 'two', replyTo: 'quote' } })
  t.is(missing.text, 'quote')
  t.is(missing.onPress, undefined)
  t.ok(source('screens/Grupo.js').includes('Comunidades disponíveis no site da associação ou no app ligado à instalação.'))
})

test('empty chat starters only fill the draft and respect writing capability', (t) => {
  const cases = {
    Grupo: {
      loadedAt: 1, loadError: '', canPost: true, node: { online: true, passkey: { status: { unlocked: true } } }, post: { pending: false }, pagePending: false, postHold: null, check: null, mediaHold: null, sendingMedia: false
    },
    Mensagem: {
      loaded: true, loadError: '', old: null, folder: 'inbox', blockNote: null, blocks: new Set(), peer: 'peer', node: { online: true }, post: { pending: false }, hold: null, mediaHold: null, sendingMedia: false
    }
  }
  for (const [file, env] of Object.entries(cases)) {
    const src = source('screens/' + file + '.js')
    const start = src.indexOf('        ListEmptyComponent=')
    const end = src.indexOf('\n        }', start)
    const empty = src.slice(start, end)
    const gate = empty.match(/\{(loaded(?:At)?[^\n]+)\n/)[1]
    const enabled = (change = {}) => !!runInNewContext(gate, { ...env, ...change })
    t.ok(enabled(), file + ' offers starters only inside the empty slot')
    t.absent(enabled({ node: { online: false } }))
    t.absent(enabled({ loadError: 'failed' }))
    t.absent(enabled({ sendingMedia: true }))
    t.absent(enabled({ mediaHold: {} }))
    t.absent(enabled({ post: { pending: true } }))
    if (file === 'Grupo') {
      t.absent(enabled({ canPost: false }), 'membership, acting mode and group state gate writing')
      t.absent(enabled({ node: { online: true, passkey: { status: { unlocked: false } } } }), 'locked')
      t.absent(enabled({ postHold: {} }))
      t.absent(enabled({ pagePending: true }))
      t.absent(src.includes('Só na versão web'))
    } else {
      t.absent(enabled({ folder: 'request' }))
      t.absent(enabled({ old: 'a'.repeat(64) }), 'an old-key thread is read-only')
      t.absent(enabled({ blockNote: 'blocked' }))
      t.absent(enabled({ blocks: new Set(['peer']) }))
      t.absent(enabled({ hold: {} }))
    }
    t.ok(empty.includes("['Oi', 'Tudo bem?']"))
    const handler = empty.match(/onPress=\{(\(\) => setDraft[^}]+)\}/)[1]
    for (const text of ['Oi', 'Tudo bem?']) {
      for (const typed of ['', 'Olá']) {
        let draft = typed
        runInNewContext(handler, { text, setDraft: (update) => { draft = update(draft) } })()
        t.is(draft, typed ? typed + '\n' + text : text, 'starters preserve an existing draft')
      }
    }
  }
})

test('SwipeReply provides RowShift with the value its transform uses', (t) => {
  const src = source('ui/SwipeReply.js')
  t.ok(src.includes('transform: [{ translateX: reduce ? 0 : x }]'))
  t.ok(src.includes('<RowShift.Provider value={reduce ? null : x}>{children}</RowShift.Provider>'))
})

test('group open whose rows painted before the read starts the older walk from the driver', (t) => {
  const src = source('screens/Grupo.js')
  const start = src.indexOf('  useEffect(() => {\n    const run = openRun.current\n    if (openKind === null')
  const end = src.indexOf('\n\n', start)
  t.ok(start > 0)
  for (const kind of ['older', 'row', 'end']) {
    let loads = 0
    let places = 0
    let follows = 0
    const env = {
      useEffect: (fn) => fn(),
      openKind: kind,
      openRowKey: null,
      loadingMore: false,
      rowKeys: [],
      walkEnds: 0,
      openRun: { current: { started: false, placed: false, older: 0 } },
      startOpenRef: { current: () => { env.openRun.current.started = true; return kind === 'end' } },
      olderLive: { current: { loading: false, loadOlder: () => { loads++ } } },
      walksRef: { current: { target: () => null } },
      settleOpen () {},
      away: { current: true },
      setLastSeenKey () {},
      latestKeyRef: { current: null },
      endPin: { current: { pinned: false } },
      followEnd: () => { follows++ },
      placeOpenRow: () => { places++ }
    }
    runInNewContext(src.slice(start, end), env)
    t.is(loads, kind === 'older' ? 1 : 0, kind + ': the walk starts in the same run')
    t.is(env.openRun.current.older, kind === 'older' ? 1 : 0)
    t.is(places, kind === 'row' ? 1 : 0)
    t.is(follows, kind === 'end' ? 1 : 0)
  }
})

test('content-size frames place the open row without spending its tries, bounded', async (t) => {
  const { GROWTH_PLACES, settleStep } = await import('../src/readPosition.js')
  for (const file of ['Mensagem', 'Grupo']) {
    const src = source('screens/' + file + '.js')
    const start = src.indexOf('  const placeOpenRow = useCallback(')
    const end = src.indexOf('  }, [settleOpen])', start) + '  }, [settleOpen])'.length
    let scrolls = 0
    let settles = 0
    const env = {
      useCallback: (fn) => fn,
      openRun: { current: { started: true, placed: false, tries: 2, grown: 0 } },
      planRef: { current: { kind: 'row', key: 'b' } },
      rowKeysRef: { current: ['a', 'b'] },
      listRef: { current: { scrollToIndex: () => { scrolls++ } } },
      indexJump: { current: null },
      openTimer: { current: null },
      settleStep,
      GROWTH_PLACES,
      settleOpen: () => { settles++ },
      clearTimeout () {},
      setTimeout: () => 1
    }
    const place = runInNewContext(src.slice(start, end) + '\n;placeOpenRow', env)
    for (let i = 0; i < GROWTH_PLACES + 5; i++) place(true)
    t.is(env.openRun.current.tries, 2, file + ': growth spends no try')
    t.is(env.openRun.current.grown, GROWTH_PLACES, file + ': growth is bounded')
    t.is(scrolls, GROWTH_PLACES)
    place()
    t.is(env.openRun.current.tries, 3, file + ': a timed pass spends one')
    t.is(settles, 0)
    t.ok(src.includes('if (openHeading()) placeOpenRow(true)\n'), file + ': growth places the row while the open heads for it')
    t.ok(src.includes('else followEnd()'), file + ': and follows the end otherwise')
  }
})

test('the end counts as shown only when the cursor reached the newest row', (t) => {
  for (const file of ['Mensagem', 'Grupo']) {
    const src = source('screens/' + file + '.js')
    t.ok(src.includes('  const endShown = placed && latestKey !== null && cursor === latestKey\n'), file + ': no sticky end open')
    const start = src.indexOf('  const settleOpen = useCallback(')
    const end = src.indexOf('  }, [moveCursor])', start) + '  }, [moveCursor])'.length
    for (const atEnd of [true, undefined]) {
      let cursor = null
      const env = {
        useCallback: (fn) => fn,
        openRun: { current: { placed: false } },
        openTimer: { current: null },
        indexJump: { current: null },
        latestKeyRef: { current: 'z' },
        cursorRef: { current: null },
        setPlaced () {},
        setCursor: (key) => { cursor = key },
        moveCursor () {},
        clearTimeout () {}
      }
      runInNewContext(src.slice(start, end) + '\n;settleOpen', env)(atEnd)
      t.is(cursor, atEnd ? 'z' : null, file + ': an end open starts the cursor at the newest row')
      t.ok(env.openRun.current.placed)
    }
  }
})

test('a failed older page during the open leaves only the end to mark', (t) => {
  const dm = source('screens/Mensagem.js')
  t.ok(dm.includes('  const openMissed = openKey !== null && !rowKeys.includes(openKey) && openFailed\n'))
  t.ok(dm.includes("  const upTo = !openMissed && cursorRow && typeof cursorRow.id === 'string' ? cursorRow.id : null\n"), 'DM: no upTo past a page that failed')
  const group = source('screens/Grupo.js')
  t.ok(group.includes('  const openMissed = openKey !== null && !rowKeys.includes(openKey) && openFailed\n'))
  const cut = group.slice(group.indexOf('  const seenAt = seenCut(rawItems)'), group.indexOf('  const seenKey ='))
  t.ok(cut.includes('else cutRef.current = cursorItem && !openMissed ?'), 'group: no cut past a page that failed')
  t.ok(cut.includes('else if (endShown) cutRef.current = seenAt'), 'the end still marks')
})

test('an older page that fails stays failed for the whole open, through later refreshes', async (t) => {
  for (const file of ['Mensagem', 'Grupo']) {
    const src = source('screens/' + file + '.js')
    t.ok(src.includes('loading: loadingMore, failed: openFailed })'), file + ': the plan reads the sticky flag, not the live error')
    t.is(src.split('setOpenFailed(false)').length, 2, file + ': only the reset of the open clears it')
    const reset = src.slice(src.indexOf('    openRun.current = { started: false'), src.indexOf('    return () => {', src.indexOf('    openRun.current = { started: false')))
    t.ok(reset.includes('setOpenFailed(false)'), file + ': cleared when another chat opens')
  }
  const failing = async () => { throw new Error('falhou') }
  const calls = []
  const record = (name) => (v) => calls.push([name, v])
  const dm = source('screens/Mensagem.js')
  const dmLoad = dm.slice(dm.indexOf('  const loadOlder = async () => {'), dm.indexOf('  olderLive.current = {'))
  const context = { live: true }
  const dmEnv = {
    peer: 'a'.repeat(64),
    nextRef: { current: 'c1' },
    loadingMore: false,
    endPin: { current: {} },
    pinToEnd: (state) => state,
    setLoadingMore: record('loading'),
    reactionContextRef: { current: context },
    dm: failing,
    olderErr: { current: false },
    setLoadError: record('error'),
    errorText: (err) => err.message,
    setOpenFailed: record('failed')
  }
  await runInNewContext(dmLoad + '\nloadOlder', { ...dmEnv })()
  t.alike(calls, [['loading', true], ['error', 'falhou'], ['failed', true], ['loading', false]], 'DM: failed before the spinner stops, in one batch')
  calls.length = 0
  const moved = { current: context }
  // The person opened another conversation while the page was in flight.
  await runInNewContext(dmLoad + '\nloadOlder', { ...dmEnv, reactionContextRef: moved, dm: async () => { moved.current = { live: true }; throw new Error('falhou') } })()
  t.absent(calls.some(([name]) => name === 'failed'), 'DM: a page of another conversation does not fail this open')
  calls.length = 0
  const group = source('screens/Grupo.js')
  const groupLoad = group.slice(group.indexOf('  const loadOlder = useCallback(async () => {'), group.indexOf('\n\n  const rawItems'))
  const groupEnv = {
    useCallback: (fn) => fn,
    storeRef: { current: { next: { at: 'a', writer: 'w', seq: 1 } } },
    loadingMore: false,
    endPin: { current: {} },
    pinToEnd: (state) => state,
    setLoadingMore: record('loading'),
    setMoreError: record('error'),
    readGroup: failing,
    readNewest () {},
    commitRead () {},
    errorText: (err) => err.message,
    setOpenFailed: record('failed')
  }
  await runInNewContext(groupLoad + '\nloadOlder', groupEnv)()
  t.alike(calls, [['loading', true], ['error', ''], ['error', 'falhou'], ['failed', true], ['loading', false]], 'group: failed before the spinner stops, in one batch')
})

test('a reload walk that ends without a commit wakes the group open it held back', async (t) => {
  const src = source('screens/Grupo.js')
  const walk = src.slice(src.indexOf('  const walkOlder = useCallback(async (walk, read) => {'), src.indexOf('  }, [readGroup, noteRead])') + '  }, [readGroup, noteRead])'.length)
  t.ok(walk.length > 100)
  for (const ended of [true, false]) {
    let ends = 0
    let stores = 0
    const env = {
      useCallback: (fn) => fn,
      walksRef: { current: { current: () => true, target: () => ({ pages: 3 }), end: () => ended } },
      applyPage: () => ({ next: { at: 'a', writer: 'w', seq: 1 } }),
      EMPTY_PAGES: {},
      reloadDone: () => false,
      readGroup: async () => { throw new Error('falhou') },
      setStore: () => { stores++ },
      noteRead () {},
      setWalkEnds: (fn) => { ends = fn(ends) }
    }
    await runInNewContext(walk + '\nwalkOlder', env)({ token: 1, target: { pages: 3 } }, {})
    t.is(ends, ended ? 1 : 0, ended ? 'a failed walk that ends says so' : 'a superseded walk leaves it to the newer one')
    t.is(stores, 0, 'nothing committed')
  }
  const newest = src.slice(src.indexOf('  const readNewest = useCallback('), src.indexOf('  }, [readGroup, noteRead, walkOlder, asPage.page])'))
  t.ok(newest.includes('if (walks.end(walk.token)) setWalkEnds((n) => n + 1)'), 'a failed newest read ends its walk the same way')
  t.ok(src.includes('  }, [openKind, openRowKey, loadingMore, rowKeys, walkEnds, settleOpen, placeOpenRow, followEnd])'), 'the open driver runs again on a walk end')
  const start = src.indexOf('  useEffect(() => {\n    const run = openRun.current\n    if (openKind === null')
  const driver = src.slice(start, src.indexOf('\n\n', start))
  let loads = 0
  let target = { pages: 3 }
  const env = {
    useEffect: (fn) => fn(),
    openKind: 'older',
    openRowKey: null,
    loadingMore: false,
    rowKeys: [],
    walkEnds: 0,
    openRun: { current: { started: true, placed: false, older: 1 } },
    startOpenRef: { current: () => false },
    olderLive: { current: { loading: false, loadOlder: () => { loads++ } } },
    walksRef: { current: { target: () => target } },
    settleOpen () {},
    followEnd () {},
    placeOpenRow () {}
  }
  runInNewContext(driver, { ...env })
  t.is(loads, 0, 'held back during the walk')
  target = null
  runInNewContext(driver, { ...env, walkEnds: 1 })
  t.is(loads, 1, 'goes on once the walk ended')
  t.is(env.openRun.current.older, 2)
})
