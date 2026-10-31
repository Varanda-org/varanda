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

test('tabsFor: hosted adds Cadeiras right after Espiadinha', async (t) => {
  const { TABS, tabsFor } = await load()
  const tabs = tabsFor('hosted')
  t.is(tabs.length, 6)
  t.alike(tabs, [
    TABS[0],
    TABS[1],
    { id: 'cadeiras', label: 'Cadeiras', icon: 'cadeira' },
    ...TABS.slice(2)
  ])
  t.is(TABS.length, 5)
})

test('tabsFor: other modes keep the default tabs', async (t) => {
  const { TABS, tabsFor } = await load()
  for (const mode of [undefined, null, '', 'other', 'HOSTED']) {
    t.alike(tabsFor(mode), TABS)
  }
})
