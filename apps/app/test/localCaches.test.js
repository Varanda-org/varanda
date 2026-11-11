'use strict'

// The registry of local caches of other people's content (src/localCaches.js)
// and the places that invalidate it: identity changes in src/node.js and new
// blocks in src/blocksProvider.js.
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/localCaches.js')
const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

test('wipeLocalCaches calls every registered store and swallows their errors', async (t) => {
  const lc = await load()
  const calls = []
  const offA = lc.registerLocalCache({ wipe: () => { calls.push('a'); throw new Error('boom') } })
  const offB = lc.registerLocalCache({ wipe: () => { calls.push('b'); return Promise.reject(new Error('later')) } })
  const offC = lc.registerLocalCache({ wipe: () => { calls.push('c') } })
  const offD = lc.registerLocalCache({})
  lc.wipeLocalCaches()
  t.alike(calls.sort(), ['a', 'b', 'c'])
  offA(); offB(); offC(); offD()
})

test('unregister removes only that store', async (t) => {
  const lc = await load()
  const calls = []
  const offA = lc.registerLocalCache({ wipe: () => calls.push('a') })
  const offB = lc.registerLocalCache({ wipe: () => calls.push('b') })
  offA()
  lc.wipeLocalCaches()
  t.alike(calls, ['b'])
  offB()
  lc.wipeLocalCaches()
  t.alike(calls, ['b'], 'nothing registered: a no-op')
})

test('dropAuthors and keepOnlyAuthors forward to every store that has them', async (t) => {
  const lc = await load()
  const dropped = []
  const kept = []
  const offA = lc.registerLocalCache({ dropAuthors: (keys) => dropped.push(keys), keepOnlyAuthors: (set) => kept.push(set) })
  const offB = lc.registerLocalCache({ dropAuthors: () => { throw new Error('boom') } })
  const offC = lc.registerLocalCache({ wipe: () => {} })
  const keys = ['aa', 'bb']
  const allowed = new Set(['cc'])
  lc.dropAuthors(keys)
  lc.keepOnlyAuthors(allowed)
  t.is(dropped.length, 1)
  t.is(dropped[0], keys)
  t.is(kept.length, 1)
  t.is(kept[0], allowed)
  offA(); offB(); offC()
})

test('every invalidation bumps the generation', async (t) => {
  const lc = await load()
  let g = lc.cacheGeneration()
  lc.wipeLocalCaches()
  t.ok(lc.cacheGeneration() > g, 'wipe')
  g = lc.cacheGeneration()
  lc.dropAuthors(['aa'])
  t.ok(lc.cacheGeneration() > g, 'dropAuthors')
  g = lc.cacheGeneration()
  lc.keepOnlyAuthors(new Set())
  t.ok(lc.cacheGeneration() > g, 'keepOnlyAuthors')
  g = lc.cacheGeneration()
  lc.bumpCacheGeneration()
  t.ok(lc.cacheGeneration() > g, 'bumpCacheGeneration')
  g = lc.cacheGeneration()
  t.is(lc.cacheGeneration(), g, 'reading does not bump')
})

test('newlyBlocked returns only the added keys', async (t) => {
  const { newlyBlocked } = await load()
  t.alike(newlyBlocked(new Set(), new Set(['a', 'b'])), ['a', 'b'])
  t.alike(newlyBlocked(new Set(['a']), new Set(['a', 'b'])), ['b'])
  t.alike(newlyBlocked(new Set(['a', 'b']), new Set(['a'])), [], 'an unblock adds nothing')
  t.alike(newlyBlocked(new Set(['a']), new Set(['a'])), [])
})

