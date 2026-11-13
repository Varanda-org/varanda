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
