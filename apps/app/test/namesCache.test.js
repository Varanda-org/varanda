'use strict'

// Entry rules of the profiles cache (src/namesCache.js).
const test = require('brittle')
const load = () => import('../src/namesCache.js')

const AV = {
  core: 'cd'.repeat(32),
  mime: 'image/jpeg',
  start: 1,
  blocks: 1,
  bytes: 1000,
  sha256: 'ab'.repeat(32),
  width: 512,
  height: 512
}
const AV2 = { ...AV, core: 'ee'.repeat(32) }

test('a nameless Página hint is kept and a later name merges in', async (t) => {
  const { pageOnlyEntry, applySeed } = await load()
  t.is(pageOnlyEntry(null), null, 'no hint means person')
  t.is(pageOnlyEntry({ page: false, closed: false, moved: false }), null, 'a person hint keeps nothing')
  const entry = pageOnlyEntry({ page: true, closed: false, moved: true })
  t.alike(entry, { name: null, username: null, bio: null, avatar: undefined, loaded: false, page: true, closed: false, moved: true })
  t.is(applySeed(entry, { name: 'Casa' }).name, 'Casa', 'a later name merges in')
  t.is(applySeed({ ...entry, name: 'Casa' }, { name: null }), null, 'a nameless seed never overwrites a name')
})

test('seeds merge name, username and bio as before', async (t) => {
  const { applySeed } = await load()
  t.is(applySeed(null, {}), null, 'empty seed for a new key')
  t.is(applySeed(null, null), null)
  t.is(applySeed(null, { name: '', username: '' }), null, 'blank strings are no value')
  t.alike(applySeed(null, 'Ana'), { name: 'Ana', username: null, bio: null, avatar: undefined, loaded: false }, 'bare name')
  const known = { name: 'Ana', username: 'ana', bio: 'oi', avatar: undefined, loaded: true }
  t.is(applySeed(known, { name: 'Ana' }), null, 'unchanged')
  t.is(applySeed(known, { name: null, username: null }), null, 'a null never overwrites')
  t.alike(applySeed(known, { name: 'Ana B' }), { ...known, name: 'Ana B' }, 'keeps loaded and bio')
  t.alike(applySeed({ ...known, loaded: false }, { username: 'anab' }), { ...known, username: 'anab', loaded: false })
  t.is(applySeed(known, 42), null, 'non-object seed')
})

test('a seed changes the avatar only with an own avatar key', async (t) => {
  const { applySeed } = await load()
  const known = { name: 'Ana', username: null, bio: null, avatar: AV, loaded: true }
  t.is(applySeed(known, { name: 'Ana' }), null, 'no key keeps a known avatar')
  t.alike(applySeed(known, { name: 'Bia' }).avatar, AV, 'no key keeps it on change')
  t.is(applySeed(known, { avatar: AV }), null, 'same descriptor is unchanged')
  const cleared = applySeed(known, { avatar: null })
  t.is(cleared.avatar, null, 'null clears')
  t.alike(applySeed(known, { avatar: AV2 }).avatar, AV2, 'a new descriptor replaces')
  t.is(applySeed(known, { avatar: { ...AV2, width: 100 } }).avatar, null, 'an invalid descriptor is stored as null')
  t.is(applySeed(null, { name: 'Ana' }).avatar, undefined, 'a new entry without the key stays unknown')
  const fresh = applySeed(null, { name: 'Ana', avatar: AV })
  t.alike(fresh.avatar, AV)
  t.not(fresh.avatar, AV, 'stored as a copy')
  const inherited = Object.create({ avatar: AV2 })
  inherited.name = 'Ana'
  t.is(applySeed(known, inherited), null, 'only an own key counts')
  t.alike(applySeed({ ...known, avatar: undefined }, { avatar: null }).avatar, null, 'unknown to none is a change')
})

test('authoritative replaces, and an omitted avatar becomes null', async (t) => {
  const { authoritative } = await load()
  t.alike(authoritative({ author: 'x', name: 'Ana', username: '', bio: null, avatar: AV }), { name: 'Ana', username: null, bio: null, avatar: AV, loaded: true })
  t.is(authoritative({ name: 'Ana' }).avatar, null, 'older node omits it')
  t.is(authoritative({ name: 'Ana', avatar: { ...AV, mime: 'image/png' } }).avatar, null, 'invalid is null')
})

