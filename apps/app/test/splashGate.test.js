'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/splashGate.js')

test('splash gate: minimum duration only holds boot phases', async (t) => {
  const { holdSplash, HOLD_PHASES, SPLASH_MIN_MS, CONNECT_PATIENCE_MS } = await load()
  t.is(SPLASH_MIN_MS, 1500)
  t.is(CONNECT_PATIENCE_MS, 10000)
  t.alike(HOLD_PHASES, ['loading', 'connecting'])
  for (const phase of ['loading', 'connecting']) {
    t.is(holdSplash({ phase, elapsedMs: 0 }), true, phase + ' starts held')
    t.is(holdSplash({ phase, elapsedMs: 1499 }), true, phase + ' stays held before minimum')
    t.is(holdSplash({ phase, elapsedMs: 1500 }), false, phase + ' ends hold at minimum')
    t.is(holdSplash({ phase, elapsedMs: 0, released: true }), false, phase + ' stays released')
  }
  for (const phase of ['ready', 'config', 'config-error', 'error', 'x']) {
    t.is(holdSplash({ phase, elapsedMs: 0 }), false, phase + ' is never held')
  }
})

test('splash gate: a returning member skips the minimum once ready', async (t) => {
  const { holdSplash } = await load()
  t.is(holdSplash({ phase: 'ready', elapsedMs: 100, gateNext: false }), false)
  t.is(holdSplash({ phase: 'ready', elapsedMs: 100, gateNext: true }), true)
  t.is(holdSplash({ phase: 'connecting', elapsedMs: 100, gateNext: false }), true)
})

test('splash gate: gateNext holds any phase until the minimum', async (t) => {
  const { holdSplash } = await load()
  for (const phase of ['ready', 'config', 'config-error', 'error', 'x']) {
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
    t.is(holdSplash({ phase: 'connecting', elapsedMs }), true)
    t.is(holdSplash({ phase: 'ready', elapsedMs }), false)
    t.is(coverConnecting({ phase: 'connecting', canConfigure: true, elapsedMs }), true)
  }
})

