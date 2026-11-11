'use strict'

// A Rua's snapshot rules (src/feedSnapshot.js): what is kept (own and
// followed authors only), the byte cap, the strict parse and the filters.
const test = require('brittle')

const { FEED_LIMIT_DEFAULT } = require('@varanda/rpc')
const load = () => import('../src/feedSnapshot.js')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)
const BLOCKED = 'dd'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000

const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
const photo = { core: '12'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: '34'.repeat(32), width: 100, height: 100 }
const avatar = { core: '56'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: '78'.repeat(32), width: 512, height: 512 }

function post (author, seq, extra = {}) {
  return { kind: 'post', author, name: null, username: null, seq, at: at(seq), text: 'texto ' + seq, replyTo: null, quote: null, media: null, preview: null, ...extra }
}

function repost (author, seq, to) {
  return { kind: 'repost', author, name: null, username: null, seq, at: at(seq), to, text: null, replyTo: null, quote: null, media: null, preview: null }
}

const counts = (n) => ({ replies: n, likes: n, reposts: 0, quotes: 0 })

// Newest first, as A Rua holds them.
function fixture () {
  const items = [
    post(OWN, 50, { quote: { author: STRANGER, seq: 3 } }),
    post(FOLLOW, 49, { replyTo: { author: STRANGER, seq: 4 } }),
    repost(FOLLOW, 48, { author: STRANGER, seq: 7 }),
    repost(FOLLOW, 47, { author: OWN, seq: 2 }),
    post(BLOCKED, 46),
    repost(FOLLOW, 45, { author: BLOCKED, seq: 9 }),
    post(FOLLOW, 44, { quote: { author: FOLLOW, seq: 1 }, media: [photo] }),
    post(OWN, 43, { replyTo: { author: OWN, seq: 1 } })
  ]
  const originals = new Map([
    [STRANGER + ':3', post(STRANGER, 3)],
    [STRANGER + ':4', post(STRANGER, 4)],
    [STRANGER + ':7', post(STRANGER, 7)],
    // A followed original that quotes a stranger: the quote stays out.
    [OWN + ':2', { ...post(OWN, 2, { quote: { author: STRANGER, seq: 1 } }), avatar: null }],
    [STRANGER + ':1', post(STRANGER, 1)],
    [FOLLOW + ':1', { ...post(FOLLOW, 1), name: 'Bia', avatar }],
    [OWN + ':1', post(OWN, 1)],
    [BLOCKED + ':9', post(BLOCKED, 9)],
    [FOLLOW + ':99', null],
    // Under the wrong ref: never stored.
    [FOLLOW + ':5', post(FOLLOW, 6)]
  ])
  const profiles = new Map([
    [OWN, { name: 'Eu', username: 'eu_mesmo', bio: 'bio', avatar }],
    [FOLLOW, { name: 'Bia', username: 'bia', bio: '', avatar: undefined }],
    [STRANGER, { name: 'Estranho', username: 'estranho', bio: '', avatar: null }],
    [BLOCKED, { name: 'Bloqueado', username: null, bio: '', avatar: null }]
  ])
  const shown = items.map((i) => i.kind === 'repost' ? i.to.author + ':' + i.to.seq : i.author + ':' + i.seq)
  const countMap = new Map(shown.map((r, n) => [r, counts(n)]))
  countMap.set(FOLLOW + ':777', counts(9))
  return {
    origin: ORIGIN,
    association: ASSOC,
    owner: OWN,
    items,
    cursor: { at: items[items.length - 1].at, author: OWN, seq: 43 },
    profileOf: (k) => profiles.get(k),
    counts: countMap,
    liked: new Set([OWN + ':50', STRANGER + ':7', FOLLOW + ':777']),
    reposted: new Set([FOLLOW + ':49']),
    originals,
    isKnown: (a) => a === FOLLOW,
    blocked: new Set([BLOCKED]),
    now: NOW
  }
}

