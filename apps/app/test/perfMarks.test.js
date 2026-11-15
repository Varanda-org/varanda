'use strict'

const test = require('brittle')
const { pathToFileURL } = require('url')
const path = require('path')

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'perfMarks.js')).href)

test('perfEnabled needs a dev bundle and the env opt-in', async (t) => {
  const { perfEnabled } = await load()
  t.is(perfEnabled({ EXPO_PUBLIC_VARANDA_PERF: '1' }, true), true)
  t.is(perfEnabled({ EXPO_PUBLIC_VARANDA_PERF: '1' }, false), false)
  t.is(perfEnabled({}, true), false)
  t.is(perfEnabled({ EXPO_PUBLIC_VARANDA_PERF: '0' }, true), false)
  t.is(perfEnabled(undefined, true), false)
  t.is(perfEnabled({ EXPO_PUBLIC_VARANDA_PERF: '1' }, 1), false)
})

test('the dev hook forwards only the lab setup methods', async (t) => {
  const { devHookRequest, DEV_HOOK_METHODS } = await load()
  const sent = []
  const hook = devHookRequest(async (method, params) => { sent.push(method); return { ok: method, params } })
  t.alike([...DEV_HOOK_METHODS].sort(), ['community.join', 'follow.add', 'post.create'])
  t.alike(await hook('follow.add', { key: 'a' }), { ok: 'follow.add', params: { key: 'a' } })
  for (const method of ['post.delete', 'dm.send', 'identity.recoveryWrap', 'recovery.sign', 'follow.remove', 'constructor', undefined]) {
    await t.exception(hook(method, {}), /fora do gancho/, String(method) + ' refused')
  }
  t.alike(sent, ['follow.add'], 'nothing refused reached the node')
})

test('a disabled instance records nothing', async (t) => {
  const { createMarks } = await load()
  const marks = createMarks({ enabled: false, now: () => 0 })
  marks.mark('a')
  marks.span('b', 0, 5)
  t.alike(marks.report(), [])
})

test('mark and span lines keep order and format', async (t) => {
  const { createMarks } = await load()
  let clock = 1000
  const marks = createMarks({ enabled: true, now: () => clock })
  clock = 1050
  marks.mark('config')
  clock = 1200
  marks.mark('splash-end', 'feedReady')
  marks.span('req:feed.read', 1100, 1180)
  t.alike(marks.report(), ['perf: config 50', 'perf: splash-end 200 feedReady', 'perf: req:feed.read 80'])
})

test('fresh() prints each mark once and adopted marks never', async (t) => {
  const { createMarks } = await load()
  let clock = 0
  const marks = createMarks({ enabled: true, now: () => clock })
  marks.adopt('js-entry', 0, 'origin')
  clock = 10
  marks.mark('config')
  t.alike(marks.fresh(), ['perf: config 10'])
  t.alike(marks.fresh(), [], 'nothing twice')
  clock = 30
  marks.mark('tab:diario')
  t.alike(marks.fresh(), ['perf: tab:diario 30'])
  t.alike(marks.report(), ['perf: js-entry 0 origin', 'perf: config 10', 'perf: tab:diario 30'], 'report still has every retained line')
  const off = createMarks({ enabled: false })
  off.adopt('a', 1)
  t.alike(off.fresh(), [])
})

test('boot marks and node marks share one origin', async (t) => {
  const { createClock, createEarlyBuffer, createMarks, flushEarly } = await load()
  let clock = 500
  const c = createClock(() => clock)
  const buf = createEarlyBuffer({ clock: c })
  buf.mark('js-entry', 'origin')
  clock = 900
  const marks = createMarks({ enabled: true, clock: c })
  clock = 1000
  marks.mark('config')
  buf.mark('first-rows:rua')
  flushEarly(marks, buf)
  t.alike(marks.report(), ['perf: config 500', 'perf: js-entry 0 origin', 'perf: first-rows:rua 500'])
  t.alike(marks.fresh(), ['perf: config 500'], 'the boot marks were printed when made')
})

test('the ring keeps only the newest 256', async (t) => {
  const { createMarks } = await load()
  let clock = 0
  const marks = createMarks({ enabled: true, now: () => clock })
  for (let i = 0; i < 300; i++) { clock = i; marks.mark('m' + i) }
  const lines = marks.report()
  t.is(lines.length, 256)
  t.is(lines[0], 'perf: m44 44')
  t.is(lines[255], 'perf: m299 299')
})

