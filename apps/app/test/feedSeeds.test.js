'use strict'

// What feed.read items teach the profiles cache (src/feedSeeds.js).
const test = require('brittle')
const fs = require('fs')
const path = require('path')
const load = () => import('../src/feedSeeds.js')
const loadCache = () => import('../src/namesCache.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const AV = { core: 'cd'.repeat(32), mime: 'image/webp', start: 1, blocks: 1, bytes: 1000, sha256: 'ab'.repeat(32), width: 512, height: 512 }
const item = (extra) => ({ kind: 'post', author: A, name: 'Ana', username: 'ana', seq: 1, at: '2026-01-01T00:00:00.000Z', text: 'oi', replyTo: null, quote: null, media: null, preview: null, ...extra })

test('an item with an avatar seeds it', async (t) => {
  const { feedSeed } = await load()
  t.alike(feedSeed(item({ avatar: AV })), { name: 'Ana', username: 'ana', avatar: AV })
})

test('an item from an older node (no avatar key) seeds no avatar key', async (t) => {
  const { feedSeed } = await load()
  const seed = feedSeed(item())
  t.absent(Object.prototype.hasOwnProperty.call(seed, 'avatar'))
  t.alike(seed, { name: 'Ana', username: 'ana' })
  t.absent(Object.prototype.hasOwnProperty.call(feedSeed(item({ avatar: undefined })), 'avatar'))
})

test('a named profile with a null avatar says "no photo"; a nameless item says nothing', async (t) => {
  const { feedSeed } = await load()
  const plain = feedSeed(item({ avatar: null }))
  t.ok(Object.prototype.hasOwnProperty.call(plain, 'avatar'))
  t.is(plain.avatar, null)
  const nameless = feedSeed(item({ name: null, avatar: null }))
  t.absent(Object.prototype.hasOwnProperty.call(nameless, 'avatar'), 'no profile record yet')
  t.ok(Object.prototype.hasOwnProperty.call(feedSeed(item({ name: null, avatar: AV })), 'avatar'), 'a descriptor is always kept')
})

test('avatar: false seeds the name only (page.feed borrows an older head profile)', async (t) => {
  const { feedSeed, feedSeeds } = await load()
  t.alike(feedSeed(item({ avatar: AV }), { avatar: false }), { name: 'Ana', username: 'ana' })
  t.alike(feedSeeds([item({ avatar: null })], { avatar: false }), [[A, { name: 'Ana', username: 'ana' }]])
})

test('PageARua never seeds an avatar', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/ARua.js'), 'utf8')
  t.is(src.split('learnMany(feedSeeds(items, { avatar: false }))').length - 1, 1)
  t.is(src.split('learnMany(feedSeeds(items))').length - 1, 1, 'only the main feed seeds photos')
})

test('feedSeeds pairs each author with its seed', async (t) => {
  const { feedSeeds } = await load()
  t.alike(feedSeeds([item({ avatar: AV }), item({ author: B, name: 'Bia', username: null })]), [
    [A, { name: 'Ana', username: 'ana', avatar: AV }],
    [B, { name: 'Bia', username: null }]
  ])
  t.alike(feedSeeds([]), [])
})

test('through the names cache: a seed sets the photo, an older node keeps a known one', async (t) => {
  const { feedSeed } = await load()
  const { applySeed } = await loadCache()
  const fresh = applySeed(undefined, feedSeed(item({ avatar: AV })))
  t.alike(fresh.avatar, AV)
  t.is(fresh.loaded, false, 'a seed never marks the entry loaded')
  t.is(applySeed(fresh, feedSeed(item())), null, 'no avatar key: nothing changes')
  t.alike(applySeed({ ...fresh, name: 'Antiga' }, feedSeed(item())).avatar, AV, 'a known photo survives a newer name')
  t.is(applySeed(fresh, feedSeed(item({ avatar: null }))).avatar, null, 'a plain newest profile clears it')
  t.is(applySeed(undefined, feedSeed(item())).avatar, undefined, 'unknown stays unknown')
  t.is(applySeed(undefined, feedSeed(item({ avatar: null }))).avatar, null, 'known to have none')
})

test('A Rua teaches names from feed items through feedSeeds', async (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/screens/ARua.js'), 'utf8')
  t.is(src.split('learnMany(feedSeeds(items))').length - 1, 1, 'the main feed read')
  t.is(src.split('feedSeeds(items, { avatar: false })').length - 1, 1, 'the Página feed')
  t.absent(src.includes('{ name: i.name, username: i.username }'), 'no hand-built seed from items')
})