const ctx = { origin: ORIGIN, association: ASSOC, owner: OWN, now: NOW }

test('build keeps own and followed data only, and round trips', async (t) => {
  const { buildSnapshot, parseSnapshot, SNAPSHOT_VERSION } = await load()
  const s = buildSnapshot(fixture())
  t.ok(s)
  t.is(s.v, SNAPSHOT_VERSION)
  t.is(s.savedAt, NOW)
  t.alike(s.items.map((i) => i.author + ':' + i.seq), [OWN + ':50', FOLLOW + ':49', FOLLOW + ':48', FOLLOW + ':47', FOLLOW + ':44', OWN + ':43'], 'blocked author and the repost of a blocked post left out')
  t.alike(s.cursor, { at: at(43), author: OWN, seq: 43 }, 'cursor of the oldest kept row')
  t.alike(Object.keys(s.originals).sort(), [FOLLOW + ':1', OWN + ':1', OWN + ':2'].sort(), 'no stranger original, quote or reply parent; nothing under a wrong ref')
  t.alike(s.originals[FOLLOW + ':1'].avatar, avatar, 'an original keeps its avatar')
  t.absent(STRANGER + ':1' in s.originals, 'the quote of a followed original by a stranger is left out')
  t.alike(Object.keys(s.names).sort(), [OWN, FOLLOW].sort(), 'no stranger or blocked name')
  t.alike(s.names[OWN], { name: 'Eu', username: 'eu_mesmo', avatar }, 'no bio')
  t.alike(s.names[FOLLOW], { name: 'Bia', username: 'bia' }, 'unknown avatar stays unknown')
  t.absent(FOLLOW + ':777' in s.counts, 'counts of rows not shown left out')
  t.alike(Object.keys(s.counts).length, 6)
  t.ok(STRANGER + ':7' in s.counts, 'a repost row counts under its original')
  t.alike(s.liked.sort(), [OWN + ':50', STRANGER + ':7'].sort())
  t.alike(s.reposted, [FOLLOW + ':49'])
  t.alike(s.items[4].media, [photo])
  t.not(s.items[4].media[0], photo, 'a copy, never the screen object')

  const parsed = parseSnapshot(JSON.stringify(s), ctx)
  t.alike(parsed, s, 'round trip')
  t.alike(parseSnapshot(JSON.stringify(s), { origin: ORIGIN, association: ASSOC, now: NOW }), s, 'owner omitted is not checked')
})

test('build refuses a bad identity or nothing to show', async (t) => {
  const { buildSnapshot } = await load()
  t.is(buildSnapshot({ ...fixture(), owner: 'AA'.repeat(32) }), null)
  t.is(buildSnapshot({ ...fixture(), association: 'x' }), null)
  t.is(buildSnapshot({ ...fixture(), origin: '' }), null)
  t.is(buildSnapshot({ ...fixture(), items: [post(BLOCKED, 1)] }), null)
  t.is(buildSnapshot(), null)
})

test('build stops at a malformed row, keeping a contiguous top', async (t) => {
  const { buildSnapshot } = await load()
  const f = fixture()
  f.items = [f.items[0], { kind: 'post', author: FOLLOW }, f.items[1]]
  const s = buildSnapshot(f)
  t.alike(s.items.map((i) => i.seq), [50])
  t.alike(s.cursor, { at: at(50), author: OWN, seq: 50 })
})

test('build keeps only the first FEED_LIMIT_DEFAULT rows', async (t) => {
  const { buildSnapshot } = await load()
  const items = Array.from({ length: 40 }, (_, i) => post(FOLLOW, 100 - i))
  const s = buildSnapshot({ ...fixture(), items, cursor: { at: at(61), author: FOLLOW, seq: 61 } })
  t.is(s.items.length, FEED_LIMIT_DEFAULT)
  const last = 101 - FEED_LIMIT_DEFAULT
  t.alike(s.cursor, { at: at(last), author: FOLLOW, seq: last }, 'the cursor moves to the last kept row')
})

