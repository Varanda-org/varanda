'use strict'

const test = require('brittle')
const load = () => import('../src/communitiesBox.js')
const A = 'ab'.repeat(32)
const B = 'cd'.repeat(32)
const C = 'ef'.repeat(32)
const PERSON = '12'.repeat(32)
const OTHER = '34'.repeat(32)
const EMPTY = { count: 0, items: [] }
const row = (extra = {}) => ({ community: A, name: 'Jardim', state: 'ready', role: 'member', join: 'open', general: B, ...extra })
const own = Object.freeze([Object.freeze({ community: A, name: 'Jardim' }), Object.freeze({ community: B, name: 'Praça' })])

test('communitiesOf accepts all three admitted roles and projects community and name', async (t) => {
  const { communitiesOf } = await load()
  for (const role of ['creator', 'admin', 'member']) {
    t.alike(communitiesOf({ communities: [row({ role })] }), [own[0]], role)
  }
})

test('communitiesOf requires ready state even for admitted roles', async (t) => {
  const { communitiesOf } = await load()
  for (const state of ['pending', 'requested', '', undefined, null, true]) {
    t.alike(communitiesOf({ communities: [row({ state })] }), [])
  }
})

test('communitiesOf excludes every non-admitted role', async (t) => {
  const { communitiesOf } = await load()
  for (const role of ['requested', 'pending', 'banned', 'left', 'owner', '', undefined, null]) {
    t.alike(communitiesOf({ communities: [row({ role })] }), [], String(role))
  }
})

test('communitiesOf requires lowercase hex64 community keys', async (t) => {
  const { communitiesOf } = await load()
  for (const community of [A.toUpperCase(), 'g'.repeat(64), A.slice(1), A + '0', A + '\n', null, undefined, 1, [A]]) {
    t.alike(communitiesOf({ communities: [row({ community })] }), [])
  }
})

test('communitiesOf requires a non-empty string name', async (t) => {
  const { communitiesOf } = await load()
  for (const name of ['', null, undefined, 1, ['Jardim']]) {
    t.alike(communitiesOf({ communities: [row({ name })] }), [])
  }
})

test('communitiesOf preserves raw peer names for the UI to sanitize', async (t) => {
  const { communitiesOf } = await load()
  const name = '  Jardim\u202e\n🌿  '
  t.alike(communitiesOf({ communities: [row({ name })] }), [{ community: A, name }])
})

test('communitiesOf deduplicates by key with the first eligible name winning', async (t) => {
  const { communitiesOf } = await load()
  t.alike(communitiesOf({ communities: [row({ role: 'requested' }), row({ name: 'Praça' }), row()] }), [{ community: A, name: 'Praça' }])
})

test('communitiesOf sorts names in pt-BR ignoring case and accents', async (t) => {
  const { communitiesOf } = await load()
  const communities = Object.freeze([
    Object.freeze(row({ community: C, name: 'Zebra' })),
    Object.freeze(row({ community: B, name: 'banana' })),
    Object.freeze(row({ community: A, name: 'Árvore' }))
  ])
  t.alike(communitiesOf({ communities }).map((item) => item.community), [A, B, C])
  t.is(communities[0].community, C, 'input order is unchanged')
})

test('communitiesOf breaks equal base-name ties by key', async (t) => {
  const { communitiesOf } = await load()
  t.alike(communitiesOf({ communities: [row({ community: B, name: 'arvore' }), row({ name: 'ÁRVORE' })] }), [
    { community: A, name: 'ÁRVORE' }, { community: B, name: 'arvore' }
  ])
})

test('communitiesOf returns empty for malformed list results and ignores malformed rows', async (t) => {
  const { communitiesOf } = await load()
  for (const input of [undefined, null, false, 42, 'text', [], {}, { groups: [{ group: A, left: false }] }, { communities: {} }]) {
    t.alike(communitiesOf(input), [])
  }
  t.alike(communitiesOf({ communities: [null, undefined, false, [], 'text', {}, row()] }), [own[0]])
})

test('commonCommunities counts only matching admitted members of own communities', async (t) => {
  const { commonCommunities } = await load()
  const members = new Map([
    [A, [{ member: PERSON, banned: false }, { member: PERSON, banned: false }]],
    [B, [{ member: OTHER, banned: false }]],
    [C, [{ member: PERSON, banned: false }]]
  ])
  t.alike(commonCommunities(own, members, PERSON), { count: 1, items: [own[0]] })
})

test('commonCommunities excludes banned members', async (t) => {
  const { commonCommunities } = await load()
  t.alike(commonCommunities(own, new Map([[A, [{ member: PERSON, banned: true }]]]), PERSON), EMPTY)
})

test('commonCommunities accepts members whose banned flag is not true', async (t) => {
  const { commonCommunities } = await load()
  for (const banned of [false, undefined, null]) {
    t.alike(commonCommunities(own, new Map([[A, [{ member: PERSON, banned }]]]), PERSON), { count: 1, items: [own[0]] })
  }
})

test('commonCommunities never counts unknown or empty membership lists', async (t) => {
  const { commonCommunities } = await load()
  t.alike(commonCommunities(own, new Map(), PERSON), EMPTY)
  t.alike(commonCommunities(own, new Map([[A, []], [B, [{ member: OTHER }]]]), PERSON), EMPTY)
})

test('commonCommunities preserves own order and item identity', async (t) => {
  const { commonCommunities } = await load()
  const members = new Map([[B, [{ member: PERSON }]], [A, [{ member: PERSON }]]])
  const result = commonCommunities(own, members, PERSON)
  t.alike(result, { count: 2, items: own })
  t.is(result.items[0], own[0])
  t.is(result.items[1], own[1])
})

test('commonCommunities rejects invalid person keys', async (t) => {
  const { commonCommunities } = await load()
  for (const person of [undefined, null, '', A.toUpperCase(), 'g'.repeat(64), A.slice(1), A + '0', A + '\n', [A], 1]) {
    t.alike(commonCommunities(own, new Map([[A, [{ member: person }]]]), person), EMPTY)
  }
})

test('commonCommunities tolerates malformed inputs and member rows', async (t) => {
  const { commonCommunities } = await load()
  t.alike(commonCommunities(null, new Map(), PERSON), EMPTY)
  t.alike(commonCommunities(own, { [A]: [{ member: PERSON }] }, PERSON), EMPTY)
  t.alike(commonCommunities(own, null, PERSON), EMPTY)
  t.alike(commonCommunities(own, new Map([[A, {}], [B, null]]), PERSON), EMPTY)
  t.alike(commonCommunities([null, {}, ...own], new Map([[A, [null, false, [], { person: PERSON }, { member: PERSON }]]]), PERSON), { count: 1, items: [own[0]] })
})

test('MAX_COMMON_LOOKUPS caps screen reads at eight', async (t) => {
  const { MAX_COMMON_LOOKUPS } = await load()
  t.is(MAX_COMMON_LOOKUPS, 8)
})