test('sameEntry and viewOf', async (t) => {
  const { sameEntry, viewOf } = await load()
  const e = { name: 'Ana', username: 'ana', bio: null, avatar: AV, loaded: true }
  t.ok(sameEntry(e, { ...e, avatar: { ...AV } }))
  t.absent(sameEntry(e, { ...e, avatar: AV2 }))
  t.absent(sameEntry({ ...e, avatar: undefined }, { ...e, avatar: null }), 'undefined differs from null')
  t.absent(sameEntry(e, { ...e, loaded: false }))
  t.absent(sameEntry(e, null))
  t.alike(viewOf(e), { name: 'Ana', username: 'ana', bio: null, avatar: AV })
  t.is(viewOf({ ...e, avatar: undefined }).avatar, undefined)
  t.is(viewOf({ ...e, avatar: null }).avatar, null)
})

test('peekedEntry builds a loaded entry from the value alone', async (t) => {
  const { peekedEntry } = await load()
  t.alike(peekedEntry({ name: 'Ana' }), { name: 'Ana', username: null, bio: null, avatar: null, loaded: true }, 'name only')
  t.alike(peekedEntry({ username: 'ana' }), { name: null, username: 'ana', bio: null, avatar: null, loaded: true }, 'username only')
  t.alike(peekedEntry({ avatar: AV }), { name: null, username: null, bio: null, avatar: AV, loaded: true }, 'avatar only')
  t.alike(peekedEntry({ name: 'Ana', bio: 'oi', avatar: AV }), { name: 'Ana', username: null, bio: 'oi', avatar: AV, loaded: true })
  t.alike(peekedEntry({ name: 'Ana', avatar: { ...AV, mime: 'image/png' } }).avatar, null, 'an invalid avatar reads as null')
  t.is(peekedEntry({ avatar: { ...AV, mime: 'image/png' } }), null, 'an invalid avatar alone names nothing')
  t.is(peekedEntry({}), null, 'empty')
  t.is(peekedEntry({ name: '', username: '', bio: 'oi' }), null, 'a bio alone names nothing')
  t.is(peekedEntry(null), null)
  t.is(peekedEntry(undefined), null)
  t.is(peekedEntry({ name: 'Ana' }).loaded, true)
  const input = { name: 'Ana', avatar: { ...AV } }
  const before = JSON.stringify(input)
  peekedEntry(input)
  t.is(JSON.stringify(input), before, 'input not mutated')
})

test('missingEntry keeps the peek as a copy, else null', async (t) => {
  const { missingEntry } = await load()
  t.is(missingEntry(null), null)
  t.is(missingEntry(undefined), null)
  const peeked = { name: 'Ana', username: 'ana', bio: null, avatar: AV, loaded: true }
  const out = missingEntry(peeked)
  t.alike(out, peeked)
  t.not(out, peeked, 'a copy, not the same object')
})

test('names.js keeps a verified peek through a missing answer', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/names.js'), 'utf8')
  for (const piece of [
    'missingAnswer(peekedRef.current, savedRef.current, key, deniedAuthor)',
    'peekedRef.current.delete(key)',
    'peekedRef.current.clear()',
    'heldRef.current.add(key)',
    'heldRef.current.has(key)',
    'heldRef.current.clear()'
  ]) t.ok(src.includes(piece), piece)
  const line = src.split('\n').find((l) => l.includes('const value = useMemo('))
  t.ok(line && line.includes('learnVerified'), 'learnVerified is in the context value')
  const start = src.indexOf('const learnVerified = useCallback(')
  const body = src.slice(start, src.indexOf('}, [commit])', start))
  t.ok(start > 0 && body.includes('peekReplaces(known, had, unsupportedRef.current)'), 'learnVerified writes by the shared rule')
  t.ok(body.includes('pageHintFields({}, known)'), 'learnVerified keeps the replaced page hints')
})

test('missing keeps a saved peek', async (t) => {
  const { missingAnswer, savedPeeks, absentSeeds, applySeed } = await load()
  const K = 'ab'.repeat(32)
  const none = new Map()
  t.is(missingAnswer(none, none, K), null, 'base: nothing kept, the row shows unnamed')
  const [[, seed]] = absentSeeds(new Map(), [[K, { name: 'Ana', username: 'ana', avatar: AV }]])
  t.is(applySeed(null, seed).name, 'Ana', 'seedMany names the row')
  t.is(missingAnswer(none, none, K), null, 'and a missing answer loses that name')
  const saved = new Map(savedPeeks(new Map(), none, [[K.toUpperCase(), { name: 'Ana', username: 'ana', avatar: AV }]]))
  t.alike(missingAnswer(none, saved, K), { name: 'Ana', username: 'ana', bio: null, avatar: AV, loaded: true }, 'a saved peek stays through missing')
  t.not(missingAnswer(none, saved, K), saved.get(K), 'as a copy')
  const peeked = new Map([[K, { name: 'Ana B', username: 'anab', bio: null, avatar: null, loaded: true }]])
  t.is(missingAnswer(peeked, saved, K).name, 'Ana B', "this run's peek wins over the saved one")
  t.is(missingAnswer(none, saved, K, (k) => k === K), null, 'never for a denied author')
})

