'use strict'

const test = require('brittle')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { FEED_LIMIT_MAX } = require('@varanda/rpc')

const keyOf = (item) => item.author + ':' + item.seq

const load = async () => {
  const { fixtures } = await import('../src/vitrine/fixtures.js')
  const { vitrineLarge } = await import('../src/vitrine/enabled.js')
  const { largeFeed } = await import('../src/vitrine/large.js')
  const { createVitrineRequest } = await import('../src/vitrine/request.js')
  return { fixtures, vitrineLarge, largeFeed, createVitrineRequest }
}

async function pageFeed (request) {
  const items = []
  let before = null
  while (items.length < 1000) {
    const params = before ? { limit: FEED_LIMIT_MAX, before } : { limit: FEED_LIMIT_MAX }
    const page = await request('feed.read', params)
    if (page.items.length === 0) break
    items.push(...page.items)
    const oldest = page.items[0]
    before = { at: oldest.at, author: oldest.author, seq: oldest.seq }
  }
  return items
}

test('vitrineLarge needs the Vitrine, the large flag and a development bundle', async (t) => {
  const { vitrineLarge } = await load()
  const both = { EXPO_PUBLIC_VARANDA_VITRINE: '1', EXPO_PUBLIC_VARANDA_VITRINE_LARGE: '1' }
  t.is(vitrineLarge(both, true), true)
  t.is(vitrineLarge(both, false), false)
  t.is(vitrineLarge(both, undefined), false)
  t.is(vitrineLarge(both, 'true'), false)
  t.is(vitrineLarge({ EXPO_PUBLIC_VARANDA_VITRINE: '1' }, true), false)
  t.is(vitrineLarge({ EXPO_PUBLIC_VARANDA_VITRINE_LARGE: '1' }, true), false)
  t.is(vitrineLarge({ EXPO_PUBLIC_VARANDA_VITRINE: '1', EXPO_PUBLIC_VARANDA_VITRINE_LARGE: 'true' }, true), false)
  t.is(vitrineLarge({ EXPO_PUBLIC_VARANDA_VITRINE: '1', EXPO_PUBLIC_VARANDA_VITRINE_LARGE: 1 }, true), false)
  t.is(vitrineLarge(null, true), false)
  t.is(vitrineLarge(undefined, true), false)
})

test('largeFeed returns 200 fixture-shaped rows with unique keys', async (t) => {
  const { fixtures, largeFeed } = await load()
  const before = fixtures.feed.length
  const items = largeFeed(fixtures)
  t.is(fixtures.feed.length, before, 'fixtures are not mutated')
  t.is(items.length, 200)
  t.is(largeFeed(fixtures, 7).length, 7)
  t.alike(largeFeed(fixtures), items)
  const postShape = Object.keys(fixtures.feed[0]).sort()
  const repostShape = ['at', 'author', 'kind', 'media', 'name', 'quote', 'replyTo', 'seq', 'text', 'to', 'username']
  const members = new Set(fixtures.members.map((m) => m.author))
  const followed = new Set([fixtures.own, ...fixtures.follows])
  const known = new Set(fixtures.feed.map(keyOf))
  const keys = new Set()
  const seqs = new Set()
  let quotes = 0
  let reposts = 0
  const newest = Math.max(...fixtures.feed.map((p) => Date.parse(p.at)))
  let prev = Number.POSITIVE_INFINITY
  for (const item of items) {
    const key = keyOf(item)
    t.ok(!keys.has(key), key)
    keys.add(key)
    t.ok(!seqs.has(item.seq))
    seqs.add(item.seq)
    t.ok(members.has(item.author))
    t.ok(followed.has(item.author), 'feed.read can show the row')
    const member = fixtures.members.find((m) => m.author === item.author)
    t.is(item.name, member.name)
    t.is(item.username, member.username)
    t.is(item.replyTo, null)
    const ms = Date.parse(item.at)
    t.ok(ms < prev)
    t.ok(ms < newest)
    prev = ms
    if (item.kind === 'repost') {
      reposts++
      t.alike(Object.keys(item).sort(), repostShape)
      t.is(item.text, null)
      t.is(item.quote, null)
      t.is(item.media, null)
      t.ok(known.has(item.to.author + ':' + item.to.seq))
      continue
    }
    t.alike(Object.keys(item).sort(), postShape)
    t.ok(!Object.hasOwn(item, 'to'))
    t.is(item.kind, 'post')
    t.ok(typeof item.text === 'string' && item.text.length > 0)
    if (item.quote) {
      quotes++
      t.alike(Object.keys(item.quote).sort(), ['author', 'seq'])
      t.ok(known.has(item.quote.author + ':' + item.quote.seq))
    }
    t.is(item.media, null)
  }
  t.is(keys.size, 200)
  t.is(Date.parse(items[0].at), newest - 60 * 1000)
  t.is(reposts, 4)
  t.is(quotes, 4)
})

test('createVitrineRequest keeps the fixture feed unless large is on', async (t) => {
  const { fixtures, largeFeed, createVitrineRequest } = await load()
  const plain = await pageFeed(createVitrineRequest(fixtures))
  t.is(plain.length, fixtures.feed.length)
  const off = await pageFeed(createVitrineRequest(fixtures, {}))
  t.is(off.length, fixtures.feed.length)
  const notQuite = await pageFeed(createVitrineRequest(fixtures, { large: 1 }))
  t.is(notQuite.length, fixtures.feed.length)
  const n = fixtures.feed.length
  const generated = largeFeed(fixtures)
  const paged = await pageFeed(createVitrineRequest(fixtures, { large: true }))
  t.is(fixtures.feed.length, n, 'the caller fixtures stay the design-review set')
  t.ok(paged.length > 200)
  t.is(paged.length, n + generated.length)
  const seen = new Set(paged.map(keyOf))
  t.is(seen.size, paged.length)
  t.ok(generated.every((item) => seen.has(keyOf(item))))
})

test('generated posts open, peek and delete like fixture posts', async (t) => {
  const { fixtures, largeFeed, createVitrineRequest } = await load()
  const generated = largeFeed(fixtures).filter((item) => item.kind === 'post')
  t.ok(generated.every((item) => item.media === null))
  const request = createVitrineRequest(fixtures, { large: true })
  const other = generated.find((item) => item.author !== fixtures.own)
  const peeked = await request('diary.peek', { author: other.author, seqs: [other.seq] })
  t.is(peeked.missing.length, 0)
  t.is(peeked.entries.length, 1)
  t.is(peeked.entries[0].record.text, other.text)
  const own = generated.find((item) => item.author === fixtures.own)
  t.ok(own, 'an own generated row exists')
  const ref = fixtures.own + ':' + own.seq
  const result = await request('post.delete', { to: ref })
  t.is(result.changed, true)
  t.alike(result.deleted, [own.seq])
  const feed = await pageFeed(request)
  t.absent(feed.some((item) => keyOf(item) === ref))
  const gone = await request('diary.peek', { author: fixtures.own, seqs: [own.seq] })
  t.alike(gone.missing, [own.seq])
})

test('enabled.js and large.js import nothing and do not read the clock', (t) => {
  for (const file of ['enabled.js', 'large.js']) {
    const source = readFileSync(join(__dirname, '../src/vitrine', file), 'utf8')
    t.alike(source.split('\n').filter((line) => line.startsWith('import ')), [], file)
    t.ok(!/Date\.now|Math\.random/.test(source), file)
    t.ok(!source.includes(String.fromCharCode(0x2014)), file)
  }
})
