'use strict'

// The 'momentos' screen snapshot (src/screenSnapshot.js): the strip as
// useMoments holds it (momentsOf of src/momentSeen.js), kept without any
// blob reference, own and followed authors only, 24 hours per item, 64 KiB
// in all, and wiped or rewritten through the store's localCaches entry.
const test = require('brittle')

const load = () => import('../src/screenSnapshot.js')
const loadSeen = () => import('../src/momentSeen.js')
const loadCaches = () => import('../src/localCaches.js')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)
const BLOCKED = 'dd'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const ME = Object.freeze({ kind: 'me' })
const PAGE = Object.freeze({ kind: 'page', key: 'ff'.repeat(32), name: 'Loja', username: 'loja' })
const AVATAR = { core: '56'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: '78'.repeat(32), width: 512, height: 512 }

const iso = (ms) => new Date(ms).toISOString()
const bind = (extra = {}) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now: NOW, ...extra })

// Media items exactly as moments.read answers them (docs/rpc.md 5.113).
const BLOB = { id: '01'.repeat(32), key: '02'.repeat(32), nonce: '03'.repeat(24), sha256: '04'.repeat(32) }
const imageMedia = () => ({ ...BLOB, chunks: 3, bytes: 70000, mime: 'image/webp', w: 1080, h: 1350, ms: 0 })
const videoMedia = () => ({ id: '05'.repeat(32), key: '06'.repeat(32), nonce: '07'.repeat(24), sha256: '08'.repeat(32), chunks: 40, bytes: 1300000, mime: 'video/mp4', w: 720, h: 1280, ms: 9000 })

function rawItem (author, seq, extra = {}) {
  return { seq, ref: author + ':' + seq, text: 'momento ' + seq, at: iso(NOW - seq * 60 * 1000), media: imageMedia(), music: null, ...extra }
}

function answer () {
  return {
    authors: [
      { author: FOLLOW, items: [rawItem(FOLLOW, 9, { music: { p: 'audius', id: 'Ab12Cd', start: 30 } }), rawItem(FOLLOW, 8, { media: videoMedia() })] },
      { author: STRANGER, items: [rawItem(STRANGER, 5)] },
      { author: BLOCKED, items: [rawItem(BLOCKED, 4)] }
    ],
    own: [rawItem(OWN, 3, { text: 'eu' })],
    past: [{ seq: 1, ref: OWN + ':1', text: 'antigo', at: iso(NOW - 3 * DAY) }]
  }
}

const NAMES = [
  { author: OWN, name: 'Eu', username: 'eu_mesmo', avatar: null },
  { author: FOLLOW, name: 'Bia', username: 'bia', avatar: AVATAR },
  { author: STRANGER, name: 'Estranho', username: 'estranho', avatar: null },
  { author: BLOCKED, name: 'Bloqueado', username: 'bloqueado', avatar: null }
]

async function input (extra = {}) {
  const { momentsOf } = await loadSeen()
  const m = momentsOf(answer(), OWN)
  return { ...bind(), authors: m.authors, own: m.own, past: m.past, names: NAMES, followed: new Set([FOLLOW, BLOCKED]), blocked: [BLOCKED], ...extra }
}

// A momento already in the in-memory shape, an hour before NOW.
function item (author, seq, extra = {}) {
  return { seq, ref: author + ':' + seq, text: 't' + seq, at: iso(NOW - HOUR), media: { mime: 'image/jpeg', w: 100, h: 100, ms: 0 }, ...extra }
}

