'use strict'

// lib/word-check.js and lib/blocked-terms.js: the list and rule shared by the
// app and the account service. The rules use a made-up list, and the real
// list is only read from its module, so this file never spells a listed term.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { BLOCKED_TERMS, indexTerms, termInTokens } = require('@varanda/rpc')
const { wholeTokens } = require('@varanda/core/lib/search-text')

const LIB = path.join(__dirname, '../lib')

test('termInTokens: whole words, several in a row, digits at the edges', (t) => {
  const index = indexTerms(['cu', 'bola de neve'])
  t.is(termInTokens(['a', 'cultura'], index), null, 'never inside a longer word')
  t.is(termInTokens(['o', 'cu', 'dele'], index), 'cu')
  t.is(termInTokens(['uma', 'bola', 'de', 'neve'], index), 'bola de neve', 'words in a row')
  t.is(termInTokens(['bola', 'de', 'gude', 'neve'], index), null, 'not in a row')
  t.is(termInTokens(['bola', 'de'], index), null, 'cut short at the end')
  for (const token of ['cu123', '2cu', '007cu99']) t.is(termInTokens([token], index), 'cu', token)
  for (const token of ['cu1x', 'c1u']) t.is(termInTokens([token], index), null, token)
  t.is(termInTokens(['bola', '2024', 'de', 'neve'], index), null, 'a word of digits still separates')
  t.is(termInTokens(['bola1', 'de', 'neve2'], index), 'bola de neve')
  for (const value of [null, undefined, 'cu', 7, {}]) t.is(termInTokens(value, index), null, String(value))
})

test('the list: frozen, folded, whole words, no repeats, and each entry matches itself', (t) => {
  t.ok(Object.isFrozen(BLOCKED_TERMS))
  t.ok(BLOCKED_TERMS.length > 0)
  t.is(new Set(BLOCKED_TERMS).size, BLOCKED_TERMS.length, 'no repeats')
  let folded = 0
  let found = 0
  for (const term of BLOCKED_TERMS) {
    if (wholeTokens(term).join(' ') === term) folded++
    if (termInTokens(wholeTokens('antes ' + term.toUpperCase() + ' depois')) === term) found++
  }
  t.is(folded, BLOCKED_TERMS.length, 'every entry is written as the folding reads it')
  t.is(found, BLOCKED_TERMS.length, 'every entry is found by the default index')
})

test('the list and rule require nothing but each other', (t) => {
  const list = fs.readFileSync(path.join(LIB, 'blocked-terms.js'), 'utf8')
  const rule = fs.readFileSync(path.join(LIB, 'word-check.js'), 'utf8')
  t.absent(/require\(/.test(list), 'the list')
  t.alike([...rule.matchAll(/require\('(.*)'\)/g)].map((m) => m[1]), ['./blocked-terms'], 'the rule')
  for (const word of ['console.', 'fetch(', 'process', 'Date']) t.absent(rule.includes(word), 'no ' + word)
})
