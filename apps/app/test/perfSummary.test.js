'use strict'

const test = require('brittle')
const path = require('path')
const { parse, format, frameSamples, knownMark, loadStats, SAFE_TOKEN } = require(path.join(__dirname, '..', 'scripts', 'perf-summary.js'))

// Two runs as logcat would show them: boot marks printed when made, marks
// printed again by an older build's ring replay, a scroll segment, frames
// lines and render windows.
const LOG = [
  'I ReactNativeJS: perf: config 999',
  'I ReactNativeJS: perf: js-entry 0 origin',
  'I ReactNativeJS: perf: sweep-media-cache 12',
  'I ReactNativeJS: perf: config 300',
  'I ReactNativeJS: perf: first-rows:rua 700',
  'I ReactNativeJS: perf: tab:diario 2000',
  'I ReactNativeJS: perf: config 300',
  'I ReactNativeJS: perf: config 300',
  'I ReactNativeJS: perf: render list:rua 4 20',
  'I ReactNativeJS: perf: scroll-start:rua 3700',
  'I ReactNativeJS: perf: render list:rua 2 5',
  'I ReactNativeJS: perf: scroll-segment 3 down',
  'I ReactNativeJS: perf: frames n=100 p50=16 p95=30 max=80 over32=3 list=rua run=scroll rows=40 mounts=50 unmounts=10 rendersPerMountMedian=2 rendersPerMountP95=5',
  'I ReactNativeJS: perf: render list:rua 30 90 phase=scroll:rua',
  'I ReactNativeJS: perf: render tab:rua 3 9 phase=scroll:rua',
  'I ReactNativeJS: perf: scroll-done:rua 63700',
  'I ReactNativeJS: perf: js-entry 0 origin',
  'I ReactNativeJS: perf: config 500',
  'I ReactNativeJS: perf: first-rows:rua 900',
  'I ReactNativeJS: perf: config 500',
  'I ReactNativeJS: perf: render list:rua 1 1',
  'I ReactNativeJS: perf: frames n=120 p50=17 p95=40 max=90 over32=9 list=rua run=scroll rows=41 mounts=60 unmounts=12 rendersPerMountMedian=3 rendersPerMountP95=7',
  'I ReactNativeJS: perf: render list:rua 20 60 phase=scroll:rua',
  'I ReactNativeJS: perf: frames n=10 p50=16 p95=16 max=16 over32=0 list=rua rows=1 mounts=1 unmounts=0 rendersPerMountMedian=1 rendersPerMountP95=1',
  'unrelated line'
].join('\n')

test('runs split at js-entry, each mark counted once per run', (t) => {
  const runs = parse(LOG)
  t.is(runs.length, 2, 'the line before the first js-entry is left out')
  t.alike([...runs[0].marks], [['js-entry', 0], ['sweep-media-cache', 12], ['config', 300], ['first-rows:rua', 700], ['tab:diario', 2000], ['scroll-start:rua', 3700], ['scroll-done:rua', 63700]])
  t.alike([...runs[1].marks], [['js-entry', 0], ['config', 500], ['first-rows:rua', 900]])
  t.absent(runs[0].marks.has('scroll-segment'), 'a scroll segment index is not a time')
})

test('render lines sum per id and phase per run', (t) => {
  const runs = parse(LOG)
  t.alike(runs[0].renders.get('list:rua'), { count: 6, ms: 25 })
  t.alike(runs[0].renders.get('list:rua phase=scroll:rua'), { count: 30, ms: 90 })
  t.alike(runs[0].renders.get('tab:rua phase=scroll:rua'), { count: 3, ms: 9 })
  t.alike(runs[1].renders.get('list:rua'), { count: 1, ms: 1 })
})

test('frames lines keep frame and row stats per list and kind', (t) => {
  const runs = parse(LOG)
  t.is(runs[0].frames.length, 1)
  t.alike(runs[0].frames[0], { key: 'list=rua run=scroll', n: 100, p50: 16, p95: 30, max: 80, over32: 3, mounts: 50, rendersPerMountMedian: 2, rendersPerMountP95: 5 })
  t.is(runs[1].frames[1].key, 'list=rua run=manual')
})