test('a real image and a real video moment survive the round trip with no blob reference', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('momentos', await input())
  t.ok(built)
  t.alike(Object.keys(built), ['v', 'kind', 'origin', 'association', 'owner', 'savedAt', 'body'])
  t.alike(built.body.authors.map((a) => a.author), [FOLLOW], 'only the followed, unblocked author')
  const [image, video] = built.body.authors[0].items
  t.alike(image, { seq: 9, ref: FOLLOW + ':9', text: 'momento 9', at: iso(NOW - 9 * 60 * 1000), media: { mime: 'image/webp', w: 1080, h: 1350, ms: 0 }, music: { id: 'Ab12Cd', start: 30 } })
  t.alike(video, { seq: 8, ref: FOLLOW + ':8', text: 'momento 8', at: iso(NOW - 8 * 60 * 1000), media: { mime: 'video/mp4', w: 720, h: 1280, ms: 9000 } })
  t.alike(built.body.own, [{ seq: 3, ref: OWN + ':3', text: 'eu', at: iso(NOW - 3 * 60 * 1000), media: { mime: 'image/webp', w: 1080, h: 1350, ms: 0 } }])
  t.alike(built.body.names, [NAMES[0], NAMES[1]], 'names of the owner and the kept author only')

  const text = JSON.stringify(built)
  const items = JSON.stringify([built.body.own, built.body.authors.map((a) => a.items.map((i) => i.media))])
  for (const k of ['"id"', '"key"', '"nonce"', '"chunks"', '"bytes"', '"sha256"']) t.absent(items.includes(k), 'no ' + k + ' in a moment')
  for (const k of ['"key"', '"nonce"', '"chunks"', '"past"']) t.absent(text.includes(k), 'no ' + k + ' anywhere')
  for (const hex of [BLOB.id, BLOB.key, BLOB.nonce, BLOB.sha256, '05'.repeat(32), '06'.repeat(32)]) t.absent(text.includes(hex), 'no blob value')
  t.absent(text.includes('antigo'), 'past is never stored')

  t.alike(s.parseScreenSnapshot(text, 'momentos', bind()), built, 'the parse equals the build')
})

test('build drops an item with another key or a wrong type, and only the music when that fails', async (t) => {
  const s = await load()
  const build = (items, extra = {}) => s.buildScreenSnapshot('momentos', { ...bind(), authors: [{ author: FOLLOW, items }], own: [], followed: [FOLLOW], ...extra })
  const seqs = (b) => (b.body.authors[0] ? b.body.authors[0].items.map((i) => i.seq) : [])
  const bad = [
    item(FOLLOW, 1, { extra: 1 }),
    item(FOLLOW, 2, { past: true }),
    item(FOLLOW, 3, { ref: FOLLOW.toUpperCase() + ':3' }),
    item(FOLLOW, 4, { ref: STRANGER + ':4' }),
    { ...item(FOLLOW, 0), ref: FOLLOW + ':0' },
    item(FOLLOW, 5, { seq: '5' }),
    item(FOLLOW, 6, { text: '😀'.repeat(201) }),
    item(FOLLOW, 7, { text: null }),
    item(FOLLOW, 8, { at: 'ontem' }),
    item(FOLLOW, 9, { media: { mime: 'image/svg+xml', w: 10, h: 10, ms: 0 } }),
    item(FOLLOW, 10, { media: { mime: 'image/jpeg', w: 16385, h: 10, ms: 0 } }),
    item(FOLLOW, 11, { media: { mime: 'image/jpeg', w: 10, h: 0, ms: 0 } }),
    item(FOLLOW, 12, { media: { mime: 'image/jpeg', w: 10, h: 10, ms: 1 } }),
    item(FOLLOW, 13, { media: { mime: 'video/mp4', w: 10, h: 10, ms: 0 } }),
    item(FOLLOW, 14, { media: { mime: 'video/mp4', w: 10, h: 10, ms: 15001 } }),
    item(FOLLOW, 15, { media: [{ mime: 'image/jpeg', w: 10, h: 10, ms: 0 }] }),
    (() => { const i = item(FOLLOW, 16); delete i.media; return i })(),
    item(FOLLOW, 17, { media: { mime: 'video/mp4', w: 1921, h: 10, ms: 1000 } }),
    item(FOLLOW, 18, { media: { mime: 'video/mp4', w: 1920, h: 1081, ms: 1000 } }),
    item(FOLLOW, 19, { media: { mime: 'video/mp4', w: 8192, h: 8192, ms: 15000 } })
  ]
  for (const b of bad) t.alike(seqs(build([b])), [], 'drops ' + JSON.stringify(b).slice(0, 80))

  t.alike(seqs(build([item(FOLLOW, 20, { text: '😀'.repeat(200) })])), [20], '200 code points are kept')
  t.alike(seqs(build([item(FOLLOW, 21, { media: null })])), [21], 'a null media is kept')
  t.alike(seqs(build([item(FOLLOW, 22, { media: { mime: 'video/mp4', w: 1920, h: 1080, ms: 15000 } })])), [22], 'a 1920x1080 video is kept')
  t.alike(seqs(build([item(FOLLOW, 23, { media: { mime: 'video/mp4', w: 1080, h: 1920, ms: 1 } })])), [23], 'either orientation')
  t.alike(seqs(build([item(FOLLOW, 24, { media: { mime: 'image/jpeg', w: 16384, h: 16384, ms: 0 } })])), [24], 'a 16384 image side is kept')
  t.alike(seqs(build([item(FOLLOW, 25, { media: { mime: 'image/png', w: 8193, h: 10, ms: 0 } })])), [25], 'an image past 8192 is kept')

  const noMusic = build([item(FOLLOW, 30, { music: { id: 'Ab12Cd', start: -1 } }), item(FOLLOW, 31, { music: { p: 'audius', id: 'Ab12Cd', start: 1 } }), item(FOLLOW, 32, { music: null })])
  t.alike(seqs(noMusic), [30, 31, 32], 'an item whose music fails is kept')
  t.ok(noMusic.body.authors[0].items.every((i) => !Object.prototype.hasOwnProperty.call(i, 'music')), 'without music')
  const onVideo = build([item(FOLLOW, 33, { media: { mime: 'video/mp4', w: 10, h: 10, ms: 1000 }, music: { id: 'Ab12Cd', start: 1 } })])
  t.absent(Object.prototype.hasOwnProperty.call(onVideo.body.authors[0].items[0], 'music'), 'music on a video is dropped')
})

