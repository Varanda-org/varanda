'use strict'

// Per-screen snapshot rules (src/screenSnapshot.js): what each kind keeps,
// the identity binding (member only, never a page), the caps, the strict
// parse and the author filters.
const test = require('brittle')

const load = () => import('../src/screenSnapshot.js')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const C1 = '11'.repeat(32)
const C2 = '22'.repeat(32)
const G1 = '33'.repeat(32)
const G2 = '44'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const ME = Object.freeze({ kind: 'me' })
const PAGE = Object.freeze({ kind: 'page', key: 'ff'.repeat(32), name: 'Loja', username: 'loja' })

const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
const avatar = { core: '56'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: '78'.repeat(32), width: 512, height: 512 }
const id = (extra = {}) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now: NOW, ...extra })
const bind = (extra = {}) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now: NOW, ...extra })

function post (author, seq, extra = {}) {
  return { kind: 'post', author, name: null, username: null, seq, at: at(seq), text: 'texto ' + seq, replyTo: null, quote: null, media: null, preview: null, ...extra }
}

function repost (author, seq, to) {
  return { kind: 'repost', author, name: null, username: null, seq, at: at(seq), to, text: null, replyTo: null, quote: null, media: null, preview: null }
}

function diaryLog () {
  return {
    key: OWN,
    entries: [
      { seq: 9, record: { type: 'post', text: 'oi', at: at(9), replyTo: null, quote: { author: STRANGER, seq: 2 } } },
      { seq: 8, record: { type: 'repost', to: { author: FOLLOW, seq: 3 }, on: true, at: at(8) } },
      { seq: 7, record: { type: 'like', to: { author: STRANGER, seq: 1 }, on: true, at: at(7) } },
      { seq: 6, record: { type: 'group-join', group: G1, on: true, at: at(6) } },
      { seq: 5, record: { type: 'follow', author: STRANGER, on: true, at: at(5) } },
      { seq: 4, record: { type: 'post', text: 'resposta', at: at(4), replyTo: { author: FOLLOW, seq: 1 } } }
    ],
    invalid: [{ seq: 3, reason: 'malformed' }],
    entriesTruncated: 2
  }
}

const diaryOriginals = () => new Map([
  [STRANGER + ':2', post(STRANGER, 2)],
  [FOLLOW + ':3', post(FOLLOW, 3)],
  [FOLLOW + ':1', post(FOLLOW, 1)]
])

function memberInput (author, extra = {}) {
  return {
    author,
    header: { name: 'Bia', username: 'bia', bio: 'oi', avatar },
    items: [post(author, 5, { quote: { author: STRANGER, seq: 1 } }), repost(author, 4, { author: OWN, seq: 2 }), repost(author, 3, { author: STRANGER, seq: 8 }), post(author, 2)],
    before: 2,
    atEnd: false,
    originals: new Map([[STRANGER + ':1', post(STRANGER, 1)], [OWN + ':2', post(OWN, 2)]]),
    followed: new Set([FOLLOW, 'dd'.repeat(32)]),
    ...extra
  }
}

const groupRows = () => [
  { community: C1, group: G1, role: 'admin', general: true, visibility: 'public', name: 'Geral', title: 'Vizinhos', last: { preview: 'segredo' }, unread: 4 },
  { community: C1, group: G2, role: 'member', general: false, visibility: 'private', name: 'Segredo', unread: 2 }
]

const communityRows = () => [
  { community: C1, name: 'Vizinhos', join: 'open', state: 'ready', role: 'creator', general: G1 },
  { community: C2, name: null, join: null, state: 'pending', role: 'pending', general: null }
]

function roundTrip (t, s, kind) {
  const back = s.parseScreenSnapshot(JSON.stringify(s.buildScreenSnapshot(kind, KINDS[kind]())), kind, bind())
  t.ok(back, kind + ' parses')
  return back
}

const KINDS = {
  diario: () => ({ ...id(), log: diaryLog(), originals: diaryOriginals(), followed: [FOLLOW] }),
  perfil: () => ({ ...id(), profile: { author: OWN, name: 'Eu', username: 'eu_mesmo', bio: 'minha bio', avatar } }),
  membro: () => ({ ...id(), ...memberInput(FOLLOW), previous: null }),
  conversasGrupos: () => ({ ...id(), rows: groupRows() }),
  comunidades: () => ({ ...id(), rows: communityRows() })
}

