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
  // feed.read lists only followed diaries and the own one: the fixtures also
  // hold photo posts of a person the own member does not follow (her Mural).
  const visible = fixtures.feed.filter((p) => p.author === fixtures.own || fixtures.follows.includes(p.author)).length
  t.ok(visible > 0 && visible < fixtures.feed.length, 'some fixture posts are by someone not followed')
  const plain = await pageFeed(createVitrineRequest(fixtures))
  t.is(plain.length, visible)
  const off = await pageFeed(createVitrineRequest(fixtures, {}))
  t.is(off.length, visible)
  const notQuite = await pageFeed(createVitrineRequest(fixtures, { large: 1 }))
  t.is(notQuite.length, visible)
  const n = fixtures.feed.length
  const generated = largeFeed(fixtures)
  const paged = await pageFeed(createVitrineRequest(fixtures, { large: true }))
  t.is(fixtures.feed.length, n, 'the caller fixtures stay the design-review set')
  t.ok(paged.length > 200)
  t.is(paged.length, visible + generated.length)
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

const PROVIDER = /youtube\.com|youtu\.be|spotify\.com|soundcloud\.com|music\.apple\.com/

test('vitrineRich and vitrineEmbeds need the Vitrine, their flag and a development bundle', async (t) => {
  const { vitrineRich, vitrineEmbeds } = await import('../src/vitrine/enabled.js')
  const all = { EXPO_PUBLIC_VARANDA_VITRINE: '1', EXPO_PUBLIC_VARANDA_VITRINE_RICH: '1', EXPO_PUBLIC_VARANDA_VITRINE_EMBEDS: '1' }
  t.is(vitrineRich(all, true), true)
  t.is(vitrineEmbeds(all, true), true)
  t.is(vitrineRich(all, false), false)
  t.is(vitrineEmbeds(all, false), false)
  t.is(vitrineRich(all, undefined), false)
  t.is(vitrineRich({ EXPO_PUBLIC_VARANDA_VITRINE_RICH: '1' }, true), false)
  t.is(vitrineEmbeds({ EXPO_PUBLIC_VARANDA_VITRINE_EMBEDS: '1' }, true), false)
  t.is(vitrineRich({ EXPO_PUBLIC_VARANDA_VITRINE: '1', EXPO_PUBLIC_VARANDA_VITRINE_RICH: 'true' }, true), false)
  t.is(vitrineEmbeds({ EXPO_PUBLIC_VARANDA_VITRINE: '1' }, true), false)
  t.is(vitrineRich(null, true), false)
})

test('rich large feed is deterministic and keeps the fixed shares per 50 rows', async (t) => {
  const { fixtures, largeFeed } = await load()
  const { RICH_SLOTS } = await import('../src/vitrine/large.js')
  const a = largeFeed(fixtures, 100, { rich: true })
  t.alike(a, largeFeed(fixtures, 100, { rich: true }))
  const block = a.slice(0, 50)
  const count = (fn) => block.filter(fn).length
  t.is(count((r) => r.kind === 'repost'), RICH_SLOTS.repost.length)
  t.is(count((r) => r.kind === 'post' && r.quote !== null), RICH_SLOTS.quote.length + RICH_SLOTS.grid.length)
  t.is(count((r) => r.replyTo !== null), RICH_SLOTS.reply.length)
  t.is(count((r) => r.media && r.media.length === 1), RICH_SLOTS.photo.length)
  t.is(count((r) => r.media && r.media.length === 6), RICH_SLOTS.carousel.length)
  t.is(count((r) => r.media && r.media.length > 1 && r.media.length < 6), 0, 'a feed post with photos is one photo or a carousel')
  t.is(count((r) => !!r.preview), RICH_SLOTS.link.length)
  const shape = (r) => [r.kind, r.media ? r.media.length : 0, r.replyTo !== null, r.quote !== null, !!r.preview]
  t.alike(a.slice(50).map(shape), block.map(shape))
  const known = new Set(fixtures.feed.map(keyOf))
  for (const r of a.filter((x) => x.replyTo)) t.ok(known.has(r.replyTo.author + ':' + r.replyTo.seq))
})

test('grid rows quote a followed post with 2 to 4 photos, so the quote card draws the mosaic', async (t) => {
  const { fixtures, largeFeed } = await load()
  const { RICH_SLOTS, RICH_BLOCK } = await import('../src/vitrine/large.js')
  const byKey = new Map(fixtures.feed.map((p) => [keyOf(p), p]))
  const followed = new Set([fixtures.own, ...fixtures.follows])
  const rows = largeFeed(fixtures, 200, { rich: true })
  const grids = rows.filter((r, i) => RICH_SLOTS.grid.includes(i % RICH_BLOCK))
  t.is(grids.length, 8)
  const sizes = new Set()
  const targets = new Set()
  for (const r of grids) {
    t.is(r.kind, 'post')
    t.is(r.media, null)
    t.ok(r.quote, 'a grid row is a quote')
    const target = r.quote ? byKey.get(r.quote.author + ':' + r.quote.seq) : undefined
    t.ok(target, 'the quoted post is a fixture post')
    if (!target) continue
    t.ok(target.media.length >= 2 && target.media.length <= 4, 'the target has 2 to 4 photos')
    t.ok(followed.has(target.author), 'the quote card resolves from a followed diary')
    t.not(r.author, target.author)
    sizes.add(target.media.length)
    targets.add(keyOf(target))
  }
  t.ok(targets.size > 1, 'grid rows do not all quote the same post')
  t.ok(sizes.size > 1, 'more than one mosaic layout')
})

