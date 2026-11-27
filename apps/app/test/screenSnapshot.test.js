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

// A names cache's profileOf: the owner and the page authors have names too,
// and an entry never repeats them.
const memberNames = (a) => (a === STRANGER ? { name: 'Cris', username: 'cris', bio: 'oi', avatar } : a === OWN ? { name: 'Eu', username: 'eu' } : a === FOLLOW || a === 'dd'.repeat(32) ? { name: 'Bia', username: 'bia' } : undefined)

function memberInput (author, extra = {}) {
  return {
    author,
    header: { name: 'Bia', username: 'bia', bio: 'oi', avatar },
    items: [post(author, 5, { quote: { author: STRANGER, seq: 1 } }), repost(author, 4, { author: OWN, seq: 2 }), repost(author, 3, { author: STRANGER, seq: 8 }), post(author, 2)],
    before: 2,
    atEnd: false,
    originals: new Map([[STRANGER + ':1', post(STRANGER, 1)], [OWN + ':2', post(OWN, 2)]]),
    names: memberNames,
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

// A momento as useMoments holds it, an hour old at NOW.
function moment (author, seq) {
  return { seq, ref: author + ':' + seq, text: 'momento ' + seq, at: new Date(NOW - 60 * 60 * 1000 - seq).toISOString(), media: { mime: 'image/jpeg', w: 1080, h: 1350, ms: 0 } }
}

// The private kinds (src/privateSnapshot.js), one row each.
const notice = (key, seq) => ({ kind: 'follow', key, seq, at: at(seq), name: 'Bia', username: 'bia', seen: '9a'.repeat(16), avatar })
const dmRow = (peer) => ({ peer, folder: 'inbox', preview: 'oi', at: at(5), unread: true, mine: false })
const dmItem = { id: '12'.repeat(32), key: '34'.repeat(32), nonce: '56'.repeat(24), chunks: 1, bytes: 1000, sha256: '78'.repeat(32), mime: 'image/jpeg', w: 800, h: 600, ms: 0 }
const dmMessage = (n, extra = {}) => ({ id: n.toString(16).padStart(32, '0'), from: FOLLOW, text: 'mensagem ' + n, replyTo: null, fwd: 0, at: at(n), mine: false, media: null, card: null, ...extra })
const groupItem = (seq, extra = {}) => ({ writer: '77'.repeat(32), diary: FOLLOW, seq, at: at(seq), text: 'grupo ' + seq, replyTo: null, fwd: 0, media: null, card: null, hidden: false, name: 'Bia', username: 'bia', ...extra })

function roundTrip (t, s, kind) {
  const back = s.parseScreenSnapshot(JSON.stringify(s.buildScreenSnapshot(kind, KINDS[kind]())), kind, bind())
  t.ok(back, kind + ' parses')
  return back
}

const KINDS = {
  diario: () => ({ ...id(), log: diaryLog(), originals: diaryOriginals(), followed: [FOLLOW], profileOf: (a) => (a === STRANGER ? { name: 'Cris', username: 'cris', bio: 'oi', avatar } : a === FOLLOW ? { name: 'Bia', username: 'bia' } : undefined) }),
  perfil: () => ({ ...id(), profile: { author: OWN, name: 'Eu', username: 'eu_mesmo', bio: 'minha bio', avatar } }),
  membro: () => ({ ...id(), ...memberInput(FOLLOW), previous: null }),
  conversasGrupos: () => ({ ...id(), rows: groupRows() }),
  comunidades: () => ({ ...id(), rows: communityRows() }),
  momentos: () => ({
    ...id(),
    authors: [{ author: FOLLOW, items: [moment(FOLLOW, 3), moment(FOLLOW, 2)] }],
    own: [moment(OWN, 7)],
    names: [{ author: FOLLOW, name: 'Bia', username: 'bia', bio: 'oi', avatar }],
    followed: [FOLLOW]
  }),
  espiadinha: () => ({
    ...id(),
    rows: [{ ...post(STRANGER, 3), avatar, round: 0 }, { ...repost(STRANGER, 2, { author: 'dd'.repeat(32), seq: 1 }), avatar: null, round: 1 }],
    meta: { diaries: 12, skipped: 1, incomplete: false },
    blocked: [],
    followed: [FOLLOW]
  }),
  avisos: () => ({ ...id(), notices: [notice(FOLLOW, 3), notice(STRANGER, 2)], blocked: [] }),
  conversas: () => ({ ...id(), rows: [dmRow(FOLLOW), dmRow(STRANGER)], groups: groupRows(), blocked: [] }),
  mensagens: () => ({ ...id(), previous: null, peer: FOLLOW, messages: [dmMessage(1), dmMessage(2, { media: [dmItem] })], blocked: [] }),
  grupoMensagens: () => ({ ...id(), previous: null, group: G2, items: [groupItem(2), groupItem(1)], blocked: [] }),
  listas: () => ({ ...id(), previous: null, name: 'curtidas', scope: STRANGER + ':2', rows: [{ author: FOLLOW, seq: 4, name: 'Bia', username: 'bia', avatar }], total: 1, blocked: [] }),
  bloqueios: () => ({ ...id(), keys: [STRANGER, FOLLOW] }),
  silenciados: () => ({ ...id(), keys: [] })
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

test('diario keeps only post and repost records and the originals of every author not blocked', async (t) => {
  const s = await load()
  const b = roundTrip(t, s, 'diario').body
  t.alike(b.rows.map((r) => r.seq), [9, 8, 4], 'likes, follows and group joins are never kept')
  t.is(b.oldest, 3, 'the next before is the oldest entry of the page')
  t.is(b.atEnd, false)
  t.alike(Object.keys(b.originals).sort(), [FOLLOW + ':1', FOLLOW + ':3', STRANGER + ':2'].sort(), 'the stranger quote is kept')
  t.alike(b.names, [{ author: STRANGER, name: 'Cris', username: 'cris', avatar }, { author: FOLLOW, name: 'Bia', username: 'bia', avatar: null }], 'one name per author of an original, in order')
  const blocked = s.buildScreenSnapshot('diario', { ...KINDS.diario(), blocked: [STRANGER] }).body
  t.alike(Object.keys(blocked.originals).sort(), [FOLLOW + ':1', FOLLOW + ':3'], 'a blocked stranger\'s original is not kept')
  t.alike(blocked.names.map((n) => n.author), [FOLLOW], 'nor the name')
  t.is(s.buildScreenSnapshot('diario', { ...KINDS.diario(), log: { ...diaryLog(), key: FOLLOW } }), null, 'another diary is refused')
})

test('diario names: only usable entries, never the owner, and none without profileOf', async (t) => {
  const s = await load()
  const own = { [OWN + ':1']: post(OWN, 1) }
  const log = diaryLog()
  log.entries.push({ seq: 2, record: { type: 'repost', to: { author: OWN, seq: 1 }, on: true, at: at(2) } })
  const originals = new Map([...diaryOriginals(), ...Object.entries(own)])
  const names = { [OWN]: { name: 'Eu', username: 'eu' }, [STRANGER]: { name: 7 }, [FOLLOW]: { name: 'Bia', username: 'bia', avatar: 'nada' } }
  const b = s.buildScreenSnapshot('diario', { ...id(), log, originals, profileOf: (a) => names[a] }).body
  t.ok(b.originals[OWN + ':1'], 'the own original is kept')
  t.alike(b.names, [{ author: FOLLOW, name: 'Bia', username: 'bia', avatar: null }], 'the owner and an unusable entry are skipped, a bad avatar reads as none')
  t.alike(s.buildScreenSnapshot('diario', { ...id(), log: diaryLog(), originals: diaryOriginals() }).body.names, [], 'no profileOf, no names')
  const throws = s.buildScreenSnapshot('diario', { ...id(), log: diaryLog(), originals: diaryOriginals(), profileOf: () => { throw new Error('x') } })
  t.ok(throws, 'a names lookup that throws costs only the names')
  t.alike(throws.body.names, [])
})

test('diario names parse strictly; a body from before the names parses with none', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('diario', KINDS.diario())
  const parse = (change) => {
    const copy = JSON.parse(JSON.stringify(built))
    change(copy.body)
    return s.parseScreenSnapshot(JSON.stringify(copy), 'diario', bind())
  }
  const old = parse((b) => { delete b.names })
  t.ok(old, 'a four-key body parses')
  t.alike(old.body.names, [])
  t.alike(old.body.originals, built.body.originals)
  t.ok(parse((b) => { b.names = [] }), 'no names')
  t.is(parse((b) => { b.names.push({ author: 'dd'.repeat(32), name: null, username: null, avatar: null }) }), null, 'a name for an author with no stored original')
  t.is(parse((b) => { b.names.push({ author: OWN, name: null, username: null, avatar: null }) }), null, 'the owner')
  t.is(parse((b) => { b.names.push(b.names[0]) }), null, 'an author twice')
  t.is(parse((b) => { b.names[0].bio = 'oi' }), null, 'an extra key')
  t.is(parse((b) => { delete b.names[0].avatar }), null, 'a missing key')
  t.is(parse((b) => { b.names[0].avatar = { ...avatar, key: '12'.repeat(32) } }), null, 'an avatar that is not one')
  t.is(parse((b) => { b.names = {} }), null, 'not a list')
  t.is(parse((b) => { b.extra = 1 }), null, 'a sixth key')
  t.is(parse((b) => { delete b.names; delete b.atEnd }), null, 'a three-key body')
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

test('membro refuses a non-followed author and the owner; inside a followed page a stranger is kept, a blocked one is not', async (t) => {
  const s = await load()
  t.is(s.buildScreenSnapshot('membro', { ...KINDS.membro(), author: STRANGER }), null, 'a page only visited is never kept')
  t.is(s.buildScreenSnapshot('membro', { ...KINDS.membro(), author: OWN, followed: [OWN] }), null)
  t.is(s.buildScreenSnapshot('membro', { ...KINDS.membro(), blocked: new Set([FOLLOW]) }), null)
  const e = roundTrip(t, s, 'membro').body.authors[FOLLOW]
  t.alike(e.items.map((i) => i.seq), [5, 4, 3, 2], 'a repost of a stranger post is kept')
  t.alike(Object.keys(e.originals), [STRANGER + ':1', OWN + ':2'], 'and a stranger original')
  t.alike(e.names, [{ author: STRANGER, name: 'Cris', username: 'cris', avatar }], 'with the stranger name; never the owner nor the page author')
  t.is(e.before, 2)
  const b = s.buildScreenSnapshot('membro', { ...KINDS.membro(), blocked: [STRANGER] }).body.authors[FOLLOW]
  t.alike(b.items.map((i) => i.seq), [5, 4, 2], 'a blocked author\'s repost is left out')
  t.alike(Object.keys(b.originals), [OWN + ':2'], 'and their original')
  t.alike(b.names, [], 'and their name')
  const none = s.buildScreenSnapshot('membro', { ...KINDS.membro(), names: undefined }).body.authors[FOLLOW]
  t.alike(none.names, [], 'no names source, no names')
  t.alike(none.items, e.items)
  const throws = s.buildScreenSnapshot('membro', { ...KINDS.membro(), names: () => { throw new Error('x') } })
  t.alike(throws.body.authors[FOLLOW].names, [], 'a names source that throws costs the names, never the page')
})

test('membro: keep-only after an unfollow drops only pages; a block takes the author out of every page', async (t) => {
  const s = await load()
  const other = 'dd'.repeat(32)
  const first = s.buildScreenSnapshot('membro', KINDS.membro())
  const both = s.buildScreenSnapshot('membro', { ...id({ now: NOW + 1 }), ...memberInput(other), previous: first })
  t.alike(Object.keys(both.body.authors).sort(), [FOLLOW, other].sort())
  for (const e of Object.values(both.body.authors)) {
    t.ok(e.items.some((i) => i.kind === 'repost' && i.to.author === STRANGER) && e.names.some((n) => n.author === STRANGER), 'each page holds a stranger repost and name')
  }

  const kept = s.screenKeepOnlyAuthors(both, [OWN, FOLLOW])
  t.alike(Object.keys(kept.body.authors), [FOLLOW], 'the unfollowed author\'s page goes')
  t.alike(kept.body.authors[FOLLOW], both.body.authors[FOLLOW], 'strangers\' reposts, originals and names stay in a followed page')
  t.ok(s.parseScreenSnapshot(JSON.stringify(kept), 'membro', bind({ now: NOW + 1 })))
  // Saved while the stranger was followed too, then unfollowed.
  const wasFollowed = s.buildScreenSnapshot('membro', { ...KINDS.membro(), followed: [FOLLOW, STRANGER] })
  t.ok(wasFollowed.body.authors[FOLLOW].items.some((i) => i.kind === 'repost' && i.to.author === STRANGER))
  t.alike(s.screenKeepOnlyAuthors(wasFollowed, [OWN, FOLLOW]), wasFollowed, 'an unfollow leaves their repost and original in a followed page')

  const blocked = s.screenWithoutAuthors(both, [STRANGER])
  t.alike(Object.keys(blocked.body.authors).sort(), [FOLLOW, other].sort(), 'no page of the blocked author to drop')
  for (const [author, e] of Object.entries(blocked.body.authors)) {
    t.alike(e.items.map((i) => i.seq), [5, 4, 2], 'the repost of the blocked author goes in ' + author.slice(0, 2))
    t.alike(Object.keys(e.originals), [OWN + ':2'], 'and the original')
    t.alike(e.names, [], 'and the name')
    t.is(e.before, 2)
    t.is(e.atEnd, false)
  }
  t.ok(s.parseScreenSnapshot(JSON.stringify(blocked), 'membro', bind({ now: NOW + 1 })), 'still parses')

  const page = s.screenWithoutAuthors(both, [other])
  t.alike(Object.keys(page.body.authors), [FOLLOW], 'a blocked author\'s page goes')
  t.alike(page.body.authors[FOLLOW], both.body.authors[FOLLOW], 'the other page holds nothing of theirs')
})

test('membro names parse strictly; an entry from before the names parses with none', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('membro', KINDS.membro())
  const parse = (change) => {
    const copy = JSON.parse(JSON.stringify(built))
    change(copy.body.authors[FOLLOW])
    return s.parseScreenSnapshot(JSON.stringify(copy), 'membro', bind())
  }
  const old = parse((e) => { delete e.names })
  t.ok(old, 'a six-key entry parses')
  t.alike(old.body.authors[FOLLOW].names, [])
  t.alike(old.body.authors[FOLLOW].items, built.body.authors[FOLLOW].items)
  t.ok(parse((e) => { e.names = [] }), 'no names')
  const name = (author) => ({ author, name: null, username: null, avatar: null })
  t.is(parse((e) => { e.names.push(name('dd'.repeat(32))) }), null, 'a name for an author the entry does not point at')
  t.is(parse((e) => { e.names.push(name(OWN)) }), null, 'the owner')
  t.is(parse((e) => { e.names.push(name(FOLLOW)) }), null, 'the page author')
  t.is(parse((e) => { e.names.push(e.names[0]) }), null, 'an author twice')
  t.is(parse((e) => { e.names[0].bio = 'oi' }), null, 'an extra key')
  t.is(parse((e) => { delete e.names[0].avatar }), null, 'a missing key')
  t.is(parse((e) => { e.names = {} }), null, 'not a list')
  t.is(parse((e) => { e.extra = 1 }), null, 'an eighth key')
  t.is(parse((e) => { delete e.names; delete e.atEnd }), null, 'a five-key entry')
  // A repost target with no stored original still names its author.
  const target = s.buildScreenSnapshot('membro', { ...KINDS.membro(), items: [repost(FOLLOW, 3, { author: STRANGER, seq: 8 })], originals: new Map() })
  t.alike(target.body.authors[FOLLOW].names.map((n) => n.author), [STRANGER])
  t.alike(s.parseScreenSnapshot(JSON.stringify(target), 'membro', bind()), target)
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

const IMAGE = { ...avatar, mime: 'image/jpeg' }
const IMAGE_AUTHOR = '9c'.repeat(32)
const PRIVATE_IMAGE = { core: '56'.repeat(32), mime: 'application/octet-stream', start: 1, blocks: 1, bytes: 32768, sha256: '78'.repeat(32), key: '9a'.repeat(32), nonce: 'bc'.repeat(24), plainMime: 'image/jpeg', plainSha256: 'de'.repeat(32), w: 512, h: 512, ms: 0 }

test('conversasGrupos keeps a public group\'s image and its author, never a private one', async (t) => {
  const s = await load()
  const rows = [
    { ...groupRows()[0], image: IMAGE, imageAuthor: IMAGE_AUTHOR },
    { ...groupRows()[1], image: PRIVATE_IMAGE, imageAuthor: IMAGE_AUTHOR }
  ]
  const built = s.buildScreenSnapshot('conversasGrupos', { ...id(), rows })
  const back = s.parseScreenSnapshot(JSON.stringify(built), 'conversasGrupos', bind())
  t.alike(back, built, 'round trip')
  t.alike(back.body.rows, [
    { community: C1, group: G1, role: 'admin', general: true, name: 'Vizinhos', image: IMAGE, imageAuthor: IMAGE_AUTHOR },
    { community: C1, group: G2, role: 'member', general: false, name: null }
  ])
  t.absent(JSON.stringify(built).includes('"nonce"') || JSON.stringify(built).includes('"key"'), 'no key nor nonce')
  const only = (extra) => s.buildScreenSnapshot('conversasGrupos', { ...id(), rows: [{ ...groupRows()[0], ...extra }] }).body.rows[0]
  t.alike(Object.keys(only({ image: PRIVATE_IMAGE, imageAuthor: IMAGE_AUTHOR, visibility: 'public' })), ['community', 'group', 'role', 'general', 'name'], 'a private image on a public row')
  t.alike(Object.keys(only({ image: avatar, imageAuthor: IMAGE_AUTHOR })), ['community', 'group', 'role', 'general', 'name'], 'a WebP image')
  t.alike(Object.keys(only({ image: IMAGE })), ['community', 'group', 'role', 'general', 'name'], 'no author')
  t.alike(Object.keys(only({ image: IMAGE, imageAuthor: IMAGE_AUTHOR.toUpperCase() })), ['community', 'group', 'role', 'general', 'name'], 'an author that is not lowercase hex')
  t.alike(Object.keys(only({ imageAuthor: IMAGE_AUTHOR })), ['community', 'group', 'role', 'general', 'name'], 'no image')
  t.alike(only({ image: { ...IMAGE, extra: 1 }, imageAuthor: IMAGE_AUTHOR }).image, undefined, 'an image with another key')
  const copy = only({ image: IMAGE, imageAuthor: IMAGE_AUTHOR }).image
  t.alike(copy, IMAGE)
  t.not(copy, IMAGE, 'a fresh copy')
})

test('conversasGrupos parse: rows from before parse, a half or forged image is refused', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('conversasGrupos', { ...id(), rows: [{ ...groupRows()[0], image: IMAGE, imageAuthor: IMAGE_AUTHOR }, groupRows()[1]] })
  const parse = (change) => {
    const copy = JSON.parse(JSON.stringify(built))
    change(copy.body.rows)
    return s.parseScreenSnapshot(JSON.stringify(copy), 'conversasGrupos', bind())
  }
  const old = parse((rows) => { delete rows[0].image; delete rows[0].imageAuthor })
  t.alike(old.body.rows[0], { community: C1, group: G1, role: 'admin', general: true, name: 'Vizinhos' }, 'a five-key row parses')
  t.is(parse((rows) => { delete rows[0].image }), null, 'only the author')
  t.is(parse((rows) => { delete rows[0].imageAuthor }), null, 'only the image')
  t.is(parse((rows) => { rows[0].name = null }), null, 'a seven-key row without a name')
  t.is(parse((rows) => { rows[1].image = IMAGE; rows[1].imageAuthor = IMAGE_AUTHOR }), null, 'an image on a private row')
  t.is(parse((rows) => { rows[0].image.key = '9a'.repeat(32) }), null, 'an image with a key')
  t.is(parse((rows) => { rows[0].image.nonce = 'bc'.repeat(24) }), null, 'an image with a nonce')
  t.is(parse((rows) => { rows[0].image = PRIVATE_IMAGE }), null, 'a private image')
  t.is(parse((rows) => { rows[0].image.mime = 'image/webp' }), null, 'a WebP image')
  t.is(parse((rows) => { rows[0].image.width = 640 }), null, 'not an avatar')
  t.is(parse((rows) => { rows[0].imageAuthor = 'zz' }), null, 'a bad author')
  t.is(parse((rows) => { rows[0].extra = 1 }), null, 'a sixth key beside the image')
})

test('a block of the image author strips the image and keeps the row; a follow change keeps it', async (t) => {
  const s = await load()
  const built = s.buildScreenSnapshot('conversasGrupos', { ...id(), rows: [{ ...groupRows()[0], image: IMAGE, imageAuthor: IMAGE_AUTHOR }, groupRows()[1]] })
  const dropped = s.screenWithoutAuthors(built, [IMAGE_AUTHOR])
  t.alike(dropped.body.rows, [
    { community: C1, group: G1, role: 'admin', general: true, name: 'Vizinhos' },
    { community: C1, group: G2, role: 'member', general: false, name: null }
  ])
  t.ok(s.parseScreenSnapshot(JSON.stringify(dropped), 'conversasGrupos', bind()), 'still parses')
  t.alike(s.screenWithoutAuthors(built, [FOLLOW]), built, 'another author leaves it')
  t.is(s.screenKeepOnlyAuthors(built, []), built, 'keep-only never strips it')
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

test('withoutAuthors and keepOnlyAuthors rewrite membro, diario and momentos', async (t) => {
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
  t.is(s.screenKeepOnlyAuthors(diary, []), diary, 'a follow change leaves the own diary as it is')
  t.is(s.screenKeepOnlyAuthors(diary, [FOLLOW]), diary, 'a set without the stranger changes nothing')
  const noFollow = s.screenWithoutAuthors(diary, [FOLLOW])
  t.alike(Object.keys(noFollow.body.originals), [STRANGER + ':2'], 'a blocked author\'s originals go')
  t.alike(noFollow.body.names.map((n) => n.author), [STRANGER], 'and the name')
  t.alike(noFollow.body.rows, diary.body.rows.filter((r) => r.record.type !== 'repost'), 'own posts stay; an own repost of a blocked author goes with its original')
  t.ok(s.parseScreenSnapshot(JSON.stringify(noFollow), 'diario', bind()), 'still parses')
  const momentos = s.buildScreenSnapshot('momentos', KINDS.momentos())
  t.alike(s.screenWithoutAuthors(momentos, [FOLLOW]).body, { authors: [], own: momentos.body.own, names: [] }, 'momentos loses the author and the name')
  t.alike(s.screenKeepOnlyAuthors(momentos, [FOLLOW]), momentos)
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

test('poll posts are skipped in diario and membro, never failing the snapshot', async (t) => {
  const s = await load()
  const log = diaryLog()
  log.entries.unshift({ seq: 10, record: { type: 'post', text: 'enquete', at: at(10), replyTo: null, poll: { options: ['a', 'b'] } } })
  const d = s.buildScreenSnapshot('diario', { ...KINDS.diario(), log })
  t.ok(d, 'diario still builds')
  t.alike(d.body.rows.map((r) => r.seq), [9, 8, 4], 'the poll record is left out')
  t.ok(s.parseScreenSnapshot(JSON.stringify(d), 'diario', bind()))
  const input = memberInput(FOLLOW)
  input.items.unshift(post(FOLLOW, 6, { poll: { options: ['a', 'b'] } }))
  const m = s.buildScreenSnapshot('membro', { ...id(), ...input, previous: null })
  t.ok(m, 'membro still builds')
  t.absent(JSON.stringify(m).includes('"poll"'))
  t.ok(s.parseScreenSnapshot(JSON.stringify(m), 'membro', bind()))
})

test('conversasGrupos keeps a group without community and refuses any other community value', async (t) => {
  const s = await load()
  const solo = { community: null, group: G2, role: 'creator', general: false, visibility: 'public', name: 'Praia' }
  const built = s.buildScreenSnapshot('conversasGrupos', { ...KINDS.conversasGrupos(), rows: [solo] })
  const back = s.parseScreenSnapshot(JSON.stringify(built), 'conversasGrupos', bind())
  t.alike(back.body.rows, [{ community: null, group: G2, role: 'creator', general: false, name: 'Praia' }])
  for (const community of [undefined, '', 'ab', 'AB'.repeat(32), 42, false]) {
    const b = s.buildScreenSnapshot('conversasGrupos', { ...KINDS.conversasGrupos(), rows: [{ ...solo, community }] })
    t.alike(b.body.rows, [], 'build drops ' + String(community))
    const forged = { ...built, body: { ...built.body, rows: [{ community, group: G2, role: 'creator', general: false, name: 'Praia' }] } }
    t.is(s.parseScreenSnapshot(JSON.stringify(forged), 'conversasGrupos', bind()), null, 'parse refuses ' + String(community))
  }
})

test('the row validators live in snapshotParts and keep their results', async (t) => {
  const s = await load()
  const p = await import('../src/snapshotParts.js')
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/screenSnapshot.js'), 'utf8')
  t.absent(/\nfunction (itemOf|profileOf|mediaOf|cardOf|targetOf|avatarField) \(/.test(src), 'no second copy in screenSnapshot.js')
  t.ok(/import \{[^}]*\bitemOf\b[^}]*\bprofileOf\b[^}]*\} from '\.\/snapshotParts\.js'/.test(src))
  t.alike(p.itemOf({ kind: 'post', author: FOLLOW, seq: 2, at: at(2), text: 'oi' }, false), post(FOLLOW, 2, { text: 'oi' }), 'loose: missing optionals read as null')
  t.is(p.itemOf({ kind: 'post', author: FOLLOW, seq: 2, at: at(2), text: 'oi' }, true), null, 'strict: the exact shape')
  t.alike(p.itemOf(post(FOLLOW, 2, { extra: 1 }), false), post(FOLLOW, 2), 'loose: extra keys ignored')
  t.is(p.itemOf(post(FOLLOW, 2, { extra: 1 }), true), null)
  t.is(p.itemOf(post(FOLLOW, 2, { poll: ['a', 'b'] }), false), null, 'a poll post is never kept')
  t.is(p.itemOf({ ...repost(FOLLOW, 3, { author: OWN, seq: 1 }), text: 'x' }, true), null, 'a repost with text')
  t.is(p.itemOf(post(FOLLOW, 2, { replyTo: { author: OWN, seq: 1 }, quote: { author: OWN, seq: 1 } }), false), null, 'reply and quote at once')
  t.alike(p.profileOf({ name: 'Bia', avatar }, false), { name: 'Bia', username: null, bio: null, avatar })
  t.is(p.profileOf({ name: 'Bia', avatar }, true), null)
  const built = s.buildScreenSnapshot('membro', KINDS.membro())
  t.alike(built.body.authors[FOLLOW].items, memberInput(FOLLOW).items.map((i) => p.itemOf(i, false)), 'membro keeps exactly what itemOf gives')
})

test('a delegated kind keeps the shared size and age rules', async (t) => {
  const s = await load()
  const { peekCodec } = await import('../src/peekSnapshot.js')
  t.ok(s.SCREEN_SNAPSHOT_KINDS.includes('espiadinha'))
  t.alike(s.SCREEN_SNAPSHOT_KINDS.slice(0, 6), ['diario', 'perfil', 'membro', 'conversasGrupos', 'comunidades', 'momentos'], 'the older kinds keep their order')
  t.ok(peekCodec.maxBytes <= s.SCREEN_SNAPSHOT_MAX_BYTES)
  t.ok(peekCodec.maxAgeMs <= s.SCREEN_SNAPSHOT_MAX_AGE_MS)
  const built = s.buildScreenSnapshot('espiadinha', KINDS.espiadinha())
  t.alike(Object.keys(built), ['v', 'kind', 'origin', 'association', 'owner', 'savedAt', 'body'], 'the same envelope')
  const text = JSON.stringify(built)
  t.is(s.parseScreenSnapshot(text + ' '.repeat(peekCodec.maxBytes), 'espiadinha', bind()), null, 'the codec\'s cap, not the shared one')
  t.is(s.parseScreenSnapshot(JSON.stringify({ ...built, body: null }), 'espiadinha', bind()), null, 'a body that is not an object')
  t.is(s.parseScreenSnapshot(JSON.stringify({ ...built, extra: 1 }), 'espiadinha', bind()), null, 'an envelope key')
})

test('listas is a delegated kind with its own cap and the shared envelope', async (t) => {
  const s = await load()
  const { listsCodec } = await import('../src/listsSnapshot.js')
  t.ok(s.SCREEN_SNAPSHOT_KINDS.includes('listas'))
  const built = s.buildScreenSnapshot('listas', KINDS.listas())
  t.alike(Object.keys(built.body.lists), ['curtidas'])
  const text = JSON.stringify(built)
  t.is(s.parseScreenSnapshot(text + ' '.repeat(listsCodec.maxBytes), 'listas', bind()), null, 'the whole stored text counts')
  t.is(s.parseScreenSnapshot(text, 'listas', bind({ now: NOW + 15 * DAY })), null, 'the envelope expires')
  t.is(s.parseScreenSnapshot(text, 'listas', bind({ owner: FOLLOW })), null, 'another owner')
  // The rewrite reads the entry ages against the real clock.
  const live = s.buildScreenSnapshot('listas', { ...KINDS.listas(), now: Date.now() })
  t.alike(s.screenWithoutAuthors(live, [FOLLOW]).body.lists.curtidas.rows, [], 'a block drops the row')
  t.alike(s.screenWithoutAuthors(live, [STRANGER]).body.lists, {}, 'a block of the post author drops the whole entry')
})

test('bloqueios and silenciados are delegated kinds a block or a follow change leaves alone', async (t) => {
  const s = await load()
  const { bloqueiosCodec, silenciadosCodec } = await import('../src/quietLists.js')
  t.alike(s.SCREEN_SNAPSHOT_KINDS.slice(-2), ['bloqueios', 'silenciados'])
  for (const [kind, codec] of [['bloqueios', bloqueiosCodec], ['silenciados', silenciadosCodec]]) {
    const built = s.buildScreenSnapshot(kind, { ...id(), keys: [STRANGER, FOLLOW] })
    t.alike(built.body, { keys: [FOLLOW, STRANGER] }, kind + ' keeps the keys sorted')
    const text = JSON.stringify(built)
    t.is(s.parseScreenSnapshot(text + ' '.repeat(codec.maxBytes), kind, bind()), null, kind + ': the whole stored text counts')
    t.is(s.parseScreenSnapshot(text, kind, bind({ now: NOW + 15 * DAY })), null, kind + ': the envelope expires')
    t.is(s.parseScreenSnapshot(text, kind === 'bloqueios' ? 'silenciados' : 'bloqueios', bind()), null, kind + ': another kind')
    t.alike(s.screenWithoutAuthors(built, [STRANGER]), built, kind + ': a block keeps the list')
    t.alike(s.screenKeepOnlyAuthors(built, [OWN]), built, kind + ': a follow change keeps the list')
  }
})

test('membro: a post item keeps a valid thumbs list; a bad stored one fails the kind', async (t) => {
  const s = await load()
  const photo = { core: '12'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1000, sha256: '34'.repeat(32), width: 1200, height: 900 }
  const thumb = { ...photo, start: 2, sha256: '9a'.repeat(32), width: 640, height: 480 }
  const member = s.buildScreenSnapshot('membro', { ...KINDS.membro(), items: [post(FOLLOW, 6, { media: [photo], thumbs: [thumb] }), ...memberInput(FOLLOW).items] })
  const rows = member.body.authors[FOLLOW].items
  t.alike(rows[0].thumbs, [thumb], 'kept')
  t.ok(rows.slice(1).every((r) => !('thumbs' in r)), 'written only when present')
  t.alike(s.parseScreenSnapshot(JSON.stringify(member), 'membro', bind()), member, 'round trip')
  for (const thumbs of [null, [], [null], [{ ...thumb, bytes: 65537, blocks: 3 }], [{ ...thumb, mime: 'image/png' }]]) {
    const copy = JSON.parse(JSON.stringify(member))
    copy.body.authors[FOLLOW].items[0].thumbs = thumbs
    t.is(s.parseScreenSnapshot(JSON.stringify(copy), 'membro', bind()), null, 'parse refuses ' + JSON.stringify(thumbs))
  }
})
