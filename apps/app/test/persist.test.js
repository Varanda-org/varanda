'use strict'

const test = require('brittle')

const load = () => import('../src/persist.js')

test('askPersist: no storage or no persist', async (t) => {
  const { askPersist } = await load()
  t.is(await askPersist(null), false)
  t.is(await askPersist(undefined), false)
  t.is(await askPersist({}), false)
})

test('askPersist: the boolean of persist(), never rejects', async (t) => {
  const { askPersist } = await load()
  t.is(await askPersist({ persist: async () => true }), true)
  t.is(await askPersist({ persist: async () => false }), false)
  t.is(await askPersist({ persist: () => Promise.reject(new Error('x')) }), false)
  t.is(await askPersist({ persist: () => { throw new Error('x') } }), false)
})
