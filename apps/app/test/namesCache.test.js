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