test('every kind round-trips and the parse equals the build', async (t) => {
  const s = await load()
  for (const kind of s.SCREEN_SNAPSHOT_KINDS) {
    const built = s.buildScreenSnapshot(kind, KINDS[kind]())
    t.ok(built, kind + ' builds')
    t.is(built.kind, kind)
    t.alike(Object.keys(built), ['v', 'kind', 'origin', 'association', 'owner', 'savedAt', 'body'])
    t.alike(roundTrip(t, s, kind), built)
  }
})

test('diario keeps only post and repost records and own or followed originals', async (t) => {
  const s = await load()
  const b = roundTrip(t, s, 'diario').body
  t.alike(b.rows.map((r) => r.seq), [9, 8, 4], 'likes, follows and group joins are never kept')
  t.is(b.oldest, 3, 'the next before is the oldest entry of the page')
  t.is(b.atEnd, false)
  t.alike(Object.keys(b.originals).sort(), [FOLLOW + ':1', FOLLOW + ':3'], 'the stranger quote is not kept')
  t.is(s.buildScreenSnapshot('diario', { ...KINDS.diario(), log: { ...diaryLog(), key: FOLLOW } }), null, 'another diary is refused')
})

const poster = { core: '12'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: '34'.repeat(32), width: 640, height: 360 }
const clip = { core: '9a'.repeat(32), mime: 'video/mp4', start: 2, blocks: 30, bytes: 30 * 32768 - 5, sha256: 'bc'.repeat(32), width: 640, height: 360, ms: 12000 }
const badPairs = () => [
  [clip, poster],
  [clip],
  [poster, clip, poster],
  [{ ...poster, mime: 'image/png' }, clip],
  [poster, { ...clip, ms: 0 }],
  [poster, { ...clip, ms: 30001 }],
  [poster, { ...clip, width: 1920, height: 1920 }],
  [poster, { ...clip, extra: 1 }],
  [poster, { ...clip, mime: 'image/jpeg' }]
]

test('a video row round-trips in diario and membro; a malformed pair never parses', async (t) => {
  const s = await load()
  const log = diaryLog()
  log.entries[0] = { ...log.entries[0], seq: 10 }
  log.entries.splice(1, 0, { seq: 9, record: { type: 'post', text: 'vídeo', at: at(9), replyTo: null, media: [poster, clip] } })
  const diario = s.buildScreenSnapshot('diario', { ...KINDS.diario(), log })
  t.alike(diario.body.rows.map((r) => r.seq), [10, 9, 8, 4], 'the video row and every older row are kept')
  const back = s.parseScreenSnapshot(JSON.stringify(diario), 'diario', bind())
  t.alike(back, diario, 'diario round trip')
  t.alike(back.body.rows[1].record.media, [poster, clip])

  const member = s.buildScreenSnapshot('membro', { ...KINDS.membro(), items: [post(FOLLOW, 6, { media: [poster, clip] }), ...memberInput(FOLLOW).items] })
  t.ok(member, 'membro builds')
  const parsed = s.parseScreenSnapshot(JSON.stringify(member), 'membro', bind())
  t.alike(parsed, member, 'membro round trip')
  t.ok(JSON.stringify(parsed.body).includes(clip.sha256), 'the video row is in membro')

  for (const media of badPairs()) {
    const tampered = JSON.parse(JSON.stringify(diario))
    tampered.body.rows[1].record.media = JSON.parse(JSON.stringify(media))
    t.is(s.parseScreenSnapshot(JSON.stringify(tampered), 'diario', bind()), null, 'diario: ' + JSON.stringify(media.map((d) => d.mime)))
  }
})

test('perfil keeps the four fields of the own profile only', async (t) => {
  const s = await load()
  t.alike(roundTrip(t, s, 'perfil').body, { name: 'Eu', username: 'eu_mesmo', bio: 'minha bio', avatar })
  t.is(s.buildScreenSnapshot('perfil', { ...KINDS.perfil(), profile: { author: FOLLOW, name: 'Bia', username: 'bia', bio: null, avatar: null } }), null)
})

test('membro refuses a non-followed author and the owner', async (t) => {
  const s = await load()
  t.is(s.buildScreenSnapshot('membro', { ...KINDS.membro(), author: STRANGER }), null)
  t.is(s.buildScreenSnapshot('membro', { ...KINDS.membro(), author: OWN, followed: [OWN] }), null)
  t.is(s.buildScreenSnapshot('membro', { ...KINDS.membro(), blocked: new Set([FOLLOW]) }), null)
  const e = roundTrip(t, s, 'membro').body.authors[FOLLOW]
  t.alike(e.items.map((i) => i.seq), [5, 4, 2], 'a repost of a stranger post is left out')
  t.alike(Object.keys(e.originals), [OWN + ':2'], 'a stranger original is never kept')
  t.is(e.before, 2)
})