test('savedPeeks remembers only keys the cache and this run do not hold', async (t) => {
  const { savedPeeks, savedSeed, applySeed } = await load()
  const A = 'ab'.repeat(32)
  const B = 'cd'.repeat(32)
  const C = 'ef'.repeat(32)
  const D = '12'.repeat(32)
  const E = '34'.repeat(32)
  const known = new Map([[A, { name: 'Ana nova', username: 'ana', bio: null, avatar: null, loaded: true }]])
  const peeked = new Map([[B, { name: 'Bia', username: null, bio: null, avatar: null, loaded: true }]])
  const out = savedPeeks(known, peeked, [
    [A, { name: 'Ana velha' }],
    [B, { name: 'Bia velha' }],
    [C.toUpperCase(), { name: 'Caio', username: 'caio', avatar: AV }],
    [C, { name: 'Caio de novo' }],
    [D, { name: '', username: '' }],
    [E, { name: 'Eva' }],
    [null, { name: 'x' }],
    'bad'
  ], (k) => k === E)
  t.alike(out, [[C, { name: 'Caio', username: 'caio', bio: null, avatar: AV, loaded: true }]], 'a held, a peeked, a repeated, a nameless and a denied key are left out')
  t.alike(savedPeeks(new Map([[A, null]]), new Map(), [[A, { name: 'Ana' }]]).map(([k]) => k), [A], 'the null of a missing answer does not block it')
  t.alike(savedPeeks(null, peeked, null), [])
  const seed = applySeed(null, savedSeed(out[0][1]))
  t.alike(seed, { name: 'Caio', username: 'caio', bio: null, avatar: AV, loaded: false }, 'applied as a seed: not loaded, so profile.read is still asked')
})

const SAVED_A = 'ab'.repeat(32)
const SAVED_B = 'cd'.repeat(32)
const SAVED_C = 'ef'.repeat(32)

function savedRun (over = {}) {
  return {
    known: new Map(),
    peeked: new Map(),
    held: new Set(),
    saved: new Map(),
    refused: () => false,
    max: 500,
    hintOf: () => null,
    ...over
  }
}

test('seedSaved: a missing answer before the saved peek keeps the name, as after it', async (t) => {
  const { seedSaved, missingAnswer, applySeed, isSavedPeekKey } = await load()
  const stored = [[SAVED_A, { name: 'Ana', username: 'ana', avatar: AV }]]
  const kept = { name: 'Ana', username: 'ana', bio: null, avatar: AV, loaded: true }
  // Seed first, then missing.
  const one = savedRun()
  const first = seedSaved({ ...one, entries: stored })
  t.is(first.next, null, 'an absent key changes nothing but the seeds')
  t.is(first.seeds.length, 1)
  one.known.set(SAVED_A, applySeed(null, first.seeds[0][1]))
  const seededThenMissing = missingAnswer(one.peeked, one.saved, SAVED_A)
  // Missing first, then seed.
  const two = savedRun({ known: new Map([[SAVED_A, null]]) })
  const out = seedSaved({ ...two, entries: stored })
  t.alike(out.seeds, [], 'not a seed: the answer is in')
  t.alike(out.next.get(SAVED_A), kept, 'the entry the missing answer would have left')
  t.alike(out.next.get(SAVED_A), seededThenMissing, 'both orders agree')
  t.is(isSavedPeekKey(two.saved, two.peeked, SAVED_A), true, 'still owed a peek')
  t.is(two.known.get(SAVED_A), null, 'the cache passed in stays as it was')
})

test('seedSaved: a present entry and a denied author still block the saved peek', async (t) => {
  const { seedSaved } = await load()
  const profile = { name: 'Ana nova', username: 'ana', bio: null, avatar: null, loaded: true }
  const seed = { name: 'Bia', username: null, bio: null, avatar: undefined, loaded: false }
  const run = savedRun({ known: new Map([[SAVED_A, profile], [SAVED_B, seed], [SAVED_C, null]]), refused: (k) => k === SAVED_C })
  const out = seedSaved({ ...run, entries: [[SAVED_A, { name: 'Ana velha' }], [SAVED_B, { name: 'Bia velha' }], [SAVED_C, { name: 'Caio' }]] })
  t.alike(out, { seeds: [], next: null }, 'a profile answer, a loaded seed and a denied missing key are left alone')
  t.is(run.saved.size, 0, 'none is remembered')
  const peeked = savedRun({ known: new Map([[SAVED_A, null]]), peeked: new Map([[SAVED_A, { ...profile, name: 'Ana B' }]]) })
  t.alike(seedSaved({ ...peeked, entries: [[SAVED_A, { name: 'Ana velha' }]] }), { seeds: [], next: null }, "this run's peek holds it")
})

