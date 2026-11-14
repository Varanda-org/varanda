'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/searchRecents.js')
const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8')

test('recordRecent trims, dedupes ignoring case and keeps the newest first', async (t) => {
  const { recordRecent } = await load()
  const list = Object.freeze(['chuva', 'Horta'])
  t.alike(recordRecent(list, '  Céu azul  '), ['Céu azul', 'chuva', 'Horta'])
  t.alike(list, ['chuva', 'Horta'], 'the given list is not changed')
  t.alike(recordRecent(['chuva', 'Horta'], 'HORTA'), ['HORTA', 'chuva'], 'a repeat moves to the top')
  t.alike(recordRecent([], '@maria'), ['@maria'])
  t.alike(recordRecent(undefined, 'Horta'), ['Horta'])
})

test('recordRecent ignores a blank query', async (t) => {
  const { recordRecent } = await load()
  for (const query of ['', '   ', null, undefined, 42]) {
    t.alike(recordRecent(['Horta'], query), ['Horta'], JSON.stringify(query) + ' is not recorded')
  }
})

test('recordRecent keeps at most eight', async (t) => {
  const { recordRecent, RECENTS_MAX } = await load()
  t.is(RECENTS_MAX, 8)
  let list = []
  for (const q of ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez']) list = recordRecent(list, q)
  t.alike(list, ['dez', 'nove', 'oito', 'sete', 'seis', 'cinco', 'quatro', 'três'])
})

test('removeRecent drops one query ignoring case and spaces, clearRecents empties', async (t) => {
  const { removeRecent, clearRecents } = await load()
  const list = Object.freeze(['Céu', 'chuva', 'Horta'])
  t.alike(removeRecent(list, ' CHUVA '), ['Céu', 'Horta'])
  t.alike(list, ['Céu', 'chuva', 'Horta'], 'the given list is not changed')
  t.alike(removeRecent(list, 'nada'), ['Céu', 'chuva', 'Horta'])
  t.alike(removeRecent(undefined, 'Céu'), [])
  t.alike(clearRecents(), [])
})

test('texts are pt-BR without an em dash', async (t) => {
  const r = await load()
  t.is(r.RECENTS_TITLE, 'Buscas recentes')
  t.is(r.RECENTS_CLEAR, 'Limpar')
  t.is(r.RECENTS_REMOVE, 'Remover')
  for (const s of [r.RECENTS_TITLE, r.RECENTS_CLEAR, r.RECENTS_CLEAR_LABEL, r.RECENTS_REMOVE]) t.absent(s.includes('\u2014'))
})

test('the module is pure and nothing persists the recents', (t) => {
  const src = read('searchRecents.js')
  const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
  t.alike(specs, ['./buscaGlobal.js'], 'only the pure Busca model')
  const screen = read('screens/BuscaGlobal.js')
  t.ok(screen.includes("from '../searchRecents'"), 'the screen uses the module')
  const storage = /AsyncStorage|localStorage|sessionStorage|SecureStore|indexedDB|\bkv\b|from '\.\.\/storage|from '\.\.\/prefs|history\.(push|replace)State|Linking\./
  t.absent(storage.test(screen), 'no storage, file or URL call in the screen')
  t.absent(storage.test(src), 'no storage, file or URL call in the module')
  t.ok(/const \[recents, setRecents\] = useState\(NO_RECENTS\)/.test(screen), 'the list lives in component state')
  t.ok(/if \(lastOwn\.current === own\) return\s*lastOwn\.current = own\s*setRecents\(NO_RECENTS\)/.test(screen), 'a new signed-in key starts an empty list')
})
