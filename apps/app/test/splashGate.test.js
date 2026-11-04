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
  t.ok(app.includes('coverBoot('))
  t.ok(app.includes('holdBootCover('))
  t.ok(app.includes('settled: bootSettled.current, step })'))
  t.absent(app.includes('bootSettled.current || released.current'))
  t.ok(app.includes('{coveringBoot ? splash : null}'))
  t.ok(app.includes('<View style={coveringBoot ? styles.hidden : styles.flex}>{content}</View>'))
  t.ok(app.includes('if (!coveringBoot) bootSettled.current = true'))
  t.absent(app.includes('return splash'))
  t.absent(app.includes('<Splash sidePad'))
  t.is(app.split('<Splash ').length - 1, 1)
})

test('splash gate: boot cover only while the deciding read has not answered', async (t) => {
  const { coverBoot, BOOT_PATIENCE_MS, RECOVERY_PATIENCE_MS, bootPatienceMs } = await load()
  t.is(BOOT_PATIENCE_MS, 10000)
  t.is(RECOVERY_PATIENCE_MS, 65000)
  t.is(bootPatienceMs('recuperando'), RECOVERY_PATIENCE_MS)
  for (const step of ['entrar', 'idade', 'vinculo', 'carregando', undefined]) t.is(bootPatienceMs(step), BOOT_PATIENCE_MS, String(step))
  t.is(coverBoot({ step: 'entrar', passkeyKnown: false }), true)
  t.is(coverBoot({ step: 'entrar', passkeyKnown: undefined }), true)
  t.is(coverBoot({ step: 'entrar', passkeyKnown: true }), false)
  t.is(coverBoot({ step: 'recuperando' }), true)
  t.is(coverBoot({ step: 'idade', age: 'loading', ageError: '' }), true)
  t.is(coverBoot({ step: 'idade', age: 'loading', ageError: undefined }), true)
  t.is(coverBoot({ step: 'idade', age: 'loading', ageError: 'x' }), false)
  t.is(coverBoot({ step: 'idade', age: 'loading', ageError: 5 }), true, 'only error text counts')
  t.is(coverBoot({ step: 'idade', age: 'loading', ageError: {} }), true, 'only error text counts')
  t.is(coverBoot({ step: 'idade', age: 'needed' }), false)
  t.is(coverBoot({ step: 'idade', age: 'ok' }), false)
  t.is(coverBoot({ step: 'idade', age: 'off' }), false)
  t.is(coverBoot({ step: 'idade' }), false, 'missing age')
  t.is(coverBoot({ step: 'idade', age: 'needed', infoKnown: false }), false)
  for (const step of ['vinculo', 'identidade', 'certificado']) {
    t.is(coverBoot({ step, infoKnown: false }), true, step + ' unknown')
    t.is(coverBoot({ step, infoKnown: undefined }), true, step + ' undefined')
    t.is(coverBoot({ step, infoKnown: true }), false, step + ' known')
  }
  t.is(coverBoot({ step: 'carregando', profileSlow: false }), true)
  t.is(coverBoot({ step: 'carregando', profileSlow: undefined }), true)
  t.is(coverBoot({ step: 'carregando', profileSlow: true }), false)
  for (const step of ['perfil', 'pronto', undefined, 'x']) {
    t.is(coverBoot({ step, passkeyKnown: false, age: 'loading', infoKnown: false }), false, String(step))
  }
  t.is(coverBoot(), false)
})

test('splash gate: boot patience yields the real screen when a read hangs', async (t) => {
  const { holdBootCover } = await load()
  t.is(holdBootCover({ cover: false, elapsedMs: 0 }), false)
  t.is(holdBootCover({ cover: true, step: 'idade', elapsedMs: 0 }), true)
  t.is(holdBootCover({ cover: true, step: 'idade', elapsedMs: 9999 }), true)
  t.is(holdBootCover({ cover: true, step: 'idade', elapsedMs: 10000 }), false)
  t.is(holdBootCover({ cover: true, step: 'idade', elapsedMs: 0, settled: true }), false)
  t.is(holdBootCover({ cover: true, step: 'recuperando', elapsedMs: 0, settled: true }), false)
  for (const settled of [false, undefined, null, 1]) {
    t.is(holdBootCover({ cover: true, step: 'idade', elapsedMs: 0, settled }), true, 'settled ' + settled)
  }
  for (const elapsedMs of [NaN, undefined, null, Infinity]) {
    t.is(holdBootCover({ cover: true, step: 'idade', elapsedMs }), true, 'elapsed ' + elapsedMs)
  }
  t.is(holdBootCover({ cover: true, step: 'idade', elapsedMs: -1 }), true)
  t.is(holdBootCover({ cover: true, step: 'recuperando', elapsedMs: 10000 }), true, 'recovery outlasts the step patience')
  t.is(holdBootCover({ cover: true, step: 'recuperando', elapsedMs: 64999 }), true)
  t.is(holdBootCover({ cover: true, step: 'recuperando', elapsedMs: 65000 }), false, 'a recovery whose end never arrives is revealed')
  t.is(holdBootCover({ cover: true, step: 'recuperando', elapsedMs: NaN }), true)
  t.is(holdBootCover({ cover: 1, step: 'idade', elapsedMs: 0 }), false)
  t.is(holdBootCover(), false)
  const held = { cover: true, step: 'idade', elapsedMs: 0 }
  t.is(holdBootCover({ ...held, released: true }), holdBootCover(held))
  t.is(holdBootCover({ ...held, released: true }), true)
})