test('membro keeps at most 8 authors, the least recently opened out first', async (t) => {
  const s = await load()
  const keys = Array.from({ length: 10 }, (_, n) => (n + 0x60).toString(16).repeat(32))
  let prev = null
  keys.forEach((k, n) => {
    prev = s.buildScreenSnapshot('membro', { ...id({ now: NOW + n }), ...memberInput(k, { followed: keys }), previous: prev })
  })
  const kept = Object.keys(prev.body.authors)
  t.is(kept.length, s.MEMBER_MAX_AUTHORS)
  t.absent(kept.includes(keys[0]))
  t.absent(kept.includes(keys[1]))
  // Opening an old one again moves it to the front.
  const again = s.buildScreenSnapshot('membro', { ...id({ now: NOW + 20 }), ...memberInput(keys[2], { followed: keys }), previous: prev })
  const next = s.buildScreenSnapshot('membro', { ...id({ now: NOW + 21 }), ...memberInput(keys[0], { followed: keys }), previous: again })
  t.ok(next.body.authors[keys[2]], 'the reopened author stays')
  t.absent(next.body.authors[keys[3]], 'the least recently opened one goes')
  // An author no longer followed is dropped on the next build.
  const fewer = s.buildScreenSnapshot('membro', { ...id({ now: NOW + 22 }), ...memberInput(keys[9], { followed: [keys[9]] }), previous: next })
  t.alike(Object.keys(fewer.body.authors), [keys[9]])
})

test('membro cuts an entry to 64 KiB', async (t) => {
  const s = await load()
  const items = Array.from({ length: 32 }, (_, n) => post(FOLLOW, 40 - n, { text: 'x'.repeat(1000).replace(/x/g, 'é') }))
  const built = s.buildScreenSnapshot('membro', { ...KINDS.membro(), items })
  const e = built.body.authors[FOLLOW]
  t.ok(e.items.length > 0 && e.items.length < 32)
  t.ok(Buffer.byteLength(JSON.stringify(e)) <= s.MEMBER_ENTRY_MAX_BYTES)
  t.is(e.before, e.items[e.items.length - 1].seq, 'the cut moves the next bound')
  t.is(e.atEnd, false)
  t.ok(s.parseScreenSnapshot(JSON.stringify(built), 'membro', bind()))
})

test('conversasGrupos drops a private name, previews and unread state', async (t) => {
  const s = await load()
  const rows = roundTrip(t, s, 'conversasGrupos').body.rows
  t.alike(rows, [
    { community: C1, group: G1, role: 'admin', general: true, name: 'Vizinhos' },
    { community: C1, group: G2, role: 'member', general: false, name: null }
  ])
  const text = JSON.stringify(s.buildScreenSnapshot('conversasGrupos', KINDS.conversasGrupos()))
  t.absent(text.includes('Segredo'))
  t.absent(text.includes('segredo'))
  t.absent(text.includes('unread'))
})

test('comunidades keys one row per community and refuses duplicates', async (t) => {
  const s = await load()
  t.alike(roundTrip(t, s, 'comunidades').body.rows, communityRows())
  t.is(s.buildScreenSnapshot('comunidades', { ...id(), rows: communityRows().concat([communityRows()[0]]) }), null)
  const dup = s.buildScreenSnapshot('comunidades', KINDS.comunidades())
  dup.body.rows.push(dup.body.rows[0])
  t.is(s.parseScreenSnapshot(JSON.stringify(dup), 'comunidades', bind()), null)
  const priv = s.buildScreenSnapshot('comunidades', { ...id(), rows: [{ ...communityRows()[0], visibility: 'private' }] })
  t.is(priv.body.rows[0].name, null, 'a row that is not public keeps no name')
})

test('a page actor never builds nor reads a snapshot', async (t) => {
  const s = await load()
  for (const kind of s.SCREEN_SNAPSHOT_KINDS) {
    t.is(s.buildScreenSnapshot(kind, { ...KINDS[kind](), acting: PAGE }), null, kind + ' build')
    t.is(s.buildScreenSnapshot(kind, { ...KINDS[kind](), acting: undefined }), null, kind + ' without an actor')
    const text = JSON.stringify(s.buildScreenSnapshot(kind, KINDS[kind]()))
    t.is(s.parseScreenSnapshot(text, kind, bind({ acting: PAGE })), null, kind + ' parse')
  }
  t.is(s.actingAsMember(ME), true)
  t.is(s.actingAsMember(PAGE), false)
  t.is(s.actingAsMember(null), false)
})