test('seedSaved: past the cap no evicted saved name stays', async (t) => {
  const { seedSaved, applySeed, savedSeed, peekedEntry, missingEntry } = await load()
  const key = (n) => n.toString(16).padStart(4, '0').repeat(16)
  const profile = { name: 'Perfil', username: null, bio: null, avatar: null, loaded: true }
  const saved = new Map([
    [key(1), peekedEntry({ name: 'Um' })],
    [key(2), peekedEntry({ name: 'Dois' })],
    [key(3), peekedEntry({ name: 'Tres' })],
    [key(4), peekedEntry({ name: 'Quatro' })]
  ])
  const known = new Map([
    [key(1), applySeed(null, savedSeed(saved.get(key(1))))],
    [key(2), missingEntry(saved.get(key(2)))],
    [key(3), profile],
    [key(4), { ...applySeed(null, savedSeed(saved.get(key(4)))), page: true, closed: false, moved: false }]
  ])
  const run = savedRun({ known, saved, max: 5, hintOf: (e) => (e && e.page === true ? { page: true, closed: false, moved: false } : null) })
  const entries = [5, 6, 7, 8].map((n) => [key(n), { name: 'Novo ' + n }])
  // 4 old + 4 new, cap 5: the three oldest leave.
  const out = seedSaved({ ...run, entries })
  t.alike([...run.saved.keys()], [key(4), key(5), key(6), key(7), key(8)])
  t.is(out.next.has(key(1)), false, 'an unanswered saved seed goes back to unknown, so profile.read still asks')
  t.is(out.next.get(key(2)), null, 'a saved name a missing answer kept is forgotten')
  t.is(out.next.get(key(3)), profile, 'an entry a profile answer set is untouched')
  t.alike(out.seeds.map(([k]) => k), [key(5), key(6), key(7), key(8)])

  const big = savedRun({ max: 2 })
  const many = seedSaved({ ...big, entries: [1, 2, 3].map((n) => [key(n), { name: 'N' + n }]) })
  t.alike(many.seeds.map(([k]) => k), [key(2), key(3)], 'a key evicted in the same call is not shown')
  t.is(many.next, null)
  const missingBig = savedRun({ max: 1, known: new Map([[key(1), null], [key(2), null]]) })
  const late = seedSaved({ ...missingBig, entries: [[key(1), { name: 'N1' }], [key(2), { name: 'N2' }]] })
  t.is(late.next.get(key(1)), null, 'nor kept through a missing answer')
  t.is(late.next.get(key(2)).name, 'N2')

  const held = savedRun({
    max: 1,
    saved: new Map([[key(1), peekedEntry({ name: 'Um' })]]),
    known: new Map([[key(1), applySeed(null, savedSeed(peekedEntry({ name: 'Um' })))]]),
    held: new Set([key(1)])
  })
  t.is(seedSaved({ ...held, entries: [[key(2), { name: 'Dois' }]] }).next, null, 'a key a profile answer holds is never touched')
  const mixed = savedRun({
    max: 1,
    saved: new Map([[key(1), peekedEntry({ name: 'Um' })]]),
    known: new Map([[key(1), { name: 'Outro', username: null, bio: null, avatar: undefined, loaded: false }]])
  })
  t.is(seedSaved({ ...mixed, entries: [[key(2), { name: 'Dois' }]] }).next, null, 'an entry another seed changed since is not the saved one')
})

test('sameOwner: a stored copy seeds only the identity it was saved for', async (t) => {
  const { sameOwner } = await load()
  t.is(sameOwner(SAVED_A, SAVED_A), true, 'the current owner seeds')
  t.is(sameOwner(SAVED_A.toUpperCase(), SAVED_A), true, 'any case')
  t.is(sameOwner(SAVED_B, SAVED_A), false, 'another owner changes nothing')
  t.is(sameOwner(null, SAVED_A), false, 'no owner changes nothing')
  t.is(sameOwner(undefined, SAVED_A), false)
  t.is(sameOwner(SAVED_A, null), false, 'nor with no identity')
  t.is(sameOwner('', ''), false)
})

