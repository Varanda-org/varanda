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
  const short = mount()
  short.move(172)
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
  for (const file of ['Grupo', 'Mensagem']) {
    const src = source('screens/' + file + '.js')
    const start = src.indexOf('  const trackBottom =')
    let seen = 'b'
    let shown = false
    const env = {
      useCallback: (fn) => fn,
      pinToEnd,
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

test('quote jumps settle once, preserve the pin on failure and cancel on navigation or user scroll', async (t) => {
  const { pinToEnd } = await import('../src/dm-screen.js')
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
      listRef: { current: { scrollToEnd: () => follows++ } }
    }
    runInNewContext(src.slice(followStart, followEnd) + src.slice(start, end), env)
    t.is(env.away.current, !mine)
    t.is(follows, mine ? 1 : 0)
    t.is(seen, mine ? 'new' : 'old')
    t.ok(env.endPin.current.pinned)
  }
})

test('both chats show new arrivals even less than one and a half viewports away', async (t) => {
  const { awayCount } = await import('../src/chatGestures.js')
  for (const file of ['Mensagem', 'Grupo']) {
    const src = source('screens/' + file + '.js')
    const condition = src.match(/\{([^{}\n]+) \? <JumpToEnd/)[1]
    const env = { awayCount, rows: [{ key: 'seen' }, { key: 'new' }], lastSeenKey: 'seen', showJump: false, away: { current: true } }
    t.ok(runInNewContext(condition, env), file + ' gives arrivals a cue near the end')
    t.absent(runInNewContext(condition, { ...env, away: { current: false } }), file + ' at the end, a row not yet marked seen shows no cue')
    t.absent(runInNewContext(condition, { ...env, lastSeenKey: 'new' }))
    t.ok(runInNewContext(condition, { ...env, lastSeenKey: 'new', showJump: true }))
  }
})

test('DM keeps the original quoted-preview condition and group capability wording', (t) => {
  const src = source('screens/Mensagem.js')
  const start = src.indexOf('          const quoted =')
  const end = src.indexOf('          const reply =', start)
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
      loaded: true, loadError: '', folder: 'inbox', blockNote: null, blocks: new Set(), peer: 'peer', node: { online: true }, post: { pending: false }, hold: null, mediaHold: null, sendingMedia: false
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
