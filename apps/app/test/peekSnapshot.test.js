'use strict'

// The 'espiadinha' snapshot codec (src/peekSnapshot.js) on its own and
// through src/screenSnapshot.js: strict keys, caps, no cursor, the byte
// measure of the whole stored text, the 7 days, block and follow removal,
// the binding and the page actor.
const test = require('brittle')

const loadCodec = () => import('../src/peekSnapshot.js')
const loadRules = () => import('../src/screenSnapshot.js')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)
const OTHER = 'dd'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const ME = Object.freeze({ kind: 'me' })
const PAGE = Object.freeze({ kind: 'page', key: 'ff'.repeat(32), name: 'Loja', username: 'loja' })
const META = Object.freeze({ diaries: 40, skipped: 2, incomplete: true })

const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
const avatar = { core: '56'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: '78'.repeat(32), width: 512, height: 512 }
const id = (extra = {}) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now: NOW, ...extra })
const utf8 = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v))

function item (author, seq, extra = {}) {
  return { kind: 'post', author, name: 'Leo', username: 'leo_1', seq, at: at(seq), text: 'texto ' + seq, replyTo: null, quote: null, media: null, preview: null, avatar, round: 0, ...extra }
}

function repostItem (author, seq, to, extra = {}) {
  return { kind: 'repost', author, name: null, username: null, seq, at: at(seq), to, text: null, replyTo: null, quote: null, media: null, preview: null, avatar: null, round: 1, ...extra }
}

// The screen passes both lists once block.list has answered; empty is "none".
const input = (rows, extra = {}) => ({ ...id(), rows, meta: { ...META }, blocked: [], followed: new Set(), ...extra })

test('a page round-trips with every PeekItem field and no cursor', async (t) => {
  const s = await loadRules()
  const rows = [item(STRANGER, 5, { quote: { author: OTHER, seq: 2 } }), repostItem(OTHER, 4, { author: STRANGER, seq: 1 })]
  const built = s.buildScreenSnapshot('espiadinha', input(rows, { next: { round: 0, at: at(4), author: OTHER, seq: 4 } }))
  t.ok(built)
  t.alike(Object.keys(built.body), ['rows', 'meta'], 'the cursor is never stored')
  t.alike(built.body.meta, META)
  t.alike(built.body.rows[0], rows[0], 'the row keeps the item\'s name, username, avatar and round')
  t.alike(built.body.rows[1], rows[1])
  const back = s.parseScreenSnapshot(JSON.stringify(built), 'espiadinha', id())
  t.alike(back, built)
})

test('an unknown key anywhere fails the whole parse', async (t) => {
  const s = await loadRules()
  const text = JSON.stringify(s.buildScreenSnapshot('espiadinha', input([item(STRANGER, 3), repostItem(OTHER, 2, { author: STRANGER, seq: 1 })])))
  const bad = (change) => {
    const copy = JSON.parse(text)
    change(copy.body)
    return s.parseScreenSnapshot(JSON.stringify(copy), 'espiadinha', id())
  }
  t.ok(bad(() => {}), 'unchanged it parses')
  t.is(bad((b) => { b.next = null }), null, 'a cursor in the body')
  t.is(bad((b) => { b.meta.extra = 1 }), null, 'a meta key')
  t.is(bad((b) => { delete b.meta.incomplete }), null, 'a missing meta key')
  t.is(bad((b) => { b.rows[0].poll = ['a', 'b'] }), null, 'a poll')
  t.is(bad((b) => { b.rows[0].key = 'ab'.repeat(32) }), null, 'a key')
  t.is(bad((b) => { b.rows[0].nonce = 'x' }), null, 'a nonce')
  t.is(bad((b) => { delete b.rows[0].avatar }), null, 'a missing avatar')
  t.is(bad((b) => { b.rows[0].avatar.extra = 1 }), null, 'an avatar key')
  t.is(bad((b) => { b.rows[0].round = -1 }), null, 'a negative round')
  t.is(bad((b) => { b.rows[0].round = 100001 }), null, 'a round past the rpc bound')
  t.is(bad((b) => { b.rows[1].text = 'x' }), null, 'a repost with text')
  t.is(bad((b) => { b.rows.push(b.rows[0]) }), null, 'a repeated row')
  t.is(bad((b) => { b.meta.diaries = 1.5 }), null, 'a count that is not an integer')
})