test('link rows store a card that validates as a post preview and draws a LinkCard', async (t) => {
  const { fixtures, largeFeed } = await load()
  const { embedOf } = await import('../src/musicEmbed.js')
  const { musicRefOf } = await import('../src/music.js')
  const { records } = require('@varanda/core')
  const { cardUrlHost } = require('@varanda/rpc')
  const rows = largeFeed(fixtures, 200, { rich: true })
  const links = rows.filter((r) => r.preview)
  t.is(links.length, 20)
  for (const r of links) {
    t.alike(Object.keys(r.preview).sort(), ['desc', 'host', 'image', 'title', 'url'])
    t.is(r.preview.host, cardUrlHost(r.preview.url))
    t.is(r.preview.image, null)
    t.ok(r.preview.title.length > 0)
    t.ok(r.text.includes(r.preview.url))
    t.is(r.media, null, 'a post carries photos or a card, never both')
    t.is(embedOf(r.preview.url), null, 'drawn as a LinkCard, not a player')
    t.is(musicRefOf(r.preview.url), null)
    const record = { type: 'post', text: r.text, at: r.at, replyTo: null, preview: r.preview }
    t.is(records.validateRecord(record, r.seq), null, 'a post record with this preview is valid')
  }
  t.ok(rows.every((r) => !r.preview || /^https:\/\/example\.org\//.test(r.preview.url)))
})

test('provider rows store a card for every provider player, and only with rich and embeds on', async (t) => {
  const { fixtures, largeFeed } = await load()
  const { embedOf, fallbackCard } = await import('../src/musicEmbed.js')
  const { records } = require('@varanda/core')
  const anyProvider = (rows) => rows.some((r) => PROVIDER.test(r.text || '') || (r.preview && (PROVIDER.test(r.preview.url) || embedOf(r.preview.url) !== null)))
  t.absent(anyProvider(largeFeed(fixtures, 200)))
  t.absent(anyProvider(largeFeed(fixtures, 200, { rich: true })))
  t.absent(anyProvider(largeFeed(fixtures, 200, { embeds: true })))
  const rows = largeFeed(fixtures, 200, { rich: true, embeds: true })
  const players = rows.filter((r) => r.preview && embedOf(r.preview.url) !== null)
  t.is(players.length, 16)
  for (const r of players) {
    const embed = embedOf(r.preview.url)
    t.is(embed.pageUrl, r.preview.url)
    t.alike(r.preview, { ...fallbackCard(r.preview.url), image: null }, 'the card a real post stores without a fetched page')
    t.ok(r.text.includes(r.preview.url))
    t.is(r.media, null)
    t.is(records.validateRecord({ type: 'post', text: r.text, at: r.at, replyTo: null, preview: r.preview }, r.seq), null)
  }
  const first = new Set(rows.slice(0, 50).filter((r) => r.preview && embedOf(r.preview.url)).map((r) => embedOf(r.preview.url).provider))
  t.alike([...first].sort(), ['apple', 'soundcloud', 'spotify', 'youtube'], 'all four providers in each block')
  t.ok(rows.some((r) => r.preview && embedOf(r.preview.url) === null), 'a plain link card stays')
})

test('feed.read and diary.peek return the stored card of a generated link row', async (t) => {
  const { fixtures, createVitrineRequest } = await load()
  const { embedOf } = await import('../src/musicEmbed.js')
  const request = createVitrineRequest(fixtures, { large: true, rich: true, embeds: true })
  const items = await pageFeed(request)
  const withCard = items.filter((r) => r.preview && typeof r.preview === 'object')
  t.ok(withCard.some((r) => embedOf(r.preview.url) !== null))
  t.ok(withCard.some((r) => embedOf(r.preview.url) === null))
  const row = withCard.find((r) => r.seq >= 1000)
  const peeked = await request('diary.peek', { author: row.author, seqs: [row.seq] })
  t.alike(peeked.entries[0].record.preview, row.preview)
})

test('rich off leaves the text-only feed unchanged', async (t) => {
  const { fixtures, largeFeed } = await load()
  const plain = largeFeed(fixtures)
  t.alike(largeFeed(fixtures, 200, {}), plain)
  t.alike(largeFeed(fixtures, 200, { rich: false, embeds: true }), plain)
  t.ok(plain.every((r) => r.media === null && r.replyTo === null))
})

test('every generated photo resolves to real bytes through the Vitrine media route', async (t) => {
  const { fixtures, largeFeed } = await load()
  const { vitrineMediaResponse } = await import('../src/vitrine/publicMedia.js')
  const { postPictureBytes } = await import('../src/vitrine/fixtures.js')
  const photos = largeFeed(fixtures, 200, { rich: true }).flatMap((r) => (r.media || []).map((d) => [r.author, d]))
  t.ok(photos.length > 50)
  for (const [author, d] of photos) {
    const res = await vitrineMediaResponse(`/media/${author}/${d.core}/${d.start}/${d.blocks}`)
    t.is(res.status, 200)
    t.is((await res.arrayBuffer()).byteLength, postPictureBytes(d.sha256).byteLength)
  }
})

test('the rich feed pages through feed.read', async (t) => {
  const { fixtures, createVitrineRequest } = await load()
  const items = await pageFeed(createVitrineRequest(fixtures, { large: true, rich: true, embeds: true }))
  t.ok(items.some((r) => r.media && r.media.length === 6))
})
