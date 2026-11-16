'use strict'

// The word check on the account service: the list and rule of the app's own
// check (apps/app/src/wordCheck.js, @varanda/rpc lib/word-check.js), applied
// to a new @nome (store.js, pages-routes.js) and to the texts a page
// publishes through the service (pages-routes.js, pages-groups.js), so a
// modified or old client cannot skip it there. Names already held are never
// checked again. Nothing is kept: the caller refuses with a token, and no log
// carries the name, the text or the term.

const { termInTokens } = require('@varanda/rpc')
const { wholeTokens } = require('@varanda/core/lib/search-text')

// The first listed term in any of `texts`, or null. A text that is not a
// string has no term.
function findTerm (...texts) {
  for (const text of texts) {
    const term = termInTokens(wholeTokens(text))
    if (term !== null) return term
  }
  return null
}

module.exports = { findTerm }