test('build skips invalid, repeated and poll rows and keeps at most 30', async (t) => {
  const s = await loadRules()
  const { PEEK_SNAPSHOT_MAX_ROWS } = await loadCodec()
  t.is(PEEK_SNAPSHOT_MAX_ROWS, 30)
  const rows = [item(STRANGER, 99, { poll: ['a', 'b'] }), item(STRANGER, 98, { author: 'nope' }), item(STRANGER, 97), item(STRANGER, 97)]
  for (let i = 1; i <= 40; i++) rows.push(item(OTHER, i))
  const built = s.buildScreenSnapshot('espiadinha', input(rows))
  t.is(built.body.rows.length, 30)
  t.alike(built.body.rows.slice(0, 2).map((r) => r.seq), [97, 1], 'the poll, the invalid row and the repeat go')
  t.is(s.buildScreenSnapshot('espiadinha', input(rows, { meta: { diaries: 1 } })), null, 'an incomplete meta stores nothing')
  t.is(s.buildScreenSnapshot('espiadinha', input('nope')), null)
  const absent = s.buildScreenSnapshot('espiadinha', input([{ ...item(STRANGER, 1), avatar: undefined }]))
  t.is(absent.body.rows[0].avatar, null, 'an item without avatar is kept with null')

  const copy = JSON.parse(JSON.stringify(built))
  copy.body.rows.push({ ...copy.body.rows[0], seq: 500 })
  t.is(s.parseScreenSnapshot(JSON.stringify(copy), 'espiadinha', id()), null, '31 rows never parse')
})

test('build stores nothing without both the block and the follow lists', async (t) => {
  const s = await loadRules()
  const c = await loadCodec()
  const rows = [item(STRANGER, 2)]
  t.ok(s.buildScreenSnapshot('espiadinha', input(rows)), 'empty lists are an explicit none')
  t.is(s.buildScreenSnapshot('espiadinha', { ...id(), rows, meta: { ...META } }), null, 'no lists')
  t.is(s.buildScreenSnapshot('espiadinha', input(rows, { blocked: undefined })), null, 'no block list')
  t.is(s.buildScreenSnapshot('espiadinha', input(rows, { followed: undefined })), null, 'no follow list')
  t.is(s.buildScreenSnapshot('espiadinha', input(rows, { blocked: null })), null, 'a null block list')
  t.is(s.buildScreenSnapshot('espiadinha', input(rows, { followed: 'bb' })), null, 'a string is not a list')
  t.is(c.build({ rows, meta: META }, { fits: () => true }), null, 'the codec on its own too')
})

test('build leaves out rows naming a blocked author and rows of a followed one', async (t) => {
  const s = await loadRules()
  const rows = [
    item(STRANGER, 5),
    item(OTHER, 4, { quote: { author: FOLLOW, seq: 1 } }),
    repostItem(OTHER, 3, { author: STRANGER, seq: 1 }),
    item(FOLLOW, 2),
    item(OTHER, 1, { replyTo: { author: STRANGER, seq: 9 } })
  ]
  const built = s.buildScreenSnapshot('espiadinha', input(rows, { blocked: [STRANGER], followed: new Set([FOLLOW]) }))
  t.alike(built.body.rows.map((r) => r.seq), [4], 'blocked as poster, original or parent; followed as poster')
})

// Rows whose text is control characters: each UTF-16 unit is 6 bytes of
// JSON, so a few rows reach the byte cap.
const heavy = (seq, units) => item(STRANGER, seq, { avatar: null, text: '\u0001'.repeat(units) })

// One more row whose text brings the body exactly to `target` bytes.
function padRow (rows, seq, target) {
  const empty = utf8({ rows: rows.concat([heavy(seq, 0)]), meta: META })
  const gap = target - empty
  if (gap < 0 || gap > 6 * 2000) return null
  return item(STRANGER, seq, { avatar: null, text: '\u0001'.repeat(Math.floor(gap / 6)) + 'a'.repeat(gap % 6) })
}

test('a body that fits alone but not with its envelope is cut', async (t) => {
  const s = await loadRules()
  const { PEEK_SNAPSHOT_MAX_BYTES } = await loadCodec()
  t.is(PEEK_SNAPSHOT_MAX_BYTES, 196608)
  const rows = []
  for (let i = 100; rows.length < 15; i--) rows.push(heavy(i, 2000))
  t.ok(utf8({ rows, meta: META }) < PEEK_SNAPSHOT_MAX_BYTES - 6 * 2000)
  while (utf8({ rows: rows.concat([heavy(1, 2000)]), meta: META }) <= PEEK_SNAPSHOT_MAX_BYTES - 10) rows.push(heavy(rows.length + 200, 2000))
  const last = padRow(rows, 50, PEEK_SNAPSHOT_MAX_BYTES - 10)
  t.ok(last, 'the pad row fits the text cap')
  const all = rows.concat([last])
  t.is(utf8({ rows: all, meta: META }), PEEK_SNAPSHOT_MAX_BYTES - 10, 'the body alone fits')
  const built = s.buildScreenSnapshot('espiadinha', input(all))
  t.is(built.body.rows.length, rows.length, 'the last row is cut because the envelope does not fit')
  t.ok(utf8(built) <= PEEK_SNAPSHOT_MAX_BYTES)
  t.ok(s.parseScreenSnapshot(JSON.stringify(built), 'espiadinha', id()))
})

