// The check that stops a public text with a listed term (blockedTerms.js)
// before it is posted, on the device. It reads only what the person is about
// to publish: no request, no counter, no log and no record of a refusal, so
// nothing about it ever leaves the device. Direct messages and private groups
// never reach it (their call sites skip it): checking inside encrypted chat
// reads as scanning private messages, even with nothing sent anywhere.
//
// This is a bar in the official app, not a guarantee: a modified client can
// skip it, and the network rules know nothing about it. Reports and the signed
// blocklist answer that case. Pure ES module: no React, no Node built-ins.

import { BLOCKED_TERMS } from './blockedTerms.js'
import { wholeTokens } from './search.js'

// first word -> the terms starting with it, each as its list of words.
export function indexTerms (terms) {
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

const matchesAt = (tokens, at, words) => {
  for (let i = 1; i < words.length; i++) {
    if (tokens[at + i] !== words[i]) return false
  }
  return true
}

// The first listed term in `text`, or null. Compares whole folded words, so a
// term never matches inside a longer word, and reads the whole text, so a term
// cannot hide past the bound that search input has.
export function findTerm (text, index = DEFAULT_INDEX) {
  const tokens = wholeTokens(text)
  for (let at = 0; at < tokens.length; at++) {
    const rows = index.get(tokens[at])
    if (!rows) continue
    for (const words of rows) {
      if (matchesAt(tokens, at, words)) return words.join(' ')
    }
  }
  return null
}

// The term comes from the list, never from the text, and is named so a person
// hit by a false positive can find what to change in a long text.
export const refusalText = (term) => 'Não dá para publicar: "' + term + '" é um termo que o Varanda não permite em conteúdo público. Edite o texto e tente de novo.'

// The refusal message for the first of `texts` with a listed term, or ''.
export function refusalOf (...texts) {
  for (const text of texts) {
    const term = findTerm(text)
    if (term !== null) return refusalText(term)
  }
  return ''
}

// The same for a group's message or name: only a group known to be public. A
// private group is never checked, and neither is one whose visibility is not
// known yet, which may turn out to be private.
export function publicGroupRefusal (visibility, ...texts) {
  return visibility === 'public' ? refusalOf(...texts) : ''
}
