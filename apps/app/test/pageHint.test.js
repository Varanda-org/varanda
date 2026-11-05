import test from 'brittle'
import { pageBadgeLabel } from '../src/pageBadge.js'
import { validSearch, validMemberIndex } from '../src/indexClient.js'

const A = 'a'.repeat(64)

test('pageBadgeLabel', (t) => {
  t.is(pageBadgeLabel(null), null)
  t.is(pageBadgeLabel({ page: false }), null)
  t.is(pageBadgeLabel({ page: true }), 'Página')
  t.is(pageBadgeLabel({ page: true, closed: true }), 'Página · encerrada')
  t.is(pageBadgeLabel({ page: true, moved: true }), 'Página · mudou de chave')
})

const search = (m) => ({ complete: true, indexing: false, more: false, members: [m] })

test('validSearch: page hint optional and boolean only', (t) => {
  const base = { author: A, profileSeq: 1, usernameSeq: null }
  t.alike(validSearch(search(base)).members[0], base, 'old seeder: no page keys')
  t.alike(validSearch(search({ ...base, page: false })).members[0], base, 'person')
  t.alike(validSearch(search({ ...base, page: true, closed: false, moved: true })).members[0], { ...base, page: true, closed: false, moved: true })
  t.alike(validSearch(search({ ...base, page: true })).members[0], { ...base, page: true, closed: false, moved: false })
  t.is(validSearch(search({ ...base, page: 'yes' })), null)
  t.is(validSearch(search({ ...base, page: true, moved: 1 })), null)
  t.is(validSearch(search({ ...base, other: true })), null)
})

test('validMemberIndex: page hint optional', (t) => {
  const body = { complete: true, indexing: false, length: 1, posts: [], postsTotal: 0, profileSeq: null, usernameSeq: null }
  t.is(validMemberIndex(body).page, undefined)
  t.is(validMemberIndex({ ...body, page: true, closed: true, moved: false }).closed, true)
  t.is(validMemberIndex({ ...body, page: null }), null)
})
