// The stamp of the last local write.
'use strict'

const test = require('brittle')
const load = () => import('../src/localWrites.js')

test('lastLocalWrite is 0 before a write, then the latest note wins', async (t) => {
  const { noteLocalWrite, lastLocalWrite } = await load()
  t.is(lastLocalWrite(), 0)
  noteLocalWrite(1000)
  t.is(lastLocalWrite(), 1000)
  noteLocalWrite(2000)
  t.is(lastLocalWrite(), 2000)
})
