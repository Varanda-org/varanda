'use strict'

// The direct message folders (lib/dm-fold.js). No network.
const test = require('brittle')
const { fold, seenKey, tabDot, replyTarget, canSend, previewText, PREVIEW_PHOTO, PREVIEW_GIF, PREVIEW_AUDIO } = require('../lib/dm-fold')
const { DM_REQUESTS_MAX, DM_MESSAGES_PER_PEER } = require('../lib/dm')

function k (i) {
  return i.toString(16).padStart(64, '0')
}

const ME = k(1)
const ANA = k(2)
const BIA = k(3)
const CAIO = k(4)
const T = (min) => new Date(Date.UTC(2026, 10, 3, 12, min)).toISOString()
// Local filing time in ms; by default a row is filed at its own minute.
const F = (min) => Date.UTC(2026, 10, 3, 12, min)
const FUTURE = '9999-12-31T00:00:00.000Z'

let next = 1
function id () {
  return (next++).toString(16).padStart(32, '0')
}

function from (peer, min, text = 'oi') {
  return { id: id(), from: peer, to: ME, text, replyTo: null, at: T(min), filedAt: F(min) }
}

function to (peer, min, text = 'oi') {
  return { id: id(), from: ME, to: peer, text, replyTo: null, at: T(min), filedAt: F(min) }
}

function op (name, peer, min) {
  return { op: name, peer, at: T(min), filedAt: F(min) }
}

function run ({ messages = [], ops = [], follows = [], seen = [] } = {}) {
  return fold({ self: ME, followSet: new Set(follows), messages, ops, seen: new Set(seen) })
}

test('followed peer lands in the inbox, a stranger in requests', (t) => {
  const a = from(ANA, 1)
  const b = from(BIA, 2)
  const r = run({ messages: [a, b], follows: [ANA] })
  t.is(r.inbox.length, 1)
  t.is(r.inbox[0].peer, ANA)
  t.is(r.inbox[0].folder, 'inbox')
  t.is(r.requests.length, 1)
  t.is(r.requests[0].peer, BIA)
  t.is(r.requests[0].folder, 'request')
  t.alike(Object.keys(r.inbox[0]).sort(), ['at', 'folder', 'messages', 'peer', 'unread'])
})

test('accepted moves a request to the inbox; unfollow does not demote it', (t) => {
  const m = from(BIA, 1)
  t.is(run({ messages: [m], ops: [op('accepted', BIA, 2)] }).inbox[0].peer, BIA)
  t.is(run({ messages: [m], ops: [op('accepted', BIA, 2)], follows: [] }).requests.length, 0)
  t.is(run({ messages: [m], follows: [BIA] }).inbox.length, 1, 'a later follow moves an open request')
  t.is(run({ messages: [m], ops: [op('accepted', BIA, 2), op('declined', BIA, 3)] }).inbox.length, 0, 'newest folder op wins')
})

test('declined hides the current request; a later message is a new request', (t) => {
  const first = from(BIA, 1)
  const r = run({ messages: [first], ops: [op('declined', BIA, 2)] })
  t.is(r.requests.length, 0)
  t.is(r.inbox.length, 0)
  const later = from(BIA, 3, 'de novo')
  const r2 = run({ messages: [first, later], ops: [op('declined', BIA, 2)] })
  t.is(r2.requests.length, 1)
  t.alike(r2.requests[0].messages.map(m => m.text), ['de novo'])
  const atSame = from(BIA, 2)
  t.is(run({ messages: [atSame], ops: [op('declined', BIA, 2)] }).requests.length, 0, 'at or before')
})

test('declined never drops an own reply (multi-device race)', (t) => {
  const request = from(BIA, 1)
  const reply = to(BIA, 2)
  const r = run({ messages: [request, reply], ops: [op('declined', BIA, 3)] })
  t.is(r.requests.length, 0)
  t.is(r.inbox.length, 1, 'own message keeps the thread in the inbox')
  t.alike(r.inbox[0].messages.map(m => m.id), [reply.id], 'own reply kept, peer request hidden')
  t.is(run({ messages: [reply], ops: [op('deleted', BIA, 3)] }).inbox.length, 0, 'only deleted removes it')
})