test('over the cap, rows go from the end with their dependents', async (t) => {
  const { buildSnapshot, parseSnapshot, SNAPSHOT_MAX_BYTES } = await load()
  // A lone surrogate is 6 bytes in JSON: 2000 of them is 12 KB per post.
  const big = '\ud800'.repeat(2000)
  const items = []
  const originals = new Map()
  const countMap = new Map()
  for (let i = 0; i < FEED_LIMIT_DEFAULT; i++) {
    const seq = 1000 - i
    items.push(post(FOLLOW, seq, { text: big, quote: { author: FOLLOW, seq: i + 1 } }))
    originals.set(FOLLOW + ':' + (i + 1), post(FOLLOW, i + 1, { text: big }))
    countMap.set(FOLLOW + ':' + seq, counts(i))
  }
  const s = buildSnapshot({ ...fixture(), items, originals, counts: countMap, cursor: { at: at(974), author: FOLLOW, seq: 974 } })
  const bytes = Buffer.byteLength(JSON.stringify(s))
  t.ok(bytes <= SNAPSHOT_MAX_BYTES, 'fits: ' + bytes)
  const n = s.items.length
  t.ok(n > 0 && n < FEED_LIMIT_DEFAULT, 'some rows dropped: kept ' + n)
  t.alike(s.items.map((i) => i.seq), items.slice(0, n).map((i) => i.seq), 'a prefix: dropped from the end')
  t.alike(Object.keys(s.originals).sort(), Array.from({ length: n }, (_, i) => FOLLOW + ':' + (i + 1)).sort(), 'originals of dropped rows gone')
  t.alike(Object.keys(s.counts).sort(), items.slice(0, n).map((i) => FOLLOW + ':' + i.seq).sort(), 'counts of dropped rows gone')
  t.alike(s.cursor, { at: at(1000 - n + 1), author: FOLLOW, seq: 1000 - n + 1 })
  t.alike(parseSnapshot(JSON.stringify(s), ctx), s)
})

test('parse rejects anything but an exact, current snapshot of this identity', async (t) => {
  const { buildSnapshot, parseSnapshot, SNAPSHOT_MAX_AGE_MS } = await load()
  const s = buildSnapshot(fixture())
  const text = JSON.stringify(s)
  const mutate = (fn) => {
    const copy = JSON.parse(text)
    fn(copy)
    return JSON.stringify(copy)
  }
  t.is(parseSnapshot(text, { ...ctx, origin: 'https://outro.app' }), null, 'wrong origin')
  t.is(parseSnapshot(text, { ...ctx, origin: undefined }), null, 'no origin')
  t.is(parseSnapshot(text, { ...ctx, association: 'ff'.repeat(32) }), null, 'wrong association')
  t.is(parseSnapshot(text, { ...ctx, owner: FOLLOW }), null, 'wrong owner')
  t.is(parseSnapshot(mutate((c) => { c.v = 2 }), ctx), null, 'other version')
  t.is(parseSnapshot(mutate((c) => { c.items[0].author = OWN.toUpperCase() }), ctx), null, 'uppercase key')
  t.is(parseSnapshot(mutate((c) => { c.names[OWN.toUpperCase()] = c.names[OWN]; delete c.names[OWN] }), ctx), null, 'uppercase name key')
  t.is(parseSnapshot(mutate((c) => { c.counts['xyz:1'] = { replies: 0, likes: 0, reposts: 0, quotes: 0 } }), ctx), null, 'malformed ref')
  t.is(parseSnapshot(mutate((c) => { c.items[0].seq = 2 ** 53 }), ctx), null, 'unsafe integer')
  t.is(parseSnapshot(mutate((c) => { c.items[0].text = 'x'.repeat(2001) }), ctx), null, 'oversized text')
  t.is(parseSnapshot(mutate((c) => { c.names[OWN].name = 'x'.repeat(161) }), ctx), null, 'oversized name')
  t.is(parseSnapshot(mutate((c) => { c.items[0].extra = 1 }), ctx), null, 'unexpected item key')
  t.is(parseSnapshot(mutate((c) => { c.extra = 1 }), ctx), null, 'unexpected top-level key')
  t.is(parseSnapshot(mutate((c) => { delete c.liked }), ctx), null, 'missing top-level key')
  t.is(parseSnapshot(mutate((c) => { c.originals[OWN + ':3'] = c.originals[OWN + ':1'] }), ctx), null, 'original under another ref')
  t.is(parseSnapshot(mutate((c) => { c.liked.push(c.liked[0]) }), ctx), null, 'duplicate ref')
  t.is(parseSnapshot(text, { ...ctx, now: NOW + SNAPSHOT_MAX_AGE_MS + 1 }), null, 'stale')
  t.ok(parseSnapshot(text, { ...ctx, now: NOW + SNAPSHOT_MAX_AGE_MS }), 'just within the age')
  t.is(parseSnapshot(text, { ...ctx, now: NOW - DAY - 1 }), null, 'saved more than a day in the future')
  t.ok(parseSnapshot(text, { ...ctx, now: NOW - DAY + 1 }), 'a small clock skew is fine')
  t.is(parseSnapshot('{', ctx), null)
  t.is(parseSnapshot(null, ctx), null)
  t.is(parseSnapshot('[]', ctx), null)
  t.is(parseSnapshot('x'.repeat(524289), ctx), null, 'over the cap')
})

