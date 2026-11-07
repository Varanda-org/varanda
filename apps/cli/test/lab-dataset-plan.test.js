'use strict'

// apps/cli/lib/lab-dataset-plan.js: the hosted lab's dataset plan is
// deterministic from its seed, its targets always point back to another
// member's earlier post, and the predicted seqs and block counts follow the
// diary layout the runner checks against.

const test = require('brittle')
const { planDataset, parseDatasetSize, HEADER } = require('../lib/lab-dataset-plan')

const SMALL = { members: 8, blocksPerMember: 40 }

test('the same seed gives the same plan, another seed a different one', (t) => {
  const a = planDataset({ seed: 1, ...SMALL })
  const b = planDataset({ seed: 1, ...SMALL })
  t.alike(a, b, 'same seed, same plan')
  t.alike(planDataset({ seed: '1', ...SMALL }), a, 'the seed is read as text')
  const c = planDataset({ seed: 2, ...SMALL })
  t.not(JSON.stringify(c.members), JSON.stringify(a.members), 'another seed, other actions')
})

test('targets point to earlier actions of other members, at their seq', (t) => {
  const plan = planDataset({ seed: 'targets', ...SMALL })
  const byId = new Map()
  for (const m of plan.members) for (const a of m.actions) byId.set(a.id, a)
  let targeted = 0
  for (const m of plan.members) {
    const engaged = new Set()
    for (const a of m.actions) {
      t.is(a.member, m.index)
      const needs = a.kind === 'reply' || a.kind === 'quote' || a.kind === 'repost' || a.kind === 'like'
      if (!needs) {
        t.absent(a.target, a.kind + ' has no target')
        continue
      }
      targeted++
      const target = byId.get(a.target.id)
      if (!target) {
        t.fail('unknown target ' + a.target.id)
        continue
      }
      if (target.id >= a.id || target.member === a.member || target.seq !== a.target.seq || target.member !== a.target.member) {
        t.fail('bad target for action ' + a.id)
      }
      if (!['post', 'photo', 'reply', 'quote'].includes(target.kind)) t.fail('target is not a publication')
      if (a.kind === 'like' || a.kind === 'repost') {
        const k = a.kind + ':' + target.id
        if (engaged.has(k)) t.fail('duplicate ' + k)
        engaged.add(k)
      }
    }
  }
  t.ok(targeted > 20, 'many targeted actions (' + targeted + ')')
})

test('seqs follow the diary layout and fill blocksPerMember', (t) => {
  const plan = planDataset({ seed: 7, ...SMALL })
  for (const m of plan.members) {
    t.is(m.blocks, SMALL.blocksPerMember, m.username + ': exact block count')
    const firstPhoto = m.actions.findIndex((a) => a.kind === 'photo')
    let expected = HEADER.length
    m.actions.forEach((a, i) => {
      if (i === firstPhoto) expected++
      if (a.seq !== expected) t.fail(m.username + ': action ' + i + ' seq ' + a.seq + ' expected ' + expected)
      expected++
    })
    t.is(m.actions[0].kind, 'post', 'the first action is a plain post')
    t.ok(/^[a-z][a-z0-9_]{2,19}$/.test(m.username), 'a valid username ' + m.username)
  }
  t.is(new Set(plan.members.map((m) => m.username)).size, plan.members.length, 'usernames are unique')
  t.is(plan.totals.blocks, SMALL.members * SMALL.blocksPerMember)
})

test('the photo share is respected within tolerance', (t) => {
  for (const share of [0, 0.2, 0.5]) {
    const plan = planDataset({ seed: 'photos', members: 10, blocksPerMember: 100, photoShare: share })
    const ratio = plan.totals.photos / plan.totals.actions
    t.ok(Math.abs(ratio - share) < 0.06, 'share ' + share + ' -> ' + ratio.toFixed(3))
    for (const m of plan.members) {
      for (const a of m.actions.filter((x) => x.kind === 'photo')) {
        if (!(a.photo.width > 0 && a.photo.height > 0 && Number.isSafeInteger(a.photo.seed))) t.fail('bad photo')
      }
    }
  }
})

test('communities: a creator, other members, a few posts by them', (t) => {
  const plan = planDataset({ seed: 3, ...SMALL, communities: 2 })
  t.is(plan.communities.length, 2)
  for (const c of plan.communities) {
    t.ok(c.name.length > 0)
    t.absent(c.members.includes(c.creator), 'the creator is not in members')
    t.ok(c.members.length >= 1)
    for (const p of c.posts) t.ok(p.member === c.creator || c.members.includes(p.member), 'a post by a community member')
  }
  t.is(planDataset({ seed: 3, ...SMALL, communities: 0 }).communities.length, 0)
  t.is(planDataset({ seed: 3, members: 1, blocksPerMember: 4 }).members[0].actions.length, 1, 'smallest plan')
})

test('one member creates every community, each with its own index and no joiners', (t) => {
  const plan = planDataset({ seed: 1, members: 1, blocksPerMember: 4, communities: 2 })
  t.alike(plan.communities.map((c) => [c.index, c.creator, c.members.length]), [[0, 0, 0], [1, 0, 0]])
  t.is(new Set(plan.communities.map((c) => c.name)).size, 2, 'distinct names')
  for (const c of plan.communities) for (const p of c.posts) t.is(p.member, 0)
})

test('a member may be in several communities (the runner serializes its joins)', (t) => {
  const plan = planDataset({ seed: 5, members: 3, blocksPerMember: 4, communities: 2 })
  const counts = new Map()
  for (const c of plan.communities) for (const m of c.members) counts.set(m, (counts.get(m) || 0) + 1)
  t.ok([...counts.values()].some((n) => n > 1), 'seed 5, 3x4: one member joins both')
})

test('bad options and dataset sizes are refused', (t) => {
  t.exception.all(() => planDataset({}), 'no seed')
  t.exception.all(() => planDataset({ seed: 1, members: 0 }))
  t.exception.all(() => planDataset({ seed: 1, blocksPerMember: 3 }))
  t.exception.all(() => planDataset({ seed: 1, photoShare: 2 }))
  t.alike(parseDatasetSize('60x150'), { members: 60, blocksPerMember: 150 })
  t.alike(parseDatasetSize('6x20'), { members: 6, blocksPerMember: 20 })
  t.is(parseDatasetSize('6x3'), null)
  t.is(parseDatasetSize('0x20'), null)
  t.is(parseDatasetSize('6 x 20'), null)
  t.alike(parseDatasetSize('1000x10000'), { members: 1000, blocksPerMember: 10000 })
  t.is(parseDatasetSize('1001x20'), null, 'more members than the bound')
  t.is(parseDatasetSize('6x10001'), null, 'more blocks than the bound')
})