test('blocked drops messages and blocks sending', (t) => {
  const m = from(ANA, 1)
  const newer = from(ANA, 5)
  const r = run({ messages: [m, newer], follows: [ANA], ops: [op('blocked', ANA, 2)], seen: [] })
  t.is(r.inbox.length, 0)
  t.absent(tabDot(r), 'not unread')
  t.absent(canSend({ self: ME, peer: ANA, ops: [op('blocked', ANA, 2)] }))
  t.ok(canSend({ self: ME, peer: ANA, ops: [op('blocked', ANA, 2), op('unblocked', ANA, 3)] }))
  t.absent(canSend({ self: ME, peer: ANA, ops: [op('unblocked', ANA, 3), op('blocked', ANA, 3)] }), 'tie: blocked wins')
  const after = run({ messages: [m, newer], follows: [ANA], ops: [op('blocked', ANA, 2), op('unblocked', ANA, 3)] })
  t.alike(after.inbox[0].messages.map(x => x.id), [newer.id], 'messages before the block stay dropped')
  t.absent(canSend({ self: ME, peer: ME, ops: [] }), 'never to self')
  t.ok(canSend({ self: ME, peer: BIA, ops: [] }))
  t.absent(canSend({ self: ME, peer: 'nope', ops: [] }))
})

test('deleted hides messages at or before it', (t) => {
  const a = from(ANA, 1)
  const b = to(ANA, 2)
  const c = from(ANA, 3)
  const r = run({ messages: [a, b, c], follows: [ANA], ops: [op('deleted', ANA, 2)] })
  t.alike(r.inbox[0].messages.map(m => m.id), [c.id])
  t.is(run({ messages: [a, b], follows: [ANA], ops: [op('deleted', ANA, 2)] }).inbox.length, 0)
})

test('own sent messages sit under the peer, in the inbox', (t) => {
  const mine = to(CAIO, 1)
  const reply = from(CAIO, 2)
  const r = run({ messages: [mine, reply] })
  t.is(r.inbox.length, 1)
  t.is(r.inbox[0].peer, CAIO)
  t.alike(r.inbox[0].messages.map(m => [m.id, m.mine]), [[mine.id, true], [reply.id, false]])
  t.is(r.requests.length, 0)
  const other = { id: id(), from: ANA, to: BIA, text: 'x', replyTo: null, at: T(1) }
  t.is(run({ messages: [other] }).inbox.length + run({ messages: [other] }).requests.length, 0, 'not ours')
})

test('unread and the tab dot are booleans', (t) => {
  const a = from(ANA, 1)
  const mine = to(BIA, 2)
  const r = run({ messages: [a, mine], follows: [ANA, BIA] })
  t.is(r.inbox.find(x => x.peer === ANA).unread, true)
  t.is(r.inbox.find(x => x.peer === BIA).unread, false, 'own messages are never unread')
  t.is(tabDot(r), true)
  t.is(tabDot(r.inbox), true)
  t.is(tabDot(run({ messages: [a, mine], follows: [ANA, BIA], seen: [seenKey(a.from, a.id)] })), false)
  t.is(tabDot(null), false)
  for (const thread of r.inbox) {
    for (const key of Object.keys(thread)) t.absent(['read', 'delivered', 'typing'].includes(key))
  }
})

test('threads sort newest first, then by peer', (t) => {
  const r = run({ messages: [from(ANA, 1), from(BIA, 3), from(CAIO, 3)], follows: [ANA, BIA, CAIO] })
  t.alike(r.inbox.map(x => x.peer), [BIA, CAIO, ANA])
})

test('caps: requests and messages per peer', (t) => {
  const messages = []
  for (let i = 0; i < DM_REQUESTS_MAX + 5; i++) messages.push({ ...from(k(100 + i), 0), at: new Date(Date.UTC(2026, 10, 3, 0, 0, i)).toISOString() })
  const r = run({ messages })
  t.is(r.requests.length, DM_REQUESTS_MAX)
  t.is(r.requests[0].peer, k(100 + DM_REQUESTS_MAX + 4), 'newest kept')

  const many = []
  for (let i = 0; i < DM_MESSAGES_PER_PEER + 3; i++) many.push({ ...from(ANA, 0), at: new Date(Date.UTC(2026, 10, 3, 0, 0, i)).toISOString() })
  const thread = run({ messages: many, follows: [ANA] }).inbox[0]
  t.is(thread.messages.length, DM_MESSAGES_PER_PEER)
  t.is(thread.messages[thread.messages.length - 1].id, many[many.length - 1].id)
  t.is(thread.messages[0].id, many[3].id)
})

