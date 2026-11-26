'use strict'

// The private snapshot codecs (src/privateSnapshot.js) through
// src/screenSnapshot.js: Avisos, the Conversas list, the last pages of
// private conversations and of groups. Strict keys, every cap and eviction
// order, the 14-day age of the envelope and of each entry, no media key or
// nonce, and the block rules.
const test = require('brittle')

const loadRules = () => import('../src/screenSnapshot.js')
const loadPrivate = () => import('../src/privateSnapshot.js')

const OWN = 'aa'.repeat(32)
const FOLLOW = 'bb'.repeat(32)
const STRANGER = 'cc'.repeat(32)
const OTHER = 'dd'.repeat(32)
const ASSOC = 'ee'.repeat(32)
const G1 = '33'.repeat(32)
const G2 = '44'.repeat(32)
const WRITER = '77'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
// The real clock: a block rewrite (screenWithoutAuthors) ages entries by Date.now().
const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000
const ME = Object.freeze({ kind: 'me' })
const PAGE = Object.freeze({ kind: 'page', key: 'ff'.repeat(32), name: 'Loja', username: 'loja' })

const at = (n) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString()
const hex = (n, len) => n.toString(16).padStart(len, '0')
const peerKey = (n) => hex(n + 1, 2).repeat(32)
const avatar = { core: '56'.repeat(32), mime: 'image/webp', start: 1, blocks: 2, bytes: 40000, sha256: '78'.repeat(32), width: 512, height: 512 }
const id = (extra = {}) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now: NOW, ...extra })
const bind = (extra = {}) => ({ origin: ORIGIN, association: ASSOC, owner: OWN, acting: ME, now: NOW, ...extra })
const card = (image) => ({ url: 'https://exemplo.com.br/a', host: 'exemplo.com.br', title: 'Título', desc: 'desc', image })

const notice = (key, seq, extra = {}) => ({ kind: 'follow', key, seq, at: at(seq), name: 'Bia', username: 'bia', seen: hex(seq, 32), avatar: null, ...extra })
const dmRow = (peer, n = 5) => ({ peer, folder: 'inbox', preview: 'oi ' + n, at: at(n), unread: n % 2 === 0, mine: false })
const dmItem = (extra = {}) => ({ id: '12'.repeat(32), key: '34'.repeat(32), nonce: '56'.repeat(24), chunks: 1, bytes: 1000, sha256: '78'.repeat(32), mime: 'image/jpeg', w: 800, h: 600, ms: 0, ...extra })
const message = (n, extra = {}) => ({ id: hex(n, 32), from: FOLLOW, text: 'mensagem ' + n, replyTo: null, fwd: 0, at: at(n), mine: false, media: null, card: null, ...extra })
const groupItem = (seq, extra = {}) => ({ writer: WRITER, diary: FOLLOW, seq, at: at(seq), text: 'grupo ' + seq, replyTo: null, fwd: 0, media: null, card: null, hidden: false, name: 'Bia', username: 'bia', ...extra })
const privateItem = { core: '99'.repeat(32), mime: 'application/octet-stream', start: 1, blocks: 1, bytes: 32768, sha256: '78'.repeat(32), key: '34'.repeat(32), nonce: '56'.repeat(24), plainMime: 'image/png', plainSha256: '9a'.repeat(32), w: 640, h: 480, ms: 0 }
const publicItem = { core: '99'.repeat(32), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 20000, sha256: '78'.repeat(32), width: 1024, height: 768 }

const groupRows = () => [
  { community: null, group: G1, role: 'admin', general: false, visibility: 'public', name: 'Aberto' },
  { community: null, group: G2, role: 'member', general: false, visibility: 'private', name: 'Segredo', unread: 2 }
]

const INPUT = {
  avisos: () => ({ ...id(), notices: [notice(FOLLOW, 3, { kind: 'like', post: OWN + ':4' }), notice(STRANGER, 2, { avatar })], blocked: [] }),
  conversas: () => ({ ...id(), rows: [dmRow(FOLLOW), dmRow(STRANGER, 4)], groups: groupRows() }),
  mensagens: () => ({ ...id(), previous: null, peer: FOLLOW, messages: [message(1), message(2, { media: [dmItem()], reactions: [{ emoji: '❤️', mine: true }] })], blocked: [] }),
  grupoMensagens: () => ({ ...id(), previous: null, group: G2, items: [groupItem(2, { media: [privateItem] }), groupItem(1, { reactions: [{ emoji: '👍', count: 2, mine: false }] })], blocked: [] })
}
const KINDS = Object.keys(INPUT)