test('isSavedPeekKey: a saved peek this run has not verified again', async (t) => {
  const { isSavedPeekKey } = await load()
  const A = 'ab'.repeat(32)
  const B = 'cd'.repeat(32)
  const saved = new Map([[A, { name: 'Ana' }], [B, { name: 'Bia' }]])
  const peeked = new Map([[B, { name: 'Bia' }]])
  t.is(isSavedPeekKey(saved, peeked, A), true)
  t.is(isSavedPeekKey(saved, peeked, A.toUpperCase()), true, 'any case')
  t.is(isSavedPeekKey(saved, peeked, B), false, 'verified again in this run')
  t.is(isSavedPeekKey(saved, peeked, 'ef'.repeat(32)), false, 'never saved')
  t.is(isSavedPeekKey(saved, peeked, null), false)
})

test('savedRebuild starts a new scope with the saved peeks as seeds, never a denied one', async (t) => {
  const { savedRebuild } = await load()
  const A = 'ab'.repeat(32)
  const B = 'cd'.repeat(32)
  const saved = new Map([[A, { name: 'Ana', username: 'ana', bio: null, avatar: AV, loaded: true }], [B, { name: 'Bia', username: null, bio: null, avatar: null, loaded: true }]])
  const out = savedRebuild(saved, (k) => k === B)
  t.alike([...out.keys()], [A])
  t.alike(out.get(A), { name: 'Ana', username: 'ana', bio: null, avatar: AV, loaded: false }, 'a seed: the re-ask still reads it')
  t.is(savedRebuild(new Map()).size, 0)
  t.is(saved.size, 2, 'the saved peeks themselves stay')
})

test('names.js keeps saved peeks by the shared rules', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/names.js'), 'utf8')
  const between = (from, to) => {
    const start = src.indexOf(from)
    return start < 0 ? '' : src.slice(start, src.indexOf(to, start))
  }
  const seed = between('const seedPeeked = useCallback(', '}, [apply, commit])')
  t.ok(seed.includes('const { seeds, next } = seedSaved({') && seed.includes('refused: deniedAuthor') && seed.includes('max: MAX_REASK_KEYS'), 'seedPeeked: by the shared rule, never a denied author')
  t.ok(seed.includes('held: heldRef.current') && seed.includes('peeked: peekedRef.current') && seed.includes('hintOf: (known) => pageHintFields({}, known)'), 'with this run\'s answers and the page hints')
  t.ok(seed.includes('isKey(pair[0])'), 'only valid keys are saved')
  t.ok(seed.includes('if (next !== null) commit(next)') && seed.includes('apply(seeds)'), 'missing keys and evictions written, absent keys applied as seeds')
  const guard = seed.indexOf('if (!sameOwner(owner, ownKeyRef.current)) return')
  t.ok(guard > 0 && guard < seed.indexOf('seedSaved('), 'a copy saved for another identity, or none, is dropped first, against the current own key')
  t.ok(src.includes('isSavedPeekKey(savedRef.current, peekedRef.current, key)'), 'isSavedPeek reads the refs')
  const learn = between('const learnVerified = useCallback(', '}, [commit])')
  t.ok(learn.includes('const had = peeked.has(key) || savedRef.current.has(key)'), "this run's peek replaces a saved one, even after missing kept it")
  t.ok(learn.indexOf('savedRef.current.delete(key)') > learn.indexOf('if (entry === null || heldRef.current.has(key)) continue'), 'only an accepted peek drops it')
  const forget = between('const forgetVerified = useCallback(', '}, [commit])')
  t.ok(forget.indexOf('savedRef.current.delete(key)') > 0 && forget.indexOf('savedRef.current.delete(key)') < forget.indexOf('if (heldRef.current.has(key)) continue'), 'a gone diary drops the saved name')
  const flush = between('flushRef.current = async', 'const schedulePeek = useCallback(')
  t.ok(flush.includes('missingAnswer(peekedRef.current, savedRef.current, key, deniedAuthor)'), 'missing keeps a saved peek')
  t.ok(flush.indexOf('savedRef.current.delete(key)') > flush.indexOf('const settled = settleProfile('), 'a profile answer drops it')
  const owner = between('useEffect(() => {\n    if (savedOwnerRef.current === ownKey) return', '}, [ownKey])')
  t.ok(owner.includes('savedRef.current.clear()'), 'another identity forgets the saved peeks')
  const epoch = between('const keys = new Set([...cacheRef.current.keys(), ...frontRef.current])', '}, [epoch, generation, schedule])')
  t.ok(src.indexOf('if (savedOwnerRef.current === ownKey) return') < src.indexOf('}, [epoch, generation, schedule])'), 'the identity check runs before the rebuild')
  t.ok(epoch.includes('cacheRef.current = savedRebuild(savedRef.current, deniedAuthor)'), 'a new scope writes the saved peeks back')
  t.absent(epoch.includes('savedRef.current.clear()'), 'a new epoch or generation keeps them')
  t.is(src.split('savedRef.current.clear()').length - 1, 1, 'cleared only on an identity change')
  const line = src.split('\n').find((l) => l.includes('const value = useMemo('))
  t.ok(line && line.includes('seedPeeked') && line.includes('isSavedPeek'), 'both are in the context value')
})

