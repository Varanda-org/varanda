'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/peopleFilter.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)

const table = (rows) => (key) => rows[key]

const people = table({
  [A]: { name: 'Ana Silva', username: 'ana' },
  [B]: { name: 'Ana Costa', username: 'costa.b' },
  [C]: { name: 'Silva Lima', username: 'lima' }
})

test('empty text returns the keys unchanged', async (t) => {
  const { filterPeople } = await load()
  const keys = [A, B, C]
  t.is(filterPeople(keys, people, ''), keys)
  t.is(filterPeople(keys, people, '   '), keys)
  t.is(filterPeople(keys, people, '@'), keys, 'a lone @ is no word')
  t.is(filterPeople(keys, people, null), keys)
  t.is(filterPeople(keys, people, undefined), keys)
  t.is(filterPeople(keys, people, 42), keys)
})

test('accents and case are folded', async (t) => {
  const { filterPeople } = await load()
  const profiles = table({ [A]: { name: 'João Pedro', username: null }, [B]: { name: 'Bia', username: null } })
  t.alike(filterPeople([A, B], profiles, 'joao'), [A])
  t.alike(filterPeople([A, B], profiles, 'JOÃO'), [A])
  t.alike(filterPeople([A, B], profiles, 'pedro'), [A])
})

test('a leading @ matches the username', async (t) => {
  const { filterPeople } = await load()
  t.alike(filterPeople([A, B, C], people, '@ana'), [A, B], 'the @ is dropped and the word matches either field')
  t.alike(filterPeople([A, B, C], people, '@costa.b'), [B], 'a username with a dot')
  t.alike(filterPeople([A, B, C], people, 'ana'), [A, B], 'without @ the same word matches')
})

test('every token must match, each in either field', async (t) => {
  const { filterPeople } = await load()
  t.alike(filterPeople([A, B, C], people, 'ana sil'), [A], 'Ana Silva has both words')
  t.alike(filterPeople([A, B, C], people, 'sil ana'), [A], 'order of the tokens does not matter')
  t.alike(filterPeople([A, B, C], people, 'ana lima'), [], 'no account has both')
  t.alike(filterPeople([A, B, C], people, '  ana   sil  '), [A], 'extra spaces are dropped')
})

test('a username-only hit is kept', async (t) => {
  const { filterPeople } = await load()
  const profiles = table({ [A]: { name: null, username: 'zeca' }, [B]: { name: 'Carla', username: 'cafe_123' } })
  t.alike(filterPeople([A, B], profiles, 'zec'), [A])
  t.alike(filterPeople([A, B], profiles, 'cafe'), [B])
  t.alike(filterPeople([A, B], profiles, 'carla cafe'), [B], 'one token per field')
})

test('an unknown profile is dropped only when the text is not empty', async (t) => {
  const { filterPeople } = await load()
  const profiles = table({ [A]: { name: 'Ana', username: null }, [C]: { name: null, username: null } })
  t.alike(filterPeople([A, B, C], profiles, 'ana'), [A], 'B is unknown and C has no name')
  t.is(filterPeople([A, B, C], profiles, '').length, 3, 'with empty text nothing is dropped')
  t.alike(filterPeople([A, B, C], profiles, '@'), [A, B, C])
})

test('a profile that throws is dropped and never throws out', async (t) => {
  const { filterPeople } = await load()
  const boom = () => { throw new Error('no profile') }
  t.alike(filterPeople([A], boom, 'ana'), [])
  t.alike(filterPeople([A], null, 'ana'), [], 'a missing lookup drops every key')
  t.alike(filterPeople(null, people, 'ana'), [], 'non-array keys give an empty list')
  t.alike(filterPeople('abc', people, 'ana'), [])
})

test('a 64-hex string is only text', async (t) => {
  const { filterPeople } = await load()
  const profiles = table({ [A]: { name: 'Ana', username: null }, [B]: { name: null, username: A } })
  t.alike(filterPeople([A, B], profiles, A), [B], 'matches only where the hex appears as a username')
  t.alike(filterPeople([A, B], profiles, 'ana'), [A])
  t.alike(filterPeople([A, B], profiles, C), [], 'an unknown hex is not looked up')
})

test('order is kept', async (t) => {
  const { filterPeople } = await load()
  const profiles = table({ [A]: { name: 'Ana 1', username: null }, [B]: { name: 'Ana 2', username: null }, [C]: { name: 'Ana 3', username: null } })
  t.alike(filterPeople([C, A, B], profiles, 'ana'), [C, A, B])
  t.alike(filterPeople([B, C, A], profiles, 'ANA 2'), [B])
})

test('the fixed texts are the agreed ones', async (t) => {
  const s = await load()
  t.is(s.FILTER_LABEL, 'Filtrar nesta lista')
  t.is(s.FILTER_PLACEHOLDER, 'nome ou @nome')
  t.is(s.FILTER_HINT, 'Para encontrar outra conta, use a Busca.')
  t.is(s.FILTER_EMPTY, 'Ninguém com esse nome nesta lista.')
})

test('the module imports no React, React Native or Node built-ins', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'peopleFilter.js'), 'utf8')
  t.absent(/from\s+['"](react|react-native|node:[^'"]*)['"]/.test(src), 'no forbidden import')
  t.absent(/import\s+['"](react|react-native|node:[^'"]*)['"]/.test(src), 'no bare forbidden import')
  t.ok(/from\s+['"]\.\/search\.js['"]/.test(src), 'imports the fold of the account search')
})

test('folds like the account search: every @, punctuation, special letters, invisible characters', async (t) => {
  const { filterPeople } = await load()
  const D = 'd'.repeat(64)
  const E = 'e'.repeat(64)
  const F = 'f'.repeat(64)
  const more = table({
    [A]: { name: 'Ana Silva', username: 'ana' },
    [C]: { name: 'Silva Lima', username: 'lima' },
    [D]: { name: 'Łukasz', username: null },
    [E]: { name: 'Straße Ø', username: null },
    [F]: { name: 'Zé​ca', username: null }
  })
  const keys = [A, C, D, E, F]
  t.alike(filterPeople(keys, more, 'silva @lima'), [C], 'an @ inside the text')
  t.alike(filterPeople(keys, more, '@silva @lima'), [C], 'an @ on every word')
  t.alike(filterPeople(keys, more, 'Ana,'), [A], 'punctuation is no part of the word')
  t.alike(filterPeople(keys, more, 'lukasz'), [D])
  t.alike(filterPeople(keys, more, 'strasse'), [E])
  t.alike(filterPeople(keys, more, 'zeca'), [F], 'a zero-width character inside a name')
})