test('parse is strict on the shape and drops an item that fails', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('momentos', { ...bind(), authors: [{ author: FOLLOW, items: [item(FOLLOW, 2, { music: { id: 'Ab12Cd', start: 3 } }), item(FOLLOW, 1)] }], own: [item(OWN, 1)], names: [{ author: FOLLOW, name: 'Bia', username: 'bia', avatar: null }], followed: [FOLLOW] })
  const text = JSON.stringify(built)
  const parse = (change) => {
    const copy = JSON.parse(text)
    change(copy.body)
    return s.parseScreenSnapshot(JSON.stringify(copy), 'momentos', bind())
  }
  t.ok(parse(() => {}))
  t.is(parse((b) => { b.past = [] }), null, 'a past list')
  t.is(parse((b) => { delete b.names }), null, 'no names')
  t.is(parse((b) => { b.authors[0].extra = 1 }), null, 'an extra key in an author entry')
  t.is(parse((b) => { b.authors.push(b.authors[0]) }), null, 'an author twice')
  t.is(parse((b) => { b.authors[0].author = FOLLOW.toUpperCase() }), null, 'an author not in lowercase')
  t.is(parse((b) => { b.names[0].bio = 'oi' }), null, 'an extra key in a name')
  t.is(parse((b) => { b.names[0].author = STRANGER }), null, 'a name of an author not stored')
  t.is(parse((b) => { b.names[0].avatar = { mime: 'image/png' } }), null, 'a bad avatar')

  const items = (b) => b.body.authors[0].items.map((i) => i.seq)
  t.alike(items(parse((b) => { b.authors[0].items[0].media.id = BLOB.id })), [1], 'an item with a blob id is dropped')
  t.alike(items(parse((b) => { b.authors[0].items[0].media.key = BLOB.key })), [1], 'an item with a blob key is dropped')
  t.alike(items(parse((b) => { b.authors[0].items[0].extra = 1 })), [1], 'an item with another key is dropped')
  t.alike(items(parse((b) => { b.authors[0].items[0].ref = STRANGER + ':2' })), [1], 'an item under another ref is dropped')
  t.alike(parse((b) => { b.own[0].text = 'x'.repeat(201) }).body.own, [], 'an own item too long is dropped')
  const music = parse((b) => { b.authors[0].items[0].music.p = 'audius' })
  t.alike(items(music), [2, 1], 'a bad music keeps the item')
  t.absent(Object.prototype.hasOwnProperty.call(music.body.authors[0].items[0], 'music'), 'without music')
  const empty = parse((b) => { b.authors[0].items.forEach((i) => { i.seq = 0 }) })
  t.alike(empty.body.authors, [], 'an author left with no items goes')
  t.alike(empty.body.names, [], 'and that author\'s name')
})