test('peekReplaces lets a peek replace a missing answer, a seed or an earlier peek, never a profile', async (t) => {
  const { peekReplaces } = await load()
  t.is(peekReplaces(null, false, false), true, 'profile.read said missing')
  t.is(peekReplaces(undefined, false, false), false, 'not answered yet')
  t.is(peekReplaces(undefined, false, true), true, 'a node without profile.read')
  const seed = { name: 'Ana', username: 'ana', bio: null, avatar: undefined, loaded: false }
  t.is(peekReplaces(seed, false, false), true, 'only a seed named it')
  const loaded = { ...seed, avatar: null, loaded: true }
  t.is(peekReplaces(loaded, false, false), false, 'a profile answer wins')
  t.is(peekReplaces(loaded, true, false), true, 'an earlier peek of this key')
})

test('isPeekedKey: a kept peek not since answered with a profile', async (t) => {
  const { isPeekedKey } = await load()
  const A = 'ab'.repeat(32)
  const B = 'cd'.repeat(32)
  const peeked = new Map([[A, { name: 'Ana' }], [B, { name: 'Bia' }]])
  const held = new Set([B])
  t.is(isPeekedKey(peeked, held, A), true)
  t.is(isPeekedKey(peeked, held, A.toUpperCase()), true, 'any case')
  t.is(isPeekedKey(peeked, held, B), false, 'a profile.read answer holds it')
  t.is(isPeekedKey(peeked, held, 'ef'.repeat(32)), false, 'never peeked')
  t.is(isPeekedKey(peeked, held, null), false)
})

test('forgottenEntry only takes away and keeps a page hint', async (t) => {
  const { forgottenEntry } = await load()
  const peek = { name: 'Ana', username: 'ana', bio: 'oi', avatar: AV, loaded: true }
  t.is(forgottenEntry(peek, null), null, 'back to a plain missing answer')
  t.is(forgottenEntry({ ...peek, loaded: false }, null), null, 'a seed too')
  t.is(forgottenEntry(null, null), undefined, 'already missing: no change')
  t.is(forgottenEntry(undefined, null), undefined, 'an unknown key stays unknown')
  const hint = { page: true, closed: false, moved: true }
  const out = forgottenEntry({ ...peek, ...hint }, hint)
  t.alike(out, { name: null, username: null, bio: null, avatar: null, loaded: true, page: true, closed: false, moved: true }, 'unnamed, the page hint kept')
  t.is(forgottenEntry(out, hint), undefined, 'forgotten twice: no change')
})