const build = async (kind, extra = {}) => (await loadRules()).buildScreenSnapshot(kind, { ...INPUT[kind](), ...extra })
const reparse = async (snap, kind, extra = {}) => (await loadRules()).parseScreenSnapshot(JSON.stringify(snap), kind, bind(extra))

test('every private kind round-trips through the envelope', async (t) => {
  const s = await loadRules()
  for (const kind of KINDS) {
    t.ok(s.SCREEN_SNAPSHOT_KINDS.includes(kind), kind + ' is registered')
    const built = await build(kind)
    t.ok(built, kind + ' builds')
    t.alike(await reparse(built, kind), built, kind + ' parses back the same')
  }
})

test('a page actor, a missing actor and another binding are refused', async (t) => {
  const s = await loadRules()
  for (const kind of KINDS) {
    t.is(await build(kind, { acting: PAGE }), null, kind + ' page build')
    t.is(await build(kind, { acting: undefined }), null, kind + ' build without an actor')
    const built = await build(kind)
    t.is(await reparse(built, kind, { acting: PAGE }), null, kind + ' page parse')
    t.is(await reparse(built, kind, { owner: FOLLOW }), null, kind + ' another owner')
    t.is(await reparse(built, kind, { origin: 'https://outro.app' }), null, kind + ' another origin')
    t.is(await reparse(built, kind, { association: 'ab'.repeat(32) }), null, kind + ' another association')
    t.ok(await reparse(built, kind, { now: NOW + 13 * DAY }), kind + ' 13 days later')
    t.is(await reparse(built, kind, { now: NOW + 15 * DAY }), null, kind + ' 15 days later')
    t.is(s.parseScreenSnapshot(JSON.stringify(built), kind, bind({ now: NOW - 2 * DAY })), null, kind + ' from the future')
  }
})

test('strict keys: an unknown key anywhere fails the parse', async (t) => {
  const bad = async (kind, change) => {
    const copy = JSON.parse(JSON.stringify(await build(kind)))
    change(copy.body)
    return reparse(copy, kind)
  }
  for (const kind of KINDS) t.is(await bad(kind, (b) => { b.next = null }), null, kind + ' body key')
  t.is(await bad('avisos', (b) => { b.notices[0].extra = 1 }), null, 'notice key')
  t.is(await bad('avisos', (b) => { delete b.notices[0].seen }), null, 'notice without seen')
  t.is(await bad('conversas', (b) => { b.rows[0].count = 3 }), null, 'dm row key')
  t.is(await bad('conversas', (b) => { b.groups[0].role = 'member' }), null, 'group name key')
  t.is(await bad('mensagens', (b) => { b.threads[FOLLOW].next = null }), null, 'thread entry key')
  t.is(await bad('mensagens', (b) => { b.threads[FOLLOW].messages[0].seen = true }), null, 'message key')
  t.is(await bad('mensagens', (b) => { b.threads[FOLLOW].messages[1].media[0].sha256 = '78'.repeat(32) }), null, 'a stub key beyond mime, w, h, ms')
  t.is(await bad('mensagens', (b) => { b.threads[FOLLOW].messages[1].reactions[0].from = FOLLOW }), null, 'reaction key')
  t.is(await bad('grupoMensagens', (b) => { b.groups[G2].items[0].epoch = null }), null, 'group item key')
  t.is(await bad('grupoMensagens', (b) => { b.groups[G2].items[0].media[0].core = '99'.repeat(32) }), null, 'group stub key')
  t.is(await bad('grupoMensagens', (b) => { b.groups[G2].items[0].card = card({ mime: 'image/jpeg' }) }), null, 'a card with an image')
})

