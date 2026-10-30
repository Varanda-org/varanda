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

test('a core config starts the core kind with the same arguments as before', async (t) => {
  const native = await import('../src/client/native.js')
  const before = globalThis.__stubWorklets.length
  const starting = native.startNode({ association: 'ab'.repeat(32), bootstrap: ['127.0.0.1:49737'], dataDir: '/stub/data' })
  const w = globalThis.__stubWorklets[before]
  t.is(w.id, 'app.varanda.node')
  t.alike(JSON.parse(w.args[0]), {
    dataDir: '/stub/data',
    association: 'ab'.repeat(32),
    bootstrap: ['127.0.0.1:49737'],
    dhtHost: null,
    allowPublicDht: false,
    recover: true,
    diagnostics: false
  })
  w.IPC.emit('end')
  await t.exception(starting)
})

test('a hosted config starts the web kind with the upload cache dir and no recover', async (t) => {
  const native = await import('../src/client/native.js')
  const before = globalThis.__stubWorklets.length
  const config = {
    kind: 'hosted',
    installationUrl: 'https://varanda.example',
    association: 'cd'.repeat(32),
    seederUrl: 'wss://varanda.example/seeder',
    rpId: 'varanda.example'
  }
  const starting = native.startNode(config)
  const w = globalThis.__stubWorklets[before]
  t.is(w.id, 'app.varanda.node')
  t.alike(JSON.parse(w.args[0]), {
    kind: 'web',
    dataDir: '/stub/Documents/varanda',
    cacheDir: '/stub/Caches/varanda-upload',
    association: 'cd'.repeat(32),
    seederUrl: 'wss://varanda.example/seeder'
  })
  t.ok(globalThis.__stubDirs.has('file:///stub/Caches/varanda-upload/'), 'the upload dir is created')
  w.IPC.emit('end')
  await t.exception(starting)
  t.ok(w.terminated)
})
