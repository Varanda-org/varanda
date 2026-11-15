'use strict'

const test = require('brittle')
const fs = require('fs')
const { pathToFileURL } = require('url')
const path = require('path')

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'perfScroll.js')).href)
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('the plan is 60 s with 4 reversals', async (t) => {
  const { scrollPlan, TOTAL_MS } = await load()
  const plan = scrollPlan()
  t.is(TOTAL_MS, 60000)
  t.is(plan[0].start, 0)
  t.is(plan[plan.length - 1].end, 60000)
  let reversals = 0
  for (let i = 1; i < plan.length; i++) {
    t.is(plan[i].start, plan[i - 1].end, 'contiguous')
    if (plan[i].dir !== plan[i - 1].dir) reversals++
  }
  t.is(reversals, 4)
})

test('the driver runs on a fake clock at a fixed speed', async (t) => {
  const { createScrollDriver, scrollPlan, SPEED } = await load()
  let clock = 0
  let queue = null
  const offsets = []
  const notified = []
  let done = 0
  const d = createScrollDriver({
    now: () => clock,
    raf: (fn) => { queue = fn; return 1 },
    cancel: () => { queue = null },
    scrollTo: (y) => offsets.push([clock, y]),
    notify: () => notified.push(clock),
    onDone: () => { done++ }
  })
  d.start()
  while (queue) {
    const fn = queue
    queue = null
    fn()
    clock += 100
  }
  t.is(done, 1)
  t.is(notified.length, scrollPlan().length, 'one notify per segment')
  t.alike(notified, [0, 12000, 24000, 36000, 48000])
  t.is(offsets[offsets.length - 1][0] >= 60000, true, 'ran to the total duration')
  const [t1, y1] = offsets.find(([c]) => c === 5000)
  t.is(y1, SPEED * t1, 'fixed speed on the way down')
  let flips = 0
  for (let i = 2; i < offsets.length; i++) {
    const a = offsets[i - 1][1] - offsets[i - 2][1]
    const b = offsets[i][1] - offsets[i - 1][1]
    if (a > 0 && b < 0) flips++
    if (a < 0 && b > 0) flips++
  }
  t.is(flips, 4, 'four direction reversals')
})

test('offsets stay inside the content', async (t) => {
  const { offsetAt, scrollPlan } = await load()
  t.is(offsetAt(scrollPlan(), 11000, 1.2, 5000), 5000)
  t.is(offsetAt(scrollPlan(), 30000, 1.2, Infinity) >= 0, true)
})

test('content that grows after a clamped stretch never makes the offset jump', async (t) => {
  const { createScrollDriver } = await load()
  const plan = [{ start: 0, end: 10000, dir: 1 }, { start: 10000, end: 20000, dir: -1 }]
  let clock = 0
  let queue = null
  let max = 3000
  const offsets = []
  const d = createScrollDriver({
    now: () => clock,
    raf: (fn) => { queue = fn; return 1 },
    scrollTo: (y) => offsets.push([clock, y]),
    notify: () => {},
    max: () => max,
    plan,
    speed: 1
  })
  d.start()
  while (queue) {
    const fn = queue
    queue = null
    fn()
    clock += 100
    // more rows arrive at 5 s, after the scroll was held at the old end
    if (clock === 5000) max = 100000
  }
  const at = (c) => offsets.find(([x]) => x === c)[1]
  t.is(at(4900), 3000, 'held at the old end')
  t.is(at(5000), 3100, 'one frame of travel when the end moves, no jump to 5000')
  t.is(at(6000), 4100, 'goes on from where it was')
  t.is(at(10000), 8100)
  t.is(at(12000), 6100, 'the way back starts from the real offset')
  let maxStep = 0
  for (let i = 1; i < offsets.length; i++) maxStep = Math.max(maxStep, Math.abs(offsets[i][1] - offsets[i - 1][1]))
  t.is(maxStep, 100, 'never more than one frame of travel')
})

test('advance moves through segment boundaries inside one step', async (t) => {
  const { advance } = await load()
  const plan = [{ start: 0, end: 100, dir: 1 }, { start: 100, end: 200, dir: -1 }]
  t.is(advance(plan, 50, 50, 150, 1), 50, '+50 then -50')
  t.is(advance(plan, 0, 0, 100, 1, 30), 30, 'clamped to max')
  t.is(advance(plan, 10, 100, 200, 1), 0, 'never above the top')
})

