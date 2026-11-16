'use strict'

// Eventos: the group-event side record of public groups and its fold (an
// event on a root post of the same diary, RSVPs from group-choice picks 0 and 1).

const test = require('brittle')
const b4a = require('b4a')
const {
  GROUP_TYPES, validateGroupRecord, groupPost, groupHide, groupLeave, groupTopic, groupPoll, groupChoice, groupEvent,
  groupAdmit, groupKey, groupSealed, sealedInner, buildGroup
} = require('../lib/group')
const { newBoxKeyPair, newEpochKey, sealEpochKey, openFrom, sealRecord, keyCommit } = require('../lib/group-crypto')
const { K, AT, NOW, community: communityOf, groupIn } = require('./helpers/groups')

const G = K(0x100)
const C = K(1)
const A = K(2)
const X = K(4)
const Y = K(5)
const wA = K(0x200)
const wX = K(0x400)
const wX2 = K(0x401)
const wY = K(0x500)
const CMG = K(0xc0)
const cwOf = (diary) => 'cc' + diary.slice(2)

function world () {
  const parent = communityOf({ key: CMG, creator: C, creates: [{ by: C, group: G }] })
  const g = groupIn(parent, { key: G, diary: C, join: 'open', name: 'Varanda', bindRoot: true })
  const w = {
    logs: g.logs,
    add (diary, key, { rejoin = null, at = AT(0) } = {}) {
      if (parent.cwOf(diary) === undefined) parent.addWriter(diary, cwOf(diary))
      g.add(diary, key, { rejoin, at })
      return w
    },
    push: g.push,
    len: g.len,
    input () {
      return g.input({ drop: [], community: parent.input() })
    }
  }
  return w
}

const START = '2030-06-01T20:00:00.000Z'
const END = '2030-06-01T23:00:00.000Z'
const EV = { title: 'Churrasco', start: START, end: END, place: 'Praça' }
const post = (w, key, s, extra = {}) => w.push(key, groupPost({ text: 'p' + s, at: AT(s), ...extra }))
const event = (w, key, target, s, e = EV) => w.push(key, groupEvent({ target, ...e, at: AT(s) }))
const topic = (w, key, target, s) => w.push(key, groupTopic({ target, at: AT(s) }))
const poll = (w, key, target, s, options = ['sim', 'não']) => w.push(key, groupPoll({ target, options, at: AT(s) }))
const choose = (w, key, target, pick, s) => w.push(key, groupChoice({ target, pick, at: AT(s) }))
const postOf = (g, ref) => g.posts.find((p) => p.writer === ref.writer && p.seq === ref.seq)
const visible = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.writer + ':' + p.seq)
const fold = (w, extra = {}) => buildGroup({ ...w.input(), ...extra })

test('group-event record shape and validation', async (t) => {
  t.is(GROUP_TYPES[GROUP_TYPES.length - 1], 'group-event')
  const target = { writer: wA, seq: 1, x: 1 }
  const r = groupEvent({ target, ...EV, seen: { writer: wX, seq: 2 }, at: AT(1) })
  t.alike(r, { type: 'group-event', target: { writer: wA, seq: 1 }, title: 'Churrasco', start: START, end: END, place: 'Praça', seen: { writer: wX, seq: 2 }, at: AT(1) })
  t.alike(Object.keys(r), ['type', 'target', 'title', 'start', 'end', 'place', 'seen', 'at'])
  const d = groupEvent({ target, title: 'Só', start: START, at: AT(1) })
  t.is(d.end, null, 'end defaults to none')
  t.is(d.place, '', 'place defaults to none')
  t.is(validateGroupRecord(r, 1), null)
  t.is(validateGroupRecord({ ...r, extra: 1 }, 1), 'malformed')
  const { place, ...noPlace } = r
  t.ok(place)
  t.is(validateGroupRecord(noPlace, 1), 'malformed', 'an exact key set')
  t.is(validateGroupRecord({ ...r, target: { writer: wA, seq: 0 } }, 1), 'malformed', 'target is a block')
  t.is(validateGroupRecord({ ...r, target: null }, 1), 'malformed')
  t.is(validateGroupRecord({ ...r, seen: { writer: wX } }, 1), 'seen-invalid')
  t.is(validateGroupRecord({ ...r, at: 'x' }, 1), 'date-invalid')
  t.is(validateGroupRecord(r, 1, { community: true }), 'group-only')
  t.is(validateGroupRecord(r, 1, { private: true }), 'public-only', 'a private group refuses it in the clear')
  t.is(validateGroupRecord(r, 1, { sealed: true }), 'public-only', 'never inside an envelope')
  for (const bad of [
    { title: '' }, { title: 'a\nb' }, { title: 'x'.repeat(81) }, { title: 1 }, { title: null },
    { start: '2030-06-01' }, { start: '2030-06-01T20:00:00Z' }, { start: 'x' }, { start: null }, { start: '2019-12-31T23:59:59.999Z' },
    { end: START }, { end: '2030-06-01T19:00:00.000Z' }, { end: 'x' }, { end: '2032-06-01T20:00:00.000Z' },
    { place: 'x'.repeat(121) }, { place: 'a\nb' }, { place: null }
  ]) {
    t.is(validateGroupRecord({ ...r, ...bad }, 1), 'event-invalid', JSON.stringify(bad))
  }
  t.is(validateGroupRecord({ ...r, end: null, place: '' }, 1), null)
  await t.exception.all(async () => groupEvent({ target, ...EV, title: '', at: AT(1) }), /event-invalid/)
  await t.exception.all(async () => groupEvent({ target, ...EV, end: START, at: AT(1) }), /event-invalid/)
})

