'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/connectText.js')

const LOAD_FAILED = 'Não foi possível carregar o app. Recarregue a página.'

test('another tab maps to the plain other-tab sentence', async (t) => {
  const { connectProblem, OTHER_TAB_TEXT } = await load()
  t.alike(connectProblem('outra aba já usa o Varanda neste navegador'), { text: OTHER_TAB_TEXT, detail: '' })
  t.alike(connectProblem('outra aba assumiu a conexão'), { text: OTHER_TAB_TEXT, detail: '' })
  t.alike(connectProblem('armazenamento do navegador (IndexedDB) falhou ao abrir o banco (bloqueado por outra aba)'), { text: OTHER_TAB_TEXT, detail: '' })
  t.alike(connectProblem('armazenamento do navegador (IndexedDB) falhou ao apagar o banco varanda (em uso por outra aba)'), { text: OTHER_TAB_TEXT, detail: '' })
})

test('the browser node message the mapping relies on still exists', async (t) => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'packages', 'web-member', 'web', 'node.js'), 'utf8')
  t.ok(source.includes('outra aba já usa o Varanda neste navegador'))
})

test('the load failure sentence is already plain and kept as is', async (t) => {
  const { connectProblem } = await load()
  t.alike(connectProblem(LOAD_FAILED), { text: LOAD_FAILED, detail: '' })
})

test('any other message becomes the generic sentence with the message as detail', async (t) => {
  const { connectProblem, CONNECT_FAILED_TEXT } = await load()
  t.alike(connectProblem('QuotaExceededError'), { text: CONNECT_FAILED_TEXT, detail: 'QuotaExceededError' })
  t.alike(connectProblem('a conexão com o nó foi encerrada'), { text: CONNECT_FAILED_TEXT, detail: 'a conexão com o nó foi encerrada' })
})

test('no error means no problem', async (t) => {
  const { connectProblem } = await load()
  t.alike(connectProblem(''), { text: '', detail: '' })
  t.alike(connectProblem(undefined), { text: '', detail: '' })
  t.alike(connectProblem(null), { text: '', detail: '' })
  t.alike(connectProblem(new Error('x')), { text: '', detail: '' })
})

test('the shown strings avoid technical words and the em dash', async (t) => {
  const mod = await load()
  const strings = [mod.OTHER_TAB_TEXT, mod.CONNECT_FAILED_TEXT, mod.RETRY_LABEL, mod.DETAILS_LABEL, LOAD_FAILED]
  const banned = new Set(['semeador', 'nó', 'chave', 'certificado', 'bootstrap', 'dht', 'hypercore', 'índice'])
  for (const s of strings) {
    t.absent(s.includes('\u2014'), 'no em dash: ' + s)
    const words = s.toLowerCase().split(/[^\p{L}]+/u)
    t.absent(words.some((w) => banned.has(w)), 'no technical word: ' + s)
  }
})
