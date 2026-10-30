'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/splashGate.js')

test('splash gate: minimum duration only holds boot phases', async (t) => {
  const { holdSplash, HOLD_PHASES, SPLASH_MIN_MS, CONNECT_PATIENCE_MS } = await load()
  t.is(SPLASH_MIN_MS, 1500)
  t.is(CONNECT_PATIENCE_MS, 10000)
  t.alike(HOLD_PHASES, ['loading', 'connecting', 'ready'])
  for (const phase of ['loading', 'connecting', 'ready']) {
    t.is(holdSplash({ phase, elapsedMs: 0 }), true, phase + ' starts held')
    t.is(holdSplash({ phase, elapsedMs: 1499 }), true, phase + ' stays held before minimum')
    t.is(holdSplash({ phase, elapsedMs: 1500 }), false, phase + ' ends hold at minimum')
    t.is(holdSplash({ phase, elapsedMs: 0, released: true }), false, phase + ' stays released')
  }
  for (const phase of ['config', 'config-error', 'error', 'x']) {
    t.is(holdSplash({ phase, elapsedMs: 0 }), false, phase + ' is never held')
  }
})

test('splash gate: gateNext holds any phase until the minimum', async (t) => {
  const { holdSplash } = await load()
  for (const phase of ['config', 'config-error', 'error', 'x']) {
    t.is(holdSplash({ phase, elapsedMs: 0, gateNext: true }), true, phase + ' held at 0')
    t.is(holdSplash({ phase, elapsedMs: 1499, gateNext: true }), true, phase + ' held at 1499')
    t.is(holdSplash({ phase, elapsedMs: 1500, gateNext: true }), false, phase + ' ends hold at minimum')
    t.is(holdSplash({ phase, elapsedMs: 0, gateNext: true, released: true }), false, phase + ' released wins')
    for (const gateNext of [false, undefined]) {
      t.is(holdSplash({ phase, elapsedMs: 0, gateNext }), false, phase + ' not held without gateNext')
    }
  }
})

test('splash gate: connection coverage ends at configurable patience', async (t) => {
  const { coverConnecting } = await load()
  for (const elapsedMs of [0, 99999]) {
    t.is(coverConnecting({ phase: 'loading', elapsedMs }), true)
    t.is(coverConnecting({ phase: 'loading', elapsedMs, released: true }), false)
    t.is(coverConnecting({ phase: 'connecting', canConfigure: false, elapsedMs }), true)
    t.is(coverConnecting({ phase: 'connecting', canConfigure: false, elapsedMs, released: true }), false)
  }
  t.is(coverConnecting({ phase: 'connecting', canConfigure: true, elapsedMs: 9999 }), true)
  t.is(coverConnecting({ phase: 'connecting', canConfigure: true, elapsedMs: 10000 }), false)
  t.is(coverConnecting({ phase: 'connecting', canConfigure: true, elapsedMs: 0, released: true }), false)
  for (const phase of ['ready', 'config', 'config-error', 'error', 'x']) {
    for (const canConfigure of [false, true]) {
      t.is(coverConnecting({ phase, canConfigure, elapsedMs: 0 }), false, phase + ' is never covered')
    }
  }
})

test('splash gate: non-finite elapsed time counts as zero', async (t) => {
  const { holdSplash, coverConnecting } = await load()
  for (const elapsedMs of [NaN, undefined, null, Infinity]) {
    t.is(holdSplash({ phase: 'ready', elapsedMs }), true)
    t.is(coverConnecting({ phase: 'connecting', canConfigure: true, elapsedMs }), true)
  }
})

test('splash gate: only literal true releases the splash', async (t) => {
  const { holdSplash, coverConnecting } = await load()
  for (const released of [false, undefined, null, 1]) {
    t.is(holdSplash({ phase: 'ready', elapsedMs: 0, released }), true)
    t.is(coverConnecting({ phase: 'connecting', canConfigure: true, elapsedMs: 0, released }), true)
  }
})

test('splash gate: pure helper and app integration guards', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../src/splashGate.js'), 'utf8')
  t.absent(source.includes("from 'react"))
  t.absent(source.includes('require('))
  t.absent(source.includes('node:'))
  const app = fs.readFileSync(path.join(__dirname, '../App.js'), 'utf8')
  t.ok(app.includes('holdSplash('))
  t.ok(app.includes('coverConnecting('))
  t.absent(app.includes("node.phase === 'connecting' && !node.canConfigure"))
})
