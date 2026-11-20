'use strict'

// When the shell acts on a held launch intent (src/launchDue.js).
const test = require('brittle')

const load = () => import('../src/launchDue.js')

test('launchDue: the tabs take every intent', async (t) => {
  const { launchDue } = await load()
  for (const kind of ['convite', 'dm', 'follow', 'reply']) {
    t.is(launchDue({ kind, atTabs: true, sheetOpen: false, phoneClear: true }), true, kind)
  }
})

test('launchDue: off the tabs only a convite into an open sheet, past the phone gate', async (t) => {
  const { launchDue } = await load()
  t.is(launchDue({ kind: 'convite', atTabs: false, sheetOpen: true, phoneClear: true }), true)
  t.is(launchDue({ kind: 'convite', atTabs: false, sheetOpen: false, phoneClear: true }), false)
  for (const kind of ['dm', 'follow', 'reply']) {
    t.is(launchDue({ kind, atTabs: false, sheetOpen: true, phoneClear: true }), false, kind)
  }
})

test('launchDue: the explainer delete keeps a held convite held', async (t) => {
  const { launchDue } = await load()
  t.is(launchDue({ kind: 'convite', atTabs: false, sheetOpen: true, phoneClear: false, deleteFromAviso: true }), false)
  t.is(launchDue({ kind: 'convite', atTabs: false, sheetOpen: true, phoneClear: false }), false)
  t.is(launchDue({ kind: 'convite', atTabs: false, sheetOpen: true, phoneClear: true, deleteFromAviso: true }), false)
  for (const phoneClear of [undefined, 'true', 1]) {
    t.is(launchDue({ kind: 'convite', atTabs: false, sheetOpen: true, phoneClear }), false, String(phoneClear))
  }
  t.is(launchDue(), false)
})