test('withoutAuthors drops their rows, reposts of them, names, originals and counts', async (t) => {
  const { buildSnapshot, withoutAuthors } = await load()
  const s = buildSnapshot(fixture())
  const before = JSON.stringify(s)
  const out = withoutAuthors(s, new Set([FOLLOW]))
  t.is(JSON.stringify(s), before, 'the input is untouched')
  t.alike(out.items.map((i) => i.author + ':' + i.seq), [OWN + ':50', OWN + ':43'])
  t.alike(Object.keys(out.names), [OWN])
  t.alike(Object.keys(out.originals), [OWN + ':1'])
  t.alike(Object.keys(out.counts).sort(), [OWN + ':50', OWN + ':43'].sort())
  t.alike(out.liked, [OWN + ':50'])
  t.alike(out.reposted, [])
  t.alike(out.cursor, s.cursor)

  const noOwnOriginal = withoutAuthors(s, [OWN])
  t.alike(noOwnOriginal.items.find((i) => i.kind === 'repost' && i.to.author === OWN), undefined, 'a repost of a removed author goes too')
})

test('keepOnlyAuthors keeps own rows always and drops originals of others', async (t) => {
  const { buildSnapshot, keepOnlyAuthors } = await load()
  const s = buildSnapshot(fixture())
  const none = keepOnlyAuthors(s, new Set())
  t.alike(none.items.map((i) => i.author + ':' + i.seq), [OWN + ':50', OWN + ':43'], 'own kept')
  t.alike(Object.keys(none.originals), [OWN + ':1'])
  t.alike(Object.keys(none.names), [OWN])
  const all = keepOnlyAuthors(s, [FOLLOW])
  t.alike(all, s, 'nothing to drop')
})

