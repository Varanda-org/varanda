'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/historyCopy.js')
const EM_DASH = String.fromCharCode(0x2014)

test('the import notice reads plainly', async (t) => {
  const { importedText, IMPORTED_TITLE, IMPORTED_DISMISS } = await load()
  t.is(IMPORTED_TITLE, 'Conversas copiadas de outro aparelho')
  t.is(importedText({ messages: 1 }), '1 mensagem chegou de outro aparelho seu. Ela aparece na data em que foi enviada.')
  t.is(importedText({ messages: 4 }), '4 mensagens chegaram de outro aparelho seu. Elas aparecem na data em que foram enviadas.')
  t.ok(importedText({ messages: 0 }).includes('em dia'))
  t.ok(importedText(null).includes('em dia'), 'a malformed count reads as nothing new')
  for (const s of [IMPORTED_TITLE, IMPORTED_DISMISS, importedText({ messages: 2 })]) t.absent(s.includes(EM_DASH), 'no em dash')
})

test('the store folds dm.copyImported and ignores anything else', async (t) => {
  const { createCopyStore } = await load()
  const store = createCopyStore()
  let calls = 0
  const off = store.subscribe(() => { calls++ })
  const idle = store.get()
  store.apply('dm.changed', { added: 1 })
  store.apply('dm.copyProgress', { done: 1, total: 3 })
  store.apply('dm.copyImported', {})
  store.apply('dm.copyImported', { messages: -1 })
  t.is(store.get(), idle, 'a malformed or other event changes nothing')
  t.is(calls, 0)
  store.apply('dm.copyImported', { messages: 7 })
  t.alike(store.get().imported, { messages: 7 })
  t.is(calls, 1)
  store.clearImported()
  t.is(store.get().imported, null)
  store.clearImported()
  t.is(calls, 2, 'clearing twice notifies once')
  off()
  store.apply('dm.copyImported', { messages: 2 })
  t.is(calls, 2, 'no call after unsubscribe')
})

test('Conversas keeps the notice and has no copy row: the copy is automatic', async (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(screen.includes('<HistoryImportedNote />'), 'the notice is in the list header')
  t.absent(screen.includes('HistoryCopyRow') || screen.includes('HistoryCopySheet'), 'no row, no sheet')
  const ui = readFileSync(join(__dirname, '../src/ui/HistoryCopy.js'), 'utf8')
  t.absent(ui.includes('Platform'), 'the notice never branches on the platform')
  t.absent(ui.includes('dm.historyCopy') || ui.includes('Copiar conversas'), 'nothing starts a copy from the app')
  const node = readFileSync(join(__dirname, '../src/node.js'), 'utf8')
  t.ok(node.includes("name === 'dm.copyImported'"), 'node.js feeds the store')
  t.absent(node.includes('dm.copyProgress'), 'no progress event any more')
})
