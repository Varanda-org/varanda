'use strict'

// apps/cli/scripts/lab-dataset.js joinMember: a member's community joins
// count only after the push that carries them to the seeder has succeeded.

const test = require('brittle')
const { joinMember } = require('../scripts/lab-dataset')

function setup ({ states, pushError = null, postError = null }) {
  const calls = []
  const counted = []
  const logs = []
  const queue = { ...states }
  const comm = (name) => ({ name, community: 'k-' + name, general: 'g-' + name })
  const joins = [comm('a'), comm('b')].map((c) => ({ c, planned: { posts: [{ member: 3, text: 'oi ' + c.name }, { member: 4, text: 'outro' }] } }))
  const opts = {
    joins,
    member: 3,
    username: 'ana',
    join: async (c) => ({ state: queue[c.name].shift() }),
    sync: async () => { calls.push('sync') },
    post: async (c, text) => {
      calls.push('post ' + text)
      if (postError) throw postError
    },
    push: async () => {
      calls.push('push')
      if (pushError) throw pushError
    },
    count: (c) => {
      calls.push('count ' + c.name)
      counted.push(c.name)
    },
    log: (m) => logs.push(m)
  }
  return { opts, calls, counted, logs }
}

test('a push that fails after two joins counts neither', async (t) => {
  const { opts, calls, counted } = setup({ states: { a: ['member'], b: ['member'] }, pushError: new Error('sem semeador') })
  await t.exception(joinMember(opts), /sem semeador/)
  t.alike(calls, ['post oi a', 'post oi b', 'push'], 'only this member\'s posts, then the push')
  t.alike(counted, [], 'nothing counted')
})

test('a pending join that turns member counts after the push', async (t) => {
  const { opts, calls, counted } = setup({ states: { a: ['pending', 'member'], b: ['member'] } })
  await joinMember(opts)
  t.alike(calls, ['sync', 'post oi a', 'post oi b', 'push', 'count a', 'count b'], 'counted only after the push')
  t.alike(counted, ['a', 'b'])
})

test('a post that fails after a join counts nothing and skips the push', async (t) => {
  const { opts, calls, counted } = setup({ states: { a: ['member'], b: ['member'] }, postError: new Error('post falhou') })
  await t.exception(joinMember(opts), /post falhou/)
  t.alike(calls, ['post oi a'])
  t.alike(counted, [], 'nothing counted')
})

test('a community that did not answer member is not counted and is logged', async (t) => {
  const { opts, counted, logs } = setup({ states: { a: ['pending', 'pending'], b: ['member'] } })
  await joinMember(opts)
  t.alike(counted, ['b'])
  t.alike(logs, ['@ana não entrou em "a" (pending)'])
})