test('caps: 32 authors, 4 items each, 4 own', async (t) => {
  const s = await load()
  const keys = Array.from({ length: 33 }, (_, i) => (i + 16).toString(16).padStart(2, '0').repeat(32))
  const authors = keys.map((author) => ({ author, items: [1, 2, 3, 4, 5].map((n) => item(author, n)) }))
  const own = [1, 2, 3, 4, 5].map((n) => item(OWN, n))
  const built = s.buildScreenSnapshot('momentos', { ...bind(), authors, own, followed: keys })
  t.is(built.body.authors.length, s.MOMENT_MAX_AUTHORS)
  t.alike(built.body.authors.map((a) => a.author), keys.slice(0, 32), 'the first 32 in order')
  t.ok(built.body.authors.every((a) => a.items.length === s.MOMENT_MAX_ITEMS))
  t.alike(built.body.own.map((i) => i.seq), [1, 2, 3, 4])
  t.ok(s.parseScreenSnapshot(JSON.stringify(built), 'momentos', bind()))

  const over = (change) => {
    const copy = JSON.parse(JSON.stringify(built))
    change(copy.body)
    return s.parseScreenSnapshot(JSON.stringify(copy), 'momentos', bind())
  }
  t.is(over((b) => { b.authors.push({ author: keys[32], items: [item(keys[32], 1)] }) }), null, '33 authors')
  t.is(over((b) => { b.authors[0].items.push(item(keys[0], 5)) }), null, '5 items')
  t.is(over((b) => { b.own.push(item(OWN, 5)) }), null, '5 own')
})

test('the whole text fits 64 KiB: authors are cut from the end', async (t) => {
  const s = await load()
  t.is(s.KIND_MAX_BYTES.momentos, 65536)
  t.ok(Object.isFrozen(s.KIND_MAX_BYTES))
  const keys = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).padStart(2, '0').repeat(32))
  const long = '😀'.repeat(200)
  const authors = keys.map((author) => ({ author, items: [1, 2, 3, 4].map((n) => item(author, n, { text: long })) }))
  const names = keys.map((author) => ({ author, name: 'Nome', username: null, avatar: null }))
  const args = { ...bind(), authors, own: [item(OWN, 1, { text: long })], names, followed: keys }
  const built = s.buildScreenSnapshot('momentos', args)
  const text = JSON.stringify(built)
  const bytes = Buffer.byteLength(text, 'utf8')
  t.ok(bytes <= 65536, 'fits: ' + bytes)
  const n = built.body.authors.length
  t.ok(n > 0 && n < 32, 'cut to ' + n)
  t.alike(built.body.authors.map((a) => a.author), keys.slice(0, n), 'a prefix: cut from the end')
  t.alike(built.body.names.map((e) => e.author), keys.slice(0, n), 'names only of the kept authors')
  const oneMore = { ...built, body: { ...built.body, authors: authors.slice(0, n + 1).map((a) => ({ author: a.author, items: built.body.authors[0].items.map((i) => ({ ...i, ref: a.author + ':' + i.seq })) })) } }
  t.ok(Buffer.byteLength(JSON.stringify(oneMore), 'utf8') > 65536, 'one more author would not fit')
  t.alike(s.parseScreenSnapshot(text, 'momentos', bind()), built)

  const big = text.replace('"body":', '"body":' + ' '.repeat(65537 - bytes))
  t.is(s.parseScreenSnapshot(big, 'momentos', bind()), null, 'parse measures the whole text against the momentos cap')
})

