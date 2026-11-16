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

test('a successful switch tells its listeners the new value, a failed one tells nobody', async (t) => {
  const { onPreviewsChange, setPreviewsEnabled } = await load()
  const heard = []
  const off = onPreviewsChange((on) => heard.push(on))
  const broken = onPreviewsChange(() => { throw new Error('listener') })
  const store = memoryStore()
  t.is(setPreviewsEnabled(store, false), true, 'a throwing listener does not fail the write')
  t.is(setPreviewsEnabled(store, true), true)
  t.is(setPreviewsEnabled(store, 'off'), false)
  t.is(setPreviewsEnabled({ setItem () { throw new Error('full') } }, false), false)
  t.alike(heard, [false, true], 'only the written values')
  off()
  broken()
  setPreviewsEnabled(store, false)
  t.alike(heard, [false, true], 'nothing after unsubscribing')
  t.is(typeof onPreviewsChange(null), 'function', 'a non-function listener is ignored')
})

test('web: a storage event from another tab reaches this tab', async (t) => {
  const { onPreviewPrefStorage } = await import('../src/previewBuild.web.js')
  const had = { add: Object.hasOwn(globalThis, 'addEventListener'), remove: Object.hasOwn(globalThis, 'removeEventListener') }
  const saved = { add: globalThis.addEventListener, remove: globalThis.removeEventListener }
  const added = []
  const removed = []
  globalThis.addEventListener = (type, fn) => added.push([type, fn])
  globalThis.removeEventListener = (type, fn) => removed.push([type, fn])
  t.teardown(() => {
    if (had.add) globalThis.addEventListener = saved.add
    else delete globalThis.addEventListener
    if (had.remove) globalThis.removeEventListener = saved.remove
    else delete globalThis.removeEventListener
  })
  let heard = 0
  const off = onPreviewPrefStorage(() => heard++)
  t.is(added.length, 1)
  t.is(added[0][0], 'storage')
  added[0][1]({ key: 'varanda-previas-links' })
  t.is(heard, 1)
  off()
  t.alike(removed, added, 'the same handler is removed')
  t.is(typeof onPreviewPrefStorage(null), 'function', 'a non-function listener is ignored')
  t.is(added.length, 1)
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