test('an event counts on a root post of the same diary, on the root\'s own core', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  const root = post(w, wX, 1)
  const other = post(w, wY, 2)
  event(w, wX2, root, 3) // another device of the author: its own core is not the root's
  event(w, wX, other, 4) // foreign target
  let g = fold(w)
  t.absent('event' in postOf(g, root), 'only a marker on the root\'s own core counts')
  t.absent('event' in postOf(g, other), 'a marker on another diary\'s post is ignored')
  event(w, wX, root, 5)
  g = fold(w)
  t.alike(postOf(g, root).event, { writer: wX, seq: 3, ...EV, totals: [0, 0], by: [[], []] })
  t.absent('topic' in postOf(g, root), 'an event alone makes no topic')
  t.absent('thread' in postOf(g, root))
  t.alike(visible(g), [wX + ':1', wY + ':1'], 'side records never become posts')
})

test('an event mark on a reply, a foreign post or an unknown post is ignored', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const p = post(w, wY, 1)
  const reply = post(w, wY, 2, { replyTo: p })
  event(w, wY, reply, 3)
  event(w, wY, { writer: wY, seq: 99 }, 4)
  event(w, wX, p, 5)
  const g = fold(w)
  t.ok(g.posts.every((x) => !('event' in x)), 'plain posts keep their exact keys')
})

test('the first event on the root\'s own core wins and never changes', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  event(w, wY, root, 2)
  event(w, wY, root, 3, { title: 'Outro', start: '2031-01-01T10:00:00.000Z', end: null, place: '' })
  const g = fold(w)
  t.alike(postOf(g, root).event, { writer: wY, seq: 2, ...EV, totals: [0, 0], by: [[], []] })
})

test('an event written before its root post is ignored', (t) => {
  const w = world().add(Y, wY)
  const first = post(w, wY, 1)
  const root = { writer: wY, seq: 3 }
  w.push(wY, groupEvent({ target: root, ...EV, at: AT(2) })) // seq 2, names the post written after it
  post(w, wY, 3)
  const g = fold(w)
  t.absent('event' in postOf(g, root))
  t.absent('event' in postOf(g, first))
})

test('a future-dated event at a lower seq holds the root eventless until its date', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  const ahead = NOW + 2 * 86400000
  w.push(wY, groupEvent({ target: root, title: 'Futuro', start: START, at: new Date(ahead).toISOString() }))
  event(w, wY, root, 3) // a later seq dated now: must not win meanwhile
  choose(w, wX, root, 0, 4)
  let g = fold(w)
  t.absent('event' in postOf(g, root), 'no event now, never the higher seq')
  g = fold(w, { now: ahead })
  t.alike(postOf(g, root).event, { writer: wY, seq: 2, title: 'Futuro', start: START, end: null, place: '', totals: [1, 0], by: [[X], []] })
})

test('a root carries a poll or an event, never both: the lowest seq decides', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const r1 = post(w, wY, 1)
  topic(w, wY, r1, 2)
  event(w, wY, r1, 3)
  poll(w, wY, r1, 4)
  const r2 = post(w, wY, 5)
  topic(w, wY, r2, 6)
  poll(w, wY, r2, 7)
  event(w, wY, r2, 8)
  choose(w, wX, r1, 0, 9)
  choose(w, wX, r2, 1, 10)
  const g = fold(w)
  t.alike(postOf(g, r1).topic, { poll: null }, 'the event came first')
  t.alike(postOf(g, r1).event.totals, [1, 0])
  t.alike(postOf(g, r2).topic.poll.totals, [0, 1], 'the poll came first')
  t.absent('event' in postOf(g, r2))
  t.alike(postOf(g, r1).thread, { writer: wY, seq: 1 }, 'a topic with an event still threads')
})