test('replyTarget stays inside one thread', (t) => {
  const a = from(ANA, 1)
  const b = from(BIA, 2)
  const r = run({ messages: [a, b], follows: [ANA, BIA] })
  const anaThread = r.inbox.find(x => x.peer === ANA)
  t.is(replyTarget(anaThread.messages, a.id).id, a.id)
  t.is(replyTarget(anaThread.messages, b.id), null, 'another peer')
  const mixed = [...anaThread.messages, ...r.inbox.find(x => x.peer === BIA).messages]
  t.is(replyTarget(mixed, a.id), null, 'not a single thread')
  t.is(replyTarget(null, a.id), null)
})

test('hostile input never throws', (t) => {
  t.alike(fold(), { inbox: [], requests: [] })
  t.alike(fold({ self: ME, messages: [null, 1, { id: 'x' }, { ...from(ANA, 1), at: 'nope' }], ops: [null, { op: 'blocked' }] }), { inbox: [], requests: [] })
  const dup = from(ANA, 1)
  t.is(run({ messages: [dup, dup], follows: [ANA] }).inbox[0].messages.length, 1, 'duplicate ids once')
})

test('a future `at` defeats no cutoff and pins no thread', (t) => {
  const early = { ...from(BIA, 1), at: FUTURE }
  t.is(run({ messages: [early], ops: [op('declined', BIA, 2)] }).requests.length, 0, 'filed before the decline: hidden')
  const late = { ...from(BIA, 3), at: FUTURE }
  const r = run({ messages: [late], ops: [op('declined', BIA, 2)] })
  t.is(r.requests.length, 1, 'filed after the decline: a new request')
  t.is(r.requests[0].messages[0].sentAt, FUTURE, 'sentAt keeps the claim')
  t.is(r.requests[0].messages[0].at, T(3), 'at is the effective time')

  t.is(run({ messages: [early], follows: [BIA], ops: [op('deleted', BIA, 2)] }).inbox.length, 0, 'delete removes it')
  const after = run({ messages: [early], follows: [BIA], ops: [op('blocked', BIA, 2), op('unblocked', BIA, 3)] })
  t.is(after.inbox.length, 0, 'filed before the block stays hidden after unblock')

  const real = from(ANA, 5)
  const pinned = run({ messages: [early, real], follows: [ANA, BIA] })
  t.alike(pinned.inbox.map(x => x.peer), [ANA, BIA], 'a newer real thread sorts first')

  // An op's own `at` is never read: only its filing time counts.
  t.is(run({ messages: [from(BIA, 3)], ops: [{ op: 'declined', peer: BIA, at: FUTURE, filedAt: F(2) }] }).requests.length, 1)
})

test('rows without a valid filedAt are ignored', (t) => {
  const { filedAt, ...unfiled } = from(ANA, 1)
  t.is(typeof filedAt, 'number')
  t.is(run({ messages: [unfiled], follows: [ANA] }).inbox.length, 0)
  // A filedAt outside the Date range is ignored, never thrown on, and does
  // not take the other threads down with it.
  const huge = { ...from(BIA, 1), filedAt: -9e15 }
  t.execution(() => run({ messages: [huge, from(ANA, 1)], follows: [ANA, BIA] }))
  t.alike(run({ messages: [huge, from(ANA, 1)], follows: [ANA, BIA] }).inbox.map(x => x.peer), [ANA])
  t.is(run({ messages: [{ ...from(ANA, 1), filedAt: 'x' }], follows: [ANA] }).inbox.length, 0)
  t.is(run({ messages: [from(ANA, 1)], follows: [ANA], ops: [{ op: 'deleted', peer: ANA, at: T(2) }] }).inbox.length, 1, 'unfiled op ignored')
  t.ok(canSend({ self: ME, peer: ANA, ops: [{ op: 'blocked', peer: ANA, at: T(2) }] }))
})