test('an item past 24 hours is dropped at parse, then an author with none', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('momentos', {
    ...bind(),
    authors: [
      { author: FOLLOW, items: [item(FOLLOW, 2, { at: iso(NOW - HOUR) }), item(FOLLOW, 1, { at: iso(NOW - 20 * HOUR) })] },
      { author: STRANGER, items: [item(STRANGER, 1, { at: iso(NOW - 22 * HOUR) })] }
    ],
    own: [item(OWN, 1, { at: iso(NOW - 10 * HOUR) })],
    names: [{ author: FOLLOW, name: 'Bia', username: null, avatar: null }, { author: STRANGER, name: 'Leo', username: null, avatar: null }],
    followed: [FOLLOW, STRANGER]
  })
  const text = JSON.stringify(built)
  const at = (now) => s.parseScreenSnapshot(text, 'momentos', bind({ now }))
  t.is(at(NOW).body.authors.length, 2)
  const later = at(NOW + 3 * HOUR)
  t.alike(later.body.authors.map((a) => a.author), [FOLLOW], 'the author with nothing left goes')
  t.alike(later.body.authors[0].items.map((i) => i.seq), [2, 1])
  t.alike(later.body.names.map((n) => n.author), [FOLLOW], 'with its name')
  const edge = at(NOW + 4 * HOUR)
  t.alike(edge.body.authors[0].items.map((i) => i.seq), [2], 'exactly 24 hours is gone')
  t.alike(edge.body.own.map((i) => i.seq), [1])
  const gone = at(NOW + 23 * HOUR + 1)
  t.alike(gone.body, { authors: [], own: [], names: [] })
  t.alike(s.buildScreenSnapshot('momentos', { ...bind(), authors: [], own: [item(OWN, 1, { at: iso(NOW - DAY) })], followed: [] }).body.own, [], 'build drops an expired item too')
})

test('only the owner and followed, unblocked authors; block and unfollow rewrite', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('momentos', await input({ followed: [FOLLOW, STRANGER, BLOCKED] }))
  t.alike(built.body.authors.map((a) => a.author), [FOLLOW, STRANGER])
  t.alike(built.body.names.map((n) => n.author), [OWN, FOLLOW, STRANGER])
  const none = s.buildScreenSnapshot('momentos', await input({ followed: () => false, blocked: [] }))
  t.alike(none.body.authors, [], 'nobody followed')
  t.alike(none.body.names.map((n) => n.author), [OWN])
  t.alike(none.body.own.map((i) => i.seq), [3], 'the own moments stay')

  const dropped = s.screenWithoutAuthors(built, new Set([STRANGER]))
  t.alike(dropped.body.authors.map((a) => a.author), [FOLLOW])
  t.alike(dropped.body.names.map((n) => n.author), [OWN, FOLLOW])
  t.alike(dropped.body.own, built.body.own)
  t.ok(s.parseScreenSnapshot(JSON.stringify(dropped), 'momentos', bind()))
  const kept = s.screenKeepOnlyAuthors(built, [STRANGER])
  t.alike(kept.body.authors.map((a) => a.author), [STRANGER])
  t.alike(kept.body.names.map((n) => n.author), [OWN, STRANGER], 'the own name stays')
})

test('wrong owner, origin or association, or a page actor, is refused', async (t) => {
  const s = await load()
  const args = await input()
  const text = JSON.stringify(s.buildScreenSnapshot('momentos', args))
  t.ok(s.parseScreenSnapshot(text, 'momentos', bind()))
  t.is(s.parseScreenSnapshot(text, 'momentos', bind({ owner: FOLLOW })), null, 'owner')
  t.is(s.parseScreenSnapshot(text, 'momentos', bind({ origin: 'https://outro.app' })), null, 'origin')
  t.is(s.parseScreenSnapshot(text, 'momentos', bind({ association: 'ab'.repeat(32) })), null, 'association')
  t.is(s.parseScreenSnapshot(text, 'momentos', bind({ acting: PAGE })), null, 'page actor reads nothing')
  t.is(s.parseScreenSnapshot(text, 'momentos', bind({ now: NOW + 15 * DAY })), null, 'older than 14 days')
  t.is(s.parseScreenSnapshot(text, 'diario', bind()), null, 'another kind')
  t.is(s.buildScreenSnapshot('momentos', { ...args, acting: PAGE }), null, 'a page actor never builds')
  t.is(s.buildScreenSnapshot('momentos', { ...args, owner: 'nope' }), null, 'bad owner')
  t.is(s.buildScreenSnapshot('momentos', { ...args, authors: null }), null, 'no authors list')
})

