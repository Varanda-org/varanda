'use strict'

// src/client/native.js with react-native-bare-kit stubbed: the node's worklet
// is created under a fixed registry id, so a full JS reload (dev) makes the
// native registry terminate the previous context's worklet; the gate's probe
// has no id, or starting it would terminate the node.
const { register } = require('node:module')
const { pathToFileURL } = require('node:url')
const test = require('brittle')

register('./helpers/native-stubs.mjs', pathToFileURL(__filename))

test('the node worklet has a fixed id and the probe has none', async (t) => {
  const native = await import('../src/client/native.js')
  const worklets = () => globalThis.__stubWorklets
  const config = { association: 'ab'.repeat(32), dataDir: '/stub/data' }

  const starting = native.startNode(config)
  t.is(worklets().length, 1)
  t.is(worklets()[0].id, 'app.varanda.node')
  worklets()[0].IPC.emit('end')
  await t.exception(starting)
  t.ok(worklets()[0].terminated, 'a failed start terminates its worklet')

  const probing = native.startProbe(config)
  t.is(worklets().length, 2)
  t.is(worklets()[1].id, null)
  worklets()[1].IPC.emit('end')
  await t.exception(probing)
})