test('names.js forgets a gone peek by the shared rules', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/names.js'), 'utf8')
  t.ok(src.includes('isPeekedKey(peekedRef.current, heldRef.current, key)'), 'isPeeked reads the refs')
  t.ok(/const forgetVerified = useCallback\(\(keys, scope\) => \{\s*if \(scope !== peekScopeRef\.current\) return/.test(src), 'the scope check is the first statement')
  const start = src.indexOf('const forgetVerified = useCallback(')
  const body = src.slice(start, src.indexOf('}, [commit])', start))
  t.ok(body.includes('peekedRef.current.delete(key)'), 'the kept peek is dropped')
  t.ok(body.indexOf('if (heldRef.current.has(key)) continue') < body.indexOf('next.set(key, entry)'), 'a held key is never touched')
  t.ok(body.includes('forgottenEntry(known, pageHintFields({}, known))'), 'the shared rule, page hints kept')
  t.ok(body.includes('if (changed) commit(next)'), 'commits only a change')
  const line = src.split('\n').find((l) => l.includes('const value = useMemo('))
  t.ok(line && line.includes('isPeeked') && line.includes('forgetVerified'), 'both are in the context value')
})

test('names.js forgets the peek the cap evicts, so none is left unchecked', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/names.js'), 'utf8')
  const start = src.indexOf('const learnVerified = useCallback(')
  const body = src.slice(start, src.indexOf('}, [commit])', start))
  const loop = body.slice(body.indexOf('while (peeked.size > MAX_REASK_KEYS) {'), body.indexOf('const known = next.get(key)'))
  t.ok(loop.length > 0, 'the eviction loop')
  t.ok(body.indexOf('peeked.set(key, entry)') < body.indexOf('while (peeked.size > MAX_REASK_KEYS)'), 'the learned key is re-inserted before the cap, so it is never the evicted one')
  t.ok(loop.includes('const evicted = peeked.keys().next().value') && loop.includes('peeked.delete(evicted)'), 'the oldest key leaves peekedRef')
  t.ok(loop.indexOf('if (heldRef.current.has(evicted)) continue') > loop.indexOf('peeked.delete(evicted)') && loop.indexOf('if (heldRef.current.has(evicted)) continue') < loop.indexOf('next.set(evicted, forgotten)'), 'a held key is never touched')
  t.ok(loop.includes('forgottenEntry(old, pageHintFields({}, old))'), 'the shared rule, page hints kept')
  t.ok(loop.includes('if (forgotten === undefined) continue'), 'nothing to take away: no write')
  t.ok(loop.indexOf('next.set(evicted, forgotten)') < loop.indexOf('changed = true'), 'the change is committed')
})

test('names.js drops a peek from an older session scope', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/names.js'), 'utf8')
  t.ok(/const learnVerified = useCallback\(\(entries, scope\) => \{\s*if \(scope !== peekScopeRef\.current\) return/.test(src), 'the scope check is the first statement')
  t.ok(src.includes("const peekScope = epoch + ':' + generation"), 'the provider owns the scope')
  t.ok(src.includes('peekScopeRef.current = peekScope'), 'the ref follows the provider scope')
  const line = src.split('\n').find((l) => l.includes('const value = useMemo('))
  t.ok(line && line.includes('peekScope'), 'peekScope is in the context value')
})

test('fillFromPeek keeps a verified peek only for an answer with nothing at all', async (t) => {
  const { fillFromPeek } = await load()
  const peeked = { name: 'Padaria do Lab', username: 'padaria', bio: 'pão', avatar: AV, loaded: true }
  const bare = { name: null, username: null, bio: null, avatar: null, loaded: true }
  t.alike(fillFromPeek(bare, peeked), { name: 'Padaria do Lab', username: 'padaria', bio: 'pão', avatar: AV, loaded: true }, 'an empty answer keeps the whole peek')
  const onlyUser = { ...bare, username: 'nova' }
  t.is(fillFromPeek(onlyUser, peeked).username, 'nova', 'the @nome the answer brought wins')
  t.is(fillFromPeek(onlyUser, peeked).name, 'Padaria do Lab', 'and the profile group still fills')
  const renamed = { name: 'Novo', username: null, bio: null, avatar: null, loaded: true }
  t.is(fillFromPeek(renamed, peeked), renamed, 'a newer profile without bio and photo keeps those nulls, and no revoked @nome comes back')
  t.is(fillFromPeek({ ...bare, bio: 'x' }, peeked).name, null, 'any profile field makes the answer the newest record')
  t.is(fillFromPeek(bare, undefined), bare, 'no kept peek, nothing to fill')
})

test('settleProfile keeps the peek only while it filled the answer', async (t) => {
  const { settleProfile } = await load()
  const peeked = { name: 'Padaria', username: 'padaria', bio: null, avatar: null, loaded: true }
  const bare = { name: null, username: null, bio: null, avatar: null, loaded: true }
  const a = settleProfile(bare, peeked)
  t.is(a.entry.name, 'Padaria')
  t.is(a.peek, peeked, 'the peek stays for the next answer')
  const named = { ...bare, name: 'Novo' }
  const b = settleProfile(named, peeked)
  t.is(b.entry, named)
  t.is(b.peek, undefined, 'a newer profile drops it')
  t.is(settleProfile(bare, undefined).peek, undefined)
})

test('a blank profile.read answer clears the name, bio and photo shown: it may be a deleted profile', async (t) => {
  const { settleProfile, applySeed } = await load()
  const { pickAvatar } = await import('../src/media/avatar.js')
  // The owner deleted the last profile version; names.invalidate kept the old
  // values as a seed (loaded: false) and asked again.
  const shown = { name: 'Ana', username: 'ana', bio: 'oi', avatar: AV, loaded: true }
  const invalidated = { ...shown, loaded: false }
  const blank = { name: null, username: 'ana', bio: null, avatar: null, loaded: true }
  // The entry it replaces is passed too, whatever settleProfile does with it.
  for (const old of [invalidated, shown, applySeed(null, { name: 'Ana', username: 'ana', avatar: AV })]) {
    const out = settleProfile(blank, undefined, old)
    t.alike(out.entry, blank, 'nothing of the deleted profile comes back')
    t.is(out.peek, undefined)
    t.is(pickAvatar(out.entry, { avatar: AV2 }), null, 'and no row photo shows through for the cached entry')
  }
  t.alike(settleProfile({ ...blank, username: null }, undefined, shown).entry, { ...blank, username: null }, 'nor without an @nome')
})

test('keptProfile is what a save or a rename leaves as the verified entry', async (t) => {
  const { keptProfile, peekedEntry } = await load()
  t.is(keptProfile(null, 'padaria'), null, 'no known name, nothing kept')
  t.is(keptProfile({ name: '', bio: '', avatar: null }, 'x'), null)
  const kept = keptProfile({ name: 'Padaria', bio: 'pão', avatar: AV }, 'novo_nome')
  t.alike(kept, { name: 'Padaria', bio: 'pão', avatar: AV, username: 'novo_nome' }, 'the new @nome replaces the old one')
  t.alike(peekedEntry(kept), { name: 'Padaria', username: 'novo_nome', bio: 'pão', avatar: peekedEntry(kept).avatar, loaded: true })
  t.is(keptProfile({ name: 'P', bio: '', avatar: null }, undefined).username, null)
})

test('names.js settles a profile.read answer through settleProfile', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/names.js'), 'utf8')
  t.ok(src.includes('const settled = settleProfile(entry, peekedRef.current.get(key))'), 'the rule is the pure one')
  t.ok(src.includes('if (settled.peek === undefined) peekedRef.current.delete(key)'), 'the peek is kept only while it filled the answer')
})

