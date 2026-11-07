'use strict'

const test = require('brittle')
const load = () => import('../src/previewPref.js')

function memoryStore (entries = new Map()) {
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value) }
  }
}

test('previews default to on and the switch label is in Portuguese', async (t) => {
  const { PREVIEW_PREF_LABEL, previewsEnabled } = await load()
  t.is(PREVIEW_PREF_LABEL, 'Prévia de links')
  t.is(previewsEnabled(memoryStore()), true)
})

test('off persists across store instances and can be switched on again', async (t) => {
  const { previewsEnabled, setPreviewsEnabled } = await load()
  const entries = new Map([['unrelated', 'keep']])
  t.is(setPreviewsEnabled(memoryStore(entries), false), true)
  t.is(previewsEnabled(memoryStore(entries)), false)
  t.is(entries.get('unrelated'), 'keep')
  t.is(entries.size, 2)
  t.is(setPreviewsEnabled(memoryStore(entries), true), true)
  t.is(previewsEnabled(memoryStore(entries)), true)
  t.is(previewsEnabled(memoryStore()), true, 'stores are independent')
})

test('broken or malformed stores read as on and failed writes report failure', async (t) => {
  const { previewsEnabled, setPreviewsEnabled } = await load()
  const broken = { getItem () { throw new Error('unavailable') }, setItem () { throw new Error('unavailable') } }
  for (const store of [null, undefined, {}, broken]) {
    t.is(previewsEnabled(store), true)
    t.is(setPreviewsEnabled(store, false), false)
  }
  for (const raw of [undefined, null, false, '', '{', 'null', '[]', 'false', '{}',
    '{"v":2,"enabled":false}', '{"v":1,"enabled":"false"}']) {
    t.is(previewsEnabled({ getItem: () => raw }), true)
  }
})

test('invalid switch values do not overwrite an explicit opt-out', async (t) => {
  const { previewsEnabled, setPreviewsEnabled } = await load()
  const store = memoryStore()
  setPreviewsEnabled(store, false)
  for (const value of [null, undefined, 0, 1, 'false', {}, []]) {
    t.is(setPreviewsEnabled(store, value), false)
    t.is(previewsEnabled(store), false)
  }
})