function memoryRaw () {
  const map = new Map()
  return {
    map,
    load: (kind) => (map.has(kind) ? map.get(kind) : null),
    save: (kind, text) => { map.set(kind, text) },
    clear: (kind) => { map.delete(kind) }
  }
}

test('store: a wipe removes momentos; a block or an unfollow rewrites it; the cap holds on save', async (t) => {
  const s = await load()
  const { cacheGeneration, wipeLocalCaches, dropAuthors, keepOnlyAuthors } = await loadCaches()
  const raw = memoryRaw()
  const store = s.createScreenSnapshotStore(raw)
  const now = Date.now()
  const fresh = (author, seq) => item(author, seq, { at: iso(now - HOUR) })
  const live = { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now }
  const snap = s.buildScreenSnapshot('momentos', {
    ...live,
    authors: [{ author: FOLLOW, items: [fresh(FOLLOW, 1)] }, { author: STRANGER, items: [fresh(STRANGER, 1)] }],
    own: [fresh(OWN, 1)],
    names: [{ author: FOLLOW, name: 'Bia', username: null, avatar: null }, { author: STRANGER, name: 'Leo', username: null, avatar: null }],
    followed: [FOLLOW, STRANGER]
  })
  t.is(store.saveScreenSnapshot('momentos', snap, cacheGeneration()), true)
  t.alike(store.loadScreenSnapshot('momentos', live), snap)
  t.is(store.loadScreenSnapshot('momentos', { ...live, acting: PAGE }), null)
  t.ok(raw.map.has('momentos'), 'a page actor removes nothing')

  dropAuthors([STRANGER])
  const afterBlock = store.loadScreenSnapshot('momentos', live)
  t.alike(afterBlock.body.authors.map((a) => a.author), [FOLLOW])
  t.alike(afterBlock.body.names.map((n) => n.author), [FOLLOW])
  keepOnlyAuthors(new Set([]))
  const afterUnfollow = store.loadScreenSnapshot('momentos', live)
  t.alike(afterUnfollow.body.authors, [])
  t.alike(afterUnfollow.body.own.map((i) => i.seq), [1], 'own moments stay')

  const big = { ...snap, body: { ...snap.body, own: [{ ...snap.body.own[0], text: 'x'.repeat(70000) }] } }
  t.is(store.saveScreenSnapshot('momentos', big, cacheGeneration()), false, 'over 64 KiB is never written')

  wipeLocalCaches()
  t.absent(raw.map.has('momentos'), 'the wipe removed it, with no screen mounted')
  raw.map.set('momentos', JSON.stringify(snap))
  store.clearScreenSnapshots()
  t.is(raw.map.size, 0)
})

test('media bounds match the live reader at parse too', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('momentos', { ...bind(), authors: [{ author: FOLLOW, items: [item(FOLLOW, 2), item(FOLLOW, 1)] }], own: [], followed: [FOLLOW] })
  const seqsWith = (media) => {
    const copy = JSON.parse(JSON.stringify(built))
    copy.body.authors[0].items[0].media = media
    return s.parseScreenSnapshot(JSON.stringify(copy), 'momentos', bind()).body.authors[0].items.map((i) => i.seq)
  }
  t.alike(seqsWith({ mime: 'image/webp', w: 16384, h: 9000, ms: 0 }), [2, 1])
  t.alike(seqsWith({ mime: 'image/webp', w: 16385, h: 9000, ms: 0 }), [1])
  t.alike(seqsWith({ mime: 'video/mp4', w: 1920, h: 1080, ms: 15000 }), [2, 1])
  t.alike(seqsWith({ mime: 'video/mp4', w: 1920, h: 1920, ms: 1000 }), [1], 'over the video pixel cap')
  t.alike(seqsWith({ mime: 'video/mp4', w: 2000, h: 10, ms: 1000 }), [1], 'over the video side cap')
})