test('build, parse and save agree on the byte measure of the whole text', async (t) => {
  const s = await loadRules()
  const { PEEK_SNAPSHOT_MAX_BYTES } = await loadCodec()
  const { cacheGeneration } = await import('../src/localCaches.js')
  const base = s.buildScreenSnapshot('espiadinha', input([heavy(900, 2000)]))
  const exact = (target) => {
    const rows = base.body.rows.slice()
    const env = (r) => utf8({ ...base, body: { rows: r, meta: base.body.meta } })
    // Rows of 1500 units: the gap left for the pad row stays under one row's
    // text cap, and the page under 30 rows.
    while (env(rows.concat([heavy(rows.length + 1, 1500)])) <= target - 400) rows.push(heavy(rows.length + 1, 1500))
    const bodyTarget = target - (env([]) - utf8({ rows: [], meta: base.body.meta }))
    const last = padRow(rows, 800, bodyTarget)
    return { ...base, body: { rows: rows.concat([last]), meta: base.body.meta } }
  }
  const at = exact(PEEK_SNAPSHOT_MAX_BYTES)
  const over = exact(PEEK_SNAPSHOT_MAX_BYTES + 1)
  t.is(utf8(at), PEEK_SNAPSHOT_MAX_BYTES)
  t.is(utf8(over), PEEK_SNAPSHOT_MAX_BYTES + 1)
  t.ok(s.parseScreenSnapshot(JSON.stringify(at), 'espiadinha', id()), 'at the cap it parses')
  t.is(s.parseScreenSnapshot(JSON.stringify(over), 'espiadinha', id()), null, 'one byte over it does not')

  const saved = []
  const store = s.createScreenSnapshotStore({ load: () => null, save: (kind, text) => saved.push(text), clear: () => {} })
  t.is(store.saveScreenSnapshot('espiadinha', at, cacheGeneration()), true, 'at the cap it saves')
  t.is(store.saveScreenSnapshot('espiadinha', over, cacheGeneration()), false, 'one byte over it does not')
  t.is(saved.length, 1)
  t.is(utf8(saved[0]), PEEK_SNAPSHOT_MAX_BYTES)

  const rebuilt = s.buildScreenSnapshot('espiadinha', input(over.body.rows))
  t.is(rebuilt.body.rows.length, over.body.rows.length - 1, 'build cuts the same page')
})

test('save writes only the canonical parse', async (t) => {
  const s = await loadRules()
  const { cacheGeneration } = await import('../src/localCaches.js')
  const store = s.createScreenSnapshotStore({ load: () => null, save: () => {}, clear: () => {} })
  const built = s.buildScreenSnapshot('espiadinha', input([item(STRANGER, 2)]))
  t.is(store.saveScreenSnapshot('espiadinha', { ...built, body: { ...built.body, next: { round: 0 } } }, cacheGeneration()), false, 'a cursor')
  t.is(store.saveScreenSnapshot('espiadinha', { ...built, body: { ...built.body, rows: [{ ...built.body.rows[0], key: 'x' }] } }, cacheGeneration()), false, 'a key in a row')
  t.is(store.saveScreenSnapshot('espiadinha', built, cacheGeneration() - 1), false, 'a stale generation')
  const { avatar: a, ...rest } = built.body.rows[0]
  t.is(store.saveScreenSnapshot('espiadinha', { ...built, body: { ...built.body, rows: [{ avatar: a, ...rest }] } }, cacheGeneration()), false, 'a row in another key order')
  t.is(store.saveScreenSnapshot('espiadinha', built, cacheGeneration()), true)
})

test('the snapshot lasts 7 days, never the 14 of the other kinds', async (t) => {
  const s = await loadRules()
  const { PEEK_SNAPSHOT_MAX_AGE_MS } = await loadCodec()
  t.is(PEEK_SNAPSHOT_MAX_AGE_MS, 7 * DAY)
  t.ok(PEEK_SNAPSHOT_MAX_AGE_MS <= s.SCREEN_SNAPSHOT_MAX_AGE_MS)
  const text = JSON.stringify(s.buildScreenSnapshot('espiadinha', input([item(STRANGER, 2)])))
  t.ok(s.parseScreenSnapshot(text, 'espiadinha', id({ now: NOW + 7 * DAY })))
  t.is(s.parseScreenSnapshot(text, 'espiadinha', id({ now: NOW + 7 * DAY + 1 })), null, 'past 7 days')
  t.is(s.parseScreenSnapshot(text, 'espiadinha', id({ now: NOW - 2 * DAY })), null, 'from the future')
})

