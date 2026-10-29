'use strict'

const test = require('brittle')
const load = () => import('../src/mentions.js')

const OWN = 'aa'.repeat(32)
const key = (n) => n.toString(16).padStart(64, '0')

test('insertMention replaces the active token and keeps a UTF-16 caret', async (t) => {
  const { insertMention } = await load()
  t.alike(insertMention('oi @an', { start: 6, end: 6 }, 'ana'), {
    text: 'oi @ana ', selection: { start: 8, end: 8 }, changed: true
  })
  t.alike(insertMention('😀 @an', { start: 6, end: 6 }, 'ana'), {
    text: '😀 @ana ', selection: { start: 8, end: 8 }, changed: true
  })
  t.is(insertMention('oi @anXYZ', { start: 6, end: 6 }, 'ana').text, 'oi @ana ')
})

test('insertMention leaves unavailable selections and oversized text alone', async (t) => {
  const { insertMention } = await load()
  const email = { start: 8, end: 8 }
  t.alike(insertMention('email@ana', email, 'bia'), {
    text: 'email@ana', selection: email, changed: false
  })
  const range = { start: 3, end: 5 }
  t.alike(insertMention('oi @ana', range, 'bia'), {
    text: 'oi @ana', selection: range, changed: false
  })
  const full = 'x'.repeat(996) + ' @an'
  const selection = { start: full.length, end: full.length }
  t.alike(insertMention(full, selection, 'ana'), { text: full, selection, changed: false })
})

test('suggestionRows keeps verified usernames, ranks prefixes and caps the list', async (t) => {
  const { suggestionRows, MENTION_SUGGESTIONS_MAX, MENTION_MIN_QUERY } = await load()
  const rows = [
    { author: key(1), username: 'bia' },
    { author: key(2), username: 'ana' },
    { author: OWN.toUpperCase(), username: 'anita' },
    { author: key(3), username: 'alice' },
    { author: key(4), username: 'anjo' },
    { author: key(5), username: 'Ana' },
    { author: key(6), username: 'abc123' },
    { author: key(7), username: 'cai' },
    { author: key(8), username: 'duda' }
  ]
  t.is(MENTION_SUGGESTIONS_MAX, 5)
  t.is(MENTION_MIN_QUERY, 2)
  t.alike(suggestionRows(rows, 'AN', OWN), [
    rows[1], rows[4], rows[0], rows[3], rows[7]
  ])
})

test('mention helpers reject invalid inputs without throwing', async (t) => {
  const { insertMention, suggestionRows } = await load()
  t.alike(insertMention(null, null, null), { text: null, selection: null, changed: false })
  t.alike(insertMention('@an', { start: 1, end: 2 }, 'Ana'), {
    text: '@an', selection: { start: 1, end: 2 }, changed: false
  })
  t.alike(suggestionRows(null, null, null), [])
  t.alike(suggestionRows([null, {}, { author: key(1), username: 1 }], {}, {}, NaN), [])
})

test('insertMention rejects fallback handles and non-string usernames', async (t) => {
  const { insertMention } = await load()
  t.is(insertMention('oi @ab', { start: 6, end: 6 }, 'abcdef').changed, false)
  t.is(insertMention('oi @an', { start: 6, end: 6 }, ['ana']).changed, false)
})

test('insertMention reuses following whitespace instead of adding a space', async (t) => {
  const { insertMention } = await load()
  const r = insertMention('oi @an there', { start: 6, end: 6 }, 'ana')
  t.is(r.text, 'oi @ana there')
  t.alike(r.selection, { start: 8, end: 8 })
  t.is(r.changed, true)
})

test('insertMention drops the trailing space when only it would overflow', async (t) => {
  const { insertMention } = await load()
  // The space before "@" keeps the token a real mention (an email-like prefix is not one).
  const r = insertMention('x'.repeat(995) + ' @ab', { start: 999, end: 999 }, 'ana')
  t.is(r.changed, true)
  t.is(r.text.length, 1000)
  t.alike(r.selection, { start: 1000, end: 1000 })
})