test('an item dated more than 10 minutes ahead is dropped at build and at parse', async (t) => {
  const s = await load()
  const MIN = 60 * 1000
  const ahead = (seq, ms) => item(FOLLOW, seq, { at: iso(NOW + ms) })
  const built = s.buildScreenSnapshot('momentos', { ...bind(), authors: [{ author: FOLLOW, items: [ahead(3, 11 * MIN), ahead(2, 10 * MIN), item(FOLLOW, 1)] }], own: [item(OWN, 1, { at: iso(NOW + 11 * MIN) })], followed: [FOLLOW] })
  t.alike(built.body.authors[0].items.map((i) => i.seq), [2, 1], 'build drops the one 11 minutes ahead')
  t.alike(built.body.own, [], 'and an own one')
  const text = JSON.stringify(built)
  // The clock moved back: the item 10 minutes ahead at save is now 15 ahead.
  const back = s.parseScreenSnapshot(text, 'momentos', bind({ now: NOW - 5 * MIN }))
  t.alike(back.body.authors[0].items.map((i) => i.seq), [1], 'parse drops it once the clock is behind')
  t.alike(s.parseScreenSnapshot(text, 'momentos', bind()).body.authors[0].items.map((i) => i.seq), [2, 1])
})

test('the owner never shows among the authors: build skips it, parse drops the entry', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('momentos', { ...bind(), authors: [{ author: OWN, items: [item(OWN, 5)] }, { author: FOLLOW, items: [item(FOLLOW, 1)] }], own: [item(OWN, 1)], names: [{ author: OWN, name: 'Eu', username: null, avatar: null }], followed: [FOLLOW] })
  t.alike(built.body.authors.map((a) => a.author), [FOLLOW], 'build skips the owner')
  const copy = JSON.parse(JSON.stringify(built))
  copy.body.authors.unshift({ author: OWN, items: [item(OWN, 5)] })
  const parsed = s.parseScreenSnapshot(JSON.stringify(copy), 'momentos', bind())
  t.ok(parsed)
  t.alike(parsed.body.authors.map((a) => a.author), [FOLLOW], 'parse drops the owner entry')
  t.alike(parsed.body.own.map((i) => i.seq), [1])
  t.alike(parsed.body.names.map((n) => n.author), [OWN], 'the owner name stays')
})

test('store: a hand-built momentos with a blob key or nonce is never written', async (t) => {
  const s = await load()
  const { cacheGeneration } = await loadCaches()
  const raw = memoryRaw()
  const store = s.createScreenSnapshotStore(raw)
  const now = Date.now()
  const live = { origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now }
  const snap = s.buildScreenSnapshot('momentos', { ...live, authors: [{ author: FOLLOW, items: [item(FOLLOW, 1, { at: iso(now - HOUR) })] }], own: [], followed: [FOLLOW] })
  const withKey = JSON.parse(JSON.stringify(snap))
  withKey.body.authors[0].items[0].media.key = BLOB.key
  t.is(store.saveScreenSnapshot('momentos', withKey, cacheGeneration()), false, 'a media key is refused')
  const withNonce = JSON.parse(JSON.stringify(snap))
  withNonce.body.authors[0].items[0].media.nonce = BLOB.nonce
  t.is(store.saveScreenSnapshot('momentos', withNonce, cacheGeneration()), false, 'a media nonce is refused')
  const extra = JSON.parse(JSON.stringify(snap))
  extra.body.past = []
  t.is(store.saveScreenSnapshot('momentos', extra, cacheGeneration()), false, 'a body that does not parse is refused')
  t.absent(raw.map.has('momentos'), 'nothing was written')
  t.is(store.saveScreenSnapshot('momentos', snap, cacheGeneration()), true, 'the built snapshot is written')
  t.is(raw.map.get('momentos'), JSON.stringify(snap))
})
