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