test('an id belongs to the first filed copy in a thread: a peer cannot shadow or backdate my message id', (t) => {
  const mine = to(ANA, 1, 'meu')
  // The peer copies my id, even backdated to sort first: filed later, dropped.
  const clash = { ...from(ANA, 2, 'falso'), id: mine.id, at: '2000-01-01T00:00:00.000Z' }
  const r = run({ messages: [clash, mine], follows: [ANA] })
  t.alike(r.inbox[0].messages.map(m => [m.text, m.mine]), [['meu', true]], 'only my message is kept')
  t.is(replyTarget(r.inbox[0].messages, mine.id).text, 'meu', 'a quote of that id is my message')

  // On another own device the peer's copy may be filed BEFORE the self copy
  // arrives: the own message still keeps its id.
  const early = { ...from(ANA, 0, 'antes'), id: mine.id }
  const late = { ...mine, filedAt: F(5) }
  const rOwn = run({ messages: [early, late], follows: [ANA] })
  t.alike(rOwn.inbox[0].messages.map(m => [m.text, m.mine]), [['meu', true]], 'own copy wins even when filed later')

  // The same id in two different conversations is two messages.
  const other = { ...from(BIA, 3, 'outra conversa'), id: mine.id }
  const r3 = run({ messages: [mine, other], follows: [ANA, BIA] })
  t.is(r3.inbox.length, 2, 'ids are unique per thread, not across threads')

  const first = from(ANA, 3, 'primeiro')
  const again = { ...from(ANA, 4, 'segundo'), id: first.id }
  const r2 = run({ messages: [again, first], follows: [ANA] })
  t.alike(r2.inbox[0].messages.map(m => m.text), ['primeiro'], 'first filed wins')
})

test('rows carry the effective at, the claim only as sentAt', (t) => {
  const now = from(ANA, 10)
  const future = { ...from(BIA, 10), at: FUTURE, filedAt: F(5) }
  const r = run({ messages: [now, future], follows: [ANA, BIA] })
  const bia = r.inbox.find(x => x.peer === BIA)
  t.is(bia.messages[0].at, T(5), 'effective at = filing time')
  t.is(bia.messages[0].sentAt, FUTURE)
  t.is(bia.at, T(5), 'thread at is effective too')
  t.alike(r.inbox.map(x => x.peer), [ANA, BIA], 'sorted by the effective at')
  const past = { ...from(CAIO, 9), at: T(1) }
  const c = run({ messages: [past], follows: [CAIO] }).inbox[0]
  t.is(c.messages[0].at, T(1), 'an earlier claim is kept as is')
  t.is(c.messages[0].sentAt, T(1))
})

test('seen marks are per sender', (t) => {
  t.is(seenKey(ANA, 'a'.repeat(32)), ANA + ':' + 'a'.repeat(32))
  const seenMsg = from(ANA, 1)
  const reuse = { ...from(BIA, 2), id: seenMsg.id }
  const r = run({ messages: [seenMsg, reuse], follows: [ANA, BIA], seen: [seenKey(ANA, seenMsg.id)] })
  t.is(r.inbox.find(x => x.peer === ANA).unread, false)
  t.is(r.inbox.find(x => x.peer === BIA).unread, true, 'same id from another sender stays unread')
  t.is(run({ messages: [seenMsg], follows: [ANA], seen: [seenMsg.id] }).inbox[0].unread, true, 'a bare id marks nothing')
})

test('media rows: carried through, fixed preview labels when the text is empty', (t) => {
  const jpeg = { id: 'a'.repeat(64), mime: 'image/jpeg' }
  const gif = { id: 'b'.repeat(64), mime: 'image/gif' }
  const photo = { ...from(ANA, 1, ''), media: [jpeg] }
  const anim = { ...from(ANA, 2, ''), media: [gif, gif] }
  const mixed = { ...to(ANA, 3, ''), media: [gif, jpeg] }
  const caption = { ...from(ANA, 4, 'olha'), media: [jpeg] }
  const plain = from(ANA, 5)
  const r = run({ messages: [photo, anim, mixed, caption, plain], follows: [ANA] })
  const rows = r.inbox[0].messages
  t.alike(rows.map(m => m.media), [[jpeg], [gif, gif], [gif, jpeg], [jpeg], null], 'media kept, null for a text-only row')
  t.alike(rows.map(previewText), ['Foto', 'GIF', 'Foto', 'olha', 'oi'])
  t.is(PREVIEW_PHOTO, 'Foto')
  t.is(PREVIEW_GIF, 'GIF')
  t.is(previewText({ text: '', media: [] }), '', 'no media, no label')
  t.is(previewText({ text: '', media: null }), '')
  t.is(previewText(null), '')
  t.is(previewText({ text: '', media: [null] }), 'Foto', 'a hostile item never shows peer text')
  t.is(PREVIEW_AUDIO, 'Áudio')
  t.is(previewText({ text: '', media: [{ id: 'c'.repeat(64), mime: 'audio/mp4', w: 0, h: 0, ms: 1500 }] }), 'Áudio', 'a voice note previews as Áudio')
  t.is(previewText({ text: 'ouve', media: [{ id: 'c'.repeat(64), mime: 'audio/mp4' }] }), 'ouve', 'text still wins')
  t.alike(run({ messages: [{ ...from(ANA, 1), media: 'x' }], follows: [ANA] }).inbox[0].messages[0].media, null, 'a non-list media is dropped')
})