test('initialFeedState keeps loadedAt null; socialSeed carries only shown refs', async (t) => {
  const { buildSnapshot, parseSnapshot, initialFeedState, socialSeed } = await load()
  const s = buildSnapshot(fixture())
  const state = initialFeedState(s)
  t.is(state.loadedAt, null)
  t.alike(state.items, s.items)
  t.alike(state.cursor, s.cursor)

  // A stored extra count, heart and original (no row shows them).
  const copy = JSON.parse(JSON.stringify(s))
  copy.counts[FOLLOW + ':777'] = counts(1)
  copy.liked.push(FOLLOW + ':777')
  copy.originals[FOLLOW + ':777'] = post(FOLLOW, 777)
  const parsed = parseSnapshot(JSON.stringify(copy), ctx)
  t.ok(parsed)
  const seed = socialSeed(parsed)
  t.ok(seed.counts instanceof Map && seed.originals instanceof Map && seed.liked instanceof Set && seed.reposted instanceof Set)
  t.alike([...seed.counts.keys()].sort(), Object.keys(s.counts).sort())
  t.alike([...seed.liked].sort(), s.liked.slice().sort())
  t.alike([...seed.reposted], s.reposted)
  t.alike([...seed.originals.keys()].sort(), Object.keys(s.originals).sort())
  t.alike(seed.counts.get(OWN + ':50'), counts(0))
})

test('build leaves out the rows of an author no longer followed', async (t) => {
  const { buildSnapshot } = await load()
  const f = fixture()
  const items = [post(OWN, 60), post(STRANGER, 59), post(FOLLOW, 58)]
  const s = buildSnapshot({ ...f, items, cursor: { at: at(58), author: FOLLOW, seq: 58 } })
  t.alike(s.items.map((i) => i.author + ':' + i.seq), [OWN + ':60', FOLLOW + ':58'])
  t.absent(STRANGER in s.names, 'no name of the unfollowed author')
  t.alike(s.cursor, { at: at(58), author: FOLLOW, seq: 58 })
  const reposts = buildSnapshot({ ...f, items: [repost(STRANGER, 61, { author: OWN, seq: 2 }), post(OWN, 60)] })
  t.alike(reposts.items.map((i) => i.seq), [60], 'a repost by an unfollowed author is not stored')
  t.is(buildSnapshot({ ...f, items: [post(STRANGER, 1)] }), null)
})

test('build and socialSeed never hold a blocked author, even a followed one', async (t) => {
  const { buildSnapshot, socialSeed } = await load()
  const f = fixture()
  const items = [
    post(OWN, 60, { quote: { author: BLOCKED, seq: 9 } }),
    post(FOLLOW, 59, { replyTo: { author: BLOCKED, seq: 9 } })
  ]
  const s = buildSnapshot({ ...f, items, isKnown: (a) => a === FOLLOW || a === BLOCKED })
  t.alike(s.items.map((i) => i.seq), [60, 59])
  t.absent(BLOCKED + ':9' in s.originals, 'no blocked original')
  t.absent(BLOCKED in s.names, 'no blocked name')
  const seed = socialSeed(s)
  t.absent(seed.originals.has(BLOCKED + ':9'))
})

test('parse rejects text over the cap in UTF-8 bytes, not in UTF-16 units', async (t) => {
  const { buildSnapshot, parseSnapshot, SNAPSHOT_MAX_BYTES } = await load()
  const emoji = '\u{1F600}'.repeat(1000)
  const items = []
  for (let i = 0; i < FEED_LIMIT_DEFAULT; i++) items.push(post(FOLLOW, 1000 - i, { text: emoji }))
  const s = buildSnapshot({ ...fixture(), items, cursor: { at: at(974), author: FOLLOW, seq: 974 } })
  t.is(s.items.length, FEED_LIMIT_DEFAULT)
  const json = JSON.stringify(s)
  t.ok(parseSnapshot(json, ctx), 'under the cap parses')
  // Legal JSON whitespace fills the text to the cap in UTF-16 units; the emoji
  // make it longer in bytes.
  const padded = json + ' '.repeat(SNAPSHOT_MAX_BYTES - json.length)
  t.is(padded.length, SNAPSHOT_MAX_BYTES)
  t.ok(Buffer.byteLength(padded) > SNAPSHOT_MAX_BYTES, 'over the cap in bytes')
  t.is(parseSnapshot(padded, ctx), null)
})
