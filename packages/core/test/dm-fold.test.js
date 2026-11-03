'use strict'

// The direct message folders (lib/dm-fold.js). No network.
const test = require('brittle')
const { fold, seenKey, tabDot, replyTarget, canSend } = require('../lib/dm-fold')
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