test('thread rows keep forwards and default v1 bodies to 0', (t) => {
  const messages = [from(ANA, 1), { ...from(ANA, 2), fwd: 1, media: null }, { ...to(ANA, 3), fwd: 1, media: [{ mime: 'image/jpeg' }] }]
  const rows = run({ messages, follows: [ANA] }).inbox[0].messages
  t.alike(rows.map(m => m.fwd), [0, 1, 1])
  t.is(rows[1].media, null)
})

test('fold preserves cards and gives old messages a null card', (t) => {
  const card = { url: 'https://example.org/post', host: 'example.org', title: 'Título', desc: 'Descrição', image: null }
  const a = { ...from(ANA, 1), card }
  const r = run({ messages: [a, from(ANA, 2)], follows: [ANA] })
  t.alike(r.inbox[0].messages[0].card, card)
  t.not(r.inbox[0].messages[0].card, card)
  t.is(r.inbox[0].messages[1].card, null)
})

const HEART = '❤️'
const THUMBS = '\u{1F44D}'
const FIRE = '\u{1F525}'

function rid (n) {
  return 'f' + n.toString(16).padStart(31, '0')
}

// A reaction by `who` (ME or the peer) to row m of the conversation with peer.
function reaction (who, peer, m, emoji, rev, filedMin = 30, over = {}) {
  return { id: rid(rev), from: who, to: who === ME ? peer : ME, target: { from: m.from, id: m.id }, emoji, rev, at: T(filedMin), filedAt: F(filedMin), ...over }
}

function rowOf (r, m) {
  const threads = [...r.inbox, ...r.requests]
  for (const th of threads) {
    const row = th.messages.find(x => x.id === m.id && x.from === m.from)
    if (row) return row
  }
  return undefined
}

function runR (opts, reactions) {
  return fold({ self: ME, followSet: new Set(opts.follows || []), messages: opts.messages || [], ops: opts.ops || [], seen: new Set(opts.seen || []), reactions })
}

test('reactions: either person reacts, rows carry { emoji, mine } only when non-empty', (t) => {
  const a = from(ANA, 1)
  const b = to(ANA, 2)
  const c = from(ANA, 3)
  const r = runR({ messages: [a, b, c], follows: [ANA] }, [reaction(ANA, ANA, a, HEART, 1), reaction(ME, ANA, a, THUMBS, 1), reaction(ANA, ANA, b, FIRE, 1)])
  t.alike(rowOf(r, a).reactions, [{ emoji: HEART, mine: false }, { emoji: THUMBS, mine: true }])
  t.alike(rowOf(r, b).reactions, [{ emoji: FIRE, mine: false }], 'a reaction to my own message')
  t.absent('reactions' in rowOf(r, c), 'no key without a reaction')
  t.alike(Object.keys(rowOf(r, a)), ['id', 'from', 'to', 'text', 'replyTo', 'fwd', 'media', 'card', 'at', 'sentAt', 'mine', 'peer', 'reactions'])
})

