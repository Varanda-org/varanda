'use strict'

// Hidden warm reads and the freshness re-ask yield the lane. The screens and
// the names provider load react-native, so the priority is checked on the
// source: a background read carries a token, opening the tab promotes that
// same read, and the debounced name resolve stays visible.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8')

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}

function between (src, start, end) {
  const at = src.indexOf(start)
  if (at < 0) throw new Error('missing ' + start)
  const to = src.indexOf(end, at + start.length)
  if (to < 0) throw new Error('missing ' + end + ' after ' + start)
  return src.slice(at, to)
}

const peek = withoutComments(read('screens/Espiadinha.js'))
const avisos = withoutComments(read('screens/Avisos.js'))
const names = withoutComments(read('names.js'))

test('the two warm reads pass priority background with a token', (t) => {
  for (const src of [peek, avisos]) {
    t.is(src.split("priority: 'background'").length - 1, 1, 'only the warm read is background')
    t.ok(src.includes("quiet ? { priority: 'background', token: opts.token } : undefined"))
    t.is(src.split('loadFirst({ quiet: true, token })').length - 1, 1)
    t.is(src.split('const token = Symbol(').length - 1, 1)
  }
  const peekWarm = between(peek, 'const wait = node.whenIdle(PEEK_WARM_QUIET_MS)', 'return () => wait.cancel()')
  t.ok(peekWarm.includes('activeRef.current'), 'a tab that opened during the wait sends nothing here')
  t.ok(peekWarm.indexOf('activeRef.current') < peekWarm.indexOf('const token = Symbol('))
  t.ok(peekWarm.includes('warmToken: token'))
  t.ok(peekWarm.includes('loadFirst({ quiet: true, token })'))
  t.ok(peek.includes("request('peek.read', params, options)"), 'the lane reaches peek.read')
  const peekMore = between(peek, 'const loadMore = useCallback', 'const previous = useRef')
  t.absent(peekMore.includes('priority'), 'a later page stays visible')
  t.ok(peekMore.includes('peek({ limit: PEEK_LIMIT_MAX, after })'))

  const avisosWarm = between(avisos, 'const wait = node.whenIdle(NOTICES_FIRST_READ_QUIET_MS)', 'return () => wait.cancel()')
  t.ok(avisosWarm.includes('if (!canStart()) return'))
  t.ok(avisosWarm.indexOf('if (!canStart()) return') < avisosWarm.indexOf('const token = Symbol('))
  t.ok(avisosWarm.includes('warmToken: token'))
  t.ok(avisosWarm.includes('loadFirst({ quiet: true, token })'))
  t.ok(avisos.includes('request(method, params, activeRef.current ? undefined : lane)'), 'the lane reaches notices.list while the tab is hidden, and no later page keeps it once shown')
  const avisosMore = between(avisos, 'const loadMore = useCallback', 'const poll = useCallback')
  t.absent(avisosMore.includes('priority'))
  t.ok(avisosMore.includes('read(mine, after)'))
  const poll = between(avisos, 'const poll = useCallback', 'const previous = useRef')
  t.ok(poll.includes('loadFirst()'))
  t.absent(poll.includes('quiet'), 'the poll is not a background read')
})

test('opening the tab promotes a waiting warm read instead of sending another', (t) => {
  for (const src of [peek, avisos]) {
    const show = between(src, 'const prev = previous.current', 'const stale = shouldReloadOnShow')
    t.ok(show.includes('const shown = active && !prev.active'))
    t.ok(show.includes('warmToken: prev.warmToken'), 'a refresh bump while hidden keeps the token')
    t.ok(show.includes('if (shown) promote(prev.warmToken)'))
    t.absent(show.includes('loadFirst('), 'the show transition does not send a second read while one is waiting or in flight')
    const later = src.slice(src.indexOf('const stale = shouldReloadOnShow'))
    t.ok(later.includes('loadFirst()'), 'a stale show with nothing waiting still loads')
  }
})

test('the freshness re-ask is background and the debounced resolve is not', (t) => {
  const fresh = between(names, 'const fresh = signals', 'const viewsRef')
  t.ok(fresh.includes('FRESH_DEBOUNCE_MS'))
  t.ok(fresh.includes("queueBack(keys, 'background')"))
  const ask = between(names, 'const askFront = useCallback', 'const queueBack = useCallback')
  t.ok(ask.includes('schedule()'), 'the on-screen resolve uses the debounce')
  t.ok(ask.includes('const resolve = useCallback((key) => askFront([key]), [askFront])'))
  t.absent(ask.includes("'background'"))
  t.absent(ask.includes('priority'))
  t.ok(names.includes('const schedule = useCallback((ms = DEBOUNCE_MS)'))
  const flush = between(names, 'flushRef.current = async', 'useEffect(() => {\n    mountedRef')
  t.ok(flush.includes('!front.has(key) && backLaneRef.current.get(key) === \'background\''))
  t.ok(flush.includes("const lane = freshOnly ? { priority: 'background', token: Symbol('names-fresh') } : undefined"))
  t.ok(names.includes('promoteRef.current(backTokenRef.current)'), 'a name asked for the screen promotes a waiting background batch')
  t.ok(flush.includes("request('profile.read', { authors }, lane)"))
  const retries = between(names, 'const requeueRetries = useCallback', 'const quietNow')
  t.ok(retries.includes('queueBack(keys)'))
  t.absent(retries.includes("'background'"), 'a failure retry stays on the visible lane')
})
