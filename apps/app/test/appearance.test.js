'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/appearance.js')
const src = (name) => readFileSync(join(__dirname, '..', 'src', name), 'utf8')

test('light palette keeps the strings the app shipped with', async (t) => {
  const { light } = await load()
  t.alike({ ...light }, {
    bg: '#fbf8f3',
    card: '#ffffff',
    ink: '#1f2a24',
    soft: '#4a554e',
    line: 'rgba(31,42,36,0.10)',
    accent: '#1d6b4f',
    accentSoft: 'rgba(29,107,79,0.10)',
    accentInk: '#ffffff',
    warm: '#fff4e0',
    outline: 'rgba(31,42,36,0.30)',
    ring: 'rgba(31,42,36,0.12)',
    dim: 'rgba(31,42,36,0.35)',
    tabBar: 'rgba(251,248,243,1)',
    danger: '#a3201a',
    warn: '#8a5a00',
    placeholder: '#616c67',
    skeleton: 'rgba(31,42,36,0.08)',
    pillBg: '#1d6b4f',
    pillInk: '#ffffff',
    inputOff: '#efece5',
    toastBg: '#1f2a24',
    toastInk: '#ffffff',
    bubbleMine: '#d9efe2'
  })
  t.ok(Object.isFrozen(light))
})

test('tab bar is opaque in both palettes so content does not show through', async (t) => {
  const { light, dark } = await load()
  t.is(light.tabBar, 'rgba(251,248,243,1)')
  t.is(dark.tabBar, 'rgba(28,38,34,1)')
})

test('dark palette shares the keys and is warm green ink, not black', async (t) => {
  const { light, dark, paletteFor } = await load()
  t.alike(Object.keys(dark).sort(), Object.keys(light).sort())
  t.ok(Object.isFrozen(dark))
  t.not(dark.bg, '#000000')
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(dark.bg.slice(i, i + 2), 16))
  t.ok(g > r && g > b)
  t.is(paletteFor('dark'), dark)
  t.is(paletteFor('light'), light)
  t.is(paletteFor('unspecified'), light)
  t.is(paletteFor(null), light)
})

test('text pairs reach WCAG AA in both palettes', async (t) => {
  const { light, dark, contrastRatio } = await load()
  for (const [name, p] of [['light', light], ['dark', dark]]) {
    for (const key of ['ink', 'soft', 'accent', 'danger', 'warn', 'placeholder']) {
      for (const surface of ['bg', 'card']) {
        const ratio = contrastRatio(p[key], p[surface])
        t.ok(ratio >= 4.5, `${name} ${key} on ${surface}: ${ratio.toFixed(2)}`)
      }
    }
    for (const [ink, bg] of [['accentInk', 'accent'], ['pillInk', 'pillBg'], ['toastInk', 'toastBg'], ['soft', 'inputOff']]) {
      const ratio = contrastRatio(p[ink], p[bg])
      t.ok(ratio >= 4.5, `${name} ${ink} on ${bg}: ${ratio.toFixed(2)}`)
    }
  }
})

test('contrastRatio matches the WCAG extremes', async (t) => {
  const { contrastRatio } = await load()
  t.is(Math.round(contrastRatio('#000000', '#ffffff')), 21)
  t.is(contrastRatio('#336699', '#336699'), 1)
})

test('appearanceRecordOf accepts only { v: 1, mode in MODES }', async (t) => {
  const { appearanceRecordOf, MODES } = await load()
  t.alike(MODES, ['system', 'light', 'dark'])
  for (const mode of MODES) t.alike(appearanceRecordOf({ v: 1, mode }), { v: 1, mode })
  t.is(appearanceRecordOf({ v: 1, mode: 'auto' }), null)
  t.is(appearanceRecordOf({ v: 2, mode: 'dark' }), null)
  t.is(appearanceRecordOf({ v: 1, mode: 'dark', extra: 1 }), null)
  t.is(appearanceRecordOf({ v: 1 }), null)
  t.is(appearanceRecordOf([1, 'dark']), null)
  t.is(appearanceRecordOf(null), null)
  t.is(appearanceRecordOf('dark'), null)
  t.is(appearanceRecordOf(Object.create({ v: 1, mode: 'dark' })), null)
})

test('withMode builds a valid record', async (t) => {
  const { withMode, appearanceRecordOf, MODE_LABELS } = await load()
  t.alike(withMode('dark'), { v: 1, mode: 'dark' })
  t.alike(appearanceRecordOf(withMode('system')), { v: 1, mode: 'system' })
  t.alike({ ...MODE_LABELS }, { system: 'Sistema', light: 'Claro', dark: 'Escuro' })
})

test('resolveScheme follows the mode and falls back to light', async (t) => {
  const { resolveScheme } = await load()
  t.is(resolveScheme({ mode: 'dark', system: 'light' }), 'dark')
  t.is(resolveScheme({ mode: 'light', system: 'dark' }), 'light')
  t.is(resolveScheme({ mode: 'system', system: 'dark' }), 'dark')
  t.is(resolveScheme({ mode: 'system', system: 'light' }), 'light')
  t.is(resolveScheme({ mode: 'system', system: null }), 'light')
  t.is(resolveScheme({ mode: 'system', system: undefined }), 'light')
  t.is(resolveScheme({ mode: 'system', system: 'unspecified' }), 'light')
  t.is(resolveScheme({ mode: 'bogus', system: 'dark' }), 'light')
})

test('statusBarStyle is light on dark or over the band', async (t) => {
  const { statusBarStyle } = await load()
  t.is(statusBarStyle('light'), 'dark')
  t.is(statusBarStyle('dark'), 'light')
  t.is(statusBarStyle('light', { overBand: true }), 'light')
  t.is(statusBarStyle('dark', { overBand: true }), 'light')
})

test('module boundaries', async (t) => {
  t.absent(/^\s*import\s/m.test(src('appearance.js')))
  const native = src('appearanceStore.native.js')
  t.ok(native.includes('textSync') && native.includes('FILE_NAME'))
  const web = src('appearanceStore.web.js')
  t.ok(web.includes('STORAGE_KEY') && web.includes('localStorage'))
  for (const name of ['appearance.js', 'appearanceStore.native.js', 'appearanceStore.web.js']) {
    t.absent(src(name).includes('\u2014'), name)
  }
})

test('web store round-trips and ignores corrupt data', async (t) => {
  const { STORAGE_KEY } = await load()
  const web = await import('../src/appearanceStore.web.js')
  const mem = new Map()
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) }
  })
  try {
    t.is(web.loadAppearanceRecord(), null)
    t.is(web.saveAppearanceRecord({ v: 1, mode: 'dark' }), true)
    t.alike(web.loadAppearanceRecord(), { v: 1, mode: 'dark' })
    t.is(web.saveAppearanceRecord({ v: 1, mode: 'auto' }), false)
    mem.set(STORAGE_KEY, '{nope')
    t.is(web.loadAppearanceRecord(), null)
    mem.set(STORAGE_KEY, JSON.stringify({ v: 1, mode: 'dark', x: 1 }))
    t.is(web.loadAppearanceRecord(), null)
    t.execution(() => web.applySchemeToDocument('dark', { bg: '#1c2622', themeColor: '#1c2622' }))
  } finally {
    if (prev) Object.defineProperty(globalThis, 'localStorage', prev)
    else delete globalThis.localStorage
  }
})
