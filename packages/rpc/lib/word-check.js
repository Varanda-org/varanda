'use strict'

// The matching rule of the word check, shared by the official app
// (apps/app/src/wordCheck.js) and the account service
// (apps/cli/lib/account/word-check.js), so both refuse the same texts. It
// takes words already folded by wholeTokens (apps/app/src/search.js, or
// @varanda/core/lib/search-text.js, pinned to each other by a parity test):
// this package cannot fold, because Metro cannot reach packages/core.
//
// Pure and total: no I/O, no state, nothing logged.

const { BLOCKED_TERMS } = require('./blocked-terms')

// first word -> the terms starting with it, each as its list of words.
function indexTerms (terms) {
  const index = new Map()
  for (const term of terms) {
    const words = term.split(' ')
    const rows = index.get(words[0])
    if (rows) rows.push(words)
    else index.set(words[0], [words])
  }
  return index
}

const DEFAULT_INDEX = indexTerms(BLOCKED_TERMS)

function matchesAt (tokens, at, words) {
  for (let i = 1; i < words.length; i++) {
    if (tokens[at + i] !== words[i]) return false
  }
  return true
}

function findIn (tokens, index) {
  for (let at = 0; at < tokens.length; at++) {
    const rows = index.get(tokens[at])
    if (!rows) continue
    for (const words of rows) {
      if (matchesAt(tokens, at, words)) return words.join(' ')
    }
  }
  return null
}

const EDGE_DIGITS = /^[0-9]+|[0-9]+$/g

// The same words with the digits glued to their start or end taken off, so
// "termo123" reads as "termo". A word of digits only stays as it is and still
// separates the words around it.
function withoutEdgeDigits (tokens) {
  return tokens.map((token) => token.replace(EDGE_DIGITS, '') || token)
}

// The first listed term in `tokens`, or null. Compares whole words, so a term
// never matches inside a longer word (digits at the edge of a word are not
// part of it).
function termInTokens (tokens, index = DEFAULT_INDEX) {
  if (!Array.isArray(tokens)) return null
  const found = findIn(tokens, index)
  return found !== null ? found : findIn(withoutEdgeDigits(tokens), index)
}

module.exports = { BLOCKED_TERMS, indexTerms, termInTokens }
