'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/tabs.js')
const tabBarSrc = readFileSync(join(__dirname, '..', 'src', 'ui', 'TabBar.js'), 'utf8')

test('TabBar: each tab is 48 pt tall inside the 49 pt bar, which has no top padding', (t) => {
  t.ok(tabBarSrc.includes('minHeight: layout.tabBar - 1'), 'the tab fills the bar under its 1 pt border')
  t.absent(tabBarSrc.includes('paddingTop: 6'), 'the bar does not pad the tabs from above')
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
  for (const screen of ['mensagem', 'grupo', 'comunidade', 'comunidade-info', 'comunidades', 'pedidos']) {
    t.absent(showPostButton({ tab: 'comunidades', screen }), screen)
    t.absent(showPostButton({ tab: 'rua', screen }), screen + ' opened from another tab')
  }
  for (const screen of ['conversa', 'membro', 'curtidas']) {
    t.ok(showPostButton({ tab: 'comunidades', screen }), screen + ' keeps it')
  }
})