test('parse refuses another binding, age, version, kind, size and malformed rows', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('diario', KINDS.diario())
  const text = JSON.stringify(built)
  t.ok(s.parseScreenSnapshot(text, 'diario', bind()))
  t.ok(s.parseScreenSnapshot(text, 'diario', bind({ owner: undefined })), 'owner omitted is not checked')
  t.is(s.parseScreenSnapshot(text, 'diario', bind({ origin: 'https://outro.app' })), null, 'origin')
  t.is(s.parseScreenSnapshot(text, 'diario', bind({ association: 'ab'.repeat(32) })), null, 'association')
  t.is(s.parseScreenSnapshot(text, 'diario', bind({ owner: FOLLOW })), null, 'owner')
  t.is(s.parseScreenSnapshot(text, 'diario', bind({ now: NOW + 15 * DAY })), null, 'too old')
  t.ok(s.parseScreenSnapshot(text, 'diario', bind({ now: NOW + 13 * DAY })))
  t.is(s.parseScreenSnapshot(text, 'diario', bind({ now: NOW - 2 * DAY })), null, 'from the future')
  t.is(s.parseScreenSnapshot(text, 'perfil', bind()), null, 'another kind')
  t.is(s.parseScreenSnapshot(text, 'grupos', bind()), null, 'unknown kind')
  t.is(s.parseScreenSnapshot(JSON.stringify({ ...built, v: 2 }), 'diario', bind()), null, 'version')
  t.is(s.parseScreenSnapshot(JSON.stringify({ ...built, extra: 1 }), 'diario', bind()), null, 'extra key')
  t.is(s.parseScreenSnapshot(text.slice(0, -1), 'diario', bind()), null, 'torn text')
  t.is(s.parseScreenSnapshot(text + ' '.repeat(s.SCREEN_SNAPSHOT_MAX_BYTES), 'diario', bind()), null, 'size')
  const bad = (change) => {
    const copy = JSON.parse(text)
    change(copy.body)
    return s.parseScreenSnapshot(JSON.stringify(copy), 'diario', bind())
  }
  t.is(bad((b) => { b.rows[0].record.type = 'like' }), null, 'a like row')
  t.is(bad((b) => { b.rows[0].seq = 1.5 }), null, 'a seq that is not an integer')
  t.is(bad((b) => { b.rows.reverse() }), null, 'rows out of order')
  t.is(bad((b) => { b.originals[FOLLOW + ':1'].author = STRANGER }), null, 'an original under the wrong ref')
  const g = s.buildScreenSnapshot('conversasGrupos', KINDS.conversasGrupos())
  g.body.rows[0].unread = 3
  t.is(s.parseScreenSnapshot(JSON.stringify(g), 'conversasGrupos', bind()), null, 'unread in a group row')
  const m = s.buildScreenSnapshot('membro', KINDS.membro())
  m.body.authors[FOLLOW].items[0].author = STRANGER
  t.is(s.parseScreenSnapshot(JSON.stringify(m), 'membro', bind()), null, 'a row of another author in an entry')
  t.is(s.buildScreenSnapshot('perfil', { ...KINDS.perfil(), owner: 'nope' }), null, 'bad owner')
  t.is(s.buildScreenSnapshot('perfil', { ...KINDS.perfil(), origin: '' }), null, 'bad origin')
})

test('withoutAuthors and keepOnlyAuthors rewrite membro and diario', async (t) => {
  const s = await load()
  const other = 'dd'.repeat(32)
  const first = s.buildScreenSnapshot('membro', { ...KINDS.membro(), items: [repost(FOLLOW, 9, { author: other, seq: 1 }), post(FOLLOW, 8)], originals: new Map([[other + ':1', post(other, 1)]]) })
  const both = s.buildScreenSnapshot('membro', { ...id({ now: NOW + 1 }), ...memberInput(other), previous: first })
  t.alike(Object.keys(both.body.authors).sort(), [FOLLOW, other].sort())

  const dropped = s.screenWithoutAuthors(both, [other])
  t.alike(Object.keys(dropped.body.authors), [FOLLOW])
  t.alike(dropped.body.authors[FOLLOW].items.map((i) => i.seq), [8], 'a repost of a dropped author goes')
  t.alike(dropped.body.authors[FOLLOW].originals, {})
  t.ok(s.parseScreenSnapshot(JSON.stringify(dropped), 'membro', bind({ now: NOW + 1 })))

  const kept = s.screenKeepOnlyAuthors(both, new Set([other]))
  t.alike(Object.keys(kept.body.authors), [other])

  const diary = s.buildScreenSnapshot('diario', KINDS.diario())
  const noFollow = s.screenKeepOnlyAuthors(diary, [])
  t.alike(noFollow.body.originals, {}, 'originals of an unfollowed author go')
  t.alike(noFollow.body.rows, diary.body.rows.filter((r) => r.record.type !== 'repost'), 'own posts stay; an own repost of an unfollowed author goes with its original')
  t.alike(s.screenWithoutAuthors(diary, [FOLLOW]).body.originals, {})
  const perfil = s.buildScreenSnapshot('perfil', KINDS.perfil())
  t.alike(s.screenWithoutAuthors(perfil, [FOLLOW]), perfil, 'other kinds hold no other author')
  t.is(s.screenWithoutAuthors(null, [FOLLOW]), null)
})