test('frame stats: percentiles, slow count and a fake clock', async (t) => {
  const { createFrameStats, frameLine } = await load()
  let clock = 0
  let pending = null
  const raf = (fn) => { pending = fn }
  const frame = (gap) => { clock += gap; const fn = pending; pending = null; fn() }
  const stats = createFrameStats({ raf, now: () => clock })
  t.is(stats.stop(), null, 'stop before start gives nothing')
  stats.start()
  stats.start()
  for (let i = 0; i < 18; i++) frame(16)
  frame(40)
  frame(100)
  const s = stats.stop()
  t.alike(s, { count: 20, p50: 16, p95: 40, max: 100, over: 2 })
  t.is(frameLine(s), 'n=20 p50=16 p95=40 max=100 over32=2')
  t.is(stats.running, false)
})

test('frame stats: a stopped sampler lets its pending frame lapse', async (t) => {
  const { createFrameStats } = await load()
  let clock = 0
  let pending = null
  let calls = 0
  const stats = createFrameStats({ raf: (fn) => { calls++; pending = fn }, now: () => clock })
  stats.start()
  stats.stop()
  clock = 16
  pending()
  t.is(calls, 1, 'no new frame requested')
  stats.start()
  clock = 32
  pending()
  t.is(calls, 3)
  t.alike(stats.stop(), { count: 1, p50: 16, p95: 16, max: 16, over: 0 })
})

test('frame stats: nothing is scheduled until start', async (t) => {
  const { createFrameStats } = await load()
  let calls = 0
  createFrameStats({ raf: () => { calls++ }, now: () => 0 })
  t.is(calls, 0)
})

test('frame stats: the idle tail after the last scroll and a clock step back are left out', async (t) => {
  const { createFrameStats } = await load()
  let clock = 1000
  let pending = null
  const raf = (fn) => { pending = fn }
  const frame = (gap) => { clock += gap; const fn = pending; pending = null; fn() }
  const stats = createFrameStats({ raf, now: () => clock })
  stats.start()
  frame(50)
  frame(60)
  const lastScroll = clock
  for (let i = 0; i < 60; i++) frame(16)
  const s = stats.stop(lastScroll + 17)
  t.alike(s, { count: 3, p50: 50, p95: 60, max: 60, over: 2 }, 'the hitches, not a second of idle frames')
  stats.start()
  frame(16)
  clock -= 5000
  frame(16)
  frame(16)
  t.is(stats.stop().count, 2, 'no negative gap')
})

test('summary gives median, p95 and spread', async (t) => {
  const { summary } = await load()
  t.alike(summary([]), { count: 0, median: 0, p95: 0, spread: 0 })
  const s = summary([5, 1, 3, 2, 4, 100, 6, 7, 8, 9])
  t.is(s.count, 10)
  t.is(s.median, 5)
  t.is(s.p95, 100)
  t.is(s.spread, 99)
})

test('the early buffer keeps order, once-marks and drains', async (t) => {
  const { createEarlyBuffer, flushEarly } = await load()
  let clock = 1000
  const buf = createEarlyBuffer({ now: () => clock })
  buf.mark('js-entry')
  clock = 1040
  buf.markOnce('first-rows')
  t.is(buf.markOnce('first-rows'), null, 'second once-mark ignored')
  buf.span('sweep', 1000, 1012)
  const seen = []
  flushEarly({ adopt: (name, ms, extra) => seen.push([name, ms, extra]) }, buf)
  t.alike(seen, [['js-entry', 0, undefined], ['first-rows', 40, undefined], ['sweep', 12, undefined]])
  t.alike(buf.drain(), [], 'drained')
})

test('render stats aggregate per id and print on the interval', async (t) => {
  const { createRenderStats } = await load()
  let clock = 0
  const r = createRenderStats({ now: () => clock, everyMs: 5000 })
  t.is(r.record('tab:rua', 4), null)
  clock = 1000
  t.is(r.record('list:rua', 2), null)
  t.is(r.record('tab:rua', 6), null)
  clock = 5000
  const lines = r.record('tab:rua', 1)
  // the 5000 ms record counts too: tab:rua 3 renders totalling 4+6+1
  t.alike(lines, ['perf: render tab:rua 3 11', 'perf: render list:rua 1 2'])
  t.alike(r.flush(), [], 'reset after printing')
})