test('a key or a nonce anywhere in mensagens or grupoMensagens fails the parse', async (t) => {
  const p = await loadPrivate()
  const msgs = await build('mensagens')
  const groups = await build('grupoMensagens')
  t.absent(/"(key|nonce)"/.test(JSON.stringify(msgs)), 'build strips the DM media key and nonce')
  t.absent(/"(key|nonce)"/.test(JSON.stringify(groups)), 'build strips the group media key and nonce')
  const m = msgs.body.threads[FOLLOW].messages[1]
  t.alike(m.media, [{ mime: 'image/jpeg', w: 800, h: 600, ms: 0 }], 'the DM stub')
  t.alike(groups.body.groups[G2].items[0].media, [{ mime: 'image/png', w: 640, h: 480, ms: 0 }], 'a private item: its plainMime and size')
  const inject = [
    (b) => { b.key = 'x' },
    (b) => { b.threads[FOLLOW].nonce = 'x' },
    (b) => { b.threads[FOLLOW].messages[1].media[0].key = '34'.repeat(32) },
    (b) => { b.threads[FOLLOW].messages[1].media[0].nonce = '56'.repeat(24) },
    (b) => { b.threads[FOLLOW].messages[1].reactions[0].key = FOLLOW }
  ]
  for (const change of inject) {
    const copy = JSON.parse(JSON.stringify(msgs.body))
    change(copy)
    t.is(p.mensagensCodec.parse(copy, { now: NOW }), null)
  }
  const gcopy = JSON.parse(JSON.stringify(groups.body))
  gcopy.groups[G2].items[0].media[0].nonce = '56'.repeat(24)
  t.is(p.grupoMensagensCodec.parse(gcopy, { now: NOW }), null, 'a group nonce')
  const withCard = await build('mensagens', { messages: [message(3, { card: card(dmItem()) })] })
  t.alike(withCard.body.threads[FOLLOW].messages[0].card, card(null), 'a card is kept with image: null')
  const gone = await build('mensagens', { messages: [message(3, { media: { unavailable: true } })] })
  t.alike(gone.body.threads[FOLLOW].messages[0].media, { unavailable: true })
  const pub = await build('grupoMensagens', { items: [groupItem(1, { media: [publicItem] })] })
  t.alike(pub.body.groups[G2].items[0].media, [{ mime: 'image/jpeg', w: 1024, h: 768 }], 'a public descriptor: width and height, no ms')
})

test('avisos: 60 notices, blocked ones left out, removal by the notice key and never by the owner', async (t) => {
  const s = await loadRules()
  const many = Array.from({ length: 70 }, (_, i) => notice(peerKey(i % 60), i + 1))
  const built = await build('avisos', { notices: many, next: { at: at(1), key: FOLLOW }, incomplete: true, activity: true })
  t.is(built.body.notices.length, 60)
  t.alike(Object.keys(built.body), ['notices'], 'next, incomplete and activity are not stored')
  t.is(await build('avisos', { blocked: undefined }), null, 'no block list, nothing built')
  const blocked = await build('avisos', { blocked: [STRANGER] })
  t.alike(blocked.body.notices.map((n) => n.key), [FOLLOW])
  const own = await build('avisos', { notices: [notice(FOLLOW, 3), notice(STRANGER, 2)] })
  t.alike(s.screenWithoutAuthors(own, [STRANGER]).body.notices.map((n) => n.key), [FOLLOW], 'the notice of the blocked key goes')
  t.alike(s.screenWithoutAuthors(own, [OWN]).body.notices.length, 2, 'the owner key removes nothing')
  t.alike(s.screenKeepOnlyAuthors(own, []), own, 'an unfollow changes nothing')
})

