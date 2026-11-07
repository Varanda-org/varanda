'use strict'

const test = require('brittle')

const load = () => import('../src/tabs.js')

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

test('tabsFor: hosted adds Conversas right after Espiadinha', async (t) => {
  const { TABS, tabsFor } = await load()
  const tabs = tabsFor('hosted')
  t.is(tabs.length, 5)
  t.alike(tabs, [
    { id: 'rua', label: 'A Rua', icon: 'rua' },
    { id: 'espiadinha', label: 'Espiadinha', icon: 'olho' },
    { id: 'comunidades', label: 'Conversas', icon: 'conversas' },
    { id: 'busca', label: 'Busca', icon: 'lupa' },
    { id: 'diario', label: 'Diário', icon: 'pessoa' }
  ])
  t.alike(tabs[2], { id: 'comunidades', label: 'Conversas', icon: 'conversas' })
  t.is(TABS.length, 4)
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
