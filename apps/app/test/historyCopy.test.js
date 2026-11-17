'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const load = () => import('../src/historyCopy.js')
const EM_DASH = String.fromCharCode(0x2014)

test('the option and the sheet say what goes, for whom, how long and the weekly allowance', async (t) => {
  const m = await load()
  t.is(m.COPY_ROW_LABEL, 'Copiar conversas para outro aparelho')
  const text = m.COPY_POINTS.join(' ')
  t.ok(text.includes('texto') && text.includes('fotos'), 'what goes')
  t.ok(text.includes('Páginas que você administra'), 'the Páginas')
  t.ok(text.includes('As fotos das Páginas não vão'), 'Página photos do not travel')
  t.ok(text.includes('30 a 50 minutos') && !text.includes('alguns minutos'), 'an honest duration')
  t.ok(text.includes('mesma passkey'), 'for whom')
  t.ok(text.includes('14 dias'), 'how long the other device has')
  t.ok(text.includes('cota semanal'), 'the weekly allowance')
  t.ok(Object.isFrozen(m.COPY_POINTS))
  for (const s of [...m.COPY_POINTS, m.COPY_TITLE, m.COPY_START, m.IMPORTED_TITLE]) t.absent(s.includes(EM_DASH), 'no em dash')
})

test('the result lines count messages, photos and both kinds of photo left out', async (t) => {
  const { resultLines } = await load()
  t.alike(resultLines({ messages: 1, photos: 1, notCached: 0, leftOut: 0 }), ['Pronto: 1 mensagem copiada e 1 foto.'])
  t.alike(resultLines({ messages: 12, photos: 3, notCached: 2, leftOut: 1 }), [
    'Pronto: 12 mensagens copiadas e 3 fotos.',
    '2 fotos não estavam guardadas neste aparelho e ficaram de fora.',
    '1 foto ficou de fora porque a cota de cópia de fotos acabou ou o semeador não a oferece. Uma nova cópia começa de novo pelas fotos mais recentes.'
  ])
  t.absent(resultLines({ messages: 1, photos: 0, notCached: 0, leftOut: 2 }).join(' ').includes('semana que vem'), 'no promise that the oldest photos come later')
  t.alike(resultLines({ messages: 2, photos: 0, notCached: 1, leftOut: 0 }), [
    'Pronto: 2 mensagens copiadas e 0 fotos.',
    '1 foto não estava guardada neste aparelho e ficou de fora.'
  ])
  t.alike(resultLines(null), ['A cópia terminou.'])
  t.alike(resultLines({ messages: -1, photos: 0 }), ['A cópia terminou.'])
})

test('progress and the import notice read plainly', async (t) => {
  const { progressText, importedText, COPY_STARTING } = await load()
  t.is(progressText({ done: 2, total: 5 }), 'Copiando: 2 de 5')
  t.is(progressText({ done: 9, total: 5 }), 'Copiando: 5 de 5')
  t.is(progressText(null), COPY_STARTING)
  t.is(progressText({ done: 0, total: 0 }), COPY_STARTING)
  t.is(importedText({ messages: 1 }), '1 mensagem chegou de outro aparelho seu. Ela aparece na data em que foi enviada.')
  t.is(importedText({ messages: 4 }), '4 mensagens chegaram de outro aparelho seu. Elas aparecem na data em que foram enviadas.')
  t.ok(importedText({ messages: 0 }).includes('em dia'))
})

test('the store folds the two events and ignores anything else', async (t) => {
  const { createCopyStore } = await load()
  const store = createCopyStore()
  let calls = 0
  const off = store.subscribe(() => { calls++ })
  const idle = store.get()
  store.apply('dm.changed', { added: 1 })
  store.apply('dm.copyProgress', { done: -1, total: 2 })
  store.apply('dm.copyImported', {})
  t.is(store.get(), idle, 'a malformed or other event changes nothing')
  t.is(calls, 0)
  store.apply('dm.copyProgress', { done: 1, total: 3 })
  t.alike(store.get().progress, { done: 1, total: 3 })
  store.apply('dm.copyImported', { messages: 7 })
  t.alike(store.get().imported, { messages: 7 })
  t.is(calls, 2)
  store.clearImported()
  t.is(store.get().imported, null)
  store.clearProgress()
  t.is(store.get().progress, null)
  store.clearProgress()
  t.is(calls, 4, 'clearing twice notifies once')
  off()
  store.apply('dm.copyProgress', { done: 2, total: 3 })
  t.is(calls, 4, 'no call after unsubscribe')
})

test('Conversas shows the row only where the node can copy, never by Platform.OS', async (t) => {
  const screen = readFileSync(join(__dirname, '../src/screens/Conversas.js'), 'utf8')
  t.ok(screen.includes('<HistoryCopyRow'), 'the row is in the list header')
  t.ok(screen.includes('unlocked && ready && pageKey === null'), 'unlocked, hosted and not acting as a page')
  const sheet = readFileSync(join(__dirname, '../src/ui/HistoryCopy.js'), 'utf8')
  t.absent(sheet.includes('Platform'), 'the sheet never branches on the platform')
  t.ok(sheet.includes("request('dm.historyCopy'"), 'it starts the rpc only on the button')
  const node = readFileSync(join(__dirname, '../src/node.js'), 'utf8')
  t.ok(node.includes("name === 'dm.copyProgress' || name === 'dm.copyImported'"), 'node.js feeds the store')
})