test('a block removes every row naming the author', async (t) => {
  const s = await loadRules()
  const rows = [
    item(STRANGER, 6),
    repostItem(OTHER, 5, { author: STRANGER, seq: 1 }),
    item(OTHER, 4, { quote: { author: STRANGER, seq: 2 } }),
    item(OTHER, 3, { replyTo: { author: STRANGER, seq: 3 } }),
    item(OTHER, 2)
  ]
  const built = s.buildScreenSnapshot('espiadinha', input(rows))
  const dropped = s.screenWithoutAuthors(built, [STRANGER])
  t.alike(dropped.body.rows.map((r) => r.seq), [2])
  t.alike(dropped.body.meta, META)
  t.ok(s.parseScreenSnapshot(JSON.stringify(dropped), 'espiadinha', id()))
  t.alike(s.screenWithoutAuthors(built, [FOLLOW]), built, 'an unrelated block changes nothing')
})

test('a follow removes the followed author\'s rows; the owner and the rest stay', async (t) => {
  const s = await loadRules()
  const rows = [item(STRANGER, 4), item(OWN, 3), repostItem(OTHER, 2, { author: STRANGER, seq: 1 }), item(OTHER, 1)]
  const built = s.buildScreenSnapshot('espiadinha', input(rows))
  const kept = s.screenKeepOnlyAuthors(built, new Set([OWN, STRANGER]))
  t.alike(kept.body.rows.map((r) => r.author + ':' + r.seq), [OWN + ':3', OTHER + ':2', OTHER + ':1'], 'inverted: the followed poster goes, a repost of them by a stranger stays')
  t.alike(s.screenKeepOnlyAuthors(built, new Set([OWN])), built, 'following nobody here changes nothing')
})

test('another binding and a page actor are refused', async (t) => {
  const s = await loadRules()
  const built = s.buildScreenSnapshot('espiadinha', input([item(STRANGER, 2)]))
  const text = JSON.stringify(built)
  t.is(s.parseScreenSnapshot(text, 'espiadinha', id({ origin: 'https://outro.app' })), null, 'origin')
  t.is(s.parseScreenSnapshot(text, 'espiadinha', id({ association: 'ab'.repeat(32) })), null, 'association')
  t.is(s.parseScreenSnapshot(text, 'espiadinha', id({ owner: FOLLOW })), null, 'owner')
  t.is(s.parseScreenSnapshot(text, 'espiadinha', id({ acting: PAGE })), null, 'page actor parse')
  t.is(s.buildScreenSnapshot('espiadinha', input([item(STRANGER, 2)], { acting: PAGE })), null, 'page actor build')
  t.is(s.buildScreenSnapshot('espiadinha', input([item(STRANGER, 2)], { acting: undefined })), null, 'no actor')
  t.is(s.parseScreenSnapshot(text, 'momentos', id()), null, 'another kind')
})

test('the codec on its own: fits decides the cut, null when nothing fits', async (t) => {
  const c = await loadCodec()
  t.is(c.peekCodec.KIND, 'espiadinha')
  t.ok(Object.isFrozen(c.peekCodec))
  const rows = [item(STRANGER, 3), item(STRANGER, 2), item(STRANGER, 1)]
  const two = c.build({ rows, meta: META, blocked: [], followed: [] }, { fits: (b) => b.rows.length <= 2 })
  t.alike(two.rows.map((r) => r.seq), [3, 2], 'rows are cut from the end')
  t.is(c.build({ rows, meta: META, blocked: [], followed: [] }, { fits: () => false }), null)
  t.is(c.build({ rows, meta: META, blocked: [], followed: [] }, {}), null, 'no fits, no body')
  t.is(c.parse({ rows: [], meta: META, next: null }), null)
  t.alike(c.parse({ rows: [], meta: { ...META } }), { rows: [], meta: META })
})

