'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')

const load = () => import('../src/profileThemes.js')
const loadAppearance = () => import('../src/appearance.js')

test('there are eight themes with unique ids, default first', async (t) => {
  const { THEMES, THEME_IDS, DEFAULT_THEME } = await load()
  t.is(THEMES.length, 8)
  t.is(new Set(THEME_IDS).size, 8)
  t.is(THEME_IDS[0], DEFAULT_THEME)
  t.alike([...THEME_IDS], [...rpc.THEME_IDS])
})

test('every palette keeps text at 4.5:1 or more in both modes', async (t) => {
  const { THEMES } = await load()
  const { contrastRatio } = await loadAppearance()
  for (const th of THEMES) {
    for (const mode of ['light', 'dark']) {
      const c = th[mode]
      t.ok(contrastRatio(c.bandInk, c.band) >= 4.5, `${th.id} ${mode} band`)
      t.ok(contrastRatio(c.accentInk, c.accent) >= 4.5, `${th.id} ${mode} accent label`)
    }
  }
})

test('accents read on the card of each scheme', async (t) => {
  const { THEMES } = await load()
  const { contrastRatio, light, dark } = await loadAppearance()
  for (const th of THEMES) {
    t.ok(contrastRatio(th.light.accent, light.card) >= 4.5, `${th.id} light`)
    t.ok(contrastRatio(th.dark.accent, dark.card) >= 4.5, `${th.id} dark`)
  }
})

test('unknown ids fall back to the default', async (t) => {
  const { themeFor, themeColors, isThemeId, DEFAULT_THEME } = await load()
  for (const bad of [undefined, null, 7, '', 'nope', '__proto__', {}]) {
    t.is(themeFor(bad).id, DEFAULT_THEME)
    t.is(isThemeId(bad), false)
  }
  t.is(themeColors('mar', 'dark'), themeFor('mar').dark)
  t.is(themeColors('mar', 'light'), themeFor('mar').light)
  t.is(themeColors('mar'), themeFor('mar').light)
})

test('worstContrast reports the weakest pair', async (t) => {
  const { THEMES, worstContrast } = await load()
  for (const th of THEMES) t.ok(worstContrast(th.light) >= 4.5 && worstContrast(th.dark) >= 4.5, th.id)
})
