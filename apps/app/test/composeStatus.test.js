'use strict'

// Composer note precedence (src/composeStatus.js). The helper returns an id.
// The screen keeps the sentence. An uncertain outcome stays an error.
const test = require('brittle')

const load = () => import('../src/composeStatus.js')

test('empty input has no status', async (t) => {
  const { composeStatus } = await load()
  t.is(composeStatus(), null, 'missing flags')
  t.is(composeStatus(null), null, 'null flags')
  t.is(composeStatus(undefined), null, 'undefined flags')
  t.is(composeStatus({}), null, 'empty object')
  t.is(composeStatus({ error: false, uncertain: false, locked: false, media: false, draft: false }), null, 'every flag off')
  t.is(composeStatus({ error: '', uncertain: '', locked: '', media: '', draft: '' }), null, 'empty strings are not notes')
})

test('error precedes locked, media and draft', async (t) => {
  const { composeStatus } = await load()
  t.is(composeStatus({ error: true }), 'error')
  t.is(composeStatus({ error: 'failed', locked: true, media: true, draft: true }), 'error')
  t.is(composeStatus({ error: { uncertain: true }, locked: true, media: true, draft: true }), 'error', 'an error object is not dropped')
})

test('an uncertain outcome stays an error ahead of every other note', async (t) => {
  const { composeStatus } = await load()
  t.is(composeStatus({ uncertain: true }), 'error')
  t.is(composeStatus({ uncertain: true, locked: true, media: true, draft: true }), 'error')
  t.is(composeStatus({ error: '', uncertain: true, draft: true }), 'error', 'a blank error does not hide an uncertain outcome')
})

test('locked precedes media and draft', async (t) => {
  const { composeStatus } = await load()
  t.is(composeStatus({ locked: true }), 'locked')
  t.is(composeStatus({ locked: true, media: true, draft: true }), 'locked')
  t.is(composeStatus({ error: '', uncertain: false, locked: true, media: true, draft: true }), 'locked')
})

test('media precedes draft', async (t) => {
  const { composeStatus } = await load()
  t.is(composeStatus({ media: true }), 'media')
  t.is(composeStatus({ media: true, draft: true }), 'media')
  t.is(composeStatus({ media: 'offline', draft: 'kept' }), 'media')
})

test('a draft alone is draft', async (t) => {
  const { composeStatus } = await load()
  t.is(composeStatus({ draft: true }), 'draft')
  t.is(composeStatus({ draft: 'kept' }), 'draft')
})