test('a row keeps a valid thumbs list; a bad one is left out by build and fails the parse', async (t) => {
  const s = await loadRules()
  const photo = { core: '12'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: '34'.repeat(32), width: 1200, height: 900 }
  const thumb = { ...photo, start: 2, sha256: '9a'.repeat(32), width: 640, height: 480 }
  const rows = [item(STRANGER, 5, { media: [photo], thumbs: [thumb] }), item(OTHER, 4, { media: [photo] })]
  const built = s.buildScreenSnapshot('espiadinha', input(rows))
  t.alike(built.body.rows[0].thumbs, [thumb], 'kept')
  t.absent('thumbs' in built.body.rows[1], 'written only when present')
  t.alike(s.parseScreenSnapshot(JSON.stringify(built), 'espiadinha', id()), built, 'round trip')
  const bad = [null, [], [null], [thumb, null], [{ ...thumb, bytes: 65537, blocks: 3 }], [{ ...thumb, mime: 'image/webp' }], [{ ...thumb, extra: 1 }]]
  for (const thumbs of bad) {
    const again = s.buildScreenSnapshot('espiadinha', input([item(STRANGER, 5, { media: [photo], thumbs })]))
    t.is(again.body.rows.length, 1, 'build keeps the row: ' + JSON.stringify(thumbs))
    t.absent('thumbs' in again.body.rows[0], 'without the bad thumbs')
    const copy = JSON.parse(JSON.stringify(built))
    copy.body.rows[0].thumbs = thumbs
    t.is(s.parseScreenSnapshot(JSON.stringify(copy), 'espiadinha', id()), null, 'parse refuses ' + JSON.stringify(thumbs))
  }
})

test('a real repost row never carries thumbs', async (t) => {
  const s = await loadRules()
  const photo = { core: '12'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: '34'.repeat(32), width: 1200, height: 900 }
  const thumb = { ...photo, start: 2, sha256: '9a'.repeat(32), width: 640, height: 480 }
  const rows = [item(STRANGER, 5), repostItem(OTHER, 4, { author: STRANGER, seq: 1 }, { thumbs: [thumb] })]
  const built = s.buildScreenSnapshot('espiadinha', input(rows))
  t.is(built.body.rows[1].kind, 'repost', 'the repost row is kept')
  t.absent('thumbs' in built.body.rows[1], 'without the thumbs it was handed')
  t.alike(s.parseScreenSnapshot(JSON.stringify(built), 'espiadinha', id()), built, 'positive control: the repost row parses')
  const copy = JSON.parse(JSON.stringify(built))
  copy.body.rows[1].thumbs = [thumb]
  t.is(s.parseScreenSnapshot(JSON.stringify(copy), 'espiadinha', id()), null, 'the same row with thumbs is refused')
})

test('a row keeps a valid alt list; a bad one is left out by build and fails the parse', async (t) => {
  const s = await loadRules()
  const photo = { core: '12'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: '34'.repeat(32), width: 1200, height: 900 }
  const rows = [item(STRANGER, 5, { media: [photo], alt: ['um gato'] }), item(OTHER, 4, { media: [photo] })]
  const built = s.buildScreenSnapshot('espiadinha', input(rows))
  t.alike(built.body.rows[0].alt, ['um gato'], 'kept')
  t.absent('alt' in built.body.rows[1], 'written only when present, so an old snapshot still parses')
  t.alike(s.parseScreenSnapshot(JSON.stringify(built), 'espiadinha', id()), built, 'round trip')
  for (const alt of [null, [], [null, 'x'], [''], [5], 'x']) {
    const again = s.buildScreenSnapshot('espiadinha', input([item(STRANGER, 5, { media: [photo], alt })]))
    t.is(again.body.rows.length, 1, 'build keeps the row: ' + JSON.stringify(alt))
    t.absent('alt' in again.body.rows[0], 'without the bad alt')
    const copy = JSON.parse(JSON.stringify(built))
    copy.body.rows[0].alt = alt
    t.is(s.parseScreenSnapshot(JSON.stringify(copy), 'espiadinha', id()), null, 'parse refuses ' + JSON.stringify(alt))
  }
})

// A resolved original as useSocial holds it: a post item, no round.
function orig (author, seq, extra = {}) {
  const { round: _round, ...rest } = item(author, seq, { name: 'Ana', username: 'ana_1', text: 'original ' + seq })
  return { ...rest, ...extra }
}
const ref = (author, seq) => author + ':' + seq
const BLOCKED = '12'.repeat(32)

