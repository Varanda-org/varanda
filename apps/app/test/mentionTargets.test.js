'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const load = () => import('../src/mentionTargets.js')

const OWN = 'aa'.repeat(32)
const key = (n) => n.toString(16).padStart(64, '0')
const member = { author: key(1), username: 'ana', name: 'Ana' }
const page = { author: key(2), username: 'pagina_cafe', name: 'Café', page: true }

test('mention targets label pages and open both kinds as diaries', async (t) => {
  const { mergeSuggestions, openTarget } = await load()
  const rows = mergeSuggestions([member], [page], '', OWN)
  t.alike(rows, [
    { kind: 'member', username: 'ana', name: 'Ana', key: key(1), chipLabel: null },
    { kind: 'page', username: 'pagina_cafe', name: 'Café', key: key(2), chipLabel: 'Página' }
  ])
  t.alike(openTarget(rows[0]), { screen: 'membro', key: key(1) })
  t.alike(openTarget(rows[1]), { screen: 'membro', key: key(2) })
})

test('mention targets use page hints in the existing member search and deduplicate diaries', async (t) => {
  const { mergeSuggestions } = await load()
  t.alike(mergeSuggestions([page, member], [page], '', OWN), mergeSuggestions([member], [page], '', OWN))
  t.is(mergeSuggestions([], [{ ...page, page: undefined }], '', OWN)[0].kind, 'page')
  t.alike(mergeSuggestions([{ ...member, author: OWN }], [page], '', OWN.toUpperCase()).map((row) => row.key), [key(2)])
})

test('closed and moved pages are neither suggested nor opened', async (t) => {
  const { mergeSuggestions, openTarget } = await load()
  for (const flag of ['closed', 'moved']) {
    const ended = { ...page, [flag]: true }
    t.alike(mergeSuggestions([ended], [ended], 'pa', OWN), [])
    t.is(openTarget({ ...ended, kind: 'page', key: page.author }), null)
  }
})

test('mention targets reject malformed rows and invalid usernames', async (t) => {
  const { mergeSuggestions, openTarget } = await load()
  const malformed = [null, undefined, false, 'ana', [], {},
    { ...member, author: 'bad' }, { ...member, author: 1 },
    { ...member, username: 'Ana' }, { ...member, username: 'abcdef' },
    { ...member, username: 'a' }, { ...member, username: ['ana'] },
    { ...member, name: {} }]
  t.alike(mergeSuggestions(malformed, malformed, 'an', OWN), [])
  for (const row of malformed) t.is(openTarget(row), null)
  const row = { kind: 'member', key: member.author, username: member.username, name: member.name }
  for (const bad of [{ ...row, kind: 'group' }, { ...row, key: 'bad' }, { ...row, username: null }, { ...row, name: {} }]) {
    t.is(openTarget(bad), null)
  }
  t.alike(mergeSuggestions(null, {}, null, null), [])
  t.is(mergeSuggestions([{ ...member, name: null }], [], 'an', OWN)[0].name, null)
})

test('mention targets put username prefixes first and members before pages on ties', async (t) => {
  const { mergeSuggestions } = await load()
  const members = [
    { author: key(1), username: 'bia', name: 'Ana Bia' },
    { author: key(2), username: 'anita', name: 'Anita' },
    { author: key(3), username: 'ana', name: 'Ana' }
  ]
  const pages = [
    { author: key(4), username: 'cafe', name: 'Ana Café' },
    { author: key(5), username: 'ana_livros', name: 'Ana Livros' }
  ]
  t.alike(mergeSuggestions(members, pages, 'AN', OWN).map((row) => row.username), [
    'anita', 'ana', 'ana_livros', 'bia', 'cafe'
  ])
  t.alike(members.map((hit) => hit.username), ['bia', 'anita', 'ana'], 'input order is unchanged')
  // A page that arrives first, as a hint inside the member search hits, still
  // ranks after a member with the same prefix match.
  const hinted = [{ author: key(9), username: 'ana_pagina', name: 'Ana Página', page: true }, ...members]
  t.alike(mergeSuggestions(hinted, [], 'AN', OWN).map((row) => row.username), ['anita', 'ana', 'ana_pagina', 'bia'])
})

test('mention targets cap after filtering and ranking both sources', async (t) => {
  const { mergeSuggestions } = await load()
  const { MENTION_SUGGESTIONS_MAX } = await import('../src/mentions.js')
  const members = Array.from({ length: 8 }, (_, i) => ({ author: key(i + 1), username: 'member_' + i }))
  const pages = Array.from({ length: 8 }, (_, i) => ({ author: key(i + 20), username: 'pagina_' + i }))
  const rows = mergeSuggestions(members, [{ ...page, closed: true }, ...pages], 'pa', OWN)
  t.is(rows.length, MENTION_SUGGESTIONS_MAX)
  t.alike(rows.map((row) => row.username), ['pagina_0', 'pagina_1', 'pagina_2', 'pagina_3', 'pagina_4'])
})

test('mention target names stay raw so the row can run whoOf before displayText', async (t) => {
  const { mergeSuggestions } = await load()
  const name = '\u200e@alice'
  const [row] = mergeSuggestions([], [{ ...page, name }], 'pa', OWN)
  t.is(row.name, name, 'not escaped here')
  const suggest = readFileSync(join(__dirname, '../src/ui/MentionSuggest.js'), 'utf8')
  t.ok(suggest.includes('displayText(whoOf({ name: hit.name, username: hit.username }).title)'), 'the row strips look-alikes, then escapes')
})

test('an exact @nome comes first, and the search order is kept outside the prefix tie', async (t) => {
  const { mergeSuggestions } = await load()
  const members = Array.from({ length: 6 }, (_, i) => ({ author: key(40 + i), username: 'cafe_' + i }))
  const exact = mergeSuggestions(members, [{ author: key(50), username: 'cafe' }], 'cafe', OWN)
  t.is(exact[0].username, 'cafe', 'the exact page is not pushed out by members')
  t.is(exact[0].kind, 'page')
  const fuzzy = mergeSuggestions([{ author: key(60), username: 'an_bia', page: true }, { author: key(61), username: 'bianca' }], [], 'anb', OWN)
  t.alike(fuzzy.map((r) => r.username), ['an_bia', 'bianca'], 'no prefix match: the search order stays')
})

test('member search keeps pages and their hints for every caller', (t) => {
  // Global search, invites and the new-chat sheet show pages with a badge;
  // only the mention suggestions decide what an ended page means.
  const source = readFileSync(join(__dirname, '../src/useMemberSearch.js'), 'utf8')
  t.absent(source.includes('hit.page !== true'), 'no page filter in the shared search')
  t.absent(source.includes('pages = false'), 'no opt-in flag')
})
