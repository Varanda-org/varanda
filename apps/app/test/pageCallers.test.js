'use strict'

// Source scans of the page callers that cannot load in Node (React Native
// screens): who signs a page's follows, which origin an @nome lookup asks,
// and that a page screen never falls through to Membro.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')

test('Membro signs a page follow with memberKeyOf, never the diary key', (t) => {
  const src = read('src/screens/Membro.js')
  t.absent(/pagesFollows?\([^)]*member:\s*ownKey/.test(src), 'no ownKey member')
  t.ok(/pagesFollows\(nodeRef\.current, \{ member: await memberKeyOf\(nodeRef\.current\.request, nodeRef\.current\)/.test(src))
  t.ok(/pagesFollow\(nodeRef\.current, \{ member: await memberKeyOf\(nodeRef\.current\.request, nodeRef\.current\)/.test(src))
})

test('@nome lookups for pages ask the node account origin', (t) => {
  t.ok(read('src/screens/NovaPagina.js').includes('lookupUsername(username, { origin: pagesOrigin(node) })'))
  const ajustes = read('src/screens/PaginaAjustes.js')
  t.ok(ajustes.includes('lookupUsername(username, { origin })'))
  t.ok(ajustes.includes('memberOf(inviteHandle, pagesOrigin(node))'))
  t.ok(ajustes.includes('memberOf(transferHandle, pagesOrigin(node))'))
  t.absent(/lookupUsername\(username\)/.test(ajustes))
})

test('App.js: page screens are not gated on pagesOn, so never become Membro', (t) => {
  const src = read('App.js')
  t.ok(src.includes("if (entry.screen === 'paginas' || entry.screen === 'novapagina' || entry.screen === 'paginaajustes') {"))
  t.absent(/pagesOn\([^)]*\)\s*&&\s*\(entry\.screen === 'paginas'/.test(src))
})

test('MemberRow merges the names hint and the search hit', (t) => {
  const src = read('src/ui/MemberRow.js')
  t.ok(src.includes('const pageInfo = mergePageInfo(hint, hit)'))
  t.absent(src.includes('hint || hit'))
  // The merge itself, evaluated outside React Native.
  const line = src.split('\n').filter((l) => l.startsWith('const flag') || l.startsWith('export const mergePageInfo')).join('\n').replace('export ', '')
  // eslint-disable-next-line no-new-func
  const mergePageInfo = new Function(line + '\nreturn mergePageInfo')()
  t.alike(mergePageInfo({ name: 'Ana' }, { page: true, closed: false, moved: true }), { page: true, closed: false, moved: true }, 'names view without flags keeps the hit badge')
  t.alike(mergePageInfo({ page: true, closed: true }, { page: false }), { page: true, closed: true, moved: false })
  t.alike(mergePageInfo(undefined, { author: 'x' }), { page: false, closed: false, moved: false })
})
