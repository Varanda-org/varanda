'use strict'

// Excluir conta refuses a member who still owns a live page: closing a page
// needs the owner's signed record, and the page's other admins would lose it
// without warning. Shared by ./delete-routes.js and the operator's
// `account delete` (../commands/account.js).

// True when `member` owns a page that is neither closed nor moved; a null
// store owns nothing. Whatever pagesStore.listFor throws is thrown as is:
// a store that cannot answer must refuse, since deleting the owner would
// orphan the page.
function ownsLivePage (pagesStore, member) {
  if (pagesStore === null) return false
  return pagesStore.listFor(member).owned.some((p) => !p.closed && p.movedTo === null)
}

module.exports = { ownsLivePage }