test('the report uses the perfMarks stats and gives n = runs', async (t) => {
  const { summary } = await loadStats()
  const text = format(parse(LOG), summary)
  const lines = text.split('\n')
  t.is(lines[0], 'runs: 2')
  t.ok(lines.includes('  config n=2 median=300 p95=500 spread=200'), text)
  t.ok(lines.includes('  sweep-media-cache n=1 median=12 p95=12 spread=0'))
  t.ok(lines.includes('  list:rua phase=scroll:rua count n=2 median=20 p95=30 spread=10'))
  t.ok(lines.includes('  list=rua run=scroll p95 n=2 median=30 p95=40 spread=10'))
  t.ok(lines.includes('  list=rua run=scroll rendersPerMountMedian n=2 median=2 p95=3 spread=1'))
  t.absent(text.includes('list=rua run=manual'), 'the scripted line stands for the run')
  t.absent(/scroll-segment/.test(text))
})

test('only known marks are read as times', (t) => {
  for (const name of ['js-entry', 'config', 'req:feed.read', 'tab:rua', 'first-rows:diario', 'rows-live:membro', 'scroll-done:rua']) t.ok(knownMark(name), name)
  for (const name of ['scroll-segment', 'frames', 'render', 'req:', 'origin']) t.absent(knownMark(name), name)
})

test('a log without js-entry is one run', (t) => {
  const runs = parse('perf: config 10\nperf: config 20\n')
  t.is(runs.length, 1)
  t.is(runs[0].marks.get('config'), 10)
})

// Regression: each frames line was its own sample, so a launch with two
// manual scroll sessions counted twice against a launch with one.
test('frames give one sample per list per run', async (t) => {
  const { summary } = await loadStats()
  const log = [
    'perf: js-entry 0 origin',
    'perf: frames n=100 p50=10 p95=20 max=50 over32=1 list=rua rows=5 mounts=10 unmounts=0 rendersPerMountMedian=1 rendersPerMountP95=2',
    'perf: frames n=300 p50=20 p95=40 max=90 over32=5 list=rua rows=9 mounts=30 unmounts=4 rendersPerMountMedian=3 rendersPerMountP95=6',
    'perf: frames n=50 p50=16 p95=16 max=16 over32=0 list=diario rows=1 mounts=1 unmounts=0 rendersPerMountMedian=1 rendersPerMountP95=1',
    'perf: js-entry 0 origin',
    'perf: frames n=200 p50=30 p95=60 max=70 over32=2 list=rua rows=4 mounts=20 unmounts=0 rendersPerMountMedian=2 rendersPerMountP95=4',
    'perf: frames n=9 p50=99 p95=99 max=99 over32=9 list=rua run=scroll rows=4 mounts=8 unmounts=0 rendersPerMountMedian=5 rendersPerMountP95=5',
    'perf: frames n=500 p50=15 p95=25 max=30 over32=0 list=rua run=scroll rows=40 mounts=80 unmounts=10 rendersPerMountMedian=2 rendersPerMountP95=3'
  ].join('\n')
  const runs = parse(log)
  const a = frameSamples(runs[0])
  t.is(a.length, 2, 'one per list')
  t.alike(a.find((f) => f.key === 'list=rua run=manual'), { key: 'list=rua run=manual', n: 400, p50: 17.5, p95: 35, max: 90, over32: 6, mounts: 40, rendersPerMountMedian: 2.5, rendersPerMountP95: 5 }, 'manual sessions combined, weighted by n and mounts')
  const b = frameSamples(runs[1])
  t.is(b.length, 1, 'the scripted lines stand for the run, manual left out')
  t.is(b[0].key, 'list=rua run=scroll')
  t.is(b[0].n, 509)
  const lines = format(runs, summary).split('\n')
  t.ok(lines.includes('  list=rua run=manual n n=1 median=400 p95=400 spread=0'), 'n counts runs, not sessions')
  t.ok(lines.includes('  list=diario run=manual n n=1 median=50 p95=50 spread=0'))
})