test('a page round-trips with the originals its rows draw, two levels deep', async (t) => {
  const s = await loadRules()
  const rows = [
    repostItem(OTHER, 9, { author: STRANGER, seq: 1 }),
    item(STRANGER, 8, { quote: { author: OTHER, seq: 2 } }),
    item(OTHER, 7, { replyTo: { author: STRANGER, seq: 3 } })
  ]
  const originals = {
    [ref(STRANGER, 1)]: orig(STRANGER, 1, { round: 2 }),
    [ref(OTHER, 2)]: orig(OTHER, 2, { replyTo: { author: FOLLOW, seq: 4 }, avatar: null }),
    [ref(STRANGER, 3)]: orig(STRANGER, 3),
    [ref(FOLLOW, 4)]: orig(FOLLOW, 4)
  }
  const built = s.buildScreenSnapshot('espiadinha', input(rows, { originals }))
  t.ok(built)
  t.alike(Object.keys(built.body), ['rows', 'meta', 'originals'])
  t.alike(Object.keys(built.body.originals).sort(), [ref(STRANGER, 1), ref(OTHER, 2), ref(STRANGER, 3), ref(FOLLOW, 4)].sort(), 'the second-level parent stays')
  t.alike(built.body.originals[ref(STRANGER, 1)], orig(STRANGER, 1), 'a live round is not stored on an original')
  t.is(built.body.originals[ref(OTHER, 2)].avatar, null)
  t.alike(built.body.originals[ref(STRANGER, 3)].avatar, avatar, 'the avatar is kept')
  t.alike(s.parseScreenSnapshot(JSON.stringify(built), 'espiadinha', id()), built, 'round trip')
  const plain = s.buildScreenSnapshot('espiadinha', input(rows))
  t.alike(Object.keys(plain.body), ['rows', 'meta'], 'no originals, no key: the old shape')
})

test('an old two-key body parses; any other key or a bad original fails the whole parse', async (t) => {
  const c = await loadCodec()
  const rows = [item(STRANGER, 8, { quote: { author: OTHER, seq: 2 } })]
  const old = { rows, meta: { ...META } }
  t.alike(c.parse(old), old, 'no version bump: the two-key body still parses')
  const good = { rows, meta: { ...META }, originals: { [ref(OTHER, 2)]: orig(OTHER, 2) } }
  t.alike(c.parse(good), good)
  const bad = (change) => {
    const copy = JSON.parse(JSON.stringify(good))
    change(copy)
    return c.parse(copy)
  }
  t.is(bad((b) => { b.extra = 1 }), null, 'an unknown body key')
  t.is(bad((b) => { b.originals[ref(OTHER, 2)].round = 0 }), null, 'an unknown original key')
  t.is(bad((b) => { delete b.originals[ref(OTHER, 2)].avatar }), null, 'a missing avatar')
  t.is(bad((b) => { b.originals[ref(OTHER, 2)].seq = 3 }), null, 'stored under another ref')
  t.is(bad((b) => { b.originals[ref(OTHER, 2)] = repostItem(OTHER, 2, { author: STRANGER, seq: 1 }) }), null, 'a repost as an original')
  t.is(bad((b) => { b.originals[ref(OTHER, 2)] = null }), null, 'a null original')
  t.is(bad((b) => { b.originals[ref(OTHER, 5)] = orig(OTHER, 5) }), null, 'an original no row needs')
  t.is(bad((b) => { b.originals = {} }), null, 'an empty originals')
  t.is(bad((b) => { b.originals = [] }), null, 'originals that are not an object')
  t.is(bad((b) => { b.originals[ref(OTHER, 2)].poll = ['a', 'b'] }), null, 'a poll')
})

test('build drops orphan, invalid, blocked and missing originals; the rows stay', async (t) => {
  const c = await loadCodec()
  const rows = [
    repostItem(OTHER, 9, { author: STRANGER, seq: 1 }),
    item(STRANGER, 8, { quote: { author: OTHER, seq: 2 } }),
    item(OTHER, 7, { replyTo: { author: STRANGER, seq: 3 } }),
    item(STRANGER, 6, { quote: { author: OTHER, seq: 5 } })
  ]
  const originals = {
    [ref(STRANGER, 1)]: null,
    [ref(OTHER, 2)]: orig(OTHER, 2, { quote: { author: BLOCKED, seq: 4 } }),
    [ref(BLOCKED, 4)]: orig(BLOCKED, 4),
    [ref(STRANGER, 3)]: orig(STRANGER, 3, { text: 5 }),
    [ref(OTHER, 5)]: orig(OTHER, 6),
    [ref(OTHER, 99)]: orig(OTHER, 99)
  }
  const body = c.build({ rows, meta: META, blocked: [BLOCKED], followed: [], originals }, { fits: () => true })
  t.is(body.rows.length, 4, 'every row stays')
  t.alike(Object.keys(body.originals), [ref(OTHER, 2)], 'null, blocked, invalid, misfiled and orphan originals are left out')
  t.ok(c.parse(JSON.parse(JSON.stringify(body))))
  const none = c.build({ rows, meta: META, blocked: [], followed: [], originals: { [ref(OTHER, 99)]: orig(OTHER, 99) } }, { fits: () => true })
  t.alike(Object.keys(none), ['rows', 'meta'], 'only orphans: no originals key')
})

