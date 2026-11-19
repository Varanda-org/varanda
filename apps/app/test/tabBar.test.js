'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/tabs.js')
const tabBarSrc = readFileSync(join(__dirname, '..', 'src', 'ui', 'TabBar.js'), 'utf8')

test('TabBar: six 58 pt tabs fit a floating pill on a 320 pt screen', async (t) => {
  const themeSource = readFileSync(join(__dirname, '..', 'src', 'ui', 'theme.js'), 'utf8')
    .replace("import { Platform } from 'react-native'", 'const Platform = { select: (values) => values.default }')
  const { layout, radius, space, elevation } = await import('data:text/javascript,' + encodeURIComponent(themeSource))
  const factory = tabBarSrc.slice(tabBarSrc.indexOf('const makeStyles ='), tabBarSrc.lastIndexOf('\nconst '))
  // eslint-disable-next-line no-new-func
  const styles = new Function('StyleSheet', 'layout', 'radius', 'space', 'elevation', factory + '\nreturn makeStyles({})')({ create: (value) => value }, layout, radius, space, elevation)
  const floating = styles.floating || {}
  t.alike({
    height: floating.height,
    padding: floating.padding,
    borderWidth: floating.borderWidth,
    radius: floating.borderRadius,
    shadow: floating.boxShadow,
    width: floating.width,
    maxWidth: floating.maxWidth,
    margin: styles.bar.paddingHorizontal,
    tabHeight: styles.tab.height,
    share: styles.tab.flex,
    clearance: layout.tabBar - floating.height
  }, { height: 62, padding: 2, borderWidth: 1, radius: radius.pill, shadow: elevation.lg, width: '100%', maxWidth: layout.column, margin: 24, tabHeight: 58, share: 1, clearance: 16 })
  const { tabsFor } = await load()
  const targetWidth = (Math.min(320 - 2 * styles.bar.paddingHorizontal, floating.maxWidth) - 2 * (floating.padding + floating.borderWidth)) / tabsFor('hosted').length
  t.ok(targetWidth >= layout.hit && styles.tab.height >= layout.hit &&
    !styles.bar.backgroundColor && !styles.bar.borderWidth && !styles.bar.borderTopWidth &&
    tabBarSrc.includes("pointerEvents='box-none'") && tabBarSrc.includes('paddingBottom: insets.bottom + space.lg') &&
    !tabBarSrc.includes('paddingTop: 6'), '44 pt targets, transparent margins that pass touches through and 16 pt above the safe area')
})

test('tabsFor: native and serve show the four tabs', async (t) => {
  const { TABS, tabsFor } = await load()
  t.alike(TABS, [
    { id: 'rua', label: 'A Rua', icon: 'rua' },
    { id: 'espiadinha', label: 'Espiadinha', icon: 'olho' },
    { id: 'busca', label: 'Busca', icon: 'lupa' },
    { id: 'diario', label: 'Diário', icon: 'pessoa' }
  ])
  t.alike(tabsFor('native'), TABS)
  t.alike(tabsFor('serve'), TABS)
})

test('tabsFor: hosted adds Conversas and Feira before Busca', async (t) => {
  const { TABS, tabsFor } = await load()
  const tabs = tabsFor('hosted')
  t.is(tabs.length, 6)
  t.alike(tabs, [
    { id: 'rua', label: 'A Rua', icon: 'rua' },
    { id: 'espiadinha', label: 'Espiadinha', icon: 'olho' },
    { id: 'comunidades', label: 'Conversas', icon: 'conversas' },
    { id: 'feira', label: 'Feira', icon: 'feira' },
    { id: 'busca', label: 'Busca', icon: 'lupa' },
    { id: 'diario', label: 'Diário', icon: 'pessoa' }
  ])
  t.alike(tabs[2], { id: 'comunidades', label: 'Conversas', icon: 'conversas' })
  t.is(TABS.length, 4)
})

test('showPostButton: no "publicar" on Feira nor on its screens', async (t) => {
  const { showPostButton } = await load()
  t.absent(showPostButton({ tab: 'feira', screen: null }))
  t.absent(showPostButton({ tab: 'feira' }))
  for (const screen of ['anuncio', 'anunciar', 'editar-anuncio', 'avaliar', 'anuncios']) {
    for (const tab of ['feira', 'rua', 'comunidades']) {
      t.absent(showPostButton({ tab, screen }), screen + ' on ' + tab)
    }
  }
})

