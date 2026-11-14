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

test('readFollowKeys reads every page in lower case and gives null when any page fails', async (t) => {
  const { readFollowKeys } = await load()
  const A = 'A'.repeat(64)
  const B = 'b'.repeat(64)
  const C = 'c'.repeat(64)
  const calls = []
  const pages = async (method, arg) => {
    calls.push(arg.offset)
    return arg.offset === 0 ? { follows: [A, B], total: 3 } : { follows: [C], total: 3 }
  }
  const set = await readFollowKeys(pages, 2)
  t.alike([...set], [A.toLowerCase(), B, C])
  t.alike(calls, [0, 2], 'one request per page')

  const half = async (method, arg) => {
    if (arg.offset === 0) return { follows: [A, B], total: 3 }
    throw new Error('seeder down')
  }
  t.is(await readFollowKeys(half, 2), null, 'a failure on the second page is not a half-read set')
  t.is(await readFollowKeys(async () => { throw new Error('x') }, 2), null)
  t.alike([...await readFollowKeys(async () => ({ follows: [], total: 0 }), 2)], [], 'an empty list is a real, empty set')
})

test('useFollowSet keeps what it had when the read fails, and Pessoas reads again after a follow', (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8')
  const conversa = src('screens', 'Conversa.js')
  const hook = conversa.slice(conversa.indexOf('export function useFollowSet'), conversa.indexOf('const mark = useCallback'))
  t.ok(hook.includes('const set = await readFollowKeys(request, FOLLOW_LIMIT_MAX)'), 'one shared reader')
  t.ok(hook.indexOf('if (set === null) return new Set()') < hook.indexOf('setFollows(set)'), 'a failed read never reaches setFollows')

  const pessoas = src('screens', 'Pessoas.js')
  const doFollow = pessoas.slice(pessoas.indexOf('const doFollow = async'), pessoas.indexOf('const doUnfollow = async'))
  t.ok(doFollow.includes('if (r.value.changed && typeof onFollowsChanged === \'function\') onFollowsChanged()\n        else loadFollows()'), 'a follow that did not bump followsVersion reads the set itself')
})