test('the byte cut drops the last row together with the originals only it needs', async (t) => {
  const c = await loadCodec()
  const rows = [
    item(STRANGER, 9, { quote: { author: OTHER, seq: 1 } }),
    item(STRANGER, 8, { quote: { author: OTHER, seq: 2 } }),
    repostItem(FOLLOW, 7, { author: OTHER, seq: 1 })
  ]
  const big = (seq) => orig(OTHER, seq, { text: 'x'.repeat(1000) })
  const originals = { [ref(OTHER, 1)]: big(1), [ref(OTHER, 2)]: big(2) }
  const all = c.build({ rows, meta: META, blocked: [], followed: [], originals }, { fits: () => true })
  const limit = utf8(all) - 1
  const cut = c.build({ rows, meta: META, blocked: [], followed: [], originals }, { fits: (b) => utf8(b) <= limit })
  t.alike(cut.rows.map((r) => r.seq), [9, 8], 'the last row is cut')
  t.alike(Object.keys(cut.originals).sort(), [ref(OTHER, 1), ref(OTHER, 2)].sort(), 'a shared original stays')
  const twoLimit = utf8({ rows: rows.slice(0, 1), meta: META, originals: { [ref(OTHER, 1)]: big(1) } })
  const one = c.build({ rows, meta: META, blocked: [], followed: [], originals }, { fits: (b) => utf8(b) <= twoLimit })
  t.alike(one.rows.map((r) => r.seq), [9])
  t.alike(Object.keys(one.originals), [ref(OTHER, 1)], 'the cut row\'s original goes with it')
})

test('a block drops originals by that author and orphans; a follow drops orphans', async (t) => {
  const s = await loadRules()
  const rows = [
    item(STRANGER, 9, { quote: { author: OTHER, seq: 2 } }),
    repostItem(OTHER, 8, { author: STRANGER, seq: 1 })
  ]
  const originals = {
    [ref(OTHER, 2)]: orig(OTHER, 2, { replyTo: { author: FOLLOW, seq: 7 } }),
    [ref(FOLLOW, 7)]: orig(FOLLOW, 7),
    [ref(STRANGER, 1)]: orig(STRANGER, 1)
  }
  const built = s.buildScreenSnapshot('espiadinha', input(rows, { originals }))
  t.is(Object.keys(built.body.originals).length, 3)
  const noFollow = s.screenWithoutAuthors(built, [FOLLOW])
  t.is(noFollow.body.rows.length, 2, 'no row names the blocked author at first level')
  t.alike(Object.keys(noFollow.body.originals).sort(), [ref(OTHER, 2), ref(STRANGER, 1)].sort(), 'the blocked author\'s original goes')
  t.ok(s.parseScreenSnapshot(JSON.stringify(noFollow), 'espiadinha', id()))
  const noStranger = s.screenWithoutAuthors(built, [STRANGER])
  t.alike(noStranger.body.rows, [])
  t.alike(Object.keys(noStranger.body), ['rows', 'meta'], 'orphans go with their rows')
  t.ok(s.parseScreenSnapshot(JSON.stringify(noStranger), 'espiadinha', id()))
  const followed = s.screenKeepOnlyAuthors(built, new Set([OWN, STRANGER]))
  t.alike(followed.body.rows.map((r) => r.seq), [8])
  t.alike(Object.keys(followed.body.originals), [ref(STRANGER, 1)], 'the followed poster\'s originals go; the one a stranger reposts stays')
  t.ok(s.parseScreenSnapshot(JSON.stringify(followed), 'espiadinha', id()))
})

test('peekSeedOf gives useSocial the stored originals as ref pairs', async (t) => {
  const c = await loadCodec()
  const rows = [item(STRANGER, 9, { quote: { author: OTHER, seq: 2 } })]
  const body = c.parse({ rows, meta: { ...META }, originals: { [ref(OTHER, 2)]: orig(OTHER, 2) } })
  const seed = c.peekSeedOf(body)
  t.alike([...seed.originals], [[ref(OTHER, 2), orig(OTHER, 2)]])
  t.ok(seed.counts instanceof Map)
  t.is(seed.counts.size, 0)
  t.alike([...seed.liked], [])
  t.alike([...seed.reposted], [])
  t.alike([...c.peekSeedOf({ rows, meta: META }).originals], [], 'an old body seeds nothing')
  t.is(c.peekSeedOf(null), null)
})