test('showPostButton: no "publicar" on the Varandinha screens', async (t) => {
  const { showPostButton } = await load()
  for (const screen of ['varandinha', 'varandinha-rua']) {
    for (const tab of ['rua', 'diario', 'busca']) t.absent(showPostButton({ tab, screen }), screen + ' on ' + tab)
  }
})

test('showPostButton: no "publicar" on an Assunto page', async (t) => {
  const { showPostButton } = await load()
  for (const tab of ['rua', 'diario', 'busca']) t.absent(showPostButton({ tab, screen: 'assunto' }), tab)
})

test('showPostButton: no "publicar" on Posts salvos', async (t) => {
  const { showPostButton } = await load()
  for (const tab of ['diario', 'rua', 'feira']) t.absent(showPostButton({ tab, screen: 'salvos' }), tab)
})

test('showPostButton: hidden on a profile Depoimentos tab', async (t) => {
  const { showPostButton } = await load()
  t.absent(showPostButton({ tab: 'diario', screen: null, profileTab: 'depoimentos' }))
  t.absent(showPostButton({ tab: 'rua', screen: 'membro', profileTab: 'depoimentos' }))
  t.ok(showPostButton({ tab: 'diario', screen: null, profileTab: 'posts' }))
  t.ok(showPostButton({ tab: 'rua', screen: 'membro', profileTab: 'mural' }))
  t.ok(showPostButton({ tab: 'rua', screen: 'membro' }))
})

test('tabsFor: manual and other modes show the default tabs without Conversas', async (t) => {
  const { TABS, tabsFor } = await load()
  t.alike(tabsFor('manual'), TABS)
  for (const mode of [undefined, null, '', 'other', 'HOSTED', 'core']) {
    t.alike(tabsFor(mode), TABS)
  }
  t.absent(tabsFor('manual').some((tab) => tab.id === 'comunidades'))
  t.absent(tabsFor(undefined).some((tab) => tab.id === 'comunidades'))
})

test('showPostButton: no "publicar" on Conversas nor on its screens', async (t) => {
  const { showPostButton } = await load()
  for (const tab of ['rua', 'espiadinha', 'busca', 'avisos', 'diario']) {
    t.ok(showPostButton({ tab, screen: null }), tab)
  }
  t.absent(showPostButton({ tab: 'comunidades', screen: null }), 'the Conversas tab')
  for (const screen of ['mensagem', 'grupo', 'comunidade', 'comunidade-info', 'comunidades', 'pedidos', 'conversa']) {
    t.absent(showPostButton({ tab: 'comunidades', screen }), screen)
    t.absent(showPostButton({ tab: 'rua', screen }), screen + ' opened from another tab')
  }
  for (const screen of ['membro', 'curtidas']) {
    t.ok(showPostButton({ tab: 'comunidades', screen }), screen + ' keeps it')
  }
})

test('TabBar: follows the chrome motion value and takes no touches while hidden', (t) => {
  t.ok(tabBarSrc.includes('useChromeMotion()'), 'useChromeMotion is used')
  t.ok(tabBarSrc.includes('progress.interpolate({ inputRange: [0, 1], outputRange: [0, barHeight] })'), 'the translate interpolates progress')
  t.ok(tabBarSrc.includes('transform: [{ translateY }]'), 'translate, not height')
  t.ok(/hidden\s*\? \{ pointerEvents: 'none', \.\.\.chromeHiddenProps\(show\) \}/.test(tabBarSrc), 'no touches and the hidden props while hidden')
  t.ok(tabBarSrc.includes("import { chromeHiddenProps } from '../chromeScroll'"), 'the shared hidden props')
})

test('Fab: leaves with the bar and takes no touches while hidden', (t) => {
  const fabSrc = readFileSync(join(__dirname, '..', 'src', 'ui', 'Fab.js'), 'utf8')
  t.ok(fabSrc.includes('useChromeMotion()'), 'useChromeMotion is used')
  t.ok(fabSrc.includes('progress.interpolate({ inputRange: [0, 1], outputRange: [0, offset + layout.fabSize] })'), 'the translate interpolates progress')
  t.ok(fabSrc.includes("pointerEvents={hidden ? 'none' : 'box-none'}"), 'no touches while hidden')
  t.ok(fabSrc.includes('const hiddenProps = hidden ? chromeHiddenProps(show) : null') && fabSrc.includes("import { chromeHiddenProps } from '../chromeScroll'"), 'no focus while hidden')
})