test('reactions: the highest rev wins whatever the arrival order, ties by the higher id', (t) => {
  const a = from(ANA, 1)
  const low = reaction(ANA, ANA, a, HEART, 2, 50)
  const high = reaction(ANA, ANA, a, THUMBS, 3, 10, { at: T(1) })
  for (const list of [[low, high], [high, low]]) {
    t.alike(rowOf(runR({ messages: [a], follows: [ANA] }, list), a).reactions, [{ emoji: THUMBS, mine: false }], 'never the sender at nor the filing time')
  }
  const tieLow = reaction(ANA, ANA, a, HEART, 4, 30, { id: 'e'.repeat(32) })
  const tieHigh = reaction(ANA, ANA, a, FIRE, 4, 20, { id: 'f'.repeat(32) })
  for (const list of [[tieLow, tieHigh], [tieHigh, tieLow]]) {
    t.alike(rowOf(runR({ messages: [a], follows: [ANA] }, list), a).reactions, [{ emoji: FIRE, mine: false }])
  }
  const sameId = [reaction(ANA, ANA, a, HEART, 5), reaction(ANA, ANA, a, FIRE, 5)]
  t.alike(rowOf(runR({ messages: [a], follows: [ANA] }, sameId), a).reactions, rowOf(runR({ messages: [a], follows: [ANA] }, sameId.slice().reverse()), a).reactions, 'one id signed twice: order never decides')
})

test('reactions: the empty emoji removes', (t) => {
  const a = from(ANA, 1)
  const on = reaction(ME, ANA, a, HEART, 1)
  const off = reaction(ME, ANA, a, '', 2)
  t.absent('reactions' in rowOf(runR({ messages: [a], follows: [ANA] }, [off, on]), a))
  t.alike(rowOf(runR({ messages: [a], follows: [ANA] }, [off, on, reaction(ME, ANA, a, FIRE, 3)]), a).reactions, [{ emoji: FIRE, mine: true }], 'a later rev adds it back')
})

test('reactions: an unknown, cut or other-thread target is ignored; a stored early reaction counts once its target is present', (t) => {
  const a = from(ANA, 5)
  const early = reaction(ANA, ANA, a, HEART, 1, 1)
  t.is(runR({ messages: [], follows: [ANA] }, [early]).inbox.length, 0, 'a reaction alone opens no thread')
  t.alike(rowOf(runR({ messages: [a], follows: [ANA] }, [early]), a).reactions, [{ emoji: HEART, mine: false }], 'filed before its target')
  const unknown = { ...reaction(ANA, ANA, a, HEART, 1), target: { from: ANA, id: 'c'.repeat(32) } }
  t.absent('reactions' in rowOf(runR({ messages: [a], follows: [ANA] }, [unknown]), a))
  const wrongSender = { ...reaction(ANA, ANA, a, HEART, 1), target: { from: ME, id: a.id } }
  t.absent('reactions' in rowOf(runR({ messages: [a], follows: [ANA] }, [wrongSender]), a), 'ids are unique per sender')
  const b = from(BIA, 6)
  const crossed = reaction(ANA, ANA, b, HEART, 1)
  t.absent('reactions' in rowOf(runR({ messages: [a, b], follows: [ANA, BIA] }, [crossed]), b), 'another conversation')
  t.absent('reactions' in rowOf(runR({ messages: [a, b], follows: [ANA, BIA] }, [{ ...crossed, to: CAIO }]), b), 'not to me')

  const old = from(ANA, 1)
  const fresh = from(ANA, 20)
  const cut = runR({ messages: [old, fresh], ops: [op('deleted', ANA, 10)], follows: [ANA] }, [reaction(ANA, ANA, old, HEART, 1, 25)])
  t.is(rowOf(cut, old), undefined)
  t.absent('reactions' in rowOf(cut, fresh), 'a target behind a cutoff')
  const before = runR({ messages: [fresh], ops: [op('deleted', ANA, 10)], follows: [ANA] }, [reaction(ANA, ANA, fresh, HEART, 1, 5)])
  t.absent('reactions' in rowOf(before, fresh), 'a reaction filed before a cutoff')
  const declined = runR({ messages: [fresh], ops: [op('declined', ANA, 10)] }, [reaction(ANA, ANA, fresh, HEART, 1, 5)])
  t.absent('reactions' in rowOf(declined, fresh), 'a request: the peer reaction filed before a decline')
  const blocked = runR({ messages: [fresh], ops: [op('blocked', ANA, 10), op('unblocked', ANA, 11)], follows: [ANA] }, [reaction(ANA, ANA, fresh, HEART, 1, 5)])
  t.absent('reactions' in rowOf(blocked, fresh), 'filed before a block')
  t.absent('reactions' in rowOf(runR({ messages: [a], follows: [ANA] }, [reaction(ANA, ANA, a, HEART, 1, 30, { filedAt: NaN })]), a), 'no valid filedAt')

  const many = []
  for (let i = 0; i < DM_MESSAGES_PER_PEER + 1; i++) many.push(from(ANA, i))
  const r = runR({ messages: many, follows: [ANA] }, [reaction(ANA, ANA, many[0], HEART, 1)])
  t.is(r.inbox[0].messages.length, DM_MESSAGES_PER_PEER)
  t.is(rowOf(r, many[0]), undefined, 'a target past the cap')
  t.absent(r.inbox[0].messages.some(m => m.reactions), 'it lands on no other row')
})

