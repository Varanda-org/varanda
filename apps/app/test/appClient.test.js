'use strict'

// src/appClient.js: the flag the account and report clients read.
const test = require('brittle')

const load = () => import('../src/appClient.js')

test('off by default; only a literal true turns it on', async (t) => {
  const { setAppClient, isAppClient } = await load()
  t.is(isAppClient(), false)
  setAppClient(true)
  t.is(isAppClient(), true)
  for (const value of [false, 'true', 1, {}, null, undefined]) {
    setAppClient(true)
    setAppClient(value)
    t.is(isAppClient(), false, JSON.stringify(value) + ' turns it off')
  }
})