test('an own deletion drops the own originals from the stored copy; the rows stay', async (t) => {
  const s = await loadRules()
  const { dropOwnOriginals } = await loadCodec()
  const caches = await import('../src/localCaches.js')
  const texts = new Map()
  const raw = { load: (k) => (texts.has(k) ? texts.get(k) : null), save: (k, v) => texts.set(k, v), clear: (k) => texts.delete(k) }
  const store = s.createScreenSnapshotStore(raw)
  const api = { loadText: raw.load, load: store.loadScreenSnapshot, save: store.saveScreenSnapshot, clear: store.clearScreenSnapshot }
  const rows = [repostItem(STRANGER, 9, { author: OWN, seq: 4 }), item(STRANGER, 8, { quote: { author: OTHER, seq: 2 } })]
  const originals = { [ref(OWN, 4)]: orig(OWN, 4), [ref(OTHER, 2)]: orig(OTHER, 2) }
  const now = Date.now()
  const built = s.buildScreenSnapshot('espiadinha', input(rows, { originals, now }))
  t.alike(Object.keys(built.body.originals).sort(), [ref(OWN, 4), ref(OTHER, 2)].sort(), 'an own original is stored')
  t.ok(store.saveScreenSnapshot('espiadinha', built, caches.cacheGeneration()))
  dropOwnOriginals(api, caches.cacheGeneration())
  const after = store.loadScreenSnapshot('espiadinha', id({ now }))
  t.ok(after, 'still stored')
  t.alike(after.body.rows, built.body.rows, 'every row stays')
  t.alike(Object.keys(after.body.originals), [ref(OTHER, 2)], 'only the own original goes')
  t.is(after.savedAt, built.savedAt, 'its age is kept')
  const text = raw.load('espiadinha')
  dropOwnOriginals(api, caches.cacheGeneration())
  t.is(raw.load('espiadinha'), text, 'nothing own left: not written again')
  const onlyOwn = s.buildScreenSnapshot('espiadinha', input([rows[0]], { originals, now }))
  t.ok(store.saveScreenSnapshot('espiadinha', onlyOwn, caches.cacheGeneration()))
  dropOwnOriginals(api, caches.cacheGeneration())
  const bare = store.loadScreenSnapshot('espiadinha', id({ now }))
  t.alike(Object.keys(bare.body), ['rows', 'meta'], 'no original left: the two-key body')
  t.alike(bare.body.rows, onlyOwn.body.rows)
})

test('the own-originals purge fails closed: a copy it cannot parse or write goes', async (t) => {
  const s = await loadRules()
  const { dropOwnOriginals } = await loadCodec()
  const caches = await import('../src/localCaches.js')
  const texts = new Map()
  const raw = { load: (k) => (texts.has(k) ? texts.get(k) : null), save: (k, v) => texts.set(k, v), clear: (k) => texts.delete(k) }
  const store = s.createScreenSnapshotStore(raw)
  const api = { loadText: raw.load, load: store.loadScreenSnapshot, save: store.saveScreenSnapshot, clear: store.clearScreenSnapshot }
  texts.set('espiadinha', '{not json')
  dropOwnOriginals(api, caches.cacheGeneration())
  t.is(raw.load('espiadinha'), null, 'a text that does not parse goes')
  texts.set('espiadinha', JSON.stringify({ v: 1, kind: 'espiadinha', origin: ORIGIN, association: ASSOC, owner: OWN, savedAt: Date.now(), body: { rows: [], meta: { ...META }, extra: 1 } }))
  dropOwnOriginals(api, caches.cacheGeneration())
  t.is(raw.load('espiadinha'), null, 'a body the strict parse refuses goes')
  const rows = [repostItem(STRANGER, 9, { author: OWN, seq: 4 })]
  const built = s.buildScreenSnapshot('espiadinha', input(rows, { originals: { [ref(OWN, 4)]: orig(OWN, 4) }, now: Date.now() }))
  t.ok(store.saveScreenSnapshot('espiadinha', built, caches.cacheGeneration()))
  dropOwnOriginals(api, caches.cacheGeneration() - 1)
  t.is(raw.load('espiadinha'), null, 'a refused write (a stale generation) clears the copy')
  t.is(dropOwnOriginals(api, caches.cacheGeneration()), undefined, 'no copy: nothing to do')
  t.ok(store.saveScreenSnapshot('espiadinha', built, caches.cacheGeneration()))
  const failing = s.createScreenSnapshotStore({ load: raw.load, save: () => {}, clear: raw.clear })
  dropOwnOriginals({ loadText: raw.load, load: failing.loadScreenSnapshot, save: failing.saveScreenSnapshot, clear: failing.clearScreenSnapshot }, caches.cacheGeneration())
  t.is(raw.load('espiadinha'), null, 'a write the raw store swallowed (save still true) clears the copy')
})