test('a poll without a topic mark still decides against an event: never swapped later', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  poll(w, wY, root, 2) // no topic mark yet: nothing to show, but it came first
  event(w, wY, root, 3)
  choose(w, wX, root, 0, 4)
  let g = fold(w)
  t.absent('topic' in postOf(g, root), 'a poll alone is not shown')
  t.absent('event' in postOf(g, root), 'the lower-seq poll holds the root eventless')
  // The later mark makes it a poll; the RSVP is a vote for its option 0.
  topic(w, wY, root, 5)
  g = fold(w)
  t.alike(postOf(g, root).topic.poll.totals, [1, 0])
  t.absent('event' in postOf(g, root), 'never an event')
})

test('an event that came first keeps the root when a topic mark and a later poll arrive', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  event(w, wY, root, 2)
  poll(w, wY, root, 3)
  choose(w, wX, root, 1, 4)
  const before = postOf(fold(w), root)
  t.alike(before.event.totals, [0, 1])
  t.absent('topic' in before)
  topic(w, wY, root, 5)
  const after = postOf(fold(w), root)
  t.alike(after.event, before.event, 'the event and its RSVPs are unchanged')
  t.alike(after.topic, { poll: null })
})

test('a future-dated topic mark arriving does not swap a lower-seq poll over an event', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  poll(w, wY, root, 2)
  event(w, wY, root, 3)
  const ahead = NOW + 2 * 86400000
  w.push(wY, groupTopic({ target: root, at: new Date(ahead).toISOString() }))
  choose(w, wX, root, 0, 5)
  const now = postOf(fold(w), root)
  t.absent('event' in now, 'the poll came first, so no event')
  t.absent('topic' in now)
  const later = postOf(fold(w, { now: ahead }), root)
  t.alike(later.topic.poll.totals, [1, 0], 'the vote is for the poll it always was')
  t.absent('event' in later)
})

test('RSVPs: pick 0 going, 1 maybe, one per diary, replaced, withdrawn, others ignored', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY).add(A, wA)
  const root = post(w, wY, 1)
  event(w, wY, root, 2)
  choose(w, wX, root, 0, 3)
  choose(w, wA, root, 1, 4)
  choose(w, wY, root, 0, 5)
  let e = postOf(fold(w), root).event
  t.alike(e.totals, [2, 1])
  t.alike(e.by, [[X, Y], [A]], 'by lists diaries in vote order')
  choose(w, wX2, root, 1, 6) // another device of X replaces its RSVP
  e = postOf(fold(w), root).event
  t.alike(e.totals, [1, 2])
  t.alike(e.by, [[Y], [A, X]])
  choose(w, wY, root, 2, 7) // outside going/maybe: ignored, the earlier pick stays
  choose(w, wA, root, 3, 8)
  e = postOf(fold(w), root).event
  t.alike(e.by, [[Y], [A, X]])
  choose(w, wA, root, null, 9) // null withdraws
  e = postOf(fold(w), root).event
  t.alike(e.totals, [1, 1])
  t.alike(e.by, [[Y], [X]])
  // A member who leaves takes the RSVP along; the event stays.
  w.push(wY, groupLeave({ cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(10) }))
  const g = fold(w)
  t.is(g.members.get(Y), 'left')
  t.alike(postOf(g, root).event.by, [[], [X]])
})

test('RSVPs on a reply, a post with no event or from a future date count nowhere', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  const bare = post(w, wY, 2)
  const reply = post(w, wX, 3, { replyTo: root })
  event(w, wY, root, 4)
  choose(w, wX, root, 0, 5)
  choose(w, wX, bare, 0, 6)
  choose(w, wX, reply, 0, 7)
  w.push(wY, groupChoice({ target: root, pick: 1, at: new Date(NOW + 2 * 86400000).toISOString() }))
  const g = fold(w)
  t.alike(postOf(g, root).event.totals, [1, 0], 'a future RSVP is ignored')
  t.absent('event' in postOf(g, bare))
  t.absent('event' in postOf(g, reply))
  t.absent('topic' in postOf(g, bare), 'a stray vote makes nothing')
})

test('an RSVP written before the event counts once it exists', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  choose(w, wX, root, 1, 2)
  t.absent('event' in postOf(fold(w), root))
  event(w, wY, root, 3)
  t.alike(postOf(fold(w), root).event.totals, [0, 1])
})

test('a hidden root hides its event and RSVPs; an unhide brings them back', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  event(w, wY, root, 2)
  choose(w, wX, root, 0, 3)
  w.push(wY, groupHide({ target: root, on: true, at: AT(4) }))
  let g = fold(w)
  t.ok(postOf(g, root).hidden)
  t.alike(postOf(g, root).event.totals, [0, 0], 'RSVPs on a hidden post do not count')
  w.push(wY, groupHide({ target: root, on: false, at: AT(5) }))
  g = fold(w)
  t.absent(postOf(g, root).hidden)
  t.alike(postOf(g, root).event.totals, [1, 0])
})