test('render stats: a phase holds its lines until it ends, flush prints on demand', async (t) => {
  const { createRenderStats } = await load()
  let clock = 0
  const r = createRenderStats({ now: () => clock, everyMs: 5000 })
  r.record('list:rua', 3)
  t.alike(r.begin('scroll:rua'), ['perf: render list:rua 1 3'], 'what came before prints untagged')
  for (let i = 0; i < 10; i++) {
    clock += 6000
    t.is(r.record('list:rua', 1), null, 'nothing prints inside the phase')
  }
  t.alike(r.flush(), ['perf: render list:rua 10 10 phase=scroll:rua'], 'flush keeps the phase')
  r.record('list:rua', 2)
  t.alike(r.end(), ['perf: render list:rua 1 2 phase=scroll:rua'], 'the tail is not lost')
  r.record('tab:rua', 1)
  t.alike(r.flush(), ['perf: render tab:rua 1 1'], 'untagged after the phase')
})

test('the row counter counts renders per mount, keeps mounts apart, then resets', async (t) => {
  const { createRowCounter, rowLine } = await load()
  const c = createRowCounter()
  const a = c.open('post:x:1')
  for (let i = 0; i < 9; i++) c.render(a)
  // a repost of the same post is its own row
  const b = c.open('repost:y:x:1')
  c.render(b)
  c.render(b)
  // one row mounted twice (scrolled out and back): two samples
  const d1 = c.open('post:z:2')
  c.render(d1)
  c.close(d1)
  const d2 = c.open('post:z:2')
  c.render(d2)
  c.close(d2)
  c.close(d2)
  c.render(d2)
  const s = c.stats()
  t.alike(s, { rows: 3, mounts: 4, unmounts: 2, median: 1, p95: 9 })
  t.is(rowLine(s), 'rows=3 mounts=4 unmounts=2 rendersPerMountMedian=1 rendersPerMountP95=9')
  t.alike(c.stats(), { rows: 0, mounts: 0, unmounts: 0, median: 0, p95: 0 }, 'reset; idle live rows give no sample')
  c.render(a)
  c.close(a)
  t.alike(c.stats(), { rows: 0, mounts: 0, unmounts: 1, median: 1, p95: 1 }, 'a row mounted earlier counts its new renders')
})

// Regression: all rows shared one counter, so one list's line took the other
// lists' rows and erased them from their own later lines.
test('row stats are kept and drained per list', async (t) => {
  const { openRow, countRowRender, closeRow, rowStatsLine } = await load()
  const r = openRow('post:a:1', 'perf-test-rua')
  countRowRender(r)
  countRowRender(r)
  const d = openRow('post:b:2', 'perf-test-diario')
  countRowRender(d)
  closeRow(d)
  const loose = openRow('post:c:3')
  countRowRender(loose)
  t.is(rowStatsLine('perf-test-rua'), 'rows=1 mounts=1 unmounts=0 rendersPerMountMedian=2 rendersPerMountP95=2', 'only its own rows')
  t.is(rowStatsLine('perf-test-diario'), 'rows=1 mounts=1 unmounts=1 rendersPerMountMedian=1 rendersPerMountP95=1', 'not erased by the other list')
  t.is(rowStatsLine('perf-test-rua'), 'rows=0 mounts=0 unmounts=0 rendersPerMountMedian=0 rendersPerMountP95=0', 'drained')
  t.is(rowStatsLine(undefined), 'rows=1 mounts=1 unmounts=0 rendersPerMountMedian=1 rendersPerMountP95=1', 'a row outside a list has its own counter')
})

