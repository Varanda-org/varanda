'use strict'

const test = require('brittle')
const load = () => import('../src/follow.js')

test('follow labels and note use the expected copy without em dashes', async (t) => {
  const { FOLLOW_LABEL, FOLLOWING_LABEL, UNFOLLOW_LABEL, UNFOLLOW_NOTE } = await load()
  const texts = [
    [FOLLOW_LABEL, 'Seguir'],
    [FOLLOWING_LABEL, 'Seguindo'],
    [UNFOLLOW_LABEL, 'Deixar de seguir'],
    [UNFOLLOW_NOTE, 'As publicações dessa pessoa deixam de aparecer na sua Rua. Você pode seguir de novo quando quiser.']
  ]
  for (const [actual, expected] of texts) {
    t.is(actual, expected)
    t.is(actual.includes('\u2014'), false)
  }
})

test('unfollowQuestion uses the trimmed title', async (t) => {
  const { unfollowQuestion } = await load()
  t.is(unfollowQuestion('Bia'), 'Deixar de seguir Bia?')
  t.is(unfollowQuestion('  Bia  '), 'Deixar de seguir Bia?')
})

test('unfollowQuestion falls back for empty or non-string titles', async (t) => {
  const { unfollowQuestion } = await load()
  for (const title of ['', '  ', null, undefined, 3]) {
    t.is(unfollowQuestion(title), 'Deixar de seguir esta pessoa?')
  }
})