test('claimScroll gives a list id one scripted run', async (t) => {
  const { claimScroll } = await load()
  const seen = new Set()
  t.is(claimScroll('rua', seen), true)
  t.is(claimScroll('rua', seen), false)
  t.is(claimScroll('diario', seen), true)
})

test('stop cancels the pending frame and nothing runs after', async (t) => {
  const { createScrollDriver } = await load()
  let queue = null
  let calls = 0
  const d = createScrollDriver({ now: () => 0, raf: (fn) => { queue = fn; return 7 }, cancel: () => { queue = null }, scrollTo: () => { calls++ }, notify: () => {} })
  d.start()
  d.stop()
  t.is(queue, null)
  t.is(calls, 0)
  t.is(d.running, false)
})

test('scrollWanted needs the flag on and the matching id', async (t) => {
  const { scrollWanted } = await load()
  t.is(scrollWanted('rua', true, 'rua'), true)
  t.is(scrollWanted('rua', false, 'rua'), false)
  t.is(scrollWanted('rua', true, 'diario'), false)
  t.is(scrollWanted(undefined, true, undefined), false)
  t.is(scrollWanted('', true, ''), false)
})

test('the list drives the scroll only behind the gate and reads the env literally in perfScroll', (t) => {
  const list = src('src/ui/RefreshableList.js')
  t.ok(list.includes('createScrollDriver('), 'list uses the driver')
  t.ok(/if \(!hasRows \|\| current !== null \|\| !scrollWanted\(perfId, perfOn\)\) return undefined/.test(list), 'driver behind scrollWanted, once per mount')
  t.ok(/run\.timer = setTimeout\(\(\) => \{[\s\S]*?run\.driver\.start\(\)\s+\}, SETTLE_MS\)/.test(list), 'starts after the settle delay')
  t.absent(/return \(\) => driver\.stop\(\)/.test(list), 'a hasRows flip does not stop and restart it')
  t.ok(/notify: notifyUserScroll/.test(list), 'each segment start tells the shell')
  t.ok(/onDone: \(\) => \{[\s\S]*?perf: frames [\s\S]*?endRenderPhase\(\)/.test(list), 'scroll-done flushes frames and renders')
  t.ok(src('src/perfScroll.js').includes('process.env.EXPO_PUBLIC_VARANDA_PERF_SCROLL'), 'literal env read')
  t.absent(src('index.js').includes('PERF_SCROLL'))
  t.absent(src('App.js').includes('PERF_SCROLL'))
})

// Regression: with a cached snapshot a hidden tab's list has rows, and it
// used to start (and spend the one claim) while another tab was shown.
test('the scripted scroll waits for the visible screen and claims only when it starts', (t) => {
  const list = src('src/ui/RefreshableList.js')
  t.ok(list.includes('const screenVisible = perfOn ? useContext(ScreenVisible) : false'), 'reads the screen visibility, only with the marks on')
  t.ok(/\}, \[hasRows, perfId, screenVisible, notifyUserScroll\]\)/.test(list), 'effect reruns when visibility changes')
  t.ok(/bootMarkOnce\('first-rows:' \+ perfId\)[\s\S]*?if \(!screenVisible\) \{[\s\S]*?return undefined\s+\}\s+if \(!hasRows \|\| current !== null \|\| !scrollWanted/.test(list), 'a hidden list schedules nothing')
  // Regression: the empty-rows return came first, so a tab hidden mid-refresh
  // kept its pending timer or running driver.
  t.ok(/if \(!perfOn \|\| !perfId\) return undefined\s+if \(hasRows\) bootMarkOnce\([^\n]*\n\s+const current = scripted\.current\s+if \(!screenVisible\) \{/.test(list), 'the hidden check runs with no rows too')
  t.absent(/!perfId \|\| !hasRows\) return undefined/.test(list), 'no early return on empty rows before the hidden check')
  t.ok(/if \(!screenVisible\) \{\s+if \(current !== null && current\.timer !== null\) \{\s+clearTimeout\(current\.timer\)\s+scripted\.current = null/.test(list), 'hidden before the start: the wait is dropped and can begin again')
  t.ok(/\} else if \(current !== null && current\.driver !== null\) \{\s+current\.driver\.stop\(\)[\s\S]*?perf: scroll-aborted/.test(list), 'hidden mid-run: stopped and discarded')
  t.ok(/run\.timer = setTimeout\(\(\) => \{\s+run\.timer = null\s+if \(!claimScroll\(perfId\)\) return\s+run\.driver = createScrollDriver\(/.test(list), 'claimed when the scroll starts')
  t.is(list.split('claimScroll(perfId)').length, 2, 'claimed in one place only')
})
