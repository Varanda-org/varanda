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
    'missingEntry(peekedRef.current.get(key))',
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