test('the Páginas screens name people through verified peeks, not seeds', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const read = (f) => fs.readFileSync(path.join(__dirname, '../src/screens/' + f), 'utf8')
  const paginas = read('Paginas.js')
  t.ok(paginas.includes('learnVerified([[author, entry]], scope)'), 'Páginas keeps the peeked name as a verified entry')
  t.absent(paginas.includes('learnMany'), 'and no longer seeds it (a seed does not survive "missing")')
  t.ok(read('NovaPagina.js').includes('learnVerified([[value.page,'), 'a created page is named from what the member wrote')
  const ajustes = read('PaginaAjustes.js')
  t.ok(ajustes.includes('useRowPeeks(peekKeys, hosted, peekKeys.length)'), 'Ajustes names the page and every person on its roster')
  t.is(ajustes.split('learnVerified([[page, kept]], peekScope)').length - 1, 2, 'a save and a rename replace the kept peek')
  t.ok(read('NovaPagina.js').includes('{ name, username, bio }'), 'a created page keeps exactly what was sent')
  t.ok(read('Mensagens.js').includes('useRowPeeks(sortedPeers, unlocked && loaded)'), 'the page requests list names its senders')
})

test('a Páginas row peek survives a names answer that re-runs the effect', async (t) => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/Paginas.js'), 'utf8')
  const start = src.indexOf('// Keys the names cache could not name')
  const end = src.indexOf('}, [list, profileOf, learnVerified, node, peekAgain])', start)
  t.ok(start > 0 && end > start, 'peek effect found, re-run by peekAgain')
  const effect = src.slice(start, end)
  t.ok(effect.includes('const alive = () => mountedRef.current'), 'only unmounting stops a peek')
  t.absent(/return \(\) => \{ alive = false \}/.test(effect), 'a re-run (profileOf changed) does not cancel the peek in flight')
  t.ok(effect.includes('.filter((key) => !peekedRef.current.has(key) && !peekingRef.current.has(key))'), 'a key another run already asks is skipped')
  t.ok(src.includes('mountedRef.current = false }, [])'), 'unmount marks the screen gone')
  const tries = effect.indexOf('triesRef.current.set(key, (triesRef.current.get(key) || 0) + 1)')
  t.ok(tries > 0 && tries < effect.indexOf('try {'), 'a peek that throws still counts as a try')
  t.ok(effect.includes('if (scope !== scopeRef.current) setPeekAgain((n) => n + 1)'), 'an answer dropped for another identity asks again in a new run')
  t.ok(effect.includes('else if (peeked.has(key)) peekedRef.current.add(key)'), 'only an answer for the identity that asked marks the key peeked')
})