test('PostRow counts rows under the list that RefreshableList names', (t) => {
  const row = src('src/ui/PostRow.js')
  t.ok(row.includes("import { PerfListId } from './screenVisible'"), 'the context comes from screenVisible')
  t.absent(/from '\.\/RefreshableList'/.test(row), 'PostRow does not import the list')
  t.ok(src('src/ui/screenVisible.js').includes("export const PerfListId = createContext('')"), 'inert default')
  t.ok(/import \{[^}]*PerfListId[^}]*\} from '\.\/screenVisible'/.test(src('src/ui/RefreshableList.js')), 'the list provides the same context')
  t.ok(/function usePerfRow \(key\) \{\s+const listId = useContext\(PerfListId\)[\s\S]*?openRow\(key, listId\)/.test(row), 'row opens under its list')
  const list = src('src/ui/RefreshableList.js')
  t.ok(/perfOn && perfId \? <PerfListId\.Provider value=\{perfId\}>/.test(list), 'list id provided only with the marks on')
  t.absent(/rowStatsLine\(\)/.test(list), 'every drain names its list')
})

// Source inspection: every call site sits behind perfOn, and the entry files
// name no flag. These fail on a version without the gate.
const fs = require('fs')
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('index.js and App.js name no perf or vitrine flag', (t) => {
  for (const f of ['index.js', 'App.js']) t.absent(/EXPO_PUBLIC_VARANDA_(PERF|VITRINE)/.test(src(f)), f)
})

test('perfMarks reads the flag once as a literal', (t) => {
  const s = src('src/perfMarks.js')
  t.ok(s.includes("export const perfOn = perfEnabled({ EXPO_PUBLIC_VARANDA_PERF: process.env.EXPO_PUBLIC_VARANDA_PERF }, typeof __DEV__ !== 'undefined' && __DEV__)"))
})

test('each new call site is behind perfOn', (t) => {
  const lines = (f) => src(f).split('\n')
  const gated = (f, needle) => {
    const ls = lines(f)
    const hits = ls.map((l, i) => [l, i]).filter(([l]) => l.includes(needle))
    t.ok(hits.length > 0, f + ' has ' + needle)
    for (const [l] of hits) t.ok(/perfOn/.test(l), f + ': ' + l.trim())
  }
  gated('index.js', 'bootSpan(')
  gated('index.js', 'monotonicNow()')
  gated('src/client/native.js', 'bootSpan(')
  gated('src/client/native.js', 'monotonicNow()')
  const rowCalls = lines('src/ui/PostRow.js').filter((l) => l.includes('usePerfRow(') && !l.startsWith('function '))
  t.ok(rowCalls.length > 0, 'PostRow counts renders')
  for (const l of rowCalls) t.ok(/if \(perfOn\) usePerfRow\(/.test(l), 'PostRow: ' + l.trim())
  t.ok(/function PostRowView \([\s\S]*?\}\) \{\s+\/\/[^\n]*\n\s+if \(perfOn\) usePerfRow\(/.test(src('src/ui/PostRow.js')), 'counted in PostRowView, not the memo gate')
  t.absent(/function BlockGate[\s\S]*?usePerfRow[\s\S]*?^export const PostRow/m.test(src('src/ui/PostRow.js')), 'not in BlockGate')
  gated('App.js', 'const tabProfiled')
  t.ok(/perfOn \? <Profiler/.test(src('App.js')), 'App Profiler only when on')
  t.ok(/perfOn && perfId \? <PerfListId\.Provider value=\{perfId\}><Profiler/.test(src('src/ui/RefreshableList.js')), 'list Profiler only when on and id set')
  t.ok(/if \(!perfOn\) return\s+bootMark\('app-commit'\)/.test(src('App.js')), 'app-commit gated')
  t.ok(/if \(!perfOn \|\| !perfId\) return undefined\s+if \(hasRows\) bootMarkOnce\('first-rows:' \+ perfId\)/.test(src('src/ui/RefreshableList.js')), 'first-rows per list, gated')
  for (const name of ['espiadinha', 'busca', 'rua', 'avisos', 'comunidades', 'feira', 'diario']) {
    t.ok(src('App.js').includes("tabProfiled('" + name + "',"), 'tab ' + name + ' profiled')
  }
  t.absent(/marks\.report\(\)|perfMarks\(\)\.report\(\)/.test(src('App.js')), 'App prints only fresh marks')
  t.ok(src('src/perfEntry.js').includes('if (perfOn) bootMark'), 'js-entry gated')
  t.ok(/cryptoPolyfill'[\s\S]*perfEntry/.test(src('index.js')), 'perfEntry follows the polyfill')
})