test('an event stays after its author leaves', (t) => {
  const w = world().add(Y, wY)
  const root = post(w, wY, 1)
  event(w, wY, root, 2)
  w.push(wY, groupLeave({ cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(3) }))
  const g = fold(w)
  t.is(g.members.get(Y), 'left')
  t.ok(postOf(g, root).event)
})

test('a forged event record is skipped: invalid fields, a private group, another writer\'s core', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  const good = groupEvent({ target: root, ...EV, at: AT(2) })
  // A hand-built block with a bad end, written straight onto the core.
  w.push(wY, { ...good, end: START })
  event(w, wX, root, 3) // another diary
  const g = fold(w)
  t.absent('event' in postOf(g, root), 'neither forged marker counts')
  t.alike(visible(g), [wY + ':1'])
  w.push(wY, good)
  t.ok(postOf(fold(w), root).event, 'the valid one still folds after a skipped block')
})

test('an old reader skips the event record and still reads later posts', (t) => {
  const fs = require('fs')
  const path = require('path')
  const Module = require('module')
  const file = require.resolve('../lib/group')
  const src = fs.readFileSync(file, 'utf8')
  const oldSrc = src.replace(/,\n {2}'group-event': \[[^\]]*\]/, '')
  t.not(oldSrc, src, 'the type is gone from RECORD_KEYS')
  const m = new Module(file, module)
  m.filename = file
  m.paths = Module._nodeModulePaths(path.dirname(file))
  m._compile(oldSrc, file)
  const old = m.exports
  t.absent(old.GROUP_TYPES.includes('group-event'))
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  const ev = event(w, wY, root, 2)
  post(w, wX, 3, { seen: ev, replyTo: root })
  post(w, wY, 4, { seen: ev })
  t.is(old.validateGroupRecord(w.logs.get(wY).entries[2].record, 2), 'malformed')
  const g = old.buildGroup(w.input())
  t.alike(visible(g), [wY + ':1', wX + ':1', wY + ':3'])
  t.absent('event' in g.posts[0])
  const now = buildGroup(w.input())
  t.alike(visible(now), visible(g), 'the new reader shows the same posts')
  t.ok(postOf(now, root).event)
})

// A private group (visibility private, sealed records) with one admitted
// writer, its epoch key E1 and a reader that opens the envelopes.
function privateWorld () {
  const parent = communityOf({ key: CMG, creator: C, creates: [{ by: C, group: G }] })
  const boxes = new Map([[G, newBoxKeyPair()], [wY, newBoxKeyPair()]])
  const hex = (b) => b4a.toString(b, 'hex')
  const g = groupIn(parent, { key: G, diary: C, join: 'approval', visibility: 'private', box: hex(boxes.get(G).publicKey), bindRoot: true })
  parent.addWriter(Y, cwOf(Y))
  g.add(Y, wY, { box: hex(boxes.get(wY).publicKey) })
  g.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(1) }))
  const kid = { writer: G, seq: g.len(G) }
  const key = newEpochKey()
  const entry = (writer) => ({ writer, sealed: b4a.toString(sealEpochKey(key, G, kid, boxes.get(writer).publicKey), 'base64') })
  g.push(G, groupKey({ kid: null, basis: [], keys: [entry(G), entry(wY)], auth: null, commit: hex(keyCommit(key, G, kid)), at: AT(2) }))
  const seal = (writer, record) => {
    const { nonce, box } = sealRecord(sealedInner(record, { writer, group: G, kid }), key)
    return g.push(writer, groupSealed({ kid, nonce, box, at: record.at }))
  }
  const reader = { writers: new Set([wY]), unseal: (sealed) => openFrom(b4a.from(sealed, 'base64'), boxes.get(wY)) }
  return { g, seal, fold: () => buildGroup({ ...g.input({ drop: [], community: parent.input() }), keys: reader }) }
}

test('a group-event in a private group is never folded: plain or sealed', (t) => {
  const p = privateWorld()
  const root = p.seal(wY, groupPost({ text: 'segredo', at: AT(3) }))
  let g = p.fold()
  t.ok(postOf(g, root), 'control: the sealed post opens')
  t.is(g.visibility, 'private')
  const ev = groupEvent({ target: root, ...EV, at: AT(4) })
  p.g.push(wY, ev) // in the clear
  g = p.fold()
  t.absent('event' in postOf(g, root), 'a plain group-event in a private group is skipped')
  p.seal(wY, ev) // inside an envelope
  g = p.fold()
  t.absent('event' in postOf(g, root), 'a sealed group-event is skipped')
  t.ok(postOf(g, root), 'the post stays')
})