test('splash gate: only literal true releases the splash', async (t) => {
  const { holdSplash, coverConnecting } = await load()
  for (const released of [false, undefined, null, 1]) {
    t.is(holdSplash({ phase: 'connecting', elapsedMs: 0, released }), true)
    t.is(holdSplash({ phase: 'ready', elapsedMs: 0, released, gateNext: true }), true)
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
  t.ok(app.includes("holdSplash({ phase: ready || seen ? 'ready' : node.phase"))
  t.ok(app.includes('detailsGraceOver('))
  t.ok(app.includes('coverConnecting('))
  t.absent(app.includes("node.phase === 'connecting' && !node.canConfigure"))
  t.ok(app.includes('coverBoot('))
  t.ok(app.includes('holdBootCover('))
  t.ok(app.includes('settled: bootSettled.current, step })'))
  t.absent(app.includes('bootSettled.current || released.current'))
  t.ok(app.includes('{coveringBoot ? bootCover : null}'))
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
  for (const step of ['perfil', undefined, 'x']) {
    t.is(coverBoot({ step, passkeyKnown: false, age: 'loading', infoKnown: false }), false, String(step))
  }
  t.is(coverBoot(), false)
})

test('splash gate: pronto stays covered until A Rua is ready, at most CONTENT_PATIENCE_MS', async (t) => {
  const { coverBoot, holdBootCover, bootPatienceMs, CONTENT_PATIENCE_MS } = await load()
  t.is(CONTENT_PATIENCE_MS, 5000)
  t.is(bootPatienceMs('pronto'), CONTENT_PATIENCE_MS)
  t.is(coverBoot({ step: 'pronto' }), true, 'not ready yet')
  t.is(coverBoot({ step: 'pronto', feedReady: false }), true)
  t.is(coverBoot({ step: 'pronto', feedReady: 1 }), true, 'only literal true')
  t.is(coverBoot({ step: 'pronto', feedReady: true }), false)
  t.is(holdBootCover({ cover: true, step: 'pronto', elapsedMs: 4999 }), true)
  t.is(holdBootCover({ cover: true, step: 'pronto', elapsedMs: 5000 }), false, 'revealed at the cap')
  t.is(holdBootCover({ cover: true, step: 'pronto', elapsedMs: 0, settled: true }), false, 'never after the first reveal')
})

test('splash gate: details grace starts only after the first page', async (t) => {
  const { detailsGraceOver, DETAILS_GRACE_MS } = await load()
  t.is(DETAILS_GRACE_MS, 400)
  t.is(detailsGraceOver({ page: true, pageAtMs: 1000, nowMs: 1399 }), false)
  t.is(detailsGraceOver({ page: true, pageAtMs: 1000, nowMs: 1400 }), true)
  t.is(detailsGraceOver({ page: true, pageAtMs: 1000, nowMs: 1500 }), true)
  t.is(detailsGraceOver({ page: true, pageAtMs: 1000, nowMs: 999 }), false)
  t.is(detailsGraceOver({ page: true, pageAtMs: 0, nowMs: 400 }), true)
  for (const page of [false, undefined, null, 1]) {
    t.is(detailsGraceOver({ page, pageAtMs: 1000, nowMs: 1400 }), false)
  }
  for (const time of [NaN, Infinity, -Infinity, undefined, null, '1000']) {
    t.is(detailsGraceOver({ page: true, pageAtMs: time, nowMs: 1400 }), false)
    t.is(detailsGraceOver({ page: true, pageAtMs: 1000, nowMs: time }), false)
  }
})

test('splash gate: first rows are ready once their names and counts answered', async (t) => {
  const { feedDetailsReady, FEED_FIRST_ROWS } = await load()
  t.is(FEED_FIRST_ROWS, 6)
  const known = new Map([['a', { name: 'A' }], ['b', null]])
  const profileOf = (k) => known.get(k)
  const counted = new Set(['a:1'])
  const hasCount = (r) => counted.has(r)
  t.is(feedDetailsReady({ authors: ['a', 'b'], shown: ['a:1', 'b:2'], profileOf, hasCount }), true, 'null is a finished lookup')
  t.is(feedDetailsReady({ authors: ['a', 'c'], shown: ['a:1'], profileOf, hasCount }), false, 'c not looked up yet')
  t.is(feedDetailsReady({ authors: ['a'], shown: ['x:9'], profileOf, hasCount }), false, 'no count yet')
  t.is(feedDetailsReady({ authors: ['a'], shown: ['x:9'], profileOf, hasCount, countsSkipped: true }), true, 'counts not read here')
  t.is(feedDetailsReady({ authors: [], shown: [], profileOf, hasCount }), true, 'an empty feed is ready')
  t.is(feedDetailsReady({ authors: ['a'], shown: [], profileOf }), true, 'no posts to count')
  t.is(feedDetailsReady({ authors: ['a'], shown: ['a:1'], profileOf }), false, 'no hasCount')
  const resolved = new Set(['o:1'])
  const hasOriginal = (r) => resolved.has(r)
  t.is(feedDetailsReady({ authors: ['a'], shown: ['a:1'], originals: ['o:1'], hasOriginal, profileOf, hasCount }), true, 'repost original answered')
  t.is(feedDetailsReady({ authors: ['a'], shown: ['a:1'], originals: ['o:2'], hasOriginal, profileOf, hasCount }), false, 'repost original still loading')
  t.is(feedDetailsReady({ authors: ['a'], shown: ['a:1'], originals: ['o:1'], profileOf, hasCount }), false, 'no hasOriginal')
  t.is(feedDetailsReady({ authors: 'a', profileOf }), false)
  t.is(feedDetailsReady({ authors: ['a'] }), false)
  t.is(feedDetailsReady(), false)
})

test('splash gate: the bar follows real steps and only grows along them', async (t) => {
  const { bootProgress } = await load()
  const steps = [
    bootProgress({ phase: 'connecting' }),
    bootProgress({ phase: 'ready', step: 'carregando' }),
    bootProgress({ phase: 'ready', step: 'pronto' }),
    bootProgress({ phase: 'ready', step: 'pronto', page: true }),
    bootProgress({ phase: 'ready', step: 'pronto', page: true, details: true })
  ]
  t.alike(steps, [0.1, 0.35, 0.6, 0.8, 1])
  t.is(bootProgress(), 0.1)
  t.is(bootProgress({ details: true }), 1)
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

test('splash gate: the cold-start preview only for a live, fresh, gate-free boot', async (t) => {
  const { previewAllowed, PREVIEW_MAX_AGE_MS, PREVIEW_BLOCKED_STEPS } = await load()
  t.is(PREVIEW_MAX_AGE_MS, 24 * 60 * 60 * 1000)
  const now = 1_800_000_000_000
  const snapshot = { items: [{ kind: 'post' }], savedAt: now - 1000 }
  const ok = { snapshot, previewCapable: true, gateNext: false, showConexao: false, step: null, locked: false, sessionLive: true, nowMs: now }
  t.is(previewAllowed(ok), true, 'boot, step unknown')
  t.is(previewAllowed({ ...ok, step: 'carregando' }), true)
  t.is(previewAllowed({ ...ok, step: 'pronto' }), true)
  t.is(previewAllowed({ ...ok, previewCapable: false }), false, 'web')
  t.is(previewAllowed({ ...ok, previewCapable: undefined }), false)
  t.is(previewAllowed({ ...ok, snapshot: null }), false)
  t.is(previewAllowed({ ...ok, snapshot: { ...snapshot, items: [] } }), false, 'no rows')
  t.is(previewAllowed({ ...ok, snapshot: { ...snapshot, savedAt: now - PREVIEW_MAX_AGE_MS } }), true, 'exactly 24 h')
  t.is(previewAllowed({ ...ok, snapshot: { ...snapshot, savedAt: now - PREVIEW_MAX_AGE_MS - 1 } }), false, 'stale')
  t.is(previewAllowed({ ...ok, snapshot: { ...snapshot, savedAt: now + 1 } }), false, 'future savedAt')
  t.is(previewAllowed({ ...ok, snapshot: { ...snapshot, savedAt: 'x' } }), false)
  t.is(previewAllowed({ ...ok, nowMs: NaN }), false)
  t.is(previewAllowed({ ...ok, sessionLive: false }), false, 'no live session')
  t.is(previewAllowed({ ...ok, sessionLive: undefined }), false)
  t.is(previewAllowed({ ...ok, gateNext: true }), false, 'intro or terms next')
  t.is(previewAllowed({ ...ok, gateNext: undefined }), false)
  t.is(previewAllowed({ ...ok, showConexao: true }), false, 'Conexão')
  t.is(previewAllowed({ ...ok, locked: true }), false, 'locked')
  t.alike(PREVIEW_BLOCKED_STEPS, ['entrar', 'recuperando', 'idade', 'vinculo', 'identidade', 'certificado', 'perfil'])
  for (const step of PREVIEW_BLOCKED_STEPS) t.is(previewAllowed({ ...ok, step }), false, step)
  t.is(previewAllowed({ ...ok, step: 'outro' }), false, 'an unknown step name')
  t.is(previewAllowed(), false)
})