test('conversas: 30 rows, 256 private groups, removal by peer', async (t) => {
  const s = await loadRules()
  const rows = Array.from({ length: 40 }, (_, i) => dmRow(peerKey(i), i + 1))
  const groups = Array.from({ length: 300 }, (_, i) => ({ group: hex(i + 1, 64), visibility: 'private', name: 'g' + i }))
  const built = await build('conversas', { rows, groups, requests: true, inboxUnread: true })
  t.is(built.body.rows.length, 30)
  t.is(built.body.groups.length, 256)
  t.alike(Object.keys(built.body), ['rows', 'groups'], 'requests and inboxUnread are not stored')
  const small = await build('conversas')
  t.alike(small.body.groups, [{ group: G2, name: 'Segredo' }], 'only the private group, without its other fields')
  t.alike(s.screenWithoutAuthors(small, [STRANGER]).body.rows.map((r) => r.peer), [FOLLOW])
  const blocked = await build('conversas', { blocked: [FOLLOW] })
  t.alike(blocked.body.rows.map((r) => r.peer), [STRANGER])
})

test('mensagens: 30 newest messages, 28672 bytes, 8 peers with the oldest save out first', async (t) => {
  const p = await loadPrivate()
  const s = await loadRules()
  const msgs = Array.from({ length: 40 }, (_, i) => message(i + 1))
  const one = p.putThread(null, FOLLOW, msgs, NOW)
  t.alike(one.threads[FOLLOW].messages.map((m) => m.id), msgs.slice(10).map((m) => m.id), 'the 30 newest, oldest first')
  const long = Array.from({ length: 30 }, (_, i) => message(i + 1, { text: 'x'.repeat(1500) }))
  const cut = p.putThread(null, FOLLOW, long, NOW).threads[FOLLOW]
  t.ok(JSON.stringify(cut).length <= p.THREAD_MAX_BYTES)
  t.ok(cut.messages.length < 30)
  t.is(cut.messages[cut.messages.length - 1].id, long[29].id, 'the older messages go first')

  let body = null
  for (let i = 0; i < 10; i++) body = p.putThread(body, peerKey(i), [message(1)], NOW - (10 - i) * 1000)
  t.is(Object.keys(body.threads).length, 8)
  t.absent(peerKey(0) in body.threads, 'the oldest save went')
  t.absent(peerKey(1) in body.threads)
  const removed = p.removeThread(body, peerKey(9))
  t.absent(peerKey(9) in removed.threads)

  // A fit that takes only three threads keeps the three newest saves.
  let calls = 0
  const fitted = p.mensagensCodec.build({ previous: body, blocked: [] }, { fits: (b) => { calls++; return Object.keys(b.threads).length <= 3 }, now: NOW })
  t.ok(calls > 1)
  t.alike(Object.keys(fitted.threads), [peerKey(9), peerKey(8), peerKey(7)])
  t.is(p.mensagensCodec.build({ previous: body }, { fits: () => true, now: NOW }), null, 'no block list, nothing built')
  const blocked = p.mensagensCodec.build({ previous: body, blocked: [peerKey(9)] }, { fits: () => true, now: NOW })
  t.absent(peerKey(9) in blocked.threads)

  const snap = await build('mensagens', { previous: body, peer: FOLLOW, messages: [message(1)] })
  t.is(Object.keys(snap.body.threads).length, 8)
  t.is(Object.keys(snap.body.threads)[0], FOLLOW)
  t.alike(Object.keys(s.screenWithoutAuthors(snap, [FOLLOW]).body.threads).includes(FOLLOW), false, 'a block removes the thread')
  t.alike(s.screenKeepOnlyAuthors(snap, []), snap, 'a peer need not be followed')
})