test('reactions: unread and preview unchanged', (t) => {
  const a = from(ANA, 1)
  const b = to(ANA, 2)
  const plain = runR({ messages: [a, b], follows: [ANA], seen: [seenKey(ANA, a.id)] })
  const reacted = runR({ messages: [a, b], follows: [ANA], seen: [seenKey(ANA, a.id)] }, [reaction(ANA, ANA, b, HEART, 1, 59)])
  t.is(plain.inbox[0].unread, false)
  t.is(reacted.inbox[0].unread, false, 'a peer reaction is not unread')
  t.is(reacted.inbox[0].at, plain.inbox[0].at, 'nor newer')
  const last = reacted.inbox[0].messages[reacted.inbox[0].messages.length - 1]
  t.is(last.id, b.id, 'the newest message stays the newest')
  t.is(previewText(last), 'oi')
  t.ok(last.reactions)
})

// A small seeded PRNG (mulberry32), so a failing seed reproduces.
function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let x = s
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function withoutReactions (r) {
  const strip = (th) => ({ ...th, messages: th.messages.map(({ reactions, ...m }) => m) })
  return JSON.stringify({ inbox: r.inbox.map(strip), requests: r.requests.map(strip) })
}

test('reactions take no part in the fold of any other record (generated logs)', (t) => {
  const peers = [ANA, BIA, CAIO]
  const emojis = [HEART, THUMBS, FIRE, '']
  let counted = 0
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed)
    const pick = (xs) => xs[Math.floor(rand() * xs.length)]
    const messages = []
    for (let i = 0, n = 5 + Math.floor(rand() * 40); i < n; i++) {
      const peer = pick(peers)
      const min = Math.floor(rand() * 50)
      const m = rand() < 0.5 ? from(peer, min) : to(peer, min)
      if (rand() < 0.1) m.at = FUTURE
      if (rand() < 0.05) m.filedAt = NaN
      messages.push(m)
    }
    const ops = []
    for (let i = 0, n = Math.floor(rand() * 4); i < n; i++) ops.push(op(pick(['accepted', 'declined', 'blocked', 'unblocked', 'deleted']), pick(peers), Math.floor(rand() * 50)))
    const follows = peers.filter(() => rand() < 0.5)
    const seen = messages.filter(m => m.from !== ME && rand() < 0.5).map(m => seenKey(m.from, m.id))
    const reactions = []
    for (let i = 0, n = Math.floor(rand() * 30); i < n; i++) {
      const target = rand() < 0.85 ? pick(messages) : { id: id(), from: pick(peers), to: ME }
      const peer = target.from === ME ? target.to : target.from
      const who = rand() < 0.5 ? ME : peer
      reactions.push(reaction(who, peer, target, pick(emojis), 1 + Math.floor(rand() * 5), Math.floor(rand() * 60), { id: rid(Math.floor(rand() * 1e6)) }))
    }
    const opts = { messages, ops, follows, seen }
    const plain = runR(opts)
    const reacted = runR(opts, reactions)
    t.is(withoutReactions(reacted), withoutReactions(plain), 'seed ' + seed + ': only reactions differ')
    t.is(JSON.stringify(runR(opts, reactions.slice().reverse())), JSON.stringify(reacted), 'seed ' + seed + ': reaction order never decides')
    for (const th of [...reacted.inbox, ...reacted.requests]) {
      for (const m of th.messages) {
        if (!m.reactions) continue
        t.ok(m.reactions.length >= 1 && m.reactions.length <= 2 && m.reactions.every(x => x.emoji !== ''), 'seed ' + seed + ': at most one per person, never empty')
        counted++
      }
    }
  }
  t.ok(counted > 0, 'some reactions count')
})
