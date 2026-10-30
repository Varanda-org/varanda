'use strict'

const test = require('brittle')

const load = () => import('../src/followInput.js')

test('classifyFollowInput normalizes complete keys', async (t) => {
  const { classifyFollowInput } = await load()
  const key = 'abcdef0123456789'.repeat(4)
  for (const text of [key.toUpperCase(), key, '  ' + key.toUpperCase() + '  ']) {
    t.alike(classifyFollowInput(text), { kind: 'key', key })
  }
})

test('classifyFollowInput keeps partial keys out of name search', async (t) => {
  const { classifyFollowInput } = await load()
  for (const length of [63, 65, 21]) {
    t.alike(classifyFollowInput('a'.repeat(length)), { kind: 'partial-key' })
  }
})

test('classifyFollowInput recognizes names and short hexadecimal input', async (t) => {
  const { classifyFollowInput } = await load()
  for (const text of ['a'.repeat(20), 'ana', 'Ana Silva', '1234']) {
    t.alike(classifyFollowInput(text), { kind: 'name' })
  }
})

test('classifyFollowInput trims handles without changing case', async (t) => {
  const { classifyFollowInput } = await load()
  t.alike(classifyFollowInput('@ana'), { kind: 'handle', handle: '@ana' })
  t.alike(classifyFollowInput(' @Ana '), { kind: 'handle', handle: '@Ana' })
})

test('classifyFollowInput ignores blank and non-string input', async (t) => {
  const { classifyFollowInput } = await load()
  for (const text of ['', '  ', null, undefined, 7]) {
    t.alike(classifyFollowInput(text), { kind: 'empty' })
  }
})

test('partial key guidance is non-empty pt-BR text without an em dash', async (t) => {
  const { PARTIAL_KEY_TEXT } = await load()
  t.is(typeof PARTIAL_KEY_TEXT, 'string')
  t.ok(PARTIAL_KEY_TEXT.length > 0)
  t.is(PARTIAL_KEY_TEXT, 'Código incompleto: são 64 letras e números.')
  t.absent(PARTIAL_KEY_TEXT.includes('\u2014'))
})