test('grupoMensagens: 26 newest items, 40960 bytes, 6 groups, removal by diary', async (t) => {
  const p = await loadPrivate()
  const s = await loadRules()
  const items = Array.from({ length: 30 }, (_, i) => groupItem(30 - i))
  const one = p.putGroup(null, G1, items, NOW)
  t.alike(one.groups[G1].items.map((i) => i.seq), items.slice(0, 26).map((i) => i.seq), 'the 26 newest')
  const long = Array.from({ length: 26 }, (_, i) => groupItem(26 - i, { text: 'x'.repeat(2000) }))
  const cut = p.putGroup(null, G1, long, NOW).groups[G1]
  t.ok(JSON.stringify(cut).length <= p.GROUP_ENTRY_MAX_BYTES)
  t.ok(cut.items.length < 26)
  t.is(cut.items[0].seq, 26, 'the older items go first')

  let body = null
  for (let i = 0; i < 8; i++) body = p.putGroup(body, peerKey(i), [groupItem(1)], NOW - (8 - i) * 1000)
  t.is(Object.keys(body.groups).length, 6)
  t.absent(peerKey(0) in body.groups)
  t.absent(peerKey(1) in body.groups)
  t.absent(peerKey(7) in p.removeGroup(body, peerKey(7)).groups)

  // The blocked member writes through a writer core whose key is not the diary.
  const mixed = await build('grupoMensagens', { items: [groupItem(3, { diary: STRANGER }), groupItem(2), groupItem(1, { diary: STRANGER, writer: '88'.repeat(32) })] })
  const dropped = s.screenWithoutAuthors(mixed, [STRANGER])
  t.alike(dropped.body.groups[G2].items.map((i) => i.seq), [2], 'items go by diary')
  t.alike(s.screenWithoutAuthors(mixed, [WRITER]).body.groups[G2].items.length, 3, 'a writer key is not a block')
  t.ok(await reparse(dropped, 'grupoMensagens'))
  const blocked = await build('grupoMensagens', { items: [groupItem(3, { diary: STRANGER }), groupItem(2)], blocked: [STRANGER] })
  t.alike(blocked.body.groups[G2].items.map((i) => i.seq), [2])
  t.is(await build('grupoMensagens', { blocked: undefined }), null, 'no block list, nothing built')
})

test('each entry expires 14 days after its own save: saving one never renews another', async (t) => {
  const p = await loadPrivate()
  const s = await loadRules()
  let body = p.putThread(null, OTHER, [message(1)], NOW)
  for (const d of [3, 7, 10, 13]) body = p.putThread(body, FOLLOW, [message(d)], NOW + d * DAY)
  t.ok(OTHER in body.threads, 'still within its 14 days')
  body = p.putThread(body, FOLLOW, [message(15)], NOW + 15 * DAY)
  t.absent(OTHER in body.threads, 'the untouched thread expired though another was saved every few days')
  t.is(body.threads[FOLLOW].savedAt, NOW + 15 * DAY)

  const two = await build('mensagens', { previous: p.putThread(null, OTHER, [message(1)], NOW - 13 * DAY) })
  t.ok(OTHER in two.body.threads)
  const later = await reparse(two, 'mensagens', { now: NOW + 2 * DAY })
  t.alike(Object.keys(later.body.threads), [FOLLOW], 'parse drops the expired entry and keeps the envelope')
  t.alike(Object.keys(p.mensagensCodec.withoutAuthors(two.body, [], { now: NOW + 2 * DAY }).threads), [FOLLOW])
  const built = p.mensagensCodec.build({ previous: two.body, blocked: [] }, { fits: () => true, now: NOW + 2 * DAY })
  t.alike(Object.keys(built.threads), [FOLLOW], 'build drops it too')

  let groups = p.putGroup(null, G1, [groupItem(1)], NOW)
  for (const d of [5, 10, 15]) groups = p.putGroup(groups, G2, [groupItem(d)], NOW + d * DAY)
  t.alike(Object.keys(groups.groups), [G2], 'grupoMensagens: the same per-entry age')
  const g = await build('grupoMensagens', { previous: p.putGroup(null, G1, [groupItem(1)], NOW - 13 * DAY) })
  t.alike(Object.keys((await reparse(g, 'grupoMensagens', { now: NOW + 2 * DAY })).body.groups), [G2])
  t.alike(Object.keys(s.screenWithoutAuthors(g, []).body.groups), [G2, G1], 'a block rewrite keeps an entry still within its days')
})

test('a body that never fits builds nothing', async (t) => {
  const p = await loadPrivate()
  const no = { fits: () => false, now: NOW }
  t.is(p.avisosCodec.build({ notices: [notice(FOLLOW, 1)], blocked: [] }, no), null)
  t.is(p.conversasCodec.build({ rows: [dmRow(FOLLOW)], groups: [] }, no), null)
  t.is(p.mensagensCodec.build({ peer: FOLLOW, messages: [message(1)], blocked: [] }, no), null)
  t.is(p.grupoMensagensCodec.build({ group: G1, items: [groupItem(1)], blocked: [] }, no), null)
})