test('source: node.js wipes the caches on identity and installation changes', async (t) => {
  const src = read('node.js')
  t.ok(/import \{ wipeLocalCaches \} from '\.\/localCaches'/.test(src), 'imports the registry')

  const op = src.slice(src.indexOf('const passkeyOp = useCallback'))
  const wipeAt = op.indexOf("if (name === 'lock' || name === 'signOut' || name === 'reset') wipeLocalCaches()")
  const dispatchAt = op.indexOf('conn.identity[op](')
  t.ok(wipeAt > 0, 'lock, signOut and reset wipe')
  t.ok(dispatchAt > 0 && wipeAt < dispatchAt, 'before the identity op is dispatched')

  const forget = src.slice(src.indexOf('const forgetConfig = useCallback(async () => {'))
  const firstStatement = forget.split('\n').slice(1).find((l) => l.trim() !== '' && !l.trim().startsWith('//'))
  t.is(firstStatement.trim(), 'wipeLocalCaches()', 'forgetConfig wipes first')

  const rev = src.slice(src.indexOf('const revalidated = useCallback'))
  const guard = rev.indexOf("if (verdict !== 'changed' && verdict !== 'invalid') return")
  const revWipe = rev.indexOf('wipeLocalCaches()')
  const revBegin = rev.indexOf('attemptsRef.current.begin()')
  t.ok(guard > 0 && revWipe > guard && revWipe < revBegin, 'changed and invalid verdicts wipe')

  t.ok(/ownerRef\.current !== null && ownerRef\.current !== key\) wipeLocalCaches\(\)/.test(src), 'a different owner key wipes')
  t.ok(/originRef\.current !== undefined && originRef\.current !== origin\) wipeLocalCaches\(\)/.test(src), 'a different installation origin wipes')
})

test('source: blocksProvider drops newly blocked authors in commit', async (t) => {
  const src = read('blocksProvider.js')
  const commit = src.slice(src.indexOf('const commit = useCallback'), src.indexOf('const reload = useCallback'))
  const drop = commit.indexOf('dropAuthors(')
  t.ok(commit.indexOf('newlyBlocked(keysRef.current, next)') > 0, 'compares with the previous list')
  t.ok(drop > 0 && drop < commit.indexOf('setKeys(next)'), 'drops before the new list is shown')
})

test('allowedAuthor: open until a complete set is known, then the set only', async (t) => {
  const lc = await load()
  const own = 'a1'.repeat(32)
  const friend = 'b2'.repeat(32)
  const stranger = 'c3'.repeat(32)
  t.teardown(() => lc.setAllowedAuthors(null))
  lc.setAllowedAuthors(null)
  t.ok(lc.allowedAuthor(stranger), 'no set yet: allowed')
  lc.setAllowedAuthors(new Set([own, friend.toUpperCase()]))
  t.ok(lc.allowedAuthor(own), 'own (passed in the set)')
  t.ok(lc.allowedAuthor(friend), 'case does not matter')
  t.absent(lc.allowedAuthor(stranger), 'outside the set')
  t.absent(lc.allowedAuthor(null))
  lc.setAllowedAuthors('nope')
  lc.setAllowedAuthors(undefined)
  t.absent(lc.allowedAuthor(stranger), 'a non-iterable changes nothing')
  lc.setAllowedAuthors(null)
  t.ok(lc.allowedAuthor(stranger), 'null forgets the set')

  lc.keepOnlyAuthors(new Set([own]))
  t.ok(lc.allowedAuthor(own))
  t.absent(lc.allowedAuthor(friend), 'keepOnlyAuthors records the set')
  lc.keepOnlyAuthors(undefined)
  t.absent(lc.allowedAuthor(friend), 'a missing set records nothing')
  lc.keepOnlyAuthors(new Set([own, friend]))
  lc.dropAuthors([friend])
  t.absent(lc.allowedAuthor(friend), 'a dropped author leaves the set')
  t.ok(lc.allowedAuthor(own))
  lc.wipeLocalCaches()
  t.ok(lc.allowedAuthor(stranger), 'a wipe forgets the set')
})

test('a dropped author stays denied until a wipe, whatever the allowed set says', async (t) => {
  const lc = await load()
  const friend = 'b2'.repeat(32)
  const other = 'd4'.repeat(32)
  t.teardown(() => lc.wipeLocalCaches())
  lc.wipeLocalCaches()
  lc.dropAuthors([friend.toUpperCase()])
  t.absent(lc.allowedAuthor(friend), 'denied even with no allowed set')
  t.ok(lc.allowedAuthor(other))
  lc.keepOnlyAuthors(new Set([friend, other]))
  t.absent(lc.allowedAuthor(friend), 'a later set that still follows them does not allow them again')
  lc.setAllowedAuthors(null)
  t.absent(lc.allowedAuthor(friend), 'nor does forgetting the set')
  lc.wipeLocalCaches()
  t.ok(lc.allowedAuthor(friend), 'a wipe clears the denial')
})