// Regression (CWE-150): logcat is shared, so names in a log line are foreign
// text and used to reach the terminal raw.
test('lines with control or bidi characters never reach the report', async (t) => {
  const { summary } = await loadStats()
  const esc = String.fromCharCode(27)
  const log = [
    'perf: js-entry 0 origin',
    'perf: render list:rua' + esc + '[2J 4 20',
    'perf: render list:rua 4 20 phase=scroll:rua' + esc + ']0;x' + String.fromCharCode(7),
    'perf: frames n=10 p50=16 p95=16 max=16 over32=0 list=rua' + esc + '[31m',
    'perf: req:feed.read' + esc + '[1A 999',
    'perf: req:feed.read' + String.fromCharCode(0x202e) + ' 998',
    'perf: tab:rua' + String.fromCharCode(0x9b) + ' 997',
    'perf: req:feed.read 12'
  ].join('\n')
  const text = format(parse(log), summary)
  const bad = [...text].map((ch) => ch.codePointAt(0)).filter((c) => (c < 0x20 && c !== 10) || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069))
  t.alike(bad, [], 'no C0, C1 or bidi control')
  t.ok(text.includes('  req:feed.read n=1 median=12 p95=12 spread=0'), 'a clean line still counts')
  t.absent(/list:rua/.test(text), 'the forged render lines are dropped')
  t.absent(/list=rua run/.test(text), 'the forged frames line is dropped')
  for (const name of ['js-entry', 'req:feed.read', 'req:post.create', 'first-rows:rua-page', 'rows-snapshot:comunidades', 'scroll-start:diario', 'list:rua', 'tab:espiadinha', 'phase=scroll:rua-page', 'p50=16.5', '-3', 'origin']) t.ok(SAFE_TOKEN.test(name), name)
})

test('the frames max survives a very long log', (t) => {
  const lines = ['perf: js-entry 0 origin']
  for (let i = 0; i < 200000; i++) lines.push('perf: frames n=1 p50=1 p95=1 max=' + (i % 1000) + ' over32=0 list=rua')
  const runs = parse(lines.join('\n'))
  let out
  t.execution(() => { out = frameSamples(runs[0]) })
  t.is(out[0].max, 999)
  t.is(out[0].n, 200000)
})

test('an aborted scripted run leaves no partial phase sample', (t) => {
  const runs = parse([
    'perf: js-entry 0 origin',
    'perf: render list:rua 4 20',
    'perf: render list:diario 3 9 phase=scroll:diario',
    'perf: render list:rua 30 90 phase=scroll:rua',
    'perf: render tab:rua 3 9 phase=scroll:rua',
    'perf: scroll-aborted list=rua hidden'
  ].join('\n'))
  t.alike([...runs[0].renders.keys()], ['list:rua', 'list:diario phase=scroll:diario'])
})

test('a path that cannot be read is never echoed to the terminal', (t) => {
  const { spawnSync } = require('child_process')
  const script = path.join(__dirname, '..', 'scripts', 'perf-summary.js')
  const bad = path.join(__dirname, 'no-such-capture-\u001b[31mRED\u0007')
  const out = spawnSync(process.execPath, [script, bad], { encoding: 'utf8' })
  t.is(out.status, 1)
  t.ok(out.stderr.includes('ENOENT'))
  const controls = [...(out.stderr + out.stdout)].map((ch) => ch.codePointAt(0)).filter((c) => (c < 0x20 && c !== 10) || (c >= 0x7f && c <= 0x9f))
  t.alike(controls, [], 'no control character reaches the terminal')
  t.absent(out.stderr.includes('no-such-capture'), 'the path is not echoed')
})
