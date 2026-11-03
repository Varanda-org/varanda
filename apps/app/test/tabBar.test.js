'use strict'

const test = require('brittle')

const load = () => import('../src/tabs.js')

test('tabsFor: native and serve keep the five existing tabs', async (t) => {
  const { TABS, tabsFor } = await load()
  t.alike(TABS, [
    { id: 'rua', label: 'A Rua', icon: 'casa' },
    { id: 'espiadinha', label: 'Espiadinha', icon: 'olho' },
    { id: 'seguindo', label: 'Seguindo', icon: 'gente' },
    { id: 'avisos', label: 'Avisos', icon: 'sino' },
    { id: 'diario', label: 'Diário', icon: 'pessoa' }
  ])
  t.alike(tabsFor('native'), TABS)
  t.alike(tabsFor('serve'), TABS)
})

test('tabsFor: hosted adds Conversas right after Espiadinha', async (t) => {
  const { TABS, tabsFor } = await load()
  const tabs = tabsFor('hosted')
  t.is(tabs.length, 6)
  t.alike(tabs, [
    TABS[0],
    TABS[1],
    { id: 'comunidades', label: 'Conversas', icon: 'conversas' },
    ...TABS.slice(2)
  ])
  t.alike(tabs[2], { id: 'comunidades', label: 'Conversas', icon: 'conversas' })
  t.is(TABS.length, 5)
})

test('tabsFor: other modes keep the default tabs', async (t) => {
  const { TABS, tabsFor } = await load()
  for (const mode of [undefined, null, '', 'other', 'HOSTED', 'core']) {
    t.alike(tabsFor(mode), TABS)
  }
})

test('showPostButton: no "publicar" on Conversas nor on its screens', async (t) => {
  const { showPostButton } = await load()
  for (const tab of ['rua', 'espiadinha', 'seguindo', 'avisos', 'diario']) {
    t.ok(showPostButton({ tab, screen: null }), tab)
  }
  t.absent(showPostButton({ tab: 'comunidades', screen: null }), 'the Conversas tab')
  for (const screen of ['mensagem', 'grupo', 'comunidade']) {
    t.absent(showPostButton({ tab: 'comunidades', screen }), screen)
    t.absent(showPostButton({ tab: 'rua', screen }), screen + ' opened from another tab')
  }
  for (const screen of ['conversa', 'membro', 'curtidas']) {
    t.ok(showPostButton({ tab: 'comunidades', screen }), screen + ' keeps it')
  }
})
