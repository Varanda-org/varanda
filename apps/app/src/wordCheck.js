// The check that stops a public text with a listed term
// (@varanda/rpc lib/blocked-terms.js) before it is posted, on the device. It
// reads only what the person is about to publish: no request, no counter, no
// log and no record of a refusal, so nothing about it ever leaves the device.
// Direct messages and private groups never reach it (their call sites skip
// it): checking inside encrypted chat reads as scanning private messages,
// even with nothing sent anywhere.
//
// This is a bar in the official app, not a guarantee: a modified client can
// skip it, and the network rules know nothing about it. The account service
// applies the same list and rule to a new @nome and to what a page publishes
// through it (apps/cli/lib/account/word-check.js); for the rest, reports and
// the signed blocklist answer that case. Pure ES module: no React, no Node
// built-ins.

import rpc from '@varanda/rpc'
import { wholeTokens } from './search.js'

const { termInTokens } = rpc

export const indexTerms = rpc.indexTerms

// The first listed term in `text`, or null. Compares whole folded words, so a
// term never matches inside a longer word (digits at the edge of a word are
// not part of it), and reads the whole text, so a term cannot hide past the
// bound that search input has.
export function findTerm (text, index) {
  return termInTokens(wholeTokens(text), index)
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

// The title and description of a link preview come from the linked site, so the
// person cannot edit them: the refusal says to drop the preview instead.
export const previewRefusalText = (term) => 'Não dá para publicar: "' + term + '" aparece na prévia do link, e o Varanda não permite esse termo em conteúdo público. Remova a prévia ou troque o link e tente de novo.'

// The refusal for a draft link card ({ title, desc } or null), or ''.
export function previewRefusal (view) {
  if (!view || typeof view !== 'object') return ''
  for (const text of [view.title, view.desc]) {
    const term = findTerm(text)
    if (term !== null) return previewRefusalText(term)
  }
  return ''
}

// The same for a group's message or name: only a group known to be public. A
// private group is never checked, and neither is one whose visibility is not
// known yet, which may turn out to be private.
export function publicGroupRefusal (visibility, ...texts) {
  return visibility === 'public' ? refusalOf(...texts) : ''
}

// The same for a group's link preview, under the same rule.
export function publicGroupPreviewRefusal (visibility, view) {
  return visibility === 'public' ? previewRefusal(view) : ''
}