test('rows past the item cap count as a cut: the paging bound is the oldest kept', async (t) => {
  const s = await load()
  const items = Array.from({ length: 40 }, (_, i) => post(FOLLOW, 40 - i))
  const m = s.buildScreenSnapshot('membro', { ...id(), ...memberInput(FOLLOW, { items, before: 1, atEnd: true }) })
  const e = m.body.authors[FOLLOW]
  t.is(e.items.length, 32)
  t.is(e.before, e.items[e.items.length - 1].seq, 'next page starts below the oldest kept item')
  t.is(e.atEnd, false)
  const entries = Array.from({ length: 40 }, (_, i) => ({ seq: 40 - i, record: { type: 'post', text: 'p' + i, at: at(40 - i), replyTo: null } }))
  const d = s.buildScreenSnapshot('diario', { ...id(), log: { key: OWN, entries, entriesTruncated: 0 }, originals: new Map(), followed: new Set([FOLLOW]) })
  t.is(d.body.rows.length, 32)
  t.is(d.body.oldest, d.body.rows[d.body.rows.length - 1].seq)
  t.is(d.body.atEnd, false)
})

test('each membro entry ages on its own', async (t) => {
  const s = await load()
  const old = s.buildScreenSnapshot('membro', { ...id({ now: NOW }), ...memberInput(FOLLOW) })
  const other = 'dd'.repeat(32)
  // Refreshing another author on day 13 keeps the day-0 entry only until day 14.
  const both = s.buildScreenSnapshot('membro', { ...id({ now: NOW + 13 * DAY }), ...memberInput(other), previous: old })
  t.ok(both.body.authors[FOLLOW], 'still within its 14 days')
  const later = s.parseScreenSnapshot(JSON.stringify(both), 'membro', bind({ now: NOW + 20 * DAY }))
  t.ok(later, 'the envelope is 7 days old')
  t.absent(later.body.authors[FOLLOW], 'the day-0 entry is gone on day 20')
  t.ok(later.body.authors[other])
  const rebuilt = s.buildScreenSnapshot('membro', { ...id({ now: NOW + 20 * DAY }), ...memberInput(other), previous: both })
  t.absent(rebuilt.body.authors[FOLLOW], 'a rebuild drops it too')
})

test('dropping an author also drops the own reposts of that author in diario', async (t) => {
  const s = await load()
  const d = s.buildScreenSnapshot('diario', { ...id(), log: diaryLog(), originals: diaryOriginals(), followed: new Set([FOLLOW]) })
  t.ok(d.body.rows.some((r) => r.record.type === 'repost' && r.record.to.author === FOLLOW))
  const pruned = s.screenWithoutAuthors(d, [FOLLOW])
  t.absent(pruned.body.rows.some((r) => r.record.type === 'repost' && r.record.to.author === FOLLOW))
  t.ok(pruned.body.rows.some((r) => r.record.type === 'post'), 'own posts stay')
})

test('a membro entry opened in the future is not fresh; a cut page with nothing kept stores no entry', async (t) => {
  const s = await load()
  const m = s.buildScreenSnapshot('membro', { ...id({ now: NOW + 30 * DAY }), ...memberInput(FOLLOW) })
  // The device clock went back 30 days: the entry now reads as opened in the future.
  t.absent(s.parseScreenSnapshot(JSON.stringify({ ...m, savedAt: NOW }), 'membro', bind({ now: NOW })).body.authors[FOLLOW])
  const other = 'dd'.repeat(32)
  const rebuilt = s.buildScreenSnapshot('membro', { ...id({ now: NOW }), ...memberInput(other), previous: m })
  t.absent(rebuilt.body.authors[FOLLOW], 'a rebuild does not carry it either')
  const strangers = Array.from({ length: 40 }, (_, i) => post(STRANGER, 80 - i))
  t.is(s.buildScreenSnapshot('membro', { ...id(), ...memberInput(FOLLOW, { items: strangers.concat([post(FOLLOW, 1)]) }) }), null)
})
