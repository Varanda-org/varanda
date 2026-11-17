'use strict'

const test = require('brittle')
const {
  MAX_GROUP_WRITERS, MAX_GROUP_WRITERS_PER_DIARY, MAX_GROUPS_PER_DIARY, GROUP_TYPES, MAX_GROUPS_PER_COMMUNITY,
  validateGroupHeader, validateWriterHeader, validateGroupRecord,
  groupHeader, writerHeader, groupPost, groupHide, groupAdmit, groupBan, groupMeta, groupAdmin, groupLeave,
  groupCreateRecord, communityAdmit, communityBan, communityHide, groupInvites,
  groupJoins, groupJoinHistory, diaryGroupKeys, orderKey, compareOrder, isFuture, buildGroup, buildCommunity,
  GROUP_POST_V2_KEYS, groupKey, groupSealed, sealedInner, groupReact, groupTopic, groupPoll, groupChoice,
  slotWalk, walkHasRoom, MAX_FROZEN_WRITERS_PER_DIARY, MAX_WRITER_RELEASES_PER_DIARY, replacedWriterCut, retiredWriterCut,
  diaryWriterCut, diaryWalkRecords, walkRecordsCut
} = require('../lib/group')
const { groupJoinRecord, groupCutRecord } = require('../lib/records')
const { K, BASE, AT, NOW, community: communityOf, groupIn, diaryLog } = require('./helpers/groups')

const G = K(0x100)
const C = K(1)
const A = K(2)
const B = K(3)
const X = K(4)
const Y = K(5)
const wC = K(0x101)
const wA = K(0x200)
const wB = K(0x300)
const wX = K(0x400)
const wX2 = K(0x401)
const wY = K(0x500)

// The community every world() group belongs to (v2): created by C, which
// created G in it; each diary that writes in G gets one CW (cwOf) there.
const CMG = K(0xc0)
const cwOf = (diary) => 'cc' + diary.slice(2)

// A group under construction: the root, writers and the diaries' joins,
// inside its community `w.C`, an open community where every writing diary
// is a member.
// With `demoted`, Q created the community and C, a community admin later
// demoted, wrote G's header: only the community's creator creates groups, so
// that G is an orphan (no create of Q names it as C's).
const Q = K(0xd0)
function world ({ join = 'open', bindRoot = true, demoted = false } = {}) {
  const parent = demoted
    ? communityOf({ key: CMG, creator: Q, members: [{ diary: C, cw: cwOf(C), status: 'member' }], admins: [C], creates: [{ by: Q, group: G }] })
    : communityOf({ key: CMG, creator: C, creates: [{ by: C, group: G }] })
  if (demoted) parent.push(CMG, groupAdmin({ member: C, on: false, cuts: [{ writer: cwOf(C), seq: parent.len(cwOf(C)) }], at: parent.at() }))
  const g = groupIn(parent, { key: G, diary: C, join, name: 'Varanda', bindRoot })
  const w = {
    C: parent,
    logs: g.logs,
    joins: g.joins,
    add (diary, key, { rejoin = null, at = AT(0) } = {}) {
      if (parent.cwOf(diary) === undefined) parent.addWriter(diary, cwOf(diary))
      g.add(diary, key, { rejoin, at })
      return w
    },
    push: g.push,
    len: g.len,
    mark (diary, writer, cut, seq) {
      g.mark(diary, writer, cut, seq)
      return w
    },
    input ({ drop = [], community = parent.input() } = {}) {
      return g.input({ drop, community })
    }
  }
  return w
}

const post = (w, key, s, extra = {}) => w.push(key, groupPost({ text: 'p' + s, at: AT(s), ...extra }))
const visible = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.writer + ':' + p.seq)
const refs = (g) => g.posts.map((p) => p.writer + ':' + p.seq)

// The parent community's fold (Maps and Sets) as a stable text.
const stableText = (v) => JSON.stringify(v, (k, x) => x instanceof Map
  ? [...x].sort((a, b) => a[0] < b[0] ? -1 : 1)
  : x instanceof Set ? [...x].sort() : x)
function normalize (g) {
  return { ...g, admins: [...g.admins].sort(), members: [...g.members].sort((a, b) => a[0] < b[0] ? -1 : 1), community: g.community === null ? null : stableText(g.community) }
}
function nestedObject (depth) {
  let v = 1
  for (let i = 0; i < depth; i++) v = { x: v }
  return { type: 'unknown', x: v }
}

function nestedArray (depth) {
  let v = []
  for (let i = 0; i < depth; i++) v = [v]
  return { type: 'unknown', x: v }
}

function deepWorld () {
  const w = world().add(A, wA).add(X, wX).add(Y, wY)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  post(w, wA, 2)
  post(w, wX, 3)
  post(w, wY, 4)
  return w
}

// The 20000-level block is over MAX_BLOCK_BYTES as JSON but reaches the fold
// as a value; it is too deep even to copy.
// JSON.stringify itself overflows on these, so the size is counted by hand.
const nestedBytes = (label, depth) => label === 'object'
  ? '{"type":"unknown","x":'.length + depth * '{"x":}'.length + 2
  : '{"type":"unknown","x":'.length + depth * 2 + 3
for (const [label, make, depth] of [['object', nestedObject, 2200], ['array', nestedArray, 8000], ['object', nestedObject, 20000]]) {
  test(`a ${depth}-level nested invalid ${label} block in a writer leaves the group intact`, (t) => {
    const w = deepWorld()
    const before = buildGroup(w.input())
    const block = make(depth)
    if (depth <= 8000) t.ok(nestedBytes(label, depth) <= 16384, 'within MAX_BLOCK_BYTES')
    w.push(wX, block)
    post(w, wX, 6)
    const g = buildGroup(w.input())
    t.alike(visible(g), [...visible(before), wX + ':3'], 'posts kept, the later post too')
    t.ok(g.admins.has(C) && g.admins.has(A), 'admins kept')
    t.ok(g.members.has(X) && g.members.has(Y) && g.members.has(A), 'members kept')
    t.is(g.incomplete, false)

    const entries = w.logs.get(wX).entries
    const others = w.input().writers.filter((l) => l.key !== wX)
    const valid = { key: wX, diary: X, entries: entries.map((e) => e.seq === 2 ? { seq: 2, record: groupPost({ text: 'outro', at: AT(5) }) } : e) }
    const f = buildGroup({ ...w.input(), writers: [...others, { key: wX, diary: X, entries }, valid] })
    t.absent(f.writers.has(wX), 'copies differing only in the deep block are a fork')
    t.is(f.incomplete, true)
    t.alike(normalize(f), normalize(buildGroup({ ...w.input(), writers: [valid, ...others, { key: wX, diary: X, entries }] })))
    t.ok(f.admins.has(A), 'the fork leaves the admins')
  })
}

test('a writer block canon cannot render (BigInt) neither empties the group nor hides a fork', (t) => {
  const w = deepWorld()
  w.push(wX, { type: 'unknown', n: 1n })
  const g = buildGroup(w.input())
  t.ok(g.admins.has(A))
  t.is(g.posts.filter((p) => p.writer === wX).length, 1)
  const entries = w.logs.get(wX).entries
  const others = w.input().writers.filter((l) => l.key !== wX)
  const valid = { key: wX, diary: X, entries: entries.map((e) => e.seq === 2 ? { seq: 2, record: groupPost({ text: 'outro', at: AT(5) }) } : e) }
  t.absent(buildGroup({ ...w.input(), writers: [...others, { key: wX, diary: X, entries }, valid] }).writers.has(wX), 'a fork')
})

test('header shapes', async (t) => {
  const h = groupHeader({ diary: C, community: CMG, member: CMG, name: 'Varanda', at: AT(0) })
  t.alike(Object.keys(h), ['type', 'v', 'kind', 'diary', 'community', 'member', 'visibility', 'join', 'name', 'box', 'at'])
  t.is(validateGroupHeader(h), null)
  t.is(validateGroupHeader({ ...h, name: null }), null, 'a public group may be unnamed')
  t.is(validateGroupHeader({ ...h, kind: 'community', community: null, member: null }), null)
  t.is(validateGroupHeader({ ...h, kind: 'community' }), 'malformed', 'a community has no parent')
  t.is(validateGroupHeader({ ...h, community: null }), 'malformed', 'a group has exactly one parent')
  t.is(validateGroupHeader({ ...h, extra: 1 }), 'malformed', 'extra key')
  t.is(validateGroupHeader({ ...h, v: 3 }), 'malformed')
  t.is(validateGroupHeader({ ...h, v: 1 }), 'legacy')
  t.is(validateGroupHeader({ ...h, kind: 'x' }), 'malformed')
  t.is(validateGroupHeader({ ...h, box: K(9) }), 'malformed', 'public has no box')
  t.is(validateGroupHeader({ ...h, name: '' }), 'name-length')
  t.is(validateGroupHeader({ ...h, name: 'x'.repeat(81) }), 'name-length')
  t.is(validateGroupHeader({ ...h, name: 'a\nb' }), 'control-chars')
  t.is(validateGroupHeader({ ...h, at: 'x' }), 'date-invalid')
  t.is(validateGroupHeader({ ...h, name: 'x'.repeat(20000) }), 'too-large', 'oversized header')
  const priv = { ...h, visibility: 'private', join: 'approval', name: null, box: K(9) }
  t.is(validateGroupHeader(priv), null)
  t.is(validateGroupHeader({ ...priv, box: null }), 'malformed', 'private requires a box')
  t.is(validateGroupHeader({ ...priv, join: 'open' }), 'malformed', 'private implies approval')
  t.is(validateGroupHeader({ ...priv, name: 'x' }), 'malformed', 'private name is null')
  await t.exception.all(async () => groupHeader({ diary: 'x' }), /malformed/)
  const wh = writerHeader({ group: G, diary: X, member: cwOf(X), at: AT(0) })
  t.alike(wh, { type: 'group-writer', v: 2, group: G, diary: X, member: cwOf(X), box: null, rejoin: null, at: AT(0) })
  t.alike(Object.keys(wh), ['type', 'v', 'group', 'diary', 'member', 'box', 'rejoin', 'at'])
  t.alike(writerHeader({ group: G, diary: X, member: cwOf(X), rejoin: { writer: wX, seq: 2, x: 1 }, at: AT(0) }).rejoin, { writer: wX, seq: 2 })
  t.is(validateWriterHeader({ ...wh, member: 'x' }), 'malformed')
  t.is(validateWriterHeader({ ...wh, v: 1 }), 'legacy')
  t.is(validateWriterHeader({ ...wh, rejoin: { writer: wX, seq: 0 } }), 'malformed', 'a leave is never block 0')
  t.is(validateWriterHeader({ ...wh, rejoin: 'x' }), 'malformed')
  const noRejoin = { ...wh }
  delete noRejoin.rejoin
  t.is(validateWriterHeader(noRejoin), 'malformed', 'rejoin is required, null or a ref')
  t.is(validateWriterHeader(wh), null)
  t.is(validateWriterHeader({ ...wh, box: K(9) }), null, 'the shape accepts a box; the fold matches it to the visibility')
  t.is(validateWriterHeader({ ...wh, box: 'x' }), 'malformed')
  t.is(validateWriterHeader({ ...wh, extra: 1 }), 'malformed')
  t.is(validateGroupRecord(wh, 0), null)
  t.is(validateGroupRecord(h, 0, { root: true }), null)
  t.is(validateGroupRecord(h, 0), 'malformed', 'a writer core never starts with a group header')
  const hostile = { ...h }
  Object.defineProperty(hostile, 'diary', { enumerable: true, get () { throw new Error('boom') } })
  t.is(validateGroupHeader(hostile), 'malformed')
})

test('record shapes', async (t) => {
  t.alike([...GROUP_TYPES], ['group-post', 'group-hide', 'group-admit', 'group-ban', 'group-meta', 'group-admin', 'group-leave', 'group-create', 'group-drop', 'group-key', 'group-sealed', 'group-invites', 'group-react', 'group-topic', 'group-poll', 'group-choice', 'group-event'])
  const p = groupPost({ text: 'oi', replyTo: { writer: wA, seq: 1, extra: 1 }, seen: { writer: wB, seq: 2 }, at: AT(1) })
  t.alike(p, { type: 'group-post', text: 'oi', replyTo: { writer: wA, seq: 1 }, seen: { writer: wB, seq: 2 }, at: AT(1) })
  t.is(validateGroupRecord(p, 1), null)
  t.is(validateGroupRecord({ ...p, extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateGroupRecord(p, 0), 'malformed', 'seq 0 is the header')
  t.is(validateGroupRecord({ ...p, text: '' }, 1), 'text-length')
  t.is(validateGroupRecord({ ...p, text: 'x'.repeat(1001) }), 'malformed', 'no seq')
  t.is(validateGroupRecord({ ...p, text: 'x'.repeat(1001) }, 1), 'text-length')
  t.is(validateGroupRecord({ ...p, replyTo: { writer: wA, seq: 0 } }, 1), 'reply-invalid')
  t.is(validateGroupRecord({ ...p, seen: { writer: wA } }, 1), 'seen-invalid')
  const hide = groupHide({ target: { writer: wA, seq: 1 }, on: true, at: AT(1) })
  t.is(validateGroupRecord(hide, 2), null)
  t.is(validateGroupRecord({ ...hide, on: 1 }, 2), 'malformed')
  const cuts = [{ writer: wX, seq: 0 }, { writer: wX2, seq: 4 }]
  for (const build of [groupAdmit, groupBan]) {
    const r = build({ member: X, on: true, cuts, at: AT(1) })
    t.is(validateGroupRecord(r, 1), null, r.type)
    t.is(validateGroupRecord({ ...r, cuts: [{ writer: wX, seq: -1 }] }, 1), 'cuts-invalid', 'negative cut')
    t.is(validateGroupRecord({ ...r, cuts: [{ writer: wX, seq: 1 }, { writer: wX, seq: 2 }] }, 1), 'cuts-invalid', 'repeated writer')
    t.is(validateGroupRecord({ ...r, cuts: [{ writer: wX, seq: 1, x: 1 }] }, 1), 'cuts-invalid')
    t.is(validateGroupRecord({ ...r, cuts: Array.from({ length: 17 }, (_, i) => ({ writer: K(0x900 + i), seq: 1 })) }, 1), 'cuts-invalid', 'over 16 cuts')
    t.is(validateGroupRecord({ ...r, cuts: Array.from({ length: 16 }, (_, i) => ({ writer: K(0x900 + i), seq: 1 })) }, 1), null, '16 cuts')
    t.is(validateGroupRecord({ ...r, cuts: null }, 1), 'cuts-invalid')
    t.is(validateGroupRecord({ ...r, member: 'x' }, 1), 'malformed')
  }
  const ban = groupBan({ member: X, on: true, at: AT(1) })
  t.alike(ban.lifts, null)
  t.is(validateGroupRecord({ ...ban, lifts: { writer: wA, seq: 1 } }, 1), 'lifts-invalid', 'lifts without an unban')
  t.is(validateGroupRecord({ ...ban, on: false }, 1), 'lifts-invalid', 'unban without lifts')
  t.is(validateGroupRecord({ ...ban, on: false, lifts: { writer: wA, seq: 1 } }, 1), null)
  await t.exception.all(async () => groupBan({ member: X, on: false, at: AT(1) }), /lifts-invalid/)
  const meta = groupMeta({ name: 'Novo', join: 'approval', at: AT(1) })
  const admin = groupAdmin({ member: A, on: true, at: AT(1) })
  t.is(validateGroupRecord(meta, 1, { root: true }), null)
  t.is(validateGroupRecord(admin, 1, { root: true }), null)
  t.is(validateGroupRecord(meta, 1), 'root-only')
  t.is(validateGroupRecord(admin, 1), 'root-only')
  t.is(validateGroupRecord({ ...meta, join: 'x' }, 1, { root: true }), 'malformed')
  t.alike(groupLeave({ at: AT(1) }), { type: 'group-leave', seen: null, cuts: [], at: AT(1) })
  t.alike(Object.keys(groupLeave({ at: AT(1) })), ['type', 'seen', 'cuts', 'at'])
  t.alike(groupLeave({ cuts: [{ writer: wX, seq: 2, x: 1 }], at: AT(1) }).cuts, [{ writer: wX, seq: 2 }])
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, cuts: [], at: AT(1), x: 1 }, 1), 'malformed')
  t.is(validateGroupRecord({ type: 'group-leave', cuts: [], at: AT(1) }, 1), 'malformed', 'seen is required, null or a ref')
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, at: AT(1) }, 1), 'malformed', 'cuts are required')
  t.is(validateGroupRecord({ type: 'group-leave', seen: { writer: wX, seq: -1 }, cuts: [], at: AT(1) }, 1), 'seen-invalid')
  const leaveCuts = (n) => Array.from({ length: n }, (_, i) => ({ writer: K(0x900 + i), seq: 1 }))
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, cuts: leaveCuts(MAX_GROUP_WRITERS_PER_DIARY), at: AT(1) }, 1), null, '8 cuts')
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, cuts: leaveCuts(MAX_GROUP_WRITERS_PER_DIARY + 1), at: AT(1) }, 1), 'cuts-invalid', 'over 8 cuts')
  t.is(validateGroupRecord({ type: 'group-leave', seen: null, cuts: [{ writer: wX, seq: 1 }, { writer: wX, seq: 2 }], at: AT(1) }, 1), 'cuts-invalid', 'repeated writer')
  t.is(validateGroupRecord({ type: 'group-unknown', at: AT(1) }, 1), 'malformed')
  t.is(validateGroupRecord({ type: 'toString', at: AT(1) }, 1), 'malformed')
})

test('groupJoins and groupJoinHistory', (t) => {
  const G2 = K(0x999)
  const entries = [
    { seq: 0, record: { type: 'member-cert' } },
    { seq: 3, record: groupJoinRecord({ group: G, writer: wX, on: false, at: AT(3) }) },
    { seq: 1, record: groupJoinRecord({ group: G, writer: wX, on: true, at: AT(1) }) },
    { seq: 2, record: groupJoinRecord({ group: G2, writer: wX2, on: true, at: AT(2) }) },
    { seq: 4, record: { type: 'group-join', group: G, writer: 'x', on: true, at: AT(4) } },
    { seq: 5, record: groupJoinRecord({ group: G, writer: wY, on: true, rejoin: { writer: wX, seq: 2 }, at: AT(5) }) },
    null
  ]
  t.alike([...groupJoins(entries)], [[wX2, { group: G2, writer: wX2, seq: 2, at: AT(2) }], [wY, { group: G, writer: wY, seq: 5, at: AT(5) }]].sort((a, b) => a[0] < b[0] ? -1 : 1))
  // The rejoin a join names (null without one) travels to the fold.
  t.alike(groupJoinHistory(entries, G), [{ writer: wX, on: true, seq: 1, rejoin: null }, { writer: wX, on: false, seq: 3, rejoin: null }, { writer: wY, on: true, seq: 5, rejoin: { writer: wX, seq: 2 } }])
  t.alike([...groupJoins('x')], [])
  t.alike(groupJoinHistory(null, G), [])
})

test('diaryGroupKeys', (t) => {
  const join = (seq, group, on, writer = wX) => ({ seq, record: groupJoinRecord({ group, writer, on, at: AT(seq) }) })
  t.alike(diaryGroupKeys([]), [])
  t.alike(diaryGroupKeys(null), [])
  t.alike(diaryGroupKeys('x'), [])
  t.alike(diaryGroupKeys([
    { seq: 1, record: { type: 'group-join', group: G, writer: wX, on: true } },
    { seq: 2, record: { type: 'member-cert' } },
    null,
    join(3, C, true, wY)
  ]), [C], 'invalid and non-join records are ignored')
  t.alike(diaryGroupKeys([join(1, G, false)]), [], 'only on:false is absent')
  t.alike(diaryGroupKeys([join(1, G, true), join(2, G, false)]), [], 'on then off is absent')
  t.alike(diaryGroupKeys([
    join(1, G, true, wX),
    join(2, G, false, wX),
    join(3, G, true, wY)
  ]), [G], 'one writer still on keeps the group')
  // G joined at 1, left at 3, rejoined by a new writer at 10; C joined at 5.
  t.alike(diaryGroupKeys([
    join(10, G, true, wX2),
    join(1, G, true, wX),
    join(5, C, true, wY),
    join(3, G, false, wX)
  ]), [C, G], 'a leave and rejoin ranks by the live join seq')
  const left = []
  for (let i = 0; i < MAX_GROUPS_PER_DIARY; i++) {
    const group = K(0x1000 + i)
    const writer = K(0x2000 + i)
    left.push(join(i * 2 + 1, group, true, writer))
    left.push(join(i * 2 + 2, group, false, writer))
  }
  const still = K(0x1000 + MAX_GROUPS_PER_DIARY)
  left.push(join(MAX_GROUPS_PER_DIARY * 2 + 1, still, true, K(0x2000 + MAX_GROUPS_PER_DIARY)))
  t.alike(diaryGroupKeys(left.slice().reverse()), [still], 'groups already left do not fill the cap')
  const live = []
  for (let i = 0; i < MAX_GROUPS_PER_DIARY + 1; i++) {
    live.push(join(i + 1, K(0x3000 + i), true, K(0x4000 + i)))
  }
  const first64 = []
  for (let i = 0; i < MAX_GROUPS_PER_DIARY; i++) first64.push(K(0x3000 + i))
  t.alike(diaryGroupKeys(live.slice().reverse()), first64, 'the first 64 live groups by seq')
  t.alike(diaryGroupKeys(live, 1), [first64[0]], 'max keeps the earliest live group')
  const held = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY + 1; i++) held.push(join(i + 1, C, true, K(0x7000 + i)))
  t.alike(diaryGroupKeys(held), [C], 'writers past the 8 do not drop the group')
  // The only writer still on joined last by seq and first by key.
  const crowded = [join(MAX_GROUP_WRITERS_PER_DIARY + 1, G, true, K(0x5000))]
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) {
    const writer = K(0x5100 + i)
    crowded.push(join(i + 1, G, true, writer))
    crowded.push(join(100 + i, G, false, writer))
  }
  t.alike(diaryGroupKeys(crowded), [], 'a group whose only live writer is the 9th earliest is absent')
  const rooted = [join(40, G, true, G)]
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) {
    const writer = K(0x6000 + i)
    rooted.push(join(i + 1, G, true, writer))
    rooted.push(join(50 + i, G, false, writer))
  }
  t.alike(diaryGroupKeys(rooted), [G], 'the root key always counts')
  // The root joined late and then left: it spends one of the 8 slots from its
  // join on, never one an earlier writer already holds (the slot walk only
  // reads earlier records, #350), so the 8th other writer still counts.
  const displaced = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) {
    const writer = K(0x6100 + i)
    displaced.push(join(i + 1, C, true, writer))
    if (i < MAX_GROUP_WRITERS_PER_DIARY - 1) displaced.push(join(70 + i, C, false, writer))
  }
  displaced.push(join(30, C, true, C))
  displaced.push(join(31, C, false, C))
  t.alike(diaryGroupKeys(displaced), [C], 'a root joined after 8 writers takes no slot back')
  const rootFirst = [join(1, C, true, C)]
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) {
    const writer = K(0x6200 + i)
    rootFirst.push(join(i + 2, C, true, writer))
    if (i < MAX_GROUP_WRITERS_PER_DIARY - 1) rootFirst.push(join(70 + i, C, false, writer))
  }
  t.alike(diaryGroupKeys(rootFirst), [C], 'the root joined first counts')
  rootFirst.push(join(90, C, false, C))
  t.alike(diaryGroupKeys(rootFirst), [], 'and takes one of the 8 writer slots from its join on')
  const tie = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY - 1; i++) {
    const writer = K(0x5200 + i)
    tie.push(join(i + 1, B, true, writer))
    tie.push(join(80 + i, B, false, writer))
  }
  const low = K(0x5210)
  const high = K(0x5211)
  tie.push(join(MAX_GROUP_WRITERS_PER_DIARY, B, true, high))
  tie.push(join(MAX_GROUP_WRITERS_PER_DIARY, B, true, low))
  tie.push(join(90, B, false, low))
  t.alike(diaryGroupKeys(tie), [], 'the lower writer key wins a tied seq')
  const boom = [join(1, G, true, wX)]
  Object.defineProperty(boom, '1', { enumerable: true, get () { throw new Error('boom') } })
  t.alike(diaryGroupKeys(boom), [], 'an entry that throws yields nothing')
})

test('orderKey and the future skip', (t) => {
  t.ok(compareOrder(orderKey(AT(1), wB, 9), orderKey(AT(2), wA, 1)) < 0)
  t.ok(compareOrder(orderKey(AT(1), wA, 9), orderKey(AT(1), wB, 1)) < 0)
  t.ok(compareOrder(orderKey(AT(1), wA, 1), orderKey(AT(1), wA, 2)) < 0)
  t.ok(isFuture(new Date(BASE + 86400001).toISOString(), BASE))
  t.absent(isFuture(new Date(BASE + 86400000).toISOString(), BASE))
})

test('a basic group and shuffled writer input', (t) => {
  const w = world().add(A, wA).add(X, wX).add(Y, wY)
  post(w, G, 1)
  post(w, wX, 2)
  post(w, wY, 3)
  post(w, wA, 4)
  const g = buildGroup(w.input())
  t.is(g.kind, 'group')
  t.is(g.name, 'Varanda')
  t.is(g.creator, C)
  t.is(g.incomplete, false)
  t.alike(refs(g), [G + ':1', wX + ':1', wY + ':1', wA + ':1'])
  t.alike([...g.members], [[C, 'member'], [A, 'member'], [X, 'member'], [Y, 'member']])
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse().map((l) => ({ ...l, entries: l.entries.slice().reverse() }))
  t.alike(normalize(buildGroup(shuffled)), normalize(g))
  t.alike(buildGroup(null).posts, [])
  t.is(buildGroup({ root: { key: G, entries: [] } }).incomplete, true)
})

test('meta renames and changes the join mode', (t) => {
  const w = world().add(X, wX)
  w.push(G, groupMeta({ name: 'Outro', join: 'approval', at: AT(1) }))
  post(w, wX, 2)
  const g = buildGroup(w.input())
  t.is(g.name, 'Outro')
  t.is(g.join, 'approval')
  t.alike(g.requests, [X])
})

test('ban then unban hides exactly [banCut, unbanCut)', (t) => {
  const w = world().add(X, wX)
  for (let s = 1; s <= 2; s++) post(w, wX, s)
  const ban = w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 3 }], at: AT(10) }))
  for (let s = 3; s <= 5; s++) post(w, wX, s)
  w.push(G, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: 6 }], lifts: ban, at: AT(20) }))
  for (let s = 6; s <= 7; s++) post(w, wX, s)
  const g = buildGroup(w.input())
  t.alike(g.posts.filter((p) => p.hidden).map((p) => p.seq), [3, 4, 5])
  t.is(g.members.get(X), 'member')
})

test('an unban leaves a writer it does not list banned, and bans still lists the ban to lift', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX, 1)
  const ban = w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(2) }))
  post(w, wX, 3)
  post(w, wX2, 4)
  w.push(G, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], lifts: ban, at: AT(5) }))
  post(w, wX, 6)
  post(w, wX2, 7)
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1', wX + ':3'], 'the writer posting during the ban stays banned, its later posts too')
  t.alike(g.bans.get(X), ban, 'the latest ban stays liftable while a counted writer is banned')
  w.push(G, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], lifts: ban, at: AT(8) }))
  post(w, wX2, 9)
  const g2 = buildGroup(w.input())
  t.alike(visible(g2), [wX + ':1', wX + ':3', wX2 + ':3'], 'an unban citing the same ban lifts the listed writer')
  t.absent(g2.bans.has(X))
  t.is(g2.members.get(X), 'member')
})

test('a ban still covers unlisted writers from seq 0', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX, 1)
  post(w, wX2, 2)
  w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(3) }))
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1'])
  t.is(g.members.get(X), 'banned')
  t.ok(g.bans.has(X))
})

test('a cut is an observed length: its reference is seq - 1 and records at seq >= cut are affected', (t) => {
  const w = world().add(X, wX)
  post(w, wX, 100)
  post(w, wX, 101)
  // Clock far behind: without the reference the ban would sort first.
  w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 2 }], at: AT(1) }))
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.seq, p.hidden]), [[1, false], [2, true]])
  const w2 = world().add(X, wX)
  post(w2, wX, 100)
  w2.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 0 }], at: AT(1) }))
  w2.push(G, groupHide({ target: { writer: wX, seq: 1 }, on: false, at: AT(2) }))
  t.alike(buildGroup(w2.input()).posts.map((p) => p.hidden), [true], 'cut 0 covers the whole writer')
  // A's second ban observed wX:1, so it follows B's unban of the first ban
  // even though its clock says otherwise: the unban counts, and wX:1 (below
  // the second ban's cut) is visible again.
  const w3 = world().add(A, wA).add(B, wB).add(X, wX)
  w3.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w3.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  const ban1 = w3.push(wB, groupBan({ member: X, on: true, at: AT(100) }))
  w3.push(wB, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: 1 }], lifts: ban1, at: AT(200) }))
  w3.push(wA, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 2 }], at: AT(150) }))
  post(w3, wX, 300)
  const g3 = buildGroup(w3.input())
  t.is(g3.members.get(X), 'banned')
  t.alike(g3.posts.map((p) => p.hidden), [false])
})

test('lifts is an ordering reference: an unban never sorts before its ban', (t) => {
  const w = world().add(A, wA).add(B, wB).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wX, 2)
  const ban = w.push(wA, groupBan({ member: X, on: true, at: AT(500) }))
  // B's clock is far behind A's; the unban still follows the ban it lifts.
  w.push(wB, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: 1 }], lifts: ban, at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  t.alike(g.posts.map((p) => p.hidden), [false])
})

test('an unban that misses a later ban leaves D banned', (t) => {
  const w = world().add(A, wA).add(B, wB).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wX, 2)
  const b1 = w.push(wA, groupBan({ member: X, on: true, at: AT(3) }))
  w.push(wB, groupBan({ member: X, on: true, at: AT(4) }))
  w.push(wA, groupBan({ member: X, on: false, lifts: b1, at: AT(5) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.alike(g.posts.map((p) => p.hidden), [true])
})

test('an admin demoted with a cut loses actions at seq >= cut even with earlier at', (t) => {
  const w = world().add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  const p1 = post(w, wX, 2)
  const p2 = post(w, wX, 3)
  w.push(wA, groupHide({ target: p1, on: true, at: AT(4) }))
  w.push(wA, groupHide({ target: p2, on: true, at: AT(5) }))
  w.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 2 }], at: AT(3) }))
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => p.hidden), [true, false])
  t.absent(g.admins.has(A))
  t.ok(g.admins.has(C))
})

test('future posts are skipped', (t) => {
  const w = world().add(X, wX)
  post(w, wX, 1)
  w.push(wX, groupPost({ text: 'later', at: new Date(NOW + 86400001).toISOString() }))
  const g = buildGroup(w.input())
  t.alike(refs(g), [wX + ':1'])
  t.alike(g.future, [{ writer: wX, seq: 2 }])
})

test('an approval group hides posts before the admit cut', (t) => {
  const w = world({ join: 'approval' }).add(X, wX).add(X, wX2).add(Y, wY)
  post(w, wX, 1)
  post(w, wX, 2)
  post(w, wX2, 3)
  post(w, wY, 4)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 2 }], at: AT(5) }))
  post(w, wX, 6)
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':2', wX + ':3'], 'a backlog writer the admit does not list stays hidden')
  t.is(g.members.get(X), 'member')
  t.is(g.members.get(Y), 'requested')
  t.alike(g.requests, [Y], 'the backlog writer is covered from its next record, so X is no request')
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 0 }], at: AT(7) }))
  const g2 = buildGroup(w.input())
  t.alike(visible(g2), [wX + ':2', wX2 + ':1', wX + ':3'], 'a new admit listing the writer admits it')
  t.alike(g2.requests, [Y])
})

// Owner decision (#350): the admission covers the diary's new devices while
// it has not left or been banned.
test('a writer created after the admit is covered by it', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  w.add(X, wX2, { at: AT(3) })
  const empty = buildGroup(w.input())
  t.alike(empty.requests, [], 'a new device with no record is no request')
  t.ok(empty.liveWriters.has(wX2))
  post(w, wX2, 4)
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1', wX2 + ':1'], 'its posts show without a new admit')
  t.is(g.members.get(X), 'member')
  t.alike(g.requests, [])
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 1 }], at: AT(5) }))
  post(w, wX2, 6)
  const g2 = buildGroup(w.input())
  t.alike(visible(g2), [wX + ':1', wX2 + ':1', wX2 + ':2'], 'an admit listing it changes nothing')
  t.alike(g2.requests, [])
})

test('a new device counts from the admission on: earlier records, withdrawals and re-admits', (t) => {
  const w = world({ join: 'approval' }).add(X, wX).add(X, wX2)
  post(w, wX2, 1)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  post(w, wX2, 3)
  let g = buildGroup(w.input())
  t.alike(visible(g), [wX2 + ':2'], 'the record before the admit stays hidden')
  t.is(g.members.get(X), 'member')
  t.alike(g.requests, [])
  w.push(G, groupAdmit({ member: X, on: false, cuts: [{ writer: wX, seq: 1 }], at: AT(4) }))
  post(w, wX2, 5)
  g = buildGroup(w.input())
  t.alike(visible(g), [], 'a withdrawal hides every writer from seq 0')
  t.is(g.members.get(X), 'requested')
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(6) }))
  post(w, wX2, 7)
  g = buildGroup(w.input())
  t.alike(visible(g), [wX2 + ':4'], 'a re-admit listing only the other writer covers the device from after it')
  t.is(g.members.get(X), 'member')
  t.alike(g.requests, [])
})

test('after a leave only a writer whose rejoin names it is covered, by an admit of the new generation', (t) => {
  const w = world({ join: 'approval' }).add(X, wX).add(X, wX2)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }, { writer: wX2, seq: 1 }], at: AT(1) }))
  const leave = w.push(wX, groupLeave({ at: AT(2) }))
  const wNew = K(0x403)
  w.add(X, wNew, { rejoin: leave, at: AT(3) })
  post(w, wNew, 4)
  const before = buildGroup(w.input())
  t.alike(visible(before), [], 'the old admit covers no writer of the new generation')
  t.is(before.members.get(X), 'requested')
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(5) }))
  post(w, wNew, 6)
  post(w, wX2, 7)
  const after = buildGroup(w.input())
  t.is(after.members.get(X), 'member')
  t.alike(visible(after), [wNew + ':2'], 'the rejoined writer from the re-admit on; the device from before the leave never')
  t.alike(after.requests, [X], 'the old device keeps the diary in front of the admins')
})

test('a new device during a ban stays banned, also after an unban that does not list it', (t) => {
  const w = world({ join: 'approval' }).add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  const ban = w.push(wA, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(3) }))
  w.add(X, wX2, { at: AT(4) })
  post(w, wX2, 5)
  let g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.alike(visible(g), [])
  w.push(wA, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: 1 }], lifts: ban, at: AT(6) }))
  post(w, wX2, 7)
  g = buildGroup(w.input())
  t.alike(visible(g), [], 'the unban never listed the device')
  t.alike(g.bans.get(X), ban, 'still liftable')
})

test('an admit withdrawal still covers unlisted writers from seq 0', (t) => {
  const w = world({ join: 'approval' }).add(X, wX).add(X, wX2)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }, { writer: wX2, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  post(w, wX2, 3)
  w.push(G, groupAdmit({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(4) }))
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1'], 'the unlisted writer is withdrawn from seq 0')
  t.is(g.members.get(X), 'requested')
})

test('leave withdraws every writer of D', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX, 1)
  const p2 = post(w, wX2, 2)
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(3) }))
  post(w, wX2, 4, { seen: leave })
  post(w, wX, 5)
  const g = buildGroup(w.input())
  // The other writer's records go from seq 0, whatever the leave's cuts say.
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [[wX + ':1', false], [p2.writer + ':1', true], [wX2 + ':2', true], [wX + ':3', true]])
  t.is(g.members.get(X), 'left')
  const off = w.input()
  off.joins = new Map(off.joins)
  off.joins.set(X, [...off.joins.get(X), { writer: wX, on: false, seq: 9 }])
  t.alike(normalize(buildGroup(off)), normalize(g), 'a diary join on:false never withdraws a writer')
})

const wX3 = K(0x402)

test('a leave cutting another writer past its end withdraws what that writer writes later', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  w.push(G, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }, { writer: wX2, seq: 1 }], at: AT(1) }))
  post(w, wY, 2)
  w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: 3 }], at: AT(3) }))
  post(w, wX2, 4)
  w.push(wX2, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(5) }))
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [[wY + ':1', false], [wX2 + ':1', true]], 'the later post is withdrawn')
  t.is(g.members.get(Y), 'member', 'the later ban carries no authority')
  t.is(g.bans.size, 0)
})

test('a creator leaving from another writer keeps the root records below its root cut', (t) => {
  const w = world().add(C, wC).add(A, wA).add(Y, wY)
  w.push(G, groupMeta({ name: 'Novo', join: 'approval', at: AT(1) }))
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(2) }))
  post(w, wY, 3)
  w.push(wA, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(4) }))
  w.push(wC, groupLeave({ cuts: [{ writer: G, seq: w.len(G) }, { writer: wC, seq: w.len(wC) }], at: AT(5) }))
  const g = buildGroup(w.input())
  t.is(g.name, 'Novo')
  t.is(g.join, 'approval')
  t.ok(g.admins.has(A), 'the grant before the cut stays')
  t.is(g.members.get(C), 'left')
  t.is(g.members.get(Y), 'member', 'the admin appointed before the cut still admits')
  t.alike(visible(g), [wY + ':1'])
})

test('a rejoin restores what follows it, never the other writer records before the leave', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  post(w, wX2, 1)
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(2) }))
  w.add(X, wX3, { rejoin: leave, at: AT(3) })
  post(w, wX3, 4)
  post(w, wX2, 5, { seen: { writer: wX3, seq: 0 } })
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [
    [wX2 + ':1', true],
    [wX3 + ':1', false],
    [wX2 + ':2', false]
  ])
  t.is(g.members.get(X), 'member')
})

test('leave then rejoin in an open group', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 1)
  const leave = w.push(wX, groupLeave({ at: AT(2) }))
  post(w, wX, 3)
  w.add(X, wX3, { rejoin: leave, at: AT(4) })
  post(w, wX3, 1)
  post(w, wY, 6)
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [
    [wX + ':1', false],
    [wX + ':3', true],
    [wX3 + ':1', false],
    [wY + ':1', false]
  ], 'pre-leave kept, between leave and rejoin hidden, new posts shown')
  t.is(g.members.get(X), 'member')
  t.is(g.incomplete, false)
  const early = world().add(X, wX)
  const l = early.push(wX, groupLeave({ at: AT(50) }))
  early.add(X, wX3, { rejoin: l, at: AT(1) })
  post(early, wX3, 2)
  t.alike(refs(buildGroup(early.input())), [wX3 + ':1'], 'rejoin orders after the leave whatever its clock')
})

test('a rejoin in an approval group needs a new admit', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  const leave = w.push(wX, groupLeave({ at: AT(3) }))
  w.add(X, wX3, { rejoin: leave, at: AT(4) })
  post(w, wX3, 5)
  const before = buildGroup(w.input())
  t.alike(before.posts.map((p) => p.hidden), [false, true], 'the old admit does not carry over')
  t.is(before.members.get(X), 'requested')
  t.alike(before.requests, [X])
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX3, seq: 1 }], at: AT(6) }))
  const after = buildGroup(w.input())
  t.alike(after.posts.map((p) => p.hidden), [false, false])
  t.is(after.members.get(X), 'member')
})

test('a rejoin naming another diary leave is ignored', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const leave = w.push(wY, groupLeave({ at: AT(1) }))
  const notLeave = post(w, wX, 2)
  w.add(X, wX3, { rejoin: leave, at: AT(3) })
  post(w, wX3, 4)
  const g = buildGroup(w.input())
  t.alike(refs(g), [wX + ':1'])
  t.is(g.incomplete, false)
  w.logs.get(wX3).entries[0].record = writerHeader({ group: G, diary: X, member: cwOf(X), rejoin: notLeave, at: AT(3) })
  const g2 = buildGroup(w.input())
  t.alike(refs(g2), [wX + ':1'], 'a rejoin naming a post is ignored too')
  t.is(g2.incomplete, false)
  w.logs.get(wX3).entries[0].record = writerHeader({ group: G, diary: X, member: cwOf(X), rejoin: { writer: wX, seq: 9 }, at: AT(3) })
  t.is(buildGroup(w.input()).incomplete, true, 'a leave not known yet leaves the group incomplete')
})

test('a banned member who leaves and rejoins stays banned', (t) => {
  const w = world().add(X, wX)
  post(w, wX, 1)
  w.push(G, groupBan({ member: X, on: true, at: AT(2) }))
  const leave = w.push(wX, groupLeave({ at: AT(3) }))
  w.add(X, wX3, { rejoin: leave, at: AT(4) })
  post(w, wX3, 5)
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.alike(g.posts.map((p) => p.hidden), [true, true])
})

test('the author hides own posts; others cannot', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  const p1 = post(w, wX, 1)
  const p2 = post(w, wX, 2)
  w.push(wX2, groupHide({ target: p1, on: true, at: AT(3) }))
  w.push(wY, groupHide({ target: p2, on: true, at: AT(4) }))
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => p.hidden), [true, false])
})

test('last and bans give a writer its seen and lifts', (t) => {
  const w = world().add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  const p = post(w, wX, 2)
  const ban = w.push(wA, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(3) }))
  const g = buildGroup(w.input())
  t.alike(g.last, ban)
  t.alike(g.bans.get(X), ban)
  w.push(wA, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], lifts: g.bans.get(X), at: AT(4) }))
  const g2 = buildGroup(w.input())
  t.absent(g2.bans.has(X), 'nothing to lift once unbanned')
  t.is(g2.members.get(X), 'member')
  t.ok(p)
  t.is(buildGroup(world().input()).last, null)
})

test('a post that names the rejoin as seen stays visible on a slower clock', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  const leave = w.push(wX, groupLeave({ at: AT(10) }))
  w.add(X, wX3, { rejoin: leave, at: AT(100) })
  const g = buildGroup(w.input())
  t.alike(g.last, { writer: wX3, seq: 0 }, 'the rejoin node is the newest')
  t.is(g.members.get(X), 'member')
  w.push(wX2, groupPost({ text: 'depois', seen: g.last, at: AT(50) }))
  t.alike(visible(buildGroup(w.input())), [wX2 + ':1'], 'ordered after the rejoin, not between leave and rejoin')
})

test('a leave that names a rejoin as seen orders after it on a slower clock', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  const leave = w.push(wX, groupLeave({ at: AT(10) }))
  w.add(X, wX3, { rejoin: leave, at: AT(100) })
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  w.push(wX2, groupLeave({ seen: g.last, at: AT(50) }))
  t.is(buildGroup(w.input()).members.get(X), 'left', 'the second leave ends the rejoined membership')
})

test('moderation that names a rejoin as seen keeps its authority on a slower clock', (t) => {
  const w = world().add(A, wA).add(A, wB).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }, { writer: wB, seq: 0 }], at: AT(1) }))
  const leave = w.push(wB, groupLeave({ at: AT(10) }))
  w.add(A, wC, { rejoin: leave, at: AT(100) })
  const g = buildGroup(w.input())
  t.is(g.members.get(A), 'member')
  w.push(wA, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], seen: g.last, at: AT(50) }))
  t.is(buildGroup(w.input()).members.get(X), 'banned', 'the ban orders after the rejoin, where A is an admin again')
  t.is(validateGroupRecord({ type: 'group-hide', target: { writer: wX, seq: 1 }, on: true, at: AT(1) }, 1), 'malformed', 'seen is required, null or a ref')
})

test('a ban on a diary with no writer here is still liftable', (t) => {
  const w = world().add(A, wA)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  const ban = w.push(wA, groupBan({ member: Y, on: true, at: AT(2) }))
  const g = buildGroup(w.input())
  t.absent(g.members.has(Y), 'Y has no writer in this group')
  t.alike(g.bans.get(Y), ban)
})

test('a promotion keeps the earlier admission of an approval group member', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  post(w, wX, 2)
  t.alike(buildGroup(w.input()).posts.map((p) => p.hidden), [false])
  w.push(G, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 2 }], at: AT(3) }))
  post(w, wX, 4)
  t.alike(buildGroup(w.input()).posts.map((p) => p.hidden), [false, false], 'the post before the promotion stays visible')
})

test('leaves names the causal latest leave whatever its clock', (t) => {
  const w = world().add(X, wX)
  const first = w.push(wX, groupLeave({ at: AT(5) }))
  w.add(X, wX3, { rejoin: first, at: AT(6) })
  t.absent(buildGroup(w.input()).leaves.has(X), 'nothing to name once rejoined')
  const second = w.push(wX3, groupLeave({ at: AT(1) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'left')
  t.alike(g.leaves.get(X), second, 'the later leave in causal order, despite its earlier clock')
})

test('writers lists the cores the fold counted', (t) => {
  const w = world().add(X, wX)
  t.alike([...buildGroup(w.input()).writers].sort(), [G, wX].sort())
  t.alike([...buildGroup(world({ bindRoot: false }).add(X, wX).input()).writers], [wX], 'an unbound root is not counted')
  const big = world()
  for (let i = 0; i < MAX_GROUP_WRITERS + 3; i++) big.add(K(0x10000 + i), K(0x20000 + i))
  const g = buildGroup(big.input())
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.absent(g.writers.has(K(0x20000 + MAX_GROUP_WRITERS + 2)), 'a writer beyond the cap is left out')
})

test('the writer cap never keeps a rejoin without its leave', (t) => {
  const w = world({ join: 'approval' })
  const wOld = K(0x900000)
  const wNew = K(0x10)
  w.add(X, wOld)
  w.push(G, groupAdmit({ member: X, on: true, at: AT(1) }))
  const leave = w.push(wOld, groupLeave({ at: AT(2) }))
  w.add(X, wNew, { rejoin: leave, at: AT(3) })
  post(w, wNew, 4)
  for (let i = 0; i < MAX_GROUP_WRITERS - 1; i++) w.add(K(0x10000 + i), K(0x20000 + i))
  const g = buildGroup(w.input())
  t.absent(g.posts.some((p) => p.writer === wNew), 'the rejoined writer is left out with its leave')
  t.not(g.members.get(X), 'member', 'the old admission is not reused')
  t.is(g.incomplete, true)
})

test('over 512 writers keeps the 512 lowest keys', (t) => {
  const w = world()
  // A community binds at most 511 CWs besides its root, so 75 diaries of 8
  // writers each go over G's cap.
  const n = MAX_GROUP_WRITERS + 88
  for (let i = 0; i < n; i++) {
    const d = K(0x10000 + (i % 75))
    const key = K(0x20000 + ((i * 7919) % n))
    w.add(d, key)
    post(w, key, i)
  }
  const g = buildGroup(w.input())
  const writers = new Set(g.posts.map((p) => p.writer))
  t.is(writers.size + 1, MAX_GROUP_WRITERS, 'the root and 511 others')
  t.ok([...writers].every((k) => k < K(0x20000 + MAX_GROUP_WRITERS - 1)))
  t.is(g.incomplete, true, 'a writer dropped by the cap leaves the group incomplete')
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse()
  t.alike(normalize(buildGroup(shuffled)), normalize(g))
})

test('over 512 writers a frozen writer goes before the live ones of its layer (#350)', (t) => {
  // 64 diaries of 8 writers and the root: one over the cap.
  const build = (freeze) => {
    const w = world()
    for (let i = 0; i < MAX_GROUP_WRITERS; i++) {
      const key = K(0x20000 + i)
      w.add(K(0x10000 + (i % 64)), key)
      post(w, key, i)
    }
    // The lowest key, cut at its length: frozen, nothing of it is dropped.
    if (freeze) w.mark(K(0x10000), K(0x20000), 2)
    return buildGroup(w.input())
  }
  const lowest = K(0x20000)
  const highest = K(0x20000 + MAX_GROUP_WRITERS - 1)
  let g = build(false)
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.ok(g.writers.has(lowest), 'control: the lowest key stays')
  t.absent(g.writers.has(highest), 'control: the highest key goes')
  g = build(true)
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.absent(g.writers.has(lowest), 'the frozen writer goes first')
  t.ok(g.writers.has(highest), 'and the live one stays')
  t.is(g.incomplete, true, 'a dropped frozen writer leaves the group incomplete')
})

test('the creator cannot be banned or demoted', (t) => {
  const w = world().add(A, wA).add(C, wC)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: C, on: false, at: AT(2) }))
  post(w, G, 3)
  w.push(wA, groupBan({ member: C, on: true, at: AT(4) }))
  w.push(wA, groupAdmit({ member: C, on: false, at: AT(4) }))
  post(w, wC, 5)
  const g = buildGroup(w.input())
  t.ok(g.admins.has(C))
  t.is(g.members.get(C), 'member')
  t.alike(g.posts.map((p) => p.hidden), [false, false])
})

test('a missing writer sets incomplete and never blocks the rest', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const p = post(w, wX, 1)
  post(w, wY, 2, { replyTo: p, seen: p })
  const g = buildGroup(w.input({ drop: [wX] }))
  t.is(g.incomplete, true)
  t.alike(refs(g), [wY + ':1'])
  const unbound = world({ bindRoot: false }).add(X, wX)
  post(unbound, G, 1)
  post(unbound, wX, 2)
  const u = buildGroup(unbound.input())
  t.is(u.incomplete, true, 'the root is not bound by the creator diary')
  t.alike(refs(u), [wX + ':1'])
  const forged = world().add(X, wX)
  forged.logs.get(wX).diary = Y
  t.alike(buildGroup(forged.input()).members.has(X), false, 'the writer header must name the diary')
})

test('a backward clock keeps a writer in its own seq order', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 100)
  post(w, wX, 50)
  post(w, wX, 10)
  post(w, wY, 60)
  const g = buildGroup(w.input())
  t.alike(refs(g), [wY + ':1', wX + ':1', wX + ':2', wX + ':3'])
})

test('a reply never sorts before its parent', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const parent = post(w, wX, 100)
  post(w, wY, 5, { replyTo: parent })
  t.alike(refs(buildGroup(w.input())), [wX + ':1', wY + ':1'])
})

test('a forged seen cycle resolves deterministically', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 10, { seen: { writer: wY, seq: 1 } })
  post(w, wY, 5, { seen: { writer: wX, seq: 1 } })
  post(w, wY, 6, { seen: { writer: wY, seq: 9 } })
  const g = buildGroup(w.input())
  t.alike(refs(g), [wY + ':1', wY + ':2', wX + ':1'], 'the smallest head is released, then the order resumes')
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse()
  t.alike(refs(buildGroup(shuffled)), refs(g))
})

test('two admins cannot ban each other', (t) => {
  const w = world().add(A, wA).add(B, wB)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wA, 2)
  post(w, wB, 2)
  w.push(wA, groupBan({ member: B, on: true, at: AT(3) }))
  w.push(wB, groupBan({ member: A, on: true, at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(A), 'member')
  t.is(g.members.get(B), 'member')
  t.alike(g.posts.map((p) => p.hidden), [false, false])
})

test('admin shielding never depends on the clock', (t) => {
  const run = (banAt) => {
    const w = world().add(A, wA).add(B, wB)
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(10) }))
    w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(11) }))
    post(w, wB, 30)
    w.push(wA, groupBan({ member: B, on: true, at: AT(banAt) }))
    return buildGroup(w.input())
  }
  for (const at of [0, 20]) {
    const g = run(at)
    t.is(g.members.get(B), 'member', 'ban void with at ' + at)
    t.alike(g.posts.map((p) => p.hidden), [false])
  }
  t.alike(normalize(run(0)), normalize(run(20)))
})

test('a demoted admin can then be banned', (t) => {
  const w = world().add(A, wA).add(B, wB)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wB, 2)
  w.push(wA, groupBan({ member: B, on: true, at: AT(3) }))
  t.is(buildGroup(w.input()).members.get(B), 'member', 'shielded while an admin')
  w.push(G, groupAdmin({ member: B, on: false, at: AT(4) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(B), 'banned', 'the same ban counts once B is demoted')
  t.alike(g.posts.map((p) => p.hidden), [true])
  t.absent(g.admins.has(B))
})

test('an unbound root carries no authority', (t) => {
  const charter = (w) => {
    const p = post(w, wX, 1)
    w.push(G, groupMeta({ name: 'Falso', join: 'approval', at: AT(2) }))
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(2) }))
    w.push(G, groupBan({ member: X, on: true, at: AT(3) }))
    w.push(G, groupHide({ target: p, on: true, at: AT(3) }))
    w.push(wA, groupHide({ target: p, on: true, at: AT(4) }))
    post(w, G, 5)
    return buildGroup(w.input())
  }
  // G's creator is the community's creator: the community title stays, the
  // unbound G root appoints and decides nothing.
  let g = charter(world({ bindRoot: false }).add(A, wA).add(X, wX))
  t.is(g.incomplete, true)
  t.is(g.orphan, false)
  t.is(g.name, 'Varanda', 'meta ignored, header still read')
  t.is(g.join, 'open')
  t.is(g.creator, C)
  t.alike([...g.admins], [C], 'no admin appointed: the header diary is listed only as the community creator')
  t.absent(g.admins.has(A))
  t.is(g.members.get(X), 'member', 'ban ignored')
  t.alike(g.posts.map((q) => [q.writer + ':' + q.seq, q.hidden]), [[wX + ':1', false]], 'no root posts, no hide')
  // The header of a demoted community admin (never the community creator):
  // an orphan, with no community admins at all.
  g = charter(world({ bindRoot: false, demoted: true }).add(A, wA).add(X, wX))
  t.is(g.orphan, true, 'only the community creator creates groups')
  t.is(g.creator, C)
  t.alike([...g.admins], [], 'no admin appointed, and a creator with no counted core is no admin either')
  t.absent(g.members.has(C), 'nor a member: a node must not accept charter writes the fold ignores')
  t.is(g.members.get(X), 'member', 'ban ignored')
  t.alike(g.posts.map((q) => [q.writer + ':' + q.seq, q.hidden]), [[wX + ':1', false]], 'no root posts, no hide')
})

test('a ban by a later-cut admin is void and an unban lifting it is ignored', (t) => {
  const w = world().add(A, wA).add(B, wB).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(w, wX, 2)
  w.push(wB, groupBan({ member: X, on: true, at: AT(3) }))
  post(w, wA, 4)
  const voidBan = w.push(wA, groupBan({ member: X, on: true, at: AT(5) }))
  w.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 2 }], at: AT(6) }))
  w.push(wB, groupBan({ member: X, on: false, lifts: voidBan, at: AT(7) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned', 'B ban stands')
  const solo = world().add(A, wA).add(B, wB).add(X, wX)
  solo.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  solo.push(G, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 0 }], at: AT(1) }))
  post(solo, wA, 2)
  const v = solo.push(wA, groupBan({ member: X, on: true, at: AT(3) }))
  solo.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 2 }], at: AT(4) }))
  solo.push(wB, groupBan({ member: X, on: false, lifts: v, at: AT(5) }))
  t.is(buildGroup(solo.input()).members.get(X), 'member', 'the void ban never counted')
})

test('an admin who bans then leaves keeps the ban effective', (t) => {
  const w = world().add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  post(w, wX, 2)
  w.push(wA, groupBan({ member: X, on: true, at: AT(3) }))
  w.push(wA, groupLeave({ at: AT(4) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.is(g.members.get(A), 'left')
  t.alike(g.posts.map((p) => p.hidden), [true])
})

test('one diary binding many low-key writers keeps only its 8 earliest joins', (t) => {
  const w = world().add(A, wA).add(Y, wY)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  // Joined from the highest key down, so join order is not key order.
  const flood = Array.from({ length: MAX_GROUP_WRITERS + 50 }, (_, i) => K(0x100000 + MAX_GROUP_WRITERS + 50 - i))
  for (const k of flood) w.add(X, k)
  const p = post(w, wY, 2)
  w.push(wA, groupHide({ target: p, on: true, at: AT(3) }))
  const g = buildGroup(w.input())
  const xs = [...g.writers].filter((k) => flood.includes(k))
  t.alike(xs.sort(), flood.slice(0, MAX_GROUP_WRITERS_PER_DIARY).sort(), 'the 8 earliest joins of X, not its lowest keys')
  t.ok(g.writers.has(wA) && g.writers.has(wY), 'other diaries keep their writers')
  t.alike(g.posts.map((q) => q.hidden), [true], 'the admin hide still counts')
  t.is(g.incomplete, false, 'the group cap was never reached')
  const c = world()
  for (let i = 0; i < 10; i++) c.add(C, K(0x700 + i))
  const gc = buildGroup(c.input())
  t.is(gc.writers.size, MAX_GROUP_WRITERS_PER_DIARY, 'the bound root is one of the creator 8')
  t.ok(gc.writers.has(G))
})

test('over the group cap the creator and admins go first and banned diaries last', (t) => {
  const w = world()
  const wCreator = K(0xf00001)
  const wAdmin = K(0xf00002)
  const wBanned = K(0x10)
  const Z = K(0x99)
  w.add(C, wCreator).add(A, wAdmin).add(Z, wBanned)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wAdmin, seq: 0 }], at: AT(1) }))
  w.push(G, groupBan({ member: Z, on: true, at: AT(1) }))
  for (let i = 0; i < MAX_GROUP_WRITERS - 3; i++) w.add(K(0x10000 + i), K(0x20000 + i))
  const g = buildGroup(w.input())
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.ok(g.writers.has(wCreator) && g.writers.has(wAdmin), 'the creator and admin writers are kept despite high keys')
  t.absent(g.writers.has(wBanned), 'the banned diary gives up its slot despite the lowest key')
  t.ok(g.writers.has(K(0x20000 + MAX_GROUP_WRITERS - 4)), 'the highest ordinary writer keeps its slot')
  t.is(g.incomplete, true)
  const shuffled = w.input()
  shuffled.writers = shuffled.writers.slice().reverse()
  t.alike(normalize(buildGroup(shuffled)), normalize(g))
})

test('an unbound root gives the header diary no creator powers', (t) => {
  const acts = (w) => {
    const p = post(w, wX, 1)
    w.push(wC, groupBan({ member: X, on: true, at: AT(2) }))
    w.push(wC, groupHide({ target: p, on: true, at: AT(2) }))
    w.push(wC, groupAdmit({ member: X, on: true, at: AT(2) }))
    post(w, wC, 3)
    return buildGroup(w.input())
  }
  // The community creator, header diary of an unbound G root, acts from a G
  // writer: no G authority; the community title needs no admit.
  let g = acts(world({ bindRoot: false, join: 'approval' }).add(C, wC).add(X, wX))
  t.is(g.creator, C, 'the header stays readable')
  t.alike([...g.admins], [C], 'the community creator only')
  t.is(g.members.get(X), 'requested', 'no ban and no admit from the header diary')
  t.is(g.members.get(C), 'member', 'a community admin needs no admit')
  t.alike(g.posts.map((q) => q.hidden), [true, false], 'the request stays hidden, the community creator post shows')
  // A demoted community admin's header: an orphan, nobody has authority.
  g = acts(world({ bindRoot: false, join: 'approval', demoted: true }).add(C, wC).add(X, wX))
  t.is(g.orphan, true)
  t.is(g.creator, C, 'the header stays readable')
  t.alike([...g.admins], [], 'no admins in an orphan with an unbound root')
  t.is(g.members.get(X), 'requested', 'no ban and no admit from the header diary')
  t.is(g.members.get(C), 'requested', 'an ordinary diary, never auto-admitted')
  t.alike(g.posts.map((q) => q.hidden), [true, true], 'a demoted community admin needs a group admit for its posts')
  for (const demoted of [false, true]) {
    const open = world({ bindRoot: false, demoted }).add(C, wC).add(X, wX)
    open.push(wC, groupBan({ member: X, on: true, at: AT(1) }))
    open.push(wX, groupBan({ member: C, on: true, at: AT(2) }))
    const go = buildGroup(open.input())
    t.is(go.members.get(X), 'member', 'its ban counts for nothing')
    t.is(go.members.get(C), 'member', 'banned by no one with authority')
  }
})

test('a record backdated before a leave on another writer is withdrawn', (t) => {
  const w = world().add(X, wX).add(X, wX2)
  const kept = post(w, wX2, 1)
  w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(10) }))
  post(w, wX2, 5)
  const g = buildGroup(w.input())
  t.alike(g.posts.map((q) => [q.writer + ':' + q.seq, q.hidden]), [[kept.writer + ':1', true], [wX2 + ':2', true]], 'another writer is withdrawn whatever its cut and its clock')
  t.is(g.members.get(X), 'left')
  const u = world().add(X, wX).add(X, wX2)
  post(u, wX2, 1)
  u.push(wX, groupLeave({ cuts: [{ writer: wX, seq: u.len(wX) }], at: AT(10) }))
  t.alike(buildGroup(u.input()).posts.map((q) => q.hidden), [true], 'a writer the leave omits is withdrawn from seq 0')
  const a = world({ join: 'approval' }).add(X, wX).add(X, wX2)
  a.push(G, groupAdmit({ member: X, on: true, at: AT(1) }))
  const leave = a.push(wX, groupLeave({ cuts: [{ writer: wX, seq: a.len(wX) }, { writer: wX2, seq: a.len(wX2) }], at: AT(10) }))
  a.add(X, wX3, { rejoin: leave, at: AT(20) })
  post(a, wX2, 5)
  t.alike(buildGroup(a.input()).posts.map((q) => q.hidden), [true], 'no re-admission skipped by backdating')
})

test('moderation backdated before its author leave carries no authority', (t) => {
  const wA2 = K(0x201)
  const w = world().add(A, wA).add(A, wA2).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }, { writer: wA2, seq: 0 }], at: AT(1) }))
  const p = post(w, wX, 2)
  w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }, { writer: wA2, seq: w.len(wA2) }], at: AT(10) }))
  w.push(wA2, groupBan({ member: X, on: true, at: AT(5) }))
  w.push(wA2, groupHide({ target: p, on: true, at: AT(5) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  t.alike(g.posts.map((q) => q.hidden), [false])
  t.is(g.members.get(A), 'left')
})

test('an admin grant gives nothing to a writer its cuts omit', (t) => {
  const wA2 = K(0x201)
  const w = world().add(A, wA).add(A, wA2).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  const p1 = post(w, wX, 2)
  const p2 = post(w, wX, 3)
  w.push(wA2, groupHide({ target: p1, on: true, at: AT(4) }))
  w.push(wA, groupHide({ target: p2, on: true, at: AT(4) }))
  const g = buildGroup(w.input())
  t.ok(g.admins.has(A))
  t.alike(g.posts.map((q) => q.hidden), [false, true], 'only the listed writer moderates')
  const e = world().add(A, wA).add(X, wX)
  const q = post(e, wX, 1)
  e.push(wA, groupHide({ target: q, on: true, at: AT(2) }))
  e.push(G, groupAdmin({ member: A, on: true, cuts: [], at: AT(3) }))
  t.alike(buildGroup(e.input()).posts.map((r) => r.hidden), [false], 'a grant with no cuts never covers records written before it')
})

test('admits count per generation across several leaves', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, at: AT(1) }))
  post(w, wX, 2)
  const l1 = w.push(wX, groupLeave({ at: AT(3) }))
  w.add(X, wX2, { rejoin: l1, at: AT(4) })
  post(w, wX2, 5)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX2, seq: 2 }], at: AT(6) }))
  post(w, wX2, 7)
  // Every leave lists all the diary's writers, the one retired by l1 too.
  const l2 = w.push(wX2, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(8) }))
  w.add(X, wX3, { rejoin: l2, at: AT(9) })
  post(w, wX3, 10)
  const g = buildGroup(w.input())
  // l2 withdraws wX from seq 0 too: wX is another writer for it.
  t.alike(g.posts.map((q) => q.hidden), [true, true, false, true])
  t.is(g.members.get(X), 'requested')
})

test('a leave backdated under an admit it never observed needs a new admit after the rejoin', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(10) }))
  // No reference to the admit and an earlier `at`: it sorts before the admit.
  const leave = w.push(wX, groupLeave({ seen: null, cuts: [], at: AT(5) }))
  w.add(X, wX3, { rejoin: leave, at: AT(20) })
  post(w, wX3, 21)
  const before = buildGroup(w.input())
  t.alike(before.posts.map((p) => p.hidden), [true], 'the old admit does not cover the new generation')
  t.is(before.members.get(X), 'requested')
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX3, seq: 1 }], at: AT(30) }))
  const after = buildGroup(w.input())
  t.alike(after.posts.map((p) => p.hidden), [false], 'an admit that observed the leave admits it')
  t.is(after.members.get(X), 'member')
})

test('a covered leave that sorts after the admit does not advance its generation', (t) => {
  // The admit cuts past the records held here, so its cut is no ordering
  // edge, and the leave's far `at` puts it after the admit.
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 3 }], at: AT(10) }))
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: 1 }], at: AT(200000) }))
  w.add(X, wX3, { rejoin: leave, at: AT(20) })
  post(w, wX3, 21)
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => p.hidden), [true], 'the admit does not cover the generation after the leave')
  t.is(g.members.get(X), 'requested')

  // A leave whose `seen` names the admit that covers it: a forged cycle.
  const c = world({ join: 'approval' }).add(X, wX)
  const l = c.push(wX, groupLeave({ seen: { writer: G, seq: 1 }, cuts: [{ writer: wX, seq: 1 }], at: AT(200000) }))
  c.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: c.len(wX) }], at: AT(10) }))
  c.add(X, wX3, { rejoin: l, at: AT(20) })
  post(c, wX3, 21)
  const gc = buildGroup(c.input())
  t.alike(gc.posts.map((p) => p.hidden), [true], 'nor through a forged cycle')
  t.is(gc.members.get(X), 'requested')
})

test('an admit at the observed lengths after a leave and rejoin admits the new generation', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(1) }))
  post(w, wX, 2)
  const leave = w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(3) }))
  w.add(X, wX3, { rejoin: leave, at: AT(4) })
  post(w, wX3, 5)
  // Only the old writer's cut observes the leave: the rejoin is cut at 0.
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX3, seq: 0 }], at: AT(6) }))
  post(w, wX3, 7)
  const g = buildGroup(w.input())
  t.alike(g.posts.map((p) => [p.writer + ':' + p.seq, p.hidden]), [
    [wX + ':1', false],
    [wX3 + ':1', false],
    [wX3 + ':2', false]
  ])
  t.is(g.members.get(X), 'member')
})

// Communities: CM is created by Z (its root is Z's CW); C, a community
// admin, created G in it.
const CM = K(0x900)
const CM2 = K(0x901)
const Z = K(6)
const wZ = K(0x700)
const cwA = cwOf(A)
const cwA2 = K(0xcc0201)
const cwX = cwOf(X)

// G inside CM, created by CM's creator Z (only the community's creator
// creates groups): C and A are community admins unless `admins` says
// otherwise, X and Y plain members; A, X and Y write in G. Without
// `create`, nobody created G in CM (an orphan).
function linkedWorld ({ join = 'open', admins = [A], create = true } = {}) {
  const cm = communityOf({
    key: CM,
    creator: Z,
    members: [C, A, X, Y].map((diary) => ({ diary, cw: cwOf(diary), status: 'member' })),
    admins: [C, ...admins],
    creates: create ? [{ by: Z, group: G }] : []
  })
  const g = groupIn(cm, { key: G, diary: Z, join, name: 'Varanda' })
  const w = {
    C: cm,
    logs: g.logs,
    joins: g.joins,
    push: g.push,
    len: g.len,
    add (diary, key, opts = {}) {
      if (cm.cwOf(diary) === undefined) cm.addWriter(diary, cwOf(diary))
      g.add(diary, key, opts)
      return w
    },
    input ({ drop = [], community = cm.input() } = {}) {
      return g.input({ drop, community })
    }
  }
  return w.add(A, wA).add(X, wX).add(Y, wY)
}

const cwBan = (w, cw, member, s) => w.C.push(cw, communityBan({ group: G, member, on: true, at: AT(s) }))
const cwOfLog = (input, key) => input.writers.find((l) => l.key === key)

test('community record shapes and limits', async (t) => {
  const CR = { root: true, community: true }
  const CW = { community: true }
  const create = groupCreateRecord({ group: G, at: AT(1) })
  t.alike(Object.keys(create), ['type', 'group', 'seen', 'at'])
  t.is(validateGroupRecord(create, 1, CW), 'root-only', 'only the community creator creates, in its root')
  t.is(validateGroupRecord(create, 1, CR), null)
  t.is(validateGroupRecord(create, 1), 'community-only', 'group-create only in a community core')
  const ban = communityBan({ group: G, member: X, on: true, at: AT(1) })
  t.alike(Object.keys(ban), ['type', 'group', 'member', 'on', 'cuts', 'lifts', 'seen', 'at'])
  t.is(validateGroupRecord(ban, 1, CW), null)
  t.is(validateGroupRecord({ ...ban, group: null }, 1, CW), null, 'group null acts on C itself')
  t.is(validateGroupRecord(ban, 1), 'malformed', 'a group core takes no group key')
  t.is(validateGroupRecord(communityHide({ group: G, target: { writer: wX, seq: 1 }, on: true, at: AT(1) }), 1, CW), null)
  t.is(validateGroupRecord({ type: 'group-hide', group: null, target: { writer: wX, seq: 1 }, on: true, seen: null, at: AT(1) }, 1, CW), 'malformed', 'C has no posts')
  t.is(validateGroupRecord(groupPost({ text: 'oi', at: AT(1) }), 1, CW), 'group-only')
  for (const type of ['group-link', 'community-link']) {
    t.is(validateGroupRecord({ type, group: G, on: true, cuts: [], at: AT(1) }, 1, CR), 'malformed', type + ' is gone')
  }
  const many = (n) => Array.from({ length: n }, (_, i) => ({ writer: K(0x1000 + i), seq: 1 }))
  t.is(validateGroupRecord(groupAdmin({ member: A, on: false, cuts: many(16), at: AT(1) }), 1, CR), null, 'a community grant keeps 16 cuts')
  t.is(validateGroupRecord({ ...groupAdmin({ member: A, on: false, at: AT(1) }), cuts: many(17) }, 1, CR), 'cuts-invalid')
  await t.exception.all(async () => communityBan({ group: G, member: X, on: true, cuts: many(17), at: AT(1) }), /cuts-invalid/)
  await t.exception.all(async () => communityAdmit({ group: G, member: X, on: true, cuts: [{ writer: wA, seq: 1 }, { writer: wA, seq: 2 }], at: AT(1) }), /cuts-invalid/)
})

test('a header naming C without a create there is an orphan: community powers stop at it', (t) => {
  const w = linkedWorld({ create: false })
  post(w, wX, 2)
  post(w, wY, 2)
  cwBan(w, cwA, X, 3)
  w.C.push(CM, communityBan({ group: G, member: Y, on: true, at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.orphan, true)
  t.is(g.community, null)
  t.is(g.members.get(X), 'member', 'the ban of a community admin is void')
  t.is(g.members.get(Y), 'member', 'and so is the community creator\'s')
  t.absent(g.admins.has(A))
  t.absent(g.admins.has(C), 'no community admin is listed')
  t.alike([...g.admins], [Z], 'Z only as the header diary of its own root')
})

test('a community admin ban in G from its CW counts', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  cwBan(w, cwA, X, 3)
  post(w, wY, 4)
  w.C.push(CM, communityBan({ group: G, member: Y, on: true, at: AT(5) }))
  const g = buildGroup(w.input())
  t.is(g.community.creator, Z)
  t.is(g.members.get(X), 'banned', 'by a community admin')
  t.is(g.members.get(Y), 'banned', 'by the community creator')
  t.ok(g.admins.has(A) && g.admins.has(Z))
  t.alike(visible(g), [])
  t.is(g.incomplete, false)
})

test('a community admin never appoints group admins', (t) => {
  const w = linkedWorld()
  t.is(validateGroupRecord(groupAdmin({ member: X, on: true, at: AT(2) }), 1), 'root-only', 'group-admin stays a group root record')
  t.is(validateGroupRecord(groupAdmin({ member: X, on: true, at: AT(2) }), 1, { community: true }), 'root-only', 'never from a CW')
  w.C.push(cwA, communityAdmit({ group: G, member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(2) }))
  const g = buildGroup(w.input())
  t.absent(g.admins.has(X))
})

test('a community demotion removes CW power from its cut on, earlier bans stay', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  post(w, wY, 2)
  cwBan(w, cwA, X, 3)
  cwBan(w, cwA, Y, 1)
  w.C.push(CM, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: 2 }], at: AT(9) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned', 'a ban below the cut stays')
  t.is(g.members.get(Y), 'member', 'a ban at the cut is void even with an earlier at')
  t.ok(g.community !== null, 'G stays in C')
  t.absent(g.admins.has(A))
})

test('an unlisted CW loses every action after a demotion with cuts', (t) => {
  const w = linkedWorld()
  w.C.addWriter(A, cwA2)
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }, { writer: cwA2, seq: 1 }], at: AT(2) }))
  post(w, wX, 2)
  post(w, wY, 2)
  cwBan(w, cwA, X, 3)
  cwBan(w, cwA2, Y, 3)
  t.is(buildGroup(w.input()).members.get(Y), 'banned', 'the second CW acts once granted')
  w.C.push(CM, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: 5 }], at: AT(9) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned', 'the listed CW keeps actions below its cut')
  t.is(g.members.get(Y), 'member', 'the unlisted CW keeps nothing')
})

test('a community root never folds as a group, even when a community creates its key', (t) => {
  const w = linkedWorld()
  w.C.push(CM, groupCreateRecord({ group: CM2, at: AT(2) }))
  const nested = communityOf({ key: CM2, creator: C, members: [{ diary: A, cw: K(0xcc0900), status: 'member' }] })
  const g = buildGroup({ ...nested.input(), community: w.C.input() })
  t.is(g.kind, null, 'the empty group')
  t.is(g.community, null)
  t.is(validateGroupHeader({ ...groupHeader({ kind: 'community', diary: Z, at: AT(0) }), community: CM }), 'malformed', 'a community has no parent')
  w.C.push(CM, groupCreateRecord({ group: CM, at: AT(3) }))
  t.absent(buildCommunity(w.C.input()).groups.includes(CM), 'a community never lists itself')
})

test('a second community creating the same group is ignored: the header is immutable', (t) => {
  const w = linkedWorld()
  const other = communityOf({ key: CM2, creator: Y, members: [{ diary: X, cw: K(0xcc0400), status: 'member' }] })
  other.push(CM2, groupCreateRecord({ group: G, at: AT(1) }))
  other.push(CM2, communityBan({ group: G, member: X, on: true, at: AT(3) }))
  post(w, wX, 2)
  const g = buildGroup(w.input({ community: other.input() }))
  t.is(g.community, null, 'not the parent its header names')
  t.is(g.incomplete, true)
  t.is(g.members.get(X), 'member', 'the second community has no power')
  const h = buildGroup(w.input())
  t.is(h.community.creator, Z)
  t.is(h.members.get(X), 'member')
})

test('a community admin cannot be banned in G and needs no admit', (t) => {
  const w = linkedWorld({ join: 'approval' })
  w.add(Z, wZ)
  w.push(G, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  post(w, wA, 2)
  w.push(wX, groupBan({ member: A, on: true, at: AT(3) }))
  w.push(G, groupBan({ member: Z, on: true, at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(A), 'member')
  t.is(g.members.get(Z), 'member')
  t.absent(g.requests.includes(A))
  t.absent(g.requests.includes(Z))
  t.alike(visible(g), [wA + ':1'], 'auto-admitted')
  t.is(g.bans.size, 0)
  // Demoted in C, the same ban counts.
  w.C.push(CM, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: w.C.len(cwA) }], at: AT(9) }))
  t.is(buildGroup(w.input()).members.get(A), 'banned')
})

test('only the parent community root grants community admins', (t) => {
  const w = linkedWorld({ admins: [] })
  post(w, wX, 2)
  cwBan(w, cwA, X, 3)
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member')
  t.absent(g.admins.has(A))
  // Another root of the same creator grants A: never G's parent.
  const other = communityOf({ key: CM2, creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A] })
  t.is(buildGroup(w.input({ community: other.input() })).members.get(X), 'member')
  t.is(validateGroupRecord(groupAdmin({ member: A, on: true, at: AT(1) }), 1, { community: true }), 'root-only', 'never from a CW')
  // A grant naming the community creator changes nothing.
  w.C.push(CM, groupAdmin({ member: Z, on: false, at: AT(1) }))
  w.C.push(CM, communityBan({ group: G, member: Y, on: true, at: AT(4) }))
  t.is(buildGroup(w.input()).members.get(Y), 'banned')
})

test('a parent community not held sets incomplete', (t) => {
  const w = linkedWorld()
  t.is(buildGroup(w.input({ community: null })).incomplete, true)
  t.is(buildGroup(w.input()).incomplete, false)
})

test('buildCommunity basics', (t) => {
  const groups = Array.from({ length: MAX_GROUPS_PER_COMMUNITY + 1 }, (_, i) => K(0x2000 + i))
  const cm = communityOf({ key: CM, creator: Z, members: [A, B].map((diary) => ({ diary, cw: cwOf(diary), status: 'member' })), admins: [A, B] })
  cm.push(CM, groupMeta({ name: 'Bairro Novo', join: 'open', at: cm.at() }))
  cm.push(CM, groupAdmin({ member: B, on: false, cuts: [{ writer: cwOf(B), seq: 1 }], at: cm.at() }))
  for (const group of groups) cm.push(CM, groupCreateRecord({ group, at: cm.at() }))
  cm.push(cwA, groupCreateRecord({ group: G, at: cm.at() }))
  const input = cm.input()
  const c = buildCommunity({ ...input, root: { ...input.root, entries: input.root.entries.slice().reverse() } })
  t.is(c.kind, 'community')
  t.is(c.name, 'Bairro Novo')
  t.is(c.creator, Z)
  t.alike([...c.admins].sort(), [A, Z].sort())
  t.alike(c.groups, groups.slice(0, MAX_GROUPS_PER_COMMUNITY), 'the 33rd create was over the cap')
  t.is(c.general, groups[0], 'the first root create')
  t.is(c.created.get(groups[0]).diary, Z)
  t.absent(c.created.has(G), 'an admin create in its CW is root-only')
  t.is(c.incomplete, false)
  t.is(buildCommunity({ root: { key: G, entries: [{ seq: 0, record: groupHeader({ diary: C, community: CM, member: CM, at: AT(0) }) }] } }).creator, null, 'a group root is not a community')
  t.is(buildCommunity(null).incomplete, true)
  t.is(buildCommunity({ root: { key: CM, entries: 'x' } }).creator, null)
})

test('a community grant covers only the CWs it lists, from the listed seq', (t) => {
  const w = linkedWorld({ admins: [] })
  w.C.addWriter(A, cwA2)
  post(w, wX, 2)
  post(w, wY, 2)
  cwBan(w, cwA, X, 3)
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: w.C.len(cwA) }], at: AT(4) }))
  cwBan(w, cwA2, Y, 5)
  const g = buildGroup(w.input())
  t.ok(g.admins.has(A))
  t.is(g.members.get(X), 'member', 'a ban below the grant cut is void')
  t.is(g.members.get(Y), 'member', 'an unlisted CW gets nothing')
  cwBan(w, cwA, Y, 6)
  t.is(buildGroup(w.input()).members.get(Y), 'banned', 'from the cut on it counts')
})

test('a new CW of a community admin acts after a new grant alone', (t) => {
  const w = linkedWorld()
  w.C.addWriter(A, cwA2)
  post(w, wX, 2)
  cwBan(w, cwA2, X, 3)
  t.is(buildGroup(w.input()).members.get(X), 'member', 'no grant lists it')
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }, { writer: cwA2, seq: w.C.len(cwA2) }], at: AT(4) }))
  t.is(buildGroup(w.input()).members.get(X), 'member', 'nothing retroactive')
  cwBan(w, cwA2, X, 5)
  t.is(buildGroup(w.input()).members.get(X), 'banned', 'the grant alone')
})

test('a new CW of the community creator acts at once', (t) => {
  const w = linkedWorld()
  const cwZ2 = K(0xcc0006)
  w.C.addWriter(Z, cwZ2)
  post(w, wX, 2)
  cwBan(w, cwZ2, X, 3)
  const g = buildGroup(w.input())
  t.ok(g.community !== null)
  t.is(g.members.get(X), 'banned', 'the creator needs no grant')
})

test('a community grant starts each listed CW at its own cut', (t) => {
  const w = linkedWorld({ admins: [] })
  w.C.addWriter(A, cwA2)
  post(w, wX, 1)
  post(w, wY, 1)
  cwBan(w, cwA, X, 2)
  cwBan(w, cwA2, Y, 2)
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: 0 }, { writer: cwA2, seq: w.C.len(cwA2) }], at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned', 'a cut at 0 covers the CW from its start')
  t.is(g.members.get(Y), 'member', 'nothing below the other cut')
  cwBan(w, cwA2, Y, 4)
  t.is(buildGroup(w.input()).members.get(Y), 'banned', 'the listed CW from its cut')
})

test('after a leave and a rejoin in C, the new CW acts once a grant lists it', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  const leave = w.C.push(cwA, groupLeave({ cuts: [{ writer: cwA, seq: w.C.len(cwA) }], at: AT(3) }))
  cwBan(w, cwA, X, 1)
  t.is(buildGroup(w.input()).members.get(X), 'member', 'a CW record after the leave is withdrawn in C')
  w.C.addWriter(A, cwA2, { rejoin: leave })
  cwBan(w, cwA2, X, 5)
  t.is(buildGroup(w.input()).members.get(X), 'member', 'the standing grant never listed the new CW')
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA2, seq: w.C.len(cwA2) }], at: AT(6) }))
  cwBan(w, cwA2, X, 7)
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.ok(g.admins.has(A))
})

test('a leave in C voids the CW actions before and after it; a rejoin needs a new grant', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  post(w, wY, 2)
  cwBan(w, cwA, X, 3)
  t.is(buildGroup(w.input()).members.get(X), 'banned', 'control: before the leave the ban counts')
  const leave = w.C.push(cwA, groupLeave({ cuts: [{ writer: cwA, seq: w.C.len(cwA) }], at: AT(4) }))
  cwBan(w, cwA, Y, 1)
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'member', 'no authority after leaving, past records included')
  t.is(g.members.get(Y), 'member', 'after it on the same CW, whatever its clock')
  t.absent(g.admins.has(A), 'a left admin is no admin')
  w.C.addWriter(A, cwA2, { rejoin: leave })
  let h = buildGroup(w.input())
  t.absent(h.admins.has(A), 'back in C on a fresh CW the standing grant never listed')
  t.is(h.members.get(X), 'member', 'the rejoin restores nothing')
  t.is(h.members.get(Y), 'member')
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA2, seq: w.C.len(cwA2) }], at: AT(9) }))
  h = buildGroup(w.input())
  t.ok(h.admins.has(A), 're-granted on the new CW')
  t.is(h.members.get(X), 'member', 'the old CW stays void')
})

test('a community creator leave withdraws its root creates above the cut, in buildGroup and buildCommunity', (t) => {
  const cm = communityOf({ key: CM, creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G }] })
  const Glate = K(0x1100)
  cm.push(CM, groupLeave({ cuts: [{ writer: CM, seq: 2 }], at: AT(5) }))
  cm.push(CM, groupCreateRecord({ group: Glate, at: AT(6) }))
  const c = buildCommunity(cm.input())
  t.alike(c.groups, [G], 'the create above the cut is withdrawn')
  t.is(c.general, G)
  t.is(buildGroup(groupIn(cm, { key: Glate, diary: Z }).input()).orphan, true, 'buildGroup agrees')
  const g = groupIn(cm, { key: G, diary: Z })
  g.add(X, wX)
  post(g, wX, 7)
  const r = buildGroup(g.input())
  t.is(r.orphan, false)
  t.is(r.members.get(Z), 'left', 'its creator is out of C')
  t.is(r.members.get(X), 'member')
})

test('copies of a CW merge by seq in any order, and a forked CW is left out', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  cwBan(w, cwA, X, 3)
  w.C.push(cwA, communityHide({ group: G, target: { writer: wX, seq: 1 }, on: true, at: AT(4) }))
  const input = w.C.input()
  const real = cwOfLog(input, cwA)
  const others = input.writers.filter((l) => l.key !== cwA)
  const one = { ...real, entries: real.entries.filter((e) => e.seq !== 2) }
  const two = { ...real, entries: real.entries.filter((e) => e.seq !== 1) }
  const a = buildGroup(w.input({ community: { ...input, writers: [...others, one, two] } }))
  const b = buildGroup(w.input({ community: { ...input, writers: [two, ...others, one] } }))
  t.alike(normalize(a), normalize(b), 'consistent copies merge')
  t.is(a.members.get(X), 'banned')
  t.is(a.incomplete, false)
  const fork = { ...real, entries: real.entries.map((e) => e.seq === 1 ? { seq: 1, record: communityBan({ group: G, member: Y, on: true, at: AT(3) }) } : e) }
  const f1 = buildGroup(w.input({ community: { ...input, writers: [...others, real, fork] } }))
  const f2 = buildGroup(w.input({ community: { ...input, writers: [fork, ...others, real] } }))
  t.alike(normalize(f1), normalize(f2), 'a fork too')
  t.is(f1.members.get(X), 'member', 'the forked CW is left out')
  t.is(f1.members.get(Y), 'member')
  t.is(f1.incomplete, true)
})

test('copies of a writer core merge by seq and a forked writer is left out', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 1)
  post(w, wX, 2)
  const entries = w.logs.get(wX).entries
  const input = w.input()
  const first = { key: wX, diary: X, entries: entries.filter((e) => e.seq !== 2) }
  const second = { key: wX, diary: X, entries: entries.filter((e) => e.seq !== 1) }
  const others = input.writers.filter((l) => l.key !== wX)
  const a = buildGroup({ ...input, writers: [...others, first, second] })
  const b = buildGroup({ ...input, writers: [second, ...others, first] })
  t.alike(normalize(a), normalize(b))
  t.is(a.posts.filter((p) => p.writer === wX).length, 2, 'both copies count')
  t.is(a.incomplete, false)
  const fork = { key: wX, diary: X, entries: entries.map((e) => e.seq === 2 ? { seq: 2, record: groupPost({ text: 'outro', at: AT(2) }) } : e) }
  const f = buildGroup({ ...input, writers: [...others, { key: wX, diary: X, entries }, fork] })
  t.absent(f.writers.has(wX), 'a forked writer is left out')
  t.is(f.incomplete, true)
  t.alike(normalize(f), normalize(buildGroup({ ...input, writers: [fork, ...others, { key: wX, diary: X, entries }] })))
})

test('copies of a writer core whose headers differ are a fork', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 1)
  const input = w.input()
  const entries = w.logs.get(wX).entries
  const others = input.writers.filter((l) => l.key !== wX)
  for (const header of [writerHeader({ group: K(0x999), diary: X, member: cwOf(X), at: AT(0) }), writerHeader({ group: G, diary: Y, member: cwOf(Y), at: AT(0) })]) {
    const odd = { key: wX, diary: header.diary, entries: [{ seq: 0, record: header }] }
    const f = buildGroup({ ...input, writers: [...others, { key: wX, diary: X, entries }, odd] })
    t.absent(f.writers.has(wX), 'left out')
    t.is(f.incomplete, true)
    t.alike(normalize(f), normalize(buildGroup({ ...input, writers: [odd, ...others, { key: wX, diary: X, entries }] })))
  }
})

test('copies that differ at a seq where one block is invalid are a fork', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 1)
  const input = w.input()
  const entries = w.logs.get(wX).entries
  const others = input.writers.filter((l) => l.key !== wX)
  const odd = { key: wX, diary: X, entries: entries.map((e) => e.seq === 1 ? { seq: 1, record: { ...e.record, extra: 1 } } : e) }
  const f = buildGroup({ ...input, writers: [...others, { key: wX, diary: X, entries }, odd] })
  t.absent(f.writers.has(wX), 'left out')
  t.is(f.posts.filter((p) => p.writer === wX).length, 0)
  t.is(f.incomplete, true)
  t.alike(normalize(f), normalize(buildGroup({ ...input, writers: [odd, ...others, { key: wX, diary: X, entries }] })))
})

test('a writer copy whose block 0 is invalid still forks the valid copy', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  post(w, wX, 1)
  const input = w.input()
  const entries = w.logs.get(wX).entries
  const others = input.writers.filter((l) => l.key !== wX)
  const odd = { key: wX, diary: X, entries: entries.map((e) => e.seq === 0 ? { seq: 0, record: { ...e.record, extra: 1 } } : e) }
  for (const writers of [[...others, { key: wX, diary: X, entries }, odd], [odd, ...others, { key: wX, diary: X, entries }]]) {
    const f = buildGroup({ ...input, writers })
    t.absent(f.writers.has(wX), 'left out')
    t.is(f.posts.filter((p) => p.writer === wX).length, 0)
    t.is(f.incomplete, true)
  }
  const alone = buildGroup({ ...input, writers: [...others, odd] })
  t.absent(alone.writers.has(wX), 'an invalid header alone binds nothing')
  t.is(alone.incomplete, true)
})

test('at the writer cap the writers of community admins rank with the group admins', (t) => {
  const w = linkedWorld()
  const wAhigh = K(0xf00002)
  w.add(A, wAhigh)
  // A community binds at most 511 CWs besides its root, so 64 diaries of
  // up to 8 writers fill G's cap.
  const n = MAX_GROUP_WRITERS - 2
  for (let i = 0; i < n; i++) w.add(K(0x10000 + (i % 64)), K(0x20000 + i))
  const g = buildGroup(w.input())
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.ok(g.writers.has(wAhigh), 'the community admin writer is kept')
  t.absent(g.writers.has(K(0x20000 + n - 1)), 'the highest ordinary writer gives its slot')
  t.is(g.incomplete, true)
})

test('at the writer cap a demoted community admin has no priority', (t) => {
  const w = linkedWorld()
  const wAhigh = K(0xf00002)
  w.add(A, wAhigh)
  w.C.push(CM, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: w.C.len(cwA) }], at: AT(2) }))
  const n = MAX_GROUP_WRITERS - 3
  for (let i = 0; i < n; i++) w.add(K(0x10000 + (i % 64)), K(0x20000 + i))
  const g = buildGroup(w.input())
  t.ok(g.community !== null)
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.absent(g.writers.has(wAhigh), 'the ex community admin is not ranked first')
  t.ok(g.writers.has(K(0x20000 + n - 2)), 'ordinary writers keep their slots by key')
})

test('at the writer cap a diary a CW ban hits in G goes last', (t) => {
  const w = linkedWorld()
  const V = K(0x60)
  const wV = K(0x6000)
  const M = K(0x61)
  const wM = K(0x6001)
  w.add(V, wV).add(M, wM)
  post(w, wV, 3)
  cwBan(w, cwA, V, 4)
  const n = MAX_GROUP_WRITERS - 3
  for (let i = 0; i < n; i++) w.add(K(0x10000 + (i % 64)), K(0x30000 + i))
  const g = buildGroup(w.input())
  t.ok(g.community !== null)
  t.is(g.writers.size, MAX_GROUP_WRITERS)
  t.ok(g.bans.has(V), 'the ban sits in the CW, outside the cap')
  t.absent(g.writers.has(wV), 'the banned diary is ranked last')
  t.ok(g.writers.has(wM), 'and a member keeps the slot')
})

test('an explicitly empty joins map binds nothing in buildCommunity, as in buildGroup', (t) => {
  const w = linkedWorld()
  const empty = { ...w.C.input(), joins: new Map() }
  const c = buildCommunity(empty)
  t.is(c.creator, null)
  t.alike(c.groups, [], 'no catalogue')
  t.is(c.incomplete, true)
  const g = buildGroup(w.input({ community: empty }))
  t.is(g.community, null)
  t.is(g.incomplete, true)
  t.is(buildGroup({ ...w.input(), joins: new Map() }).writers.size, 0, 'nor does a group')
})

test('a parent root whose header is not a community is ignored', (t) => {
  const w = linkedWorld()
  const input = w.C.input()
  const header = groupHeader({ diary: Z, community: CM2, member: CM2, name: 'Bairro', at: AT(0) })
  const other = { ...input, root: { ...input.root, entries: input.root.entries.map((e) => e.seq === 0 ? { seq: 0, record: header } : e) } }
  const a = buildGroup(w.input({ community: other }))
  t.is(a.community, null, 'the root is not a community')
  t.absent(a.admins.has(A))
  t.is(a.incomplete, true)
})

test('a community unban restores the posts a community ban hid in G', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  post(w, wX, 3)
  const ban = w.C.push(CM, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: w.C.len(cwX) }], at: w.C.at() }))
  const g = buildGroup(w.input())
  t.is(g.members.get(X), 'banned')
  t.alike(visible(g).filter((r) => r.startsWith(wX)), [])
  w.C.push(CM, communityBan({ member: X, on: false, lifts: ban, cuts: [{ writer: cwX, seq: w.C.len(cwX) }], at: w.C.at() }))
  const h = buildGroup(w.input())
  t.is(h.members.get(X), 'member')
  t.alike(visible(h).filter((r) => r.startsWith(wX)), [wX + ':1', wX + ':2'])
})

test('a group is incomplete when its community fold is incomplete', (t) => {
  const w = linkedWorld()
  w.C.addWriter(B, cwOf(B))
  const g = buildGroup(w.input({ community: w.C.input({ drop: [cwOf(B)] }) }))
  t.ok(g.community !== null, 'still under its community')
  t.is(g.incomplete, true, 'a missing CW could hide a ban or a leave')
  t.is(buildGroup(w.input()).incomplete, false)
})

test('a community root its creator never bound gives no creator power', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  post(w, wY, 2)
  cwBan(w, cwA, X, 3)
  w.C.push(CM, communityBan({ group: G, member: Y, on: true, at: AT(3) }))
  const input = w.C.input()
  const unbound = { ...input, joins: new Map([...input.joins].filter(([d]) => d !== Z)) }
  const g = buildGroup(w.input({ community: unbound }))
  t.is(g.community, null)
  t.alike([...g.admins], [Z], 'Z only as G\'s own creator')
  t.absent(g.admins.has(A))
  t.is(g.members.get(X), 'member')
  t.is(g.members.get(Y), 'member')
  t.is(g.incomplete, true, 'an unbound parent reads as incomplete')
  const c = buildCommunity(unbound)
  t.is(c.creator, null)
  t.is(c.admins.size, 0)
  t.alike(c.groups, [])
  t.is(c.incomplete, true)
  t.is(c.name, 'Bairro')
  const byA = new Map([...unbound.joins, [A, [...unbound.joins.get(A), { writer: CM, on: true, seq: 9 }]]])
  t.is(buildCommunity({ ...unbound, joins: byA }).creator, null, 'only the header diary binds')
  t.is(buildGroup(w.input()).members.get(Y), 'banned', 'bound, the creator acts')
})

test('a repeated community grant omitting a CW keeps its start; a lower cut starts it there', (t) => {
  const w = linkedWorld({ admins: [] })
  post(w, wX, 1)
  cwBan(w, cwA, X, 2)
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: 2 }], at: AT(1) }))
  t.is(buildGroup(w.input()).members.get(X), 'member', 'the ban is below the grant start')
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA2, seq: 1 }], at: AT(3) }))
  t.is(buildGroup(w.input()).members.get(X), 'member', 'a repeated grant that omits the CW keeps its start')
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }], at: AT(4) }))
  t.is(buildGroup(w.input()).members.get(X), 'banned', 'the root layer is ordered: the later grant starts it at 1')
})

test('a repeated grant that adds a CW keeps every earlier action of the CWs already listed', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  post(w, wY, 2)
  cwBan(w, cwA, X, 3)
  w.C.push(CM, communityBan({ group: G, member: Y, on: true, at: AT(3) }))
  w.C.addWriter(A, cwA2)
  w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: w.C.len(cwA) }, { writer: cwA2, seq: 1 }], at: AT(4) }))
  const g = buildGroup(w.input())
  t.ok(g.community !== null)
  t.is(g.members.get(X), 'banned', 'the admin ban stays')
  t.is(g.members.get(Y), 'banned', 'the creator ban stays')
})

test('a CW copy whose block 0 is invalid still forks the valid copy', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  cwBan(w, cwA, X, 3)
  const input = w.C.input()
  const real = cwOfLog(input, cwA)
  const others = input.writers.filter((l) => l.key !== cwA)
  const odd = { ...real, entries: real.entries.map((e) => e.seq === 0 ? { seq: 0, record: { ...e.record, extra: 1 } } : e) }
  t.is(buildGroup(w.input()).members.get(X), 'banned')
  const a = buildGroup(w.input({ community: { ...input, writers: [...others, real, odd] } }))
  const b = buildGroup(w.input({ community: { ...input, writers: [odd, ...others, real] } }))
  t.alike(normalize(a), normalize(b))
  t.is(a.members.get(X), 'member', 'the forked CW is ignored')
  t.is(a.incomplete, true)
  const alone = buildGroup(w.input({ community: { ...input, writers: [...others, odd] } }))
  t.is(alone.members.get(X), 'member')
  t.is(alone.incomplete, true, 'a CW with only an invalid block 0 reads as missing')
})

test('a CW copy without block 0 is no copy of it', (t) => {
  const w = linkedWorld()
  post(w, wX, 2)
  cwBan(w, cwA, X, 3)
  const input = w.C.input()
  const real = cwOfLog(input, cwA)
  const others = input.writers.filter((l) => l.key !== cwA)
  const with_ = (extra) => buildGroup(w.input({ community: { ...input, writers: [...others, ...extra] } }))
  t.is(with_([real, { key: cwA, diary: A, entries: [] }]).members.get(X), 'banned', 'an empty snapshot changes nothing')
  t.is(with_([{ ...real, entries: real.entries.slice(1) }, real]).members.get(X), 'banned', 'a headerless partial copy changes nothing')
  const clash = { key: cwA, diary: A, entries: [{ seq: 1, record: communityBan({ group: G, member: Y, on: true, at: AT(3) }) }] }
  const c = with_([real, clash])
  t.is(c.members.get(X), 'banned', 'without block 0 it takes no part in the merge')
  t.is(c.members.get(Y), 'member')
  t.is(c.incomplete, false)
})

test('a community entry without a block 0 counts as not given', (t) => {
  const w = linkedWorld()
  const input = w.C.input()
  t.is(buildGroup(w.input()).incomplete, false)
  t.is(buildGroup(w.input({ community: null })).incomplete, true, 'omitted')
  t.is(buildGroup(w.input({ community: { ...input, root: { key: CM, entries: [] } } })).incomplete, true, 'no entries')
  t.is(buildGroup(w.input({ community: { ...input, root: { key: CM, entries: input.root.entries.slice(1) } } })).incomplete, true, 'no block 0')
})

const MAX_CUTS_IN_TEST = 16

// mulberry32: a small seeded PRNG, so every run checks the same histories.
function mulberry32 (seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const DIARY_WRITERS = [[C, [G, wC]], [A, [wA]], [B, [wB]], [X, [wX, wX2]], [Y, [wY]]]

// A random causal history: every reference points to a record that already
// exists, so any prefix of the steps is closed under references.
function history (rnd, steps, { approval = false, rejoinRate = 0.08, withCommunity = false } = {}) {
  const pick = (a) => a[Math.floor(rnd() * a.length)]
  const join = rnd() < 0.5 && !approval ? 'open' : 'approval'
  const diaryWriters = new Map(DIARY_WRITERS.map(([d, ws]) => [d, ws.slice()]))
  const writerDiary = new Map(DIARY_WRITERS.flatMap(([d, ws]) => ws.map((k) => [k, d])))
  const skew = new Map([...writerDiary.keys()].map((k) => [k, Math.floor((rnd() - 0.5) * 7200)]))
  const lens = new Map([...writerDiary.keys()].map((k) => [k, 1]))
  // World's community: its root holds the header and G's create, each CW
  // its header.
  lens.set(CMG, 2)
  for (const d of [A, B, X, Y]) lens.set(cwOf(d), 1)
  const all = []
  const postsMade = []
  const bansMade = []
  const leavesMade = []
  const out = []
  let fresh = 0
  const cutsFor = (d) => {
    const ws = diaryWriters.get(d).slice(0, MAX_CUTS_IN_TEST)
    return ws.filter(() => rnd() < 0.6).map((writer) => ({ writer, seq: Math.floor(rnd() * (lens.get(writer) + 1)) }))
  }
  for (let i = 0; i < steps; i++) {
    // A rejoin: a fresh writer whose header names a leave, usually one of
    // its own diary (a leave of another diary makes the writer invalid).
    if (leavesMade.length && rnd() < rejoinRate) {
      const leave = pick(leavesMade)
      const diary = rnd() < 0.85 ? writerDiary.get(leave.writer) : pick([A, B, X, Y])
      const key = K(0x600 + fresh++)
      diaryWriters.get(diary).push(key)
      writerDiary.set(key, diary)
      skew.set(key, Math.floor((rnd() - 0.5) * 7200))
      lens.set(key, 1)
      out.push({ writer: key, add: { diary, rejoin: leave, at: AT(i * 60 + skew.get(key)) } })
      continue
    }
    // Community steps in G's parent (created by C): grants and demotions
    // of community admins with random cuts over their CWs, CW admits, bans
    // and hides naming G, and community leaves.
    if (withCommunity && rnd() < 0.2) {
      const at = AT(i * 60 + Math.floor((rnd() - 0.5) * 600))
      const roll = rnd()
      let writer = cwOf(pick([A, B, X]))
      let record
      if (roll < 0.35) {
        writer = CMG
        const member = pick([A, B, X])
        const cw = cwOf(member)
        record = groupAdmin({ member, on: rnd() < 0.7, cuts: rnd() < 0.7 ? [{ writer: cw, seq: Math.floor(rnd() * (lens.get(cw) + 1)) }] : [], at })
      } else if (roll < 0.6) {
        const member = pick([A, B, X, Y, C])
        if (rnd() < 0.6 || !bansMade.length) record = communityBan({ group: G, member, on: true, cuts: cutsFor(member), at })
        else record = communityBan({ group: G, member, on: false, cuts: cutsFor(member), lifts: pick(bansMade), at })
      } else if (roll < 0.8 && postsMade.length) {
        record = communityHide({ group: G, target: pick(postsMade), on: rnd() < 0.7, at })
      } else if (roll < 0.95) {
        const member = pick([A, B, X, Y])
        record = communityAdmit({ group: G, member, on: rnd() < 0.8, cuts: cutsFor(member), at })
      } else {
        record = groupLeave({ cuts: [{ writer, seq: lens.get(writer) }], at })
      }
      const seq = lens.get(writer)
      lens.set(writer, seq + 1)
      if (record.type === 'group-ban' && record.on) bansMade.push({ writer, seq })
      out.push({ writer, seq, record, community: true })
      continue
    }
    let writer = pick([...writerDiary.keys()])
    const at = AT(i * 60 + skew.get(writer) + Math.floor((rnd() - 0.5) * 600))
    const roll = rnd()
    let record
    if (writer === G && roll < 0.25) {
      record = groupAdmin({ member: pick([A, B, X, C]), on: rnd() < 0.7, cuts: [], at })
      record.cuts = cutsFor(record.member)
    } else if (roll < 0.45) {
      record = groupPost({ text: 't' + i, replyTo: postsMade.length && rnd() < 0.4 ? pick(postsMade) : null, seen: all.length && rnd() < 0.7 ? pick(all) : null, at })
    } else if (roll < 0.55 && postsMade.length) {
      record = groupHide({ target: pick(postsMade), on: rnd() < 0.7, at })
    } else if (roll < 0.75) {
      const member = pick([A, B, X, Y, C])
      const on = rnd() < 0.6
      if (on || !bansMade.length) record = groupBan({ member, on: true, cuts: cutsFor(member), at })
      else record = groupBan({ member, on: false, cuts: cutsFor(member), lifts: pick(bansMade), at })
    } else if (roll < 0.9) {
      const member = pick([A, B, X, Y])
      // Half observe every writer of the member at its length (leaves
      // included), half take random cuts that may miss a leave.
      const cuts = rnd() < 0.5
        ? diaryWriters.get(member).slice(0, MAX_CUTS_IN_TEST).map((writer) => ({ writer, seq: lens.get(writer) }))
        : cutsFor(member)
      record = groupAdmit({ member, on: rnd() < 0.8, cuts, at })
      // Mostly from the root, so that admits carry authority.
      if (rnd() < 0.6) writer = G
    } else if (roll < 0.95) {
      record = groupLeave({ cuts: cutsFor(writerDiary.get(writer)).slice(0, MAX_GROUP_WRITERS_PER_DIARY), at })
    } else {
      record = groupPost({ text: 'u' + i, replyTo: null, seen: null, at })
    }
    const seq = lens.get(writer)
    lens.set(writer, seq + 1)
    const ref = { writer, seq }
    all.push(ref)
    if (record.type === 'group-post') postsMade.push(ref)
    if (record.type === 'group-ban' && record.on) bansMade.push(ref)
    if (record.type === 'group-leave') leavesMade.push(ref)
    out.push({ writer, seq, record })
  }
  return { join, steps: out, withCommunity }
}

function inputOf (h, n, rnd) {
  const w = world({ join: h.join })
  for (const [d, ws] of DIARY_WRITERS) for (const k of ws) if (k !== G) w.add(d, k)
  for (const s of h.steps.slice(0, n)) {
    if (s.add) w.add(s.add.diary, s.writer, s.add)
    else if (s.community) w.C.push(s.writer, s.record)
    else w.push(s.writer, s.record)
  }
  const input = w.input()
  if (!rnd) return input
  const shuffle = (a) => {
    a = a.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
  }
  const mix = (x) => ({
    ...x,
    root: { ...x.root, entries: shuffle(x.root.entries) },
    writers: shuffle(x.writers).map((l) => ({ ...l, entries: shuffle(l.entries) })),
    joins: new Map(shuffle([...x.joins]).map(([d, list]) => [d, shuffle(list)]))
  })
  return { ...mix(input), community: mix(input.community) }
}

// A visible post of a rejoining writer in an approval group needs an admit
// of its diary whose cuts observe some leave of that diary (a cut above the
// leave's seq, or past the block 0 of a rejoining writer): an admit that
// observed none belongs to an earlier generation. Diaries ever granted admin
// (and the creator) are skipped, their authority bypasses admission.
function unadmittedRejoinPosts (h, g) {
  if (h.join !== 'approval') return 0
  const diaryOf = new Map(DIARY_WRITERS.flatMap(([d, ws]) => ws.map((k) => [k, d])))
  const rejoiners = new Set()
  for (const s of h.steps) {
    if (s.add) {
      diaryOf.set(s.writer, s.add.diary)
      rejoiners.add(s.writer)
    }
  }
  const granted = new Set([C])
  const leaves = []
  const admits = []
  for (const s of h.steps) {
    if (s.add) continue
    const r = s.record
    if (r.type === 'group-admin' && r.on) granted.add(r.member)
    if (r.type === 'group-leave') leaves.push({ diary: diaryOf.get(s.writer), writer: s.writer, seq: s.seq })
    if (r.type === 'group-admit' && r.on) admits.push(r)
  }
  const observes = (a) => a.cuts.some((c) => (rejoiners.has(c.writer) && diaryOf.get(c.writer) === a.member && c.seq >= 1) ||
    leaves.some((l) => l.diary === a.member && l.writer === c.writer && l.seq < c.seq))
  let bad = 0
  for (const p of g.posts) {
    if (p.hidden || !rejoiners.has(p.writer) || granted.has(p.diary)) continue
    if (!admits.some((a) => a.member === p.diary && observes(a))) bad++
  }
  return bad
}

function isSubsequence (small, big) {
  let i = 0
  for (const x of big) if (i < small.length && x === small[i]) i++
  return i === small.length
}

test('property: same output for every delivery order, stable when appending', (t) => {
  const rnd = mulberry32(0x5eed)
  let orders = 0
  let mismatches = 0
  let unstable = 0
  let banned = 0
  let hidden = 0
  let rejoined = 0
  let unadmitted = 0
  let readmitted = 0
  for (let scenario = 0; scenario < 120; scenario++) {
    const h = history(rnd, 20 + Math.floor(rnd() * 40))
    const built = buildGroup(inputOf(h, h.steps.length))
    unadmitted += unadmittedRejoinPosts(h, built)
    if (h.join === 'approval' && built.posts.some((p) => !p.hidden && p.writer >= K(0x600) && p.diary !== C)) readmitted++
    const expected = normalize(built)
    if ([...expected.members.values()].some(([, s]) => s === 'banned')) banned++
    if (expected.posts.some((p) => p.hidden)) hidden++
    if (h.steps.some((s) => s.add)) rejoined++
    for (let k = 0; k < 5; k++) {
      orders++
      const got = normalize(buildGroup(inputOf(h, h.steps.length, rnd)))
      if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches++
    }
    const cut = Math.floor(rnd() * h.steps.length)
    const prefix = normalize(buildGroup(inputOf(h, cut, rnd)))
    if (JSON.stringify(prefix) !== JSON.stringify(normalize(buildGroup(inputOf(h, cut))))) mismatches++
    if (!isSubsequence(refs(prefix), refs(expected))) unstable++
  }
  // Approval groups with frequent leaves and rejoins: admits whose cuts do or
  // do not observe a leave, under skewed clocks.
  for (let scenario = 0; scenario < 80; scenario++) {
    const h = history(rnd, 30 + Math.floor(rnd() * 40), { approval: true, rejoinRate: 0.2 })
    const built = buildGroup(inputOf(h, h.steps.length))
    unadmitted += unadmittedRejoinPosts(h, built)
    if (built.posts.some((p) => !p.hidden && p.writer >= K(0x600) && p.diary !== C)) readmitted++
    const expected = normalize(built)
    for (let k = 0; k < 3; k++) {
      orders++
      const got = normalize(buildGroup(inputOf(h, h.steps.length, rnd)))
      if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches++
    }
  }
  t.ok(orders >= 500, orders + ' delivery orders')
  t.is(mismatches, 0, 'identical output for every order')
  t.is(unstable, 0, 'appending never reorders earlier records')
  t.ok(banned > 0 && hidden > 0 && rejoined > 0, 'the histories exercise bans, hides and rejoins')
  t.is(unadmitted, 0, 'no admit of an earlier generation shows a rejoining writer post')
  t.ok(readmitted > 0, readmitted + ' approval histories show a post after a rejoin')
})

test('property: community actions keep the output identical for every delivery order', (t) => {
  const rnd = mulberry32(0xc0de)
  let orders = 0
  let mismatches = 0
  let unstable = 0
  let linked = 0
  let communityAdmins = 0
  for (let scenario = 0; scenario < 110; scenario++) {
    const h = history(rnd, 30 + Math.floor(rnd() * 40), { withCommunity: true, approval: scenario % 3 === 0 })
    const built = buildGroup(inputOf(h, h.steps.length))
    if (built.community !== null && h.steps.some((s) => s.community)) linked++
    if ([A, B, X].some((d) => built.community !== null && built.community.admins.has(d))) communityAdmins++
    const expected = normalize(built)
    for (let k = 0; k < 5; k++) {
      orders++
      const got = normalize(buildGroup(inputOf(h, h.steps.length, rnd)))
      if (JSON.stringify(got) !== JSON.stringify(expected)) mismatches++
    }
    const cut = Math.floor(rnd() * h.steps.length)
    const prefix = normalize(buildGroup(inputOf(h, cut, rnd)))
    if (JSON.stringify(prefix) !== JSON.stringify(normalize(buildGroup(inputOf(h, cut))))) mismatches++
    if (!isSubsequence(refs(prefix), refs(expected))) unstable++
  }
  t.ok(orders >= 500, orders + ' delivery orders')
  t.is(mismatches, 0, 'identical output for every order')
  t.is(unstable, 0, 'appending never reorders earlier records')
  t.ok(linked > 0, linked + ' histories carry community records')
  t.ok(communityAdmins > 0, communityAdmins + ' histories end with a community admin')
})

test('thousands of group-create records fold in linear time', (t) => {
  // The catalogue walks C's order once: 6000 creates, most of them repeats
  // or over the cap.
  const N = 6000
  const w = linkedWorld()
  for (let i = 0; i < N; i++) w.C.push(i % 2 ? cwA : CM, groupCreateRecord({ group: K(0x100000 + (i % 3000)), at: AT(10) }))
  post(w, wX, 3)
  cwBan(w, cwA, X, 4)
  const start = Date.now()
  const g = buildGroup(w.input())
  const ms = Date.now() - start
  t.ok(ms < 2000, N + ' create records folded in ' + ms + ' ms')
  t.ok(g.community !== null, 'G, created first, keeps its place')
  t.is(g.community.groups.length, MAX_GROUPS_PER_COMMUNITY)
  t.is(g.members.get(X), 'banned', 'and the admin CW still acts')
})

test('repeated community grants: the root layer decides each CW position', (t) => {
  const run = (extra) => {
    const w = linkedWorld()
    post(w, wX, 2)
    post(w, wY, 2)
    cwBan(w, cwA, X, 3)
    // A grant listing only another CW never moves cwA.
    if (extra) w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA2, seq: 1 }], at: w.C.at() }))
    w.C.push(CM, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: 2 }], at: w.C.at() }))
    w.C.push(CM, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: 4 }], at: w.C.at() }))
    cwBan(w, cwA, Y, 9)
    post(w, wA, 10)
    return buildGroup(w.input())
  }
  const plain = run(false)
  const repeated = run(true)
  t.is(plain.members.get(X), 'banned', 'a ban below the demotion counts')
  t.is(plain.members.get(Y), 'member', 'cwA is off between the demotion and the new grant cut')
  t.alike([...repeated.members], [...plain.members])
  t.alike([...repeated.admins].sort(), [...plain.admins].sort())
  t.alike(visible(repeated), visible(plain))
})

test('canon text is unchanged for ordinary values', (t) => {
  // Same text as the former recursive canon, observed through fork detection:
  // key order never matters, values do.
  const w = world().add(X, wX)
  post(w, wX, 1)
  const entries = w.logs.get(wX).entries
  const reordered = entries.map((e) => ({ seq: e.seq, record: Object.fromEntries(Object.entries(e.record).reverse()) }))
  const g = buildGroup({ ...w.input(), writers: [{ key: wX, diary: X, entries }, { key: wX, diary: X, entries: reordered }] })
  t.ok(g.writers.has(wX), 'key order alone is no fork')
})

test('group-invites shapes', async (t) => {
  const r = groupInvites({ on: true, seen: { writer: wA, seq: 1, x: 1 }, at: AT(1) })
  t.alike(r, { type: 'group-invites', on: true, seen: { writer: wA, seq: 1 }, at: AT(1) })
  t.is(validateGroupRecord(r, 1), null, 'a writer may carry one')
  t.is(validateGroupRecord(r, 1, { root: true }), null)
  t.is(validateGroupRecord(r, 1, { private: true }), null, 'plaintext in a private group')
  t.is(validateGroupRecord({ ...r, extra: 1 }, 1), 'malformed', 'extra key')
  t.is(validateGroupRecord({ type: 'group-invites', on: true, at: AT(1) }, 1), 'malformed', 'missing seen')
  t.is(validateGroupRecord({ ...r, on: 1 }, 1), 'malformed')
  t.is(validateGroupRecord({ ...r, seen: { writer: wA } }, 1), 'seen-invalid')
  t.is(validateGroupRecord({ ...r, at: 'x' }, 1), 'date-invalid')
  t.is(validateGroupRecord({ ...r, group: null }, 1), 'malformed', 'the community shape on a group core')
  t.is(validateGroupRecord({ ...r, group: G }, 1, { root: true }), 'malformed')
  await t.exception.all(async () => groupInvites({ on: 'yes', at: AT(1) }), /malformed/)
})

test('memberInvite: false by default, the last counted record in causal order', (t) => {
  t.is(buildGroup({}).memberInvite, false, 'the empty result')
  const w = world().add(X, wX)
  t.is(buildGroup(w.input()).memberInvite, false, 'no record')
  const on = w.push(G, groupInvites({ on: true, at: AT(1) }))
  t.is(buildGroup(w.input()).memberInvite, true)
  // An earlier clock never moves the off before the on it saw.
  w.push(G, groupInvites({ on: false, seen: on, at: AT(0) }))
  t.is(buildGroup(w.input()).memberInvite, false)
  w.push(G, groupInvites({ on: true, at: AT(3) }))
  t.is(buildGroup(w.input()).memberInvite, true)
})

test('memberInvite: a group admin counts, a plain member never', (t) => {
  const w = world().add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(wX, groupInvites({ on: true, at: AT(2) }))
  t.is(buildGroup(w.input()).memberInvite, false, 'a member record is ignored')
  w.push(wA, groupInvites({ on: true, at: AT(3) }))
  t.is(buildGroup(w.input()).memberInvite, true, 'an admin record counts')
  w.push(wX, groupInvites({ on: false, at: AT(4) }))
  t.is(buildGroup(w.input()).memberInvite, true, 'a member cannot turn it off')
})

test('memberInvite: a demoted admin record stops counting', (t) => {
  const w = world().add(A, wA)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(wA, groupInvites({ on: true, at: AT(2) }))
  t.is(buildGroup(w.input()).memberInvite, true)
  // Demoted from wA's block 2 on: the record before the cut keeps counting,
  // like the demoted admin's earlier admits and hides.
  w.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 2 }], at: AT(3) }))
  w.push(wA, groupInvites({ on: false, at: AT(4) }))
  t.is(buildGroup(w.input()).memberInvite, true, 'the off after the demotion is ignored')

  const v = world().add(A, wA)
  v.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  v.push(G, groupAdmin({ member: A, on: false, cuts: [{ writer: wA, seq: 1 }], at: AT(2) }))
  v.push(wA, groupInvites({ on: true, at: AT(3) }))
  t.is(buildGroup(v.input()).memberInvite, false, 'a demoted admin never sets it')
})

test('memberInvite: an admin record after its leave is withdrawn', (t) => {
  const w = world().add(A, wA)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  const leave = w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: 1 }], at: AT(2) }))
  w.push(wA, groupInvites({ on: true, seen: leave, at: AT(3) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(A), 'left')
  t.is(g.memberInvite, false)
})

test('memberInvite: an invalid record is skipped and the rest still folds', (t) => {
  const w = world().add(A, wA).add(X, wX)
  w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
  w.push(G, { type: 'group-invites', on: true, seen: null, at: AT(2), extra: 1 })
  t.is(buildGroup(w.input()).memberInvite, false, 'an extra key is malformed')
  w.push(wA, { type: 'group-invites', group: null, on: true, seen: null, at: AT(3) })
  t.is(buildGroup(w.input()).memberInvite, false, 'the community shape is malformed here')
  post(w, wX, 4)
  w.push(wA, groupInvites({ on: true, at: AT(5) }))
  const g = buildGroup(w.input())
  t.is(g.memberInvite, true)
  t.alike(visible(g), [wX + ':1'])
  t.ok(g.admins.has(A))
})

const b4a = require('b4a')
const { newBoxKeyPair, newEpochKey, sealEpochKey, openFrom, sealRecord, keyCommit } = require('../lib/group-crypto')
const { sealMedia } = require('../lib/group-media')

const PHOTO = (start, core = K(0xe0)) => ({ core, mime: 'image/webp', start, blocks: 3, bytes: 81234, sha256: 'b'.repeat(64), width: 2048, height: 1536 })
const sealedPhoto = (start, core = K(0xe0)) => {
  const { item } = sealMedia(b4a.alloc(500, 9), { plainMime: 'image/jpeg', w: 640, h: 480 })
  return { core, start, ...item }
}

test('group-post v2: one exact key set, with media or a forward', (t) => {
  const v1 = groupPost({ text: 'oi', at: AT(1) })
  t.alike(Object.keys(v1), ['type', 'text', 'replyTo', 'seen', 'at'], 'without media the v1 record')
  t.alike(groupPost({ text: 'oi', media: null, at: AT(1) }), v1, 'media null is v1 too')
  t.is(JSON.stringify(groupPost({ text: 'oi', replyTo: { writer: wA, seq: 2 }, seen: { writer: wB, seq: 3 }, at: AT(1) })),
    '{"type":"group-post","text":"oi","replyTo":{"writer":"' + wA + '","seq":2},"seen":{"writer":"' + wB + '","seq":3},"at":"' + AT(1) + '"}', 'v1 byte for byte')

  const p = groupPost({ text: '', media: [PHOTO(1), PHOTO(4)], replyTo: { writer: wA, seq: 1 }, at: AT(2) })
  t.alike(Object.keys(p), [...GROUP_POST_V2_KEYS])
  t.alike(GROUP_POST_V2_KEYS, ['type', 'text', 'replyTo', 'media', 'card', 'fwd', 'seen', 'at'])
  t.is(p.card, null)
  t.is(p.fwd, 0)
  t.is(validateGroupRecord(p, 1), null, 'empty text with media')
  t.is(validateGroupRecord({ ...p, text: 'legenda' }, 1), null)
  t.is(validateGroupRecord({ ...p, text: 'x'.repeat(1001) }, 1), 'text-length')
  t.is(validateGroupRecord({ ...p, text: 'a\u0007' }, 1), 'control-chars')
  t.is(validateGroupRecord({ ...p, media: null }, 1), 'media-invalid', 'v2 with media null and fwd 0 must stay v1')
  t.is(validateGroupRecord({ ...p, media: [] }, 1), 'media-invalid')
  t.is(validateGroupRecord({ ...p, media: [1, 2, 3, 4, 5].map((i) => PHOTO(i * 3)) }, 1), 'media-invalid', 'five items')
  t.is(validateGroupRecord({ ...p, media: [PHOTO(1), PHOTO(1)] }, 1), 'media-invalid', 'one place twice')
  t.is(validateGroupRecord({ ...p, media: [{ ...PHOTO(1), mime: 'image/svg+xml' }] }, 1), 'media-invalid')
  t.is(validateGroupRecord({ ...p, card: {} }, 1), 'card-invalid', 'a card is never next to media')
  t.is(validateGroupRecord({ ...p, fwd: 1 }, 1), null, 'fwd 1 with media')
  t.is(groupPost({ text: 'legenda', media: [PHOTO(1)], fwd: 1, at: AT(2) }).fwd, 1)
  const textFwd = groupPost({ text: 'encaminhada', fwd: 1, at: AT(2) })
  t.alike(Object.keys(textFwd), [...GROUP_POST_V2_KEYS], 'fwd 1 text only is v2')
  t.is(textFwd.media, null)
  t.is(textFwd.fwd, 1)
  t.is(textFwd.card, null)
  t.is(validateGroupRecord(textFwd, 1), null)
  t.is(validateGroupRecord({ ...textFwd, text: '' }, 1), 'text-length', 'a text forward is not an empty caption')
  t.alike(groupPost({ text: 'oi', fwd: 0, at: AT(1) }), v1, 'fwd 0 is still the v1 record')
  for (const bad of [2, true, '1', false]) {
    t.is(validateGroupRecord({ ...p, fwd: bad }, 1), 'malformed', 'fwd ' + JSON.stringify(bad))
    t.exception.all(() => groupPost({ text: 'oi', media: [PHOTO(1)], fwd: bad, at: AT(2) }), /malformed/, 'builder refuses fwd ' + JSON.stringify(bad))
    t.exception.all(() => groupPost({ text: 'oi', fwd: bad, at: AT(2) }), /malformed/, 'builder refuses a text fwd ' + JSON.stringify(bad))
  }
  t.is(validateGroupRecord({ ...p, extra: 1 }, 1), 'malformed')
  const { card, fwd, ...partial } = p
  t.is(validateGroupRecord(partial, 1), 'malformed', 'v1 keys plus media alone is no key set')
  t.is(validateGroupRecord({ ...v1, text: '' }, 1), 'text-length', 'v1 text is never empty')
  t.is(validateGroupRecord({ ...p, replyTo: { writer: wA, seq: 0 } }, 1), 'reply-invalid')

  const priv = sealedPhoto(1)
  t.is(validateGroupRecord({ ...p, media: [priv] }, 1), 'media-invalid', 'a plain post refuses a private item')
  t.exception.all(() => groupPost({ text: 'oi', media: [priv], at: AT(2) }), /media-invalid/)
  const inner = groupPost({ text: '', media: [priv], at: AT(2), sealed: true })
  t.is(validateGroupRecord(inner, 1, { sealed: true }), null, 'a sealed inner takes private items')
  t.is(validateGroupRecord(p, 1, { sealed: true }), 'media-invalid', 'a sealed inner refuses a public item')
  t.exception.all(() => groupPost({ text: 'oi', media: [PHOTO(1)], at: AT(2), sealed: true }), /media-invalid/)
  t.is(validateGroupRecord({ ...inner, media: [priv, PHOTO(9)] }, 1, { sealed: true }), 'media-invalid', 'never mixed')
  t.is(validateGroupRecord(v1, 1, { sealed: true }), null, 'a sealed v1 post as before')

  t.is(validateGroupRecord(p, 1, { private: true }), 'sealed-only', 'a private group never takes a plain post')
  t.is(validateGroupRecord(p, 1, { community: true }), 'group-only')
  t.is(validateGroupRecord(p, 1, { root: true, community: true }), 'group-only')
})

test('group-post v2: the fold carries media; v1 posts keep their shape', (t) => {
  const w = world().add(X, wX)
  post(w, wX, 1)
  w.push(wX, groupPost({ text: '', media: [PHOTO(1)], at: AT(2) }))
  w.push(wX, groupPost({ text: '', media: [sealedPhoto(1)], at: AT(3), sealed: true }))
  w.push(wX, groupPost({ text: 'encaminhada', fwd: 1, at: AT(4) }))
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1', wX + ':2', wX + ':4'], 'a private item in a plain post is skipped')
  t.alike(Object.keys(g.posts[0]), ['writer', 'diary', 'seq', 'at', 'text', 'fwd', 'replyTo', 'hidden'])
  t.alike(g.posts[1].media, [PHOTO(1)])
  t.is(g.posts[1].text, '')
  t.is(g.posts[2].text, 'encaminhada', 'a text forward folds')
  t.alike(g.posts.map(p => p.fwd), [0, 0, 1], 'v1, media and text forward flags survive the fold')
  t.alike(Object.keys(g.posts[2]), Object.keys(g.posts[0]), 'a text forward folds like a v1 post')
})

test('group-post v2: a private group reads private media only from the envelope', (t) => {
  const parent = communityOf({ key: CMG, creator: C, creates: [{ by: C, group: G }] })
  const box = newBoxKeyPair()
  const g = groupIn(parent, { key: G, diary: C, join: 'approval', visibility: 'private', box: b4a.toString(box.publicKey, 'hex') })
  const kid = { writer: G, seq: 1 }
  const key = newEpochKey()
  const sealed = b4a.toString(sealEpochKey(key, G, kid, box.publicKey), 'base64')
  g.push(G, groupKey({ kid: null, basis: [], keys: [{ writer: G, sealed }], commit: b4a.toString(keyCommit(key, G, kid), 'hex'), at: AT(1) }))
  const seal = (record) => {
    const { nonce, box: b } = sealRecord(sealedInner(record, { writer: G, group: G, kid }), key)
    return g.push(G, groupSealed({ kid, nonce, box: b, at: record.at }))
  }
  const priv = sealedPhoto(1)
  seal(groupPost({ text: 'foto', media: [priv], at: AT(2), sealed: true }))
  // A public item inside an envelope, built by hand past the builder.
  seal({ type: 'group-post', text: '', replyTo: null, media: [PHOTO(1)], card: null, fwd: 0, seen: null, at: AT(3) })
  seal(groupPost({ text: 'só texto', at: AT(4) }))
  const keys = { writers: new Set([G]), unseal: (s) => openFrom(b4a.from(s, 'base64'), box) }
  const out = buildGroup({ ...g.input(), keys })
  t.alike(out.posts.map((p) => p.text), ['foto', 'só texto'], 'the envelope with a public item stays unread')
  t.alike(out.posts[0].media, [priv], 'the key travels to the reader inside the sealed post')
  t.absent('media' in out.posts[1])
})

const THUMB = (start, core = K(0xe0)) => ({ core, mime: 'image/jpeg', start, blocks: 1, bytes: 32768, sha256: 'c'.repeat(64), width: 400, height: 210 })
const sealedThumb = (start, core = K(0xe0), n = 500) => {
  const { item } = sealMedia(b4a.alloc(n, 7), { plainMime: 'image/jpeg', w: 400, h: 210 })
  return { core, start, ...item }
}
const CARD = (image) => ({ url: 'https://example.com/a', host: 'example.com', title: 'Título', desc: 'Descrição', image })

test('group-post v2: a link card', (t) => {
  const p = groupPost({ text: 'olha https://example.com/a', card: CARD(THUMB(7)), at: AT(2) })
  t.alike(Object.keys(p), [...GROUP_POST_V2_KEYS], 'a card with no media and fwd 0 is v2')
  t.is(p.media, null)
  t.is(p.fwd, 0)
  t.alike(p.card, CARD(THUMB(7)))
  t.is(validateGroupRecord(p, 1), null)
  t.is(validateGroupRecord({ ...p, card: CARD(null) }, 1), null, 'no thumbnail')
  t.is(validateGroupRecord({ ...p, fwd: 1 }, 1), null, 'a forwarded card')
  t.is(validateGroupRecord({ ...p, text: '' }, 1), 'text-length', 'a card is not a caption-free photo')
  t.alike(groupPost({ text: 'oi', card: null, at: AT(1) }), groupPost({ text: 'oi', at: AT(1) }), 'card null is still v1')
  t.alike(groupPost({ text: 'oi', card: { ...CARD({ ...THUMB(7), extra: 1 }), extra: 1 }, at: AT(2) }).card, CARD(THUMB(7)), 'only the card and descriptor keys are copied')

  t.is(validateGroupRecord({ ...p, media: [PHOTO(1)] }, 1), 'card-invalid', 'a card next to media')
  t.exception.all(() => groupPost({ text: 'oi', media: [PHOTO(1)], card: CARD(null), at: AT(2) }), /card-invalid/)
  const bad = {
    http: { ...CARD(null), url: 'http://example.com/a' },
    javascript: { ...CARD(null), url: 'javascript:alert(1)' },
    data: { ...CARD(null), url: 'data:text/html,x' },
    ftp: { ...CARD(null), url: 'ftp://example.com/a' },
    credentials: { ...CARD(null), url: 'https://u:p@example.com/a' },
    'host mismatch': { ...CARD(null), host: 'evil.com' },
    'long title': { ...CARD(null), title: 'x'.repeat(81) },
    'long desc': { ...CARD(null), desc: 'x'.repeat(161) },
    'control in title': { ...CARD(null), title: 'a\u0000' },
    'bidi in desc': { ...CARD(null), desc: 'a‭' },
    'image over 32768': CARD({ ...THUMB(7), blocks: 2, bytes: 32769 }),
    'image not jpeg': CARD({ ...THUMB(7), mime: 'image/webp' }),
    'image a url': CARD('https://example.com/x.jpg'),
    'image a private item in a plain post': CARD(sealedThumb(7)),
    'extra key': { ...CARD(null), extra: 1 }
  }
  for (const [name, card] of Object.entries(bad)) {
    t.is(validateGroupRecord({ ...p, card }, 1), 'card-invalid', name)
    // The builder copies the card keys only, so an extra key never reaches it.
    if (name !== 'extra key') t.exception.all(() => groupPost({ text: 'oi', card, at: AT(2) }), /card-invalid/, name + ' refused by the builder')
  }

  // Inside a sealed inner the thumbnail is a private item, one block.
  const inner = groupPost({ text: 'olha', card: CARD(sealedThumb(7)), at: AT(2), sealed: true })
  t.is(validateGroupRecord(inner, 1, { sealed: true }), null)
  t.is(inner.card.image.bytes, 32768)
  t.is(validateGroupRecord({ ...inner, card: CARD(THUMB(7)) }, 1, { sealed: true }), 'card-invalid', 'a sealed inner refuses a public thumbnail')
  t.is(validateGroupRecord({ ...inner, card: CARD(sealedThumb(7, K(0xe0), 40000)) }, 1, { sealed: true }), 'card-invalid', 'a private thumbnail over one block')
  t.is(validateGroupRecord({ ...inner, card: CARD({ ...sealedThumb(7), plainMime: 'image/png' }) }, 1, { sealed: true }), 'card-invalid', 'a private thumbnail not jpeg')
  t.is(validateGroupRecord(p, 1, { private: true }), 'sealed-only')
  t.ok(validateGroupRecord({ ...p, card: {} }, 1) !== null)
})

test('group-post v2: the fold carries the card', (t) => {
  const w = world().add(X, wX)
  post(w, wX, 1)
  w.push(wX, groupPost({ text: 'olha', card: CARD(THUMB(7)), at: AT(2) }))
  w.push(wX, groupPost({ text: 'privado', card: CARD(sealedThumb(8)), at: AT(3), sealed: true }))
  const g = buildGroup(w.input())
  t.alike(visible(g), [wX + ':1', wX + ':2'], 'a private thumbnail in a plain post is skipped')
  t.absent('card' in g.posts[0], 'a v1 post has no card')
  t.alike(g.posts[1].card, CARD(THUMB(7)))

  const parent = communityOf({ key: CMG, creator: C, creates: [{ by: C, group: G }] })
  const box = newBoxKeyPair()
  const pg = groupIn(parent, { key: G, diary: C, join: 'approval', visibility: 'private', box: b4a.toString(box.publicKey, 'hex') })
  const kid = { writer: G, seq: 1 }
  const key = newEpochKey()
  const sealed = b4a.toString(sealEpochKey(key, G, kid, box.publicKey), 'base64')
  pg.push(G, groupKey({ kid: null, basis: [], keys: [{ writer: G, sealed }], commit: b4a.toString(keyCommit(key, G, kid), 'hex'), at: AT(1) }))
  const priv = sealedThumb(8)
  const { nonce, box: sbox } = sealRecord(sealedInner(groupPost({ text: 'privado', card: CARD(priv), at: AT(2), sealed: true }), { writer: G, group: G, kid }), key)
  pg.push(G, groupSealed({ kid, nonce, box: sbox, at: AT(2) }))
  const out = buildGroup({ ...pg.input(), keys: { writers: new Set([G]), unseal: (s) => openFrom(b4a.from(s, 'base64'), box) } })
  t.alike(out.posts.map((p) => p.text), ['privado'])
  t.alike(out.posts[0].card, CARD(priv), 'the thumbnail key travels inside the sealed post')
})

test('group-post v2: the worst card fits the sealed inner', (t) => {
  const { MAX_SEALED_INNER_BYTES } = require('../lib/group-crypto')
  const worstCard = (image) => ({
    url: 'https://example.com/' + '%'.repeat(280),
    host: 'example.com',
    title: '\u{1F600}'.repeat(80),
    desc: '\u{1F600}'.repeat(160),
    image
  })
  const big = 9007199254740991
  const ref = { writer: K(0xfff), seq: big }
  const image = { ...sealedThumb(8191, K(0xfff)), w: 16384, h: 16384 }
  // The widest text JSON can carry: a lone surrogate is one code point and six escaped bytes.
  const text = '\ud800'.repeat(1000)
  const inner = sealedInner(groupPost({ text, replyTo: ref, card: worstCard(image), fwd: 1, seen: ref, at: AT(2), sealed: true }), { writer: K(0xfff), group: K(0xffe), kid: ref })
  t.is(validateGroupRecord(groupPost({ text, replyTo: ref, card: worstCard(image), fwd: 1, seen: ref, at: AT(2), sealed: true }), 1, { sealed: true }), null)
  const bytes = b4a.byteLength(JSON.stringify(inner))
  t.comment('worst sealed group card inner: ' + bytes + ' of ' + MAX_SEALED_INNER_BYTES + ' bytes')
  t.ok(bytes <= MAX_SEALED_INNER_BYTES, 'fits MAX_SEALED_INNER_BYTES')
  const { box: sbox } = sealRecord(inner, newEpochKey())
  t.ok(validateGroupRecord(groupSealed({ kid: ref, nonce: '0'.repeat(48), box: sbox, at: AT(2) }), 1, { private: true }) === null, 'the envelope is valid')
  const pub = groupPost({ text, replyTo: ref, card: worstCard({ ...THUMB(8191, K(0xfff)), width: 16384, height: 16384 }), fwd: 1, seen: ref, at: AT(2) })
  t.comment('worst public group card post: ' + b4a.byteLength(JSON.stringify(pub)) + ' bytes')
  t.ok(b4a.byteLength(JSON.stringify(pub)) <= 16384, 'a public card post fits one block')
})

// Reactions (group-react, docs/protocol.md section 10).
const THUMBS = '\u{1f44d}'
const HEART = '\u2764\ufe0f'
const react = (w, key, target, emoji, s, extra = {}) => w.push(key, groupReact({ target, emoji, at: AT(s), ...extra }))
const reactionsOf = (g, ref) => g.posts.find((p) => p.writer === ref.writer && p.seq === ref.seq).reactions

test('group-react record shapes', async (t) => {
  const r = groupReact({ target: { writer: wA, seq: 1, x: 1 }, emoji: THUMBS, seen: { writer: wB, seq: 2 }, at: AT(1) })
  t.alike(r, { type: 'group-react', target: { writer: wA, seq: 1 }, emoji: THUMBS, seen: { writer: wB, seq: 2 }, at: AT(1) })
  t.alike(Object.keys(r), ['type', 'target', 'emoji', 'seen', 'at'])
  t.is(validateGroupRecord(r, 1), null)
  t.is(validateGroupRecord({ ...r, emoji: '' }, 1), null, 'empty emoji removes')
  for (const emoji of ['a', ' ', THUMBS + THUMBS, THUMBS + ' ', '\u{1f3fd}', null, 1, undefined]) {
    t.is(validateGroupRecord({ ...r, emoji }, 1), 'emoji-invalid', JSON.stringify(String(emoji)))
  }
  t.is(validateGroupRecord({ ...r, target: { writer: wA, seq: 0 } }, 1), 'malformed', 'target is a block, not a header')
  t.is(validateGroupRecord({ ...r, target: { writer: 'x', seq: 1 } }, 1), 'malformed')
  t.is(validateGroupRecord({ ...r, target: { writer: wA, seq: 1.5 } }, 1), 'malformed')
  t.is(validateGroupRecord({ ...r, target: null }, 1), 'malformed')
  t.is(validateGroupRecord({ ...r, extra: 1 }, 1), 'malformed')
  const { seen, ...noSeen } = r
  t.is(validateGroupRecord(noSeen, 1), 'malformed', 'seen is required')
  t.is(validateGroupRecord({ ...r, seen: { writer: wB } }, 1), 'seen-invalid')
  t.is(validateGroupRecord({ ...r, at: 'x' }, 1), 'date-invalid')
  t.is(validateGroupRecord(r, 1, { community: true }), 'group-only')
  t.is(validateGroupRecord(r, 1, { private: true }), 'sealed-only')
  t.is(validateGroupRecord(r, 1, { sealed: true }), null, 'an envelope may carry it')
  await t.exception.all(async () => groupReact({ target: { writer: wA, seq: 1 }, emoji: 'ok', at: AT(1) }), /emoji-invalid/)
})

test('a reaction is replaced by the same diary and removed by an empty emoji', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  const p = post(w, wY, 1)
  react(w, wX, p, THUMBS, 2)
  react(w, wY, p, THUMBS, 3)
  t.alike(reactionsOf(buildGroup(w.input()), p), [{ emoji: THUMBS, count: 2, by: [X, Y] }])
  // Another device of the same diary replaces it: one reaction per diary.
  react(w, wX2, p, HEART, 4)
  t.alike(reactionsOf(buildGroup(w.input()), p), [{ emoji: THUMBS, count: 1, by: [Y] }, { emoji: HEART, count: 1, by: [X] }])
  react(w, wX, p, '', 5)
  react(w, wY, p, '', 6)
  const g = buildGroup(w.input())
  t.is(reactionsOf(g, p), undefined, 'no reactions key when empty')
  t.absent('reactions' in g.posts[0])
})

test('reactions sort by count then first use, and by lists diaries in reaction order', (t) => {
  const w = world().add(A, wA).add(X, wX).add(Y, wY)
  const p = post(w, G, 1)
  react(w, wY, p, '\u{1f600}', 2)
  react(w, wX, p, THUMBS, 3)
  react(w, wA, p, THUMBS, 4)
  react(w, G, p, HEART, 5)
  const r = reactionsOf(buildGroup(w.input()), p)
  t.alike(r, [
    { emoji: THUMBS, count: 2, by: [X, A] },
    { emoji: '\u{1f600}', count: 1, by: [Y] },
    { emoji: HEART, count: 1, by: [C] }
  ])
  t.ok(HEART < '\u{1f600}', 'the emoji text order would have put the heart first')
})

test('reactions by non-members, banned or departed diaries are ignored', (t) => {
  const w = world({ join: 'approval' }).add(X, wX).add(Y, wY).add(A, wA)
  w.push(G, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(1) }))
  w.push(G, groupAdmit({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(1) }))
  const p = post(w, G, 2)
  react(w, wX, p, THUMBS, 3) // never admitted
  react(w, wY, p, THUMBS, 4)
  react(w, wA, p, HEART, 5)
  t.alike(reactionsOf(buildGroup(w.input()), p), [{ emoji: THUMBS, count: 1, by: [Y] }, { emoji: HEART, count: 1, by: [A] }])
  w.push(G, groupBan({ member: Y, on: true, cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(6) }))
  w.push(wA, groupLeave({ cuts: [{ writer: wA, seq: w.len(wA) }], at: AT(7) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(Y), 'banned')
  t.is(g.members.get(A), 'left')
  t.is(reactionsOf(g, p), undefined)
})

// Owner decision (#350): a new device's side records count from seq 1, as
// under an admit listing it with cut 1; its posts keep the automatic cut.
test('a new device that only reacts has its reactions counted, also once it posts, until the diary leaves', (t) => {
  const THUMB = [{ emoji: THUMBS, count: 1, by: [X] }]
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  const p = post(w, G, 2)
  const q = post(w, G, 3)
  w.add(X, wX2, { at: AT(4) })
  react(w, wX2, p, THUMBS, 5)
  react(w, wX2, q, THUMBS, 6)
  let g = buildGroup(w.input())
  t.alike(reactionsOf(g, p), THUMB, 'a reaction with no record before it on its core')
  t.alike(reactionsOf(g, q), THUMB)
  post(w, wX2, 7)
  g = buildGroup(w.input())
  t.alike(reactionsOf(g, p), THUMB, 'still counted once the device posts')
  t.alike(reactionsOf(g, q), THUMB)
  t.ok(visible(g).includes(wX2 + ':3'), 'its post after the admit shows')
  w.push(wX, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }], at: AT(8) }))
  g = buildGroup(w.input())
  t.is(g.members.get(X), 'left')
  t.is(reactionsOf(g, p), undefined, 'not once the diary has left')
  t.is(reactionsOf(g, q), undefined)
})

test('reactions to hidden, unknown or future targets are ignored', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const p1 = post(w, wY, 1)
  const p2 = post(w, wY, 2)
  w.push(wY, groupHide({ target: p1, on: true, at: AT(3) }))
  react(w, wX, p1, THUMBS, 4)
  react(w, wX, { writer: wY, seq: 99 }, THUMBS, 5)
  react(w, wX, { writer: K(0x999), seq: 1 }, THUMBS, 6)
  const hidden = w.push(wX, groupReact({ target: p2, emoji: THUMBS, at: new Date(NOW + 2 * 86400000).toISOString() }))
  const g = buildGroup(w.input())
  t.is(reactionsOf(g, p1), undefined)
  t.is(reactionsOf(g, p2), undefined, 'a future reaction is ignored')
  t.ok(hidden)
  // A reaction can never target another reaction or a hide.
  react(w, wY, { writer: wX, seq: 1 }, HEART, 7)
  t.alike(buildGroup(w.input()).posts.map((p) => p.reactions), [undefined, undefined])
})

test('at most GROUP_REACTIONS_MAX distinct emojis per message, the most chosen kept', (t) => {
  const { GROUP_REACTIONS_MAX } = require('@varanda/rpc')
  t.is(GROUP_REACTIONS_MAX, 12)
  const w = world()
  const p = post(w, G, 1)
  const emojis = []
  for (let i = 0; i < 14; i++) {
    const d = K(0x20 + i)
    const wk = K(0x600 + i)
    w.add(d, wk)
    emojis.push(String.fromCodePoint(0x1f600 + i))
    react(w, wk, p, emojis[i], 2 + i)
  }
  // A 15th diary repeating a kept emoji still counts.
  w.add(K(0x40), K(0x640))
  react(w, K(0x640), p, emojis[0], 30)
  const r = reactionsOf(buildGroup(w.input()), p)
  t.is(r.length, 12)
  t.alike(r.map((x) => x.emoji).sort(), emojis.slice(0, 12).sort())
  t.alike(r[0], { emoji: emojis[0], count: 2, by: [K(0x20), K(0x40)] })
  // A diary that clears its reaction frees a slot for the next emoji first used.
  react(w, K(0x605), p, '', 31)
  const r2 = reactionsOf(buildGroup(w.input()), p)
  t.is(r2.length, 12)
  t.ok(r2.some((x) => x.emoji === emojis[12]))
  t.absent(r2.some((x) => x.emoji === emojis[13]))
})

test('the reaction cap counts members per emoji first; `at` only breaks a tie in count, by first use', (t) => {
  const w = world()
  const p = post(w, G, 1)
  // Twelve diaries, each with its own emoji, all with an earlier `at`.
  const early = []
  for (let i = 0; i < 12; i++) {
    const d = K(0x20 + i)
    const wk = K(0x600 + i)
    w.add(d, wk)
    early.push(String.fromCodePoint(0x1f600 + i))
    react(w, wk, p, early[i], 2 + i)
  }
  // Two later diaries share one emoji that sorts after all twelve.
  const shared = '\u{1f680}'
  w.add(K(0x40), K(0x640)).add(K(0x41), K(0x641))
  react(w, K(0x640), p, shared, 40)
  react(w, K(0x641), p, shared, 41)
  const r = reactionsOf(buildGroup(w.input()), p)
  t.is(r.length, 12)
  t.alike(r[0], { emoji: shared, count: 2, by: [K(0x40), K(0x41)] }, 'the emoji two members chose is kept, first')
  // Ties at one member go by first use: the last of the twelve is the one cut.
  t.alike(r.slice(1).map((x) => x.emoji), early.slice(0, 11))
  t.absent(r.some((x) => x.emoji === early[11]))
  // The same twelve whatever order the cores are read in.
  const other = w.input()
  other.writers = other.writers.slice().reverse()
  t.alike(reactionsOf(buildGroup(other), p), r)
})

test('at the reaction cap a tie goes to the emoji first used, not to the emoji text', (t) => {
  const w = world()
  const p = post(w, G, 1)
  const used = []
  for (let i = 0; i < 12; i++) {
    const d = K(0x20 + i)
    const wk = K(0x600 + i)
    w.add(d, wk)
    used.push(String.fromCodePoint(0x1f600 + i))
    react(w, wk, p, used[i], 2 + i)
  }
  // One later diary picks an emoji that sorts before all twelve.
  w.add(K(0x40), K(0x640))
  react(w, K(0x640), p, HEART, 30)
  const r = reactionsOf(buildGroup(w.input()), p)
  t.is(r.length, 12)
  t.alike(r.map((x) => x.emoji), used, 'the twelve first used are kept, in that order')
  t.absent(r.some((x) => x.emoji === HEART), 'the late emoji is cut although its text sorts first')
  t.absent(r.some((x) => 'first' in x), 'no fold detail leaks into the summary')
  // A replacement moves the diary's reaction to its new place in the order.
  react(w, K(0x600), p, '\u{1f680}', 31)
  const r2 = reactionsOf(buildGroup(w.input()), p)
  t.alike(r2.map((x) => x.emoji), [...used.slice(1), HEART])
  const other = w.input()
  other.writers = other.writers.slice().reverse()
  t.alike(reactionsOf(buildGroup(other), p), r2, 'the same on every replica')
})

test('concurrent reactions converge on two replicas', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  const p = post(w, G, 1)
  // Concurrent: nothing seen between them; X's two devices disagree.
  react(w, wX, p, THUMBS, 5, { seen: p })
  react(w, wX2, p, HEART, 5, { seen: p })
  react(w, wY, p, HEART, 5, { seen: p })
  const one = buildGroup(w.input())
  const other = w.input()
  other.writers = other.writers.slice().reverse().map((l) => ({ ...l, entries: l.entries.slice().reverse() }))
  const two = buildGroup(other)
  t.alike(reactionsOf(two, p), reactionsOf(one, p))
  t.is(reactionsOf(one, p).reduce((n, r) => n + r.count, 0), 2, 'one per diary')
  // A later reaction (by `at`, across X's cores) wins on every replica.
  react(w, wX, p, '\u{1f525}', 6, { seen: { writer: wX2, seq: 1 } })
  const three = buildGroup(w.input())
  t.alike(reactionsOf(three, p), [{ emoji: HEART, count: 1, by: [Y] }, { emoji: '\u{1f525}', count: 1, by: [X] }])
})

test('an old reader skips group-react and still reads later posts', (t) => {
  const fs = require('fs')
  const path = require('path')
  const Module = require('module')
  const file = require.resolve('../lib/group')
  const src = fs.readFileSync(file, 'utf8')
  const oldSrc = src.replace(/,\n {2}'group-react': \[[^\]]*\]/, '')
  t.not(oldSrc, src, 'the type is gone from RECORD_KEYS')
  const m = new Module(file, module)
  m.filename = file
  m.paths = Module._nodeModulePaths(path.dirname(file))
  m._compile(oldSrc, file)
  const old = m.exports
  t.absent(old.GROUP_TYPES.includes('group-react'))
  const w = world().add(X, wX).add(Y, wY)
  const p = post(w, wY, 1)
  const r = react(w, wX, p, THUMBS, 2)
  post(w, wX, 3, { seen: r })
  post(w, wY, 4, { seen: r })
  const g = old.buildGroup(w.input())
  t.is(old.validateGroupRecord(w.logs.get(wX).entries[1].record, 1), 'malformed')
  t.alike(visible(g), [wY + ':1', wX + ':2', wY + ':2'])
  t.is(g.posts[0].reactions, undefined)
  t.alike(visible(buildGroup(w.input())), visible(g), 'the new reader shows the same posts')
})

test('a fold over many reactions stays linear', (t) => {
  const run = (n) => {
    const w = world()
    const targets = []
    for (let i = 0; i < 20; i++) targets.push(post(w, G, i + 1))
    const diaries = 50
    for (let i = 0; i < diaries; i++) w.add(K(0x2000 + i), K(0x3000 + i))
    for (let i = 0; i < n; i++) {
      const wk = K(0x3000 + (i % diaries))
      react(w, wk, targets[i % targets.length], String.fromCodePoint(0x1f600 + (i % 16)), 100 + i)
    }
    const input = w.input()
    let best = Infinity
    for (let k = 0; k < 3; k++) {
      const t0 = process.hrtime.bigint()
      buildGroup(input)
      best = Math.min(best, Number(process.hrtime.bigint() - t0))
    }
    return best
  }
  run(500)
  const small = run(2000)
  const large = run(8000)
  t.comment('2000 reactions: ' + (small / 1e6).toFixed(1) + ' ms, 8000: ' + (large / 1e6).toFixed(1) + ' ms')
  t.ok(large < small * 10, 'four times the reactions under ten times the time (quadratic would be sixteen)')
})

// The same blocks as a reader from before group-react reads them: each
// reaction an unknown type, which that reader drops as malformed.
function asOldReader (input) {
  const swap = (core) => ({ ...core, entries: core.entries.map((e) => e.record && e.record.type === 'group-react' ? { ...e, record: { ...e.record, type: 'group-unknown' } } : e) })
  return { ...input, root: swap(input.root), writers: input.writers.map(swap) }
}
const withoutReactions = (g) => stableText(normalize({ ...g, posts: g.posts.map(({ reactions, ...p }) => p) }))
const isReactRef = (input, ref) => [input.root, ...input.writers].some((c) => c.key === ref.writer && c.entries.some((e) => e.seq === ref.seq && e.record.type === 'group-react'))

test('a reaction never moves a hide: old and new readers agree', (t) => {
  for (const hideFirst of [true, false]) {
    const w = world().add(A, wA).add(X, wX).add(Y, wY)
    w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1) }))
    const p1 = post(w, wY, 2)
    const p2 = post(w, wY, 3)
    // The admin's hide at 10; a reaction at 5 that saw it; the owner's unhide
    // at 6 that saw the reaction. Through the reaction the unhide would
    // follow the hide; without it, the unhide sorts first.
    const hide = w.push(wA, groupHide({ target: p1, on: true, at: AT(10) }))
    const r = react(w, wX, p2, THUMBS, 5, { seen: hideFirst ? hide : null })
    w.push(G, groupHide({ target: p1, on: false, seen: r, at: AT(6) }))
    const input = w.input()
    const g = buildGroup(input)
    const old = buildGroup(asOldReader(input))
    t.is(g.posts.find((p) => p.seq === p1.seq && p.writer === wY).hidden, old.posts.find((p) => p.seq === p1.seq && p.writer === wY).hidden, 'same hide state')
    t.is(g.posts.find((p) => p.seq === p1.seq && p.writer === wY).hidden, true, 'the hide at 10 is the latest')
    t.is(withoutReactions(g), withoutReactions(old))
    t.alike(reactionsOf(g, p2), [{ emoji: THUMBS, count: 1, by: [X] }])
  }
})

// A small deterministic generator (mulberry32).
function rng (seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

// Posts, hides and unhides, admits, bans and unbans, leaves and rejoins, and
// reactions whose `seen` and writer chains run into all of them, at skewed
// times.
function randomWorld (seed) {
  const rand = rng(seed)
  const pick = (a) => a[Math.floor(rand() * a.length)]
  const w = world({ join: rand() < 0.5 ? 'open' : 'approval' }).add(A, wA).add(X, wX).add(Y, wY)
  const all = [w.push(G, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 0 }], at: AT(1 + Math.floor(rand() * 20)) }))]
  const targets = []
  let cores = [G, wA, wX, wY]
  let yCore = wY
  let ban = null
  let leave = null
  let rejoins = 0
  for (let i = 0; i < 48; i++) {
    const at = AT(1 + Math.floor(rand() * 40))
    const seen = rand() < 0.75 ? pick(all) : null
    const k = rand()
    let ref
    if (k < 0.25 || targets.length === 0) {
      ref = w.push(pick(cores), groupPost({ text: 'p' + i, seen, at }))
      targets.push(ref)
    } else if (k < 0.55) {
      ref = w.push(pick(cores), groupReact({ target: pick(targets), emoji: pick([THUMBS, HEART, '\u{1f525}', '']), seen, at }))
    } else if (k < 0.68) {
      ref = w.push(pick(cores), groupHide({ target: pick(targets), on: rand() < 0.6, seen, at }))
    } else if (k < 0.78) {
      const m = pick([X, Y])
      const mw = m === X ? wX : yCore
      ref = w.push(pick([G, wA]), groupAdmit({ member: m, on: rand() < 0.8, cuts: [{ writer: mw, seq: w.len(mw) }], seen, at }))
    } else if (k < 0.86) {
      ref = ban === null
        ? (ban = w.push(G, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: w.len(wX) }], seen, at })))
        : w.push(G, groupBan({ member: X, on: false, cuts: [{ writer: wX, seq: w.len(wX) }], lifts: ban, seen, at }))
      if (ref !== ban) ban = null
    } else if (leave === null) {
      ref = leave = w.push(yCore, groupLeave({ cuts: [{ writer: yCore, seq: w.len(yCore) }], seen, at }))
      cores = cores.filter((c) => c !== yCore)
    } else if (rejoins < 2) {
      yCore = K(0x501 + rejoins++)
      w.add(Y, yCore, { rejoin: leave, at })
      cores.push(yCore)
      ref = { writer: yCore, seq: 0 }
      leave = null
    } else {
      ref = w.push(pick(cores), groupPost({ text: 'q' + i, seen, at }))
      targets.push(ref)
    }
    all.push(ref)
  }
  return w
}

test('reactions take no part in the fold of any other record (generated logs)', (t) => {
  let reactions = 0
  for (let seed = 1; seed <= 40; seed++) {
    const input = randomWorld(seed).input()
    const g = buildGroup(input)
    const old = buildGroup(asOldReader(input))
    if (withoutReactions(g) !== withoutReactions(old)) {
      t.fail('seed ' + seed + ': the fold differs from an old reader\'s')
      continue
    }
    t.ok(g.last === null || !isReactRef(input, g.last), 'seed ' + seed + ': last names no reaction')
    reactions += g.posts.reduce((n, p) => n + (p.reactions || []).length, 0)
  }
  t.ok(reactions > 0, 'some reactions count')
})

test('a later reaction of the same diary replaces it, within a core and across cores', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  const p = post(w, wY, 1)
  // One core: the higher seq wins whatever its `at` says.
  react(w, wX, p, THUMBS, 5)
  const heart = react(w, wX, p, HEART, 3)
  t.alike(reactionsOf(buildGroup(w.input()), p), [{ emoji: HEART, count: 1, by: [X] }])
  // Across cores: the later `at` wins, even over one that saw it.
  react(w, wX2, p, '\u{1f525}', 2, { seen: heart })
  t.alike(reactionsOf(buildGroup(w.input()), p), [{ emoji: HEART, count: 1, by: [X] }])
  react(w, wX2, p, '\u{1f525}', 4)
  t.alike(reactionsOf(buildGroup(w.input()), p), [{ emoji: '\u{1f525}', count: 1, by: [X] }])
  // The same `at` on two cores: the greater writer key wins.
  react(w, wX, p, THUMBS, 4)
  t.alike(reactionsOf(buildGroup(w.input()), p), [{ emoji: wX2 > wX ? '\u{1f525}' : THUMBS, count: 1, by: [X] }])
})

test('last never names a reaction', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const p = post(w, wY, 1)
  react(w, wX, p, THUMBS, 9)
  const g = buildGroup(w.input())
  t.alike(g.last, p)
  t.ok(reactionsOf(g, p))
})

// Foruns e enquetes: group-topic, group-poll and group-choice side records
// (public groups only).
const OPTS = ['sim', 'não', 'talvez']
const topic = (w, key, target, s) => w.push(key, groupTopic({ target, at: AT(s) }))
const poll = (w, key, target, s, options = OPTS) => w.push(key, groupPoll({ target, options, at: AT(s) }))
const choose = (w, key, target, pick, s) => w.push(key, groupChoice({ target, pick, at: AT(s) }))
const postOf = (g, ref) => g.posts.find((p) => p.writer === ref.writer && p.seq === ref.seq)

test('forum record shapes', async (t) => {
  t.alike([...GROUP_TYPES].slice(-4), ['group-topic', 'group-poll', 'group-choice', 'group-event'])
  const target = { writer: wA, seq: 1, x: 1 }
  const tp = groupTopic({ target, seen: { writer: wX, seq: 2 }, at: AT(1) })
  t.alike(tp, { type: 'group-topic', target: { writer: wA, seq: 1 }, seen: { writer: wX, seq: 2 }, at: AT(1) })
  t.alike(Object.keys(tp), ['type', 'target', 'seen', 'at'])
  const options = ['a', 'b']
  const pl = groupPoll({ target, options, at: AT(1) })
  t.alike(Object.keys(pl), ['type', 'target', 'options', 'seen', 'at'])
  t.not(pl.options, options, 'options are copied')
  const ch = groupChoice({ target, pick: 1, at: AT(1) })
  t.alike(Object.keys(ch), ['type', 'target', 'pick', 'seen', 'at'])
  for (const r of [tp, pl, ch]) {
    t.is(validateGroupRecord(r, 1), null)
    t.is(validateGroupRecord({ ...r, extra: 1 }, 1), 'malformed')
    t.is(validateGroupRecord({ ...r, target: { writer: wA, seq: 0 } }, 1), 'malformed', 'target is a block')
    t.is(validateGroupRecord({ ...r, target: null }, 1), 'malformed')
    t.is(validateGroupRecord({ ...r, seen: { writer: wX } }, 1), 'seen-invalid')
    t.is(validateGroupRecord({ ...r, at: 'x' }, 1), 'date-invalid')
    t.is(validateGroupRecord(r, 1, { community: true }), 'group-only')
    t.is(validateGroupRecord(r, 1, { private: true }), 'public-only', 'a private group refuses it in the clear')
    t.is(validateGroupRecord(r, 1, { sealed: true }), 'public-only', 'never inside an envelope')
  }
  for (const bad of [['a'], ['a', 'b', 'c', 'd', 'e'], ['a', 'a'], ['a', ''], 'ab', null, ['a', 1]]) {
    t.is(validateGroupRecord({ ...pl, options: bad }, 1), 'poll-invalid', JSON.stringify(bad))
  }
  t.is(validateGroupRecord({ ...ch, pick: null }, 1), null, 'null withdraws')
  t.is(validateGroupRecord({ ...ch, pick: 3 }, 1), null)
  for (const bad of [4, -1, 1.5, '1', true, undefined]) {
    t.is(validateGroupRecord({ ...ch, pick: bad }, 1), 'pick-invalid', String(bad))
  }
  await t.exception.all(async () => groupPoll({ target, options: ['x'], at: AT(1) }), /poll-invalid/)
  await t.exception.all(async () => groupChoice({ target, pick: 9, at: AT(1) }), /pick-invalid/)
})

test('a topic counts on a root post of the same diary, any of its cores', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  const root = post(w, wX, 1)
  const other = post(w, wY, 2)
  topic(w, wX2, root, 3)
  topic(w, wX, other, 4) // foreign target
  const g = buildGroup(w.input())
  t.alike(postOf(g, root).topic, { poll: null })
  t.alike(postOf(g, root).thread, { writer: wX, seq: 1 })
  t.absent('topic' in postOf(g, other), 'a mark on another diary\'s post is ignored')
  t.absent('thread' in postOf(g, other))
})

test('a topic mark on a reply or an unknown post is ignored', (t) => {
  const w = world().add(Y, wY)
  const p = post(w, wY, 1)
  const reply = post(w, wY, 2, { replyTo: p })
  topic(w, wY, reply, 3)
  topic(w, wY, { writer: wY, seq: 99 }, 4)
  const g = buildGroup(w.input())
  t.absent('topic' in postOf(g, reply))
  t.absent('topic' in postOf(g, p))
  t.ok(g.posts.every((x) => !('thread' in x) && !('topic' in x)), 'plain posts keep their exact keys')
  t.alike(visible(g), [wY + ':1', wY + ':2'], 'side records never become posts')
})

// #350: each admit covers the writers of its own generation, so leaving
// keeps a covered device's earlier records exactly as a listed writer's.
test('a device the admit covers keeps its records from before a leave, as a listed one; a rejoin needs a new admit', (t) => {
  const THUMB = [{ emoji: THUMBS, count: 1, by: [X] }]
  const leaveFrom = (leaver) => {
    const w = world({ join: 'approval' }).add(X, wX)
    w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
    const p = post(w, G, 2)
    w.add(X, wX2, { at: AT(3) })
    const listed = post(w, wX, 4)
    const covered = post(w, wX2, 5)
    topic(w, wX, listed, 6)
    topic(w, wX2, covered, 7)
    react(w, wX2, p, THUMBS, 8)
    const g = buildGroup(w.input())
    t.alike(visible(g), [G + ':2', wX + ':1', wX2 + ':1'])
    t.alike(postOf(g, covered).topic, { poll: null })
    t.alike(reactionsOf(g, p), THUMB)
    const leave = w.push(leaver, groupLeave({ cuts: [{ writer: wX, seq: w.len(wX) }, { writer: wX2, seq: w.len(wX2) }], at: AT(9) }))
    return { w, p, listed, covered, leave, g: buildGroup(w.input()) }
  }
  const fromListed = leaveFrom(wX)
  t.is(fromListed.g.members.get(X), 'left')
  t.alike(visible(fromListed.g), [G + ':2', wX + ':1'], 'the listed writer that left keeps its post')
  t.alike(postOf(fromListed.g, fromListed.listed).topic, { poll: null })
  t.is(reactionsOf(fromListed.g, fromListed.p), undefined, 'a reaction needs a member now')

  const { w, p, covered, leave, g } = leaveFrom(wX2)
  t.is(g.members.get(X), 'left')
  t.alike(visible(g), [G + ':2', wX2 + ':1'], 'the covered writer that left keeps its post too')
  t.alike(postOf(g, covered).topic, { poll: null }, 'and its topic mark')
  t.is(reactionsOf(g, p), undefined, 'a reaction needs a member now')

  const wN = K(0x405)
  w.add(X, wN, { rejoin: leave, at: AT(10) })
  post(w, wN, 11)
  let r = buildGroup(w.input())
  t.is(r.members.get(X), 'requested', 'the old admit covers no writer of the next generation')
  t.alike(r.requests, [X])
  t.alike(visible(r), [G + ':2', wX2 + ':1'], 'the earlier post still stays')
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX2, seq: w.len(wX2) }], at: AT(12) }))
  post(w, wN, 13)
  const wN2 = K(0x406)
  w.add(X, wN2, { rejoin: leave, at: AT(14) })
  post(w, wN2, 15)
  r = buildGroup(w.input())
  t.is(r.members.get(X), 'member')
  t.alike(visible(r), [G + ':2', wX2 + ':1', wN + ':2', wN2 + ':1'], 'the new admit covers its generation from the admit on; the earlier post stays')
})

test('a writer generation follows the whole rejoin chain when leaves cut only their own writer', (t) => {
  const w = world({ join: 'approval' }).add(X, wX)
  w.push(G, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(1) }))
  const all = [wX]
  let cur = wX
  for (let k = 1; k <= 3; k++) {
    const s = 10 * k
    const leave = w.push(cur, groupLeave({ cuts: [{ writer: cur, seq: w.len(cur) }], at: AT(s) }))
    const back = K(0x410 + k)
    w.add(X, back, { rejoin: leave, at: AT(s + 1) })
    all.push(back)
    w.push(G, groupAdmit({ member: X, on: true, cuts: all.map((x) => ({ writer: x, seq: w.len(x) })), at: AT(s + 2) }))
    const device = K(0x420 + k)
    w.add(X, device, { rejoin: leave, at: AT(s + 3) })
    post(w, device, s + 4)
    const g = buildGroup(w.input())
    t.is(g.members.get(X), 'member', 'cycle ' + k)
    t.ok(visible(g).includes(device + ':1'), 'cycle ' + k + ': the re-admit covers the new device')
    t.absent(g.requests.includes(X), 'cycle ' + k)
    all.push(device)
    cur = back
  }
})

test('replies and replies to replies belong to the topic thread', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  topic(w, wY, root, 2)
  const r1 = post(w, wX, 3, { replyTo: root })
  const r2 = post(w, wY, 4, { replyTo: r1 })
  const loose = post(w, wX, 5)
  const r3 = post(w, wX, 6, { replyTo: loose })
  const g = buildGroup(w.input())
  for (const ref of [root, r1, r2]) t.alike(postOf(g, ref).thread, { writer: root.writer, seq: root.seq })
  t.absent('topic' in postOf(g, r1), 'only the root carries topic')
  t.absent('thread' in postOf(g, loose))
  t.absent('thread' in postOf(g, r3))
})

test('the first poll on the root\'s own core wins; a poll needs a topic', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY)
  const root = post(w, wX, 1)
  poll(w, wX2, root, 2, ['outro', 'core']) // another device of the author
  topic(w, wX, root, 3)
  poll(w, wX, root, 4)
  poll(w, wX, root, 5, ['depois', 'nunca']) // a duplicate: the first stays
  poll(w, wY, root, 6, ['alheio', 'x']) // not the author
  const bare = post(w, wY, 7)
  poll(w, wY, bare, 8)
  const g = buildGroup(w.input())
  t.alike(postOf(g, root).topic.poll, { writer: wX, seq: 3, options: OPTS, totals: [0, 0, 0], by: [[], [], []] })
  t.absent('topic' in postOf(g, bare), 'a poll alone makes no topic')
})

test('votes: one per diary, replaced, withdrawn, out of range ignored', (t) => {
  const w = world().add(X, wX).add(X, wX2).add(Y, wY).add(A, wA)
  const root = post(w, wY, 1)
  topic(w, wY, root, 2)
  poll(w, wY, root, 3)
  choose(w, wX, root, 0, 4)
  choose(w, wA, root, 0, 5)
  choose(w, wY, root, 2, 6)
  let p = postOf(buildGroup(w.input()), root).topic.poll
  t.alike(p.totals, [2, 0, 1])
  t.alike(p.by, [[X, A], [], [Y]], 'by lists diaries in vote order')
  // Another device of X replaces its vote: one vote per diary.
  choose(w, wX2, root, 1, 7)
  p = postOf(buildGroup(w.input()), root).topic.poll
  t.alike(p.totals, [1, 1, 1])
  t.alike(p.by, [[A], [X], [Y]])
  // A pick outside the three options is ignored: the earlier one stays.
  choose(w, wY, root, 3, 8)
  t.alike(postOf(buildGroup(w.input()), root).topic.poll.by, [[A], [X], [Y]])
  // Null withdraws.
  choose(w, wA, root, null, 9)
  p = postOf(buildGroup(w.input()), root).topic.poll
  t.alike(p.totals, [0, 1, 1])
  t.alike(p.by, [[], [X], [Y]])
  // A member who leaves takes the vote along, as with reactions; the topic
  // and its poll stay.
  w.push(wY, groupLeave({ cuts: [{ writer: wY, seq: w.len(wY) }], at: AT(10) }))
  const g = buildGroup(w.input())
  t.is(g.members.get(Y), 'left')
  t.alike(postOf(g, root).topic, { poll: { writer: wY, seq: 3, options: OPTS, totals: [0, 1, 0], by: [[], [X], []] } })
})

test('votes on a post with no poll, a reply or a future vote count nowhere', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  topic(w, wY, root, 2)
  const reply = post(w, wX, 3, { replyTo: root })
  choose(w, wX, root, 0, 4)
  choose(w, wX, reply, 0, 5)
  let g = buildGroup(w.input())
  t.alike(postOf(g, root).topic, { poll: null })
  t.absent('topic' in postOf(g, reply))
  poll(w, wY, root, 6)
  g = buildGroup(w.input())
  t.alike(postOf(g, root).topic.poll.totals, [1, 0, 0], 'a vote written before the poll counts once it exists')
  w.push(wX, groupChoice({ target: root, pick: 2, at: new Date(NOW + 2 * 86400000).toISOString() }))
  t.alike(postOf(buildGroup(w.input()), root).topic.poll.totals, [1, 0, 0], 'a future vote is ignored')
  // A reaction on the root still folds beside the poll.
  react(w, wX, root, THUMBS, 7)
  g = buildGroup(w.input())
  t.alike(reactionsOf(g, root), [{ emoji: THUMBS, count: 1, by: [X] }])
  t.alike(postOf(g, root).topic.poll.totals, [1, 0, 0])
})

test('a future-dated poll at a lower seq holds the topic pollless until its date', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  topic(w, wY, root, 2)
  const ahead = NOW + 2 * 86400000
  w.push(wY, groupPoll({ target: root, options: ['futuro', 'troca'], at: new Date(ahead).toISOString() }))
  poll(w, wY, root, 4) // a later seq dated now: must not win meanwhile
  choose(w, wX, root, 2, 5)
  let g = buildGroup(w.input())
  t.alike(postOf(g, root).topic, { poll: null }, 'no poll now, never the higher seq')
  t.alike(postOf(g, root).thread, { writer: wY, seq: 1 }, 'still a topic')
  // Once the clock reaches it the lower seq is the poll. The vote cast while
  // poll was null (pick 2) is outside its two options and is ignored; a
  // vote is on the topic, never on one poll record.
  g = buildGroup({ ...w.input(), now: ahead })
  t.alike(postOf(g, root).topic.poll, { writer: wY, seq: 3, options: ['futuro', 'troca'], totals: [0, 0], by: [[], []] })
  choose(w, wX, root, 1, 6)
  g = buildGroup({ ...w.input(), now: ahead })
  t.alike(postOf(g, root).topic.poll.totals, [0, 1], 'an in-range vote counts on that poll')
})

test('a hidden root hides its topic and poll; an unhide brings them back', (t) => {
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  topic(w, wY, root, 2)
  poll(w, wY, root, 3)
  const r1 = post(w, wX, 4, { replyTo: root })
  choose(w, wX, root, 1, 5)
  w.push(wY, groupHide({ target: root, on: true, at: AT(6) }))
  let g = buildGroup(w.input())
  const p = postOf(g, root)
  t.ok(p.hidden)
  // The marks stay on the hidden post (its `hidden` covers them, as for its
  // text); votes on it do not count.
  t.alike(p.topic.poll.totals, [0, 0, 0])
  t.alike(postOf(g, r1).thread, { writer: wY, seq: 1 })
  w.push(wY, groupHide({ target: root, on: false, at: AT(7) }))
  g = buildGroup(w.input())
  t.absent(postOf(g, root).hidden)
  t.alike(postOf(g, root).topic.poll.totals, [0, 1, 0])
})

test('an old reader skips the forum records and still reads later posts', (t) => {
  const fs = require('fs')
  const path = require('path')
  const Module = require('module')
  const file = require.resolve('../lib/group')
  const src = fs.readFileSync(file, 'utf8')
  const oldSrc = src.replace(/,\n {2}'group-topic': \[[^\]]*\],\n {2}'group-poll': \[[^\]]*\],\n {2}'group-choice': \[[^\]]*\](,\n {2}'group-event': \[[^\]]*\])?/, '')
  t.not(oldSrc, src, 'the types are gone from RECORD_KEYS')
  const m = new Module(file, module)
  m.filename = file
  m.paths = Module._nodeModulePaths(path.dirname(file))
  m._compile(oldSrc, file)
  const old = m.exports
  t.absent(old.GROUP_TYPES.includes('group-topic'))
  const w = world().add(X, wX).add(Y, wY)
  const root = post(w, wY, 1)
  topic(w, wY, root, 2)
  const pl = poll(w, wY, root, 3)
  const ch = choose(w, wX, root, 0, 4)
  post(w, wX, 5, { seen: ch, replyTo: root })
  post(w, wY, 6, { seen: pl })
  t.is(old.validateGroupRecord(w.logs.get(wY).entries[2].record, 2), 'malformed')
  const g = old.buildGroup(w.input())
  t.alike(visible(g), [wY + ':1', wX + ':2', wY + ':4'])
  t.absent('topic' in g.posts[0])
  const now = buildGroup(w.input())
  t.alike(visible(now), visible(g), 'the new reader shows the same posts')
  t.alike(postOf(now, root).topic.poll.totals, [1, 0, 0])
})

// Group readers ignore deletes of group-join, group-confirm and group-cut
// (docs/protocol.md, "Deletion"), so membership history stays as written.
test('a group leave still counts when its diary deletes the join it closed afterwards', (t) => {
  const D = K(0x70)
  const M = K(0x71)
  const gw1 = K(0x72)
  const gw2 = K(0x73)
  const gwM = K(0x74)
  const cm = communityOf({ key: CMG, creator: C, members: [{ diary: D, cw: cwOf(D), status: 'member' }, { diary: M, cw: cwOf(M), status: 'member' }] })
  const g = groupIn(cm, { key: G, diary: C })
  g.add(D, gw1).add(D, gw2).add(M, gwM)
  // D binds two writers, is made admin, leaves from gw1 (the leave cuts
  // both), confirms it and turns gw1 off; gw2 then hides and bans.
  const log = diaryLog()
  const on1 = log.join(G, gw1)
  log.join(G, gw2)
  const p = g.push(gwM, groupPost({ text: 'oi', at: AT(10) }))
  g.push(G, groupAdmin({ member: D, on: true, cuts: [{ writer: gw1, seq: 1 }, { writer: gw2, seq: 1 }], at: AT(11) }))
  g.push(gw1, groupLeave({ cuts: [{ writer: gw1, seq: g.len(gw1) }, { writer: gw2, seq: g.len(gw2) }], at: AT(12) }))
  const confirm = log.confirm(G, gw1, g.logs.get(gw1))
  g.push(gw2, groupHide({ target: p, on: true, at: AT(13) }))
  g.push(gw2, groupBan({ member: M, on: true, cuts: [{ writer: gwM, seq: g.len(gwM) }], at: AT(14) }))
  const fold = () => {
    const input = g.input()
    const read = log.read(G)
    return buildGroup({ ...input, joins: new Map([...input.joins, [D, read.joins]]), confirms: new Map([[D, read.confirms]]) })
  }
  const view = (r) => ({ D: r.members.get(D), M: r.members.get(M), gw2: r.authorityWriters.has(gw2), hidden: r.posts.find((x) => x.writer === gwM).hidden === true })
  const before = log.read(G)
  const left = { D: 'left', M: 'member', gw2: false, hidden: false }
  t.alike(view(fold()), left, 'after the leave D is out and gw2 acts on nothing')
  log.delete(on1)
  t.alike(log.read(G), before, 'the join is still read')
  t.alike(view(fold()), left, 'a delete of the closed join changes nothing')
  log.delete(confirm)
  t.alike(log.read(G), before, 'the confirm is still read')
  t.alike(view(fold()), left, 'nor does a delete of the confirm')
})

test('a group leave still counts when its diary deletes the off join of the leave', (t) => {
  const D = K(0x75)
  const M = K(0x76)
  const gw1 = K(0x77)
  const gwM = K(0x78)
  const cm = communityOf({ key: CMG, creator: C, members: [{ diary: D, cw: cwOf(D), status: 'member' }, { diary: M, cw: cwOf(M), status: 'member' }] })
  const g = groupIn(cm, { key: G, diary: C })
  g.add(D, gw1).add(M, gwM)
  // D binds gw1, is made admin, leaves, confirms it and turns gw1 off
  // (the off join is the block after the confirm); gw1 then hides a post.
  const log = diaryLog()
  log.join(G, gw1)
  const p = g.push(gwM, groupPost({ text: 'oi', at: AT(10) }))
  g.push(G, groupAdmin({ member: D, on: true, cuts: [{ writer: gw1, seq: 1 }], at: AT(11) }))
  g.push(gw1, groupLeave({ cuts: [{ writer: gw1, seq: g.len(gw1) }], at: AT(12) }))
  const off = log.confirm(G, gw1, g.logs.get(gw1)) + 1
  g.push(gw1, groupHide({ target: p, on: true, at: AT(13) }))
  const fold = () => {
    const input = g.input()
    const read = log.read(G)
    return buildGroup({ ...input, joins: new Map([...input.joins, [D, read.joins]]), confirms: new Map([[D, read.confirms]]) })
  }
  const view = (r) => ({ D: r.members.get(D), gw1: r.authorityWriters.has(gw1), hidden: r.posts.find((x) => x.writer === gwM).hidden === true })
  const before = log.read(G)
  const left = { D: 'left', gw1: false, hidden: false }
  t.is(log.entries[off].record.on, false, 'the block is the off join')
  t.alike(view(fold()), left, 'after the leave D is out and gw1 acts on nothing')
  log.delete(off)
  t.alike(log.read(G), before, 'the off join is still read')
  t.alike(view(fold()), left, 'a delete of the off join changes nothing')
})

// The slot walk (#350): per diary and root, from the diary's own group-join
// and group-cut records in seq order.
const walkView = (wk) => JSON.stringify({
  live: [...wk.live].sort(),
  frozen: [...wk.frozen].sort(),
  released: [...wk.released].sort(),
  over: [...wk.over].sort(),
  cut: [...wk.cut].sort((a, b) => a[0] < b[0] ? -1 : 1),
  rootSlot: wk.rootSlot,
  gap: wk.gap,
  bound: wk.bound
})
const RANK = { none: 0, live: 1, frozen: 2, released: 3 }
const stateOf = (wk, w) => wk.live.has(w) ? 'live' : wk.frozen.has(w) ? 'frozen' : wk.released.has(w) ? 'released' : 'none'
const slotted = (wk, w) => wk.live.has(w) || wk.frozen.has(w) || wk.released.has(w)

// A random diary history for root G over a small writer pool: joins (on or
// off), cuts (often 0 or 1) and now and then the root's own join.
function walkHistory (rnd, n) {
  const joins = []
  const marks = []
  const pool = []
  for (let i = 0; i < 24; i++) pool.push(K(0x8000 + i))
  for (let seq = 1; seq <= n; seq++) {
    const r = rnd()
    const writer = pool[Math.floor(rnd() * pool.length)]
    if (r < 0.03) joins.push({ writer: G, on: true, seq })
    else if (r < 0.55) joins.push({ writer, on: rnd() < 0.85, seq })
    else marks.push({ writer: rnd() < 0.03 ? G : writer, cut: rnd() < 0.4 ? 0 : 1 + Math.floor(rnd() * 5), seq })
  }
  return { joins, marks }
}

function shuffled (list, rnd) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

test('slotWalk: one result for any input order, and every prefix agrees with the whole diary (#350)', (t) => {
  const rnd = mulberry32(0x5107)
  let orders = 0
  let prefixes = 0
  for (let round = 0; round < 60; round++) {
    const { joins, marks } = walkHistory(rnd, 20 + Math.floor(rnd() * 60))
    const whole = slotWalk(joins, marks, G)
    const view = walkView(whole)
    let same = true
    for (let i = 0; i < 5; i++) {
      orders++
      if (walkView(slotWalk(shuffled(joins, rnd), shuffled(marks, rnd), G)) !== view) same = false
    }
    t.ok(same, 'round ' + round + ': input order changes nothing')
    t.is(walkView(slotWalk(joins, marks, G)), view, 'round ' + round + ': deterministic')
    const n = Math.max(0, ...joins.map((j) => j.seq), ...marks.map((m) => m.seq))
    let agrees = true
    let oneWay = true
    for (let upto = 0; upto <= n; upto++) {
      prefixes++
      const head = slotWalk(joins.filter((j) => j.seq <= upto), marks.filter((m) => m.seq <= upto), G)
      for (const j of joins) {
        if (!j.on || j.seq > upto || j.writer === G) continue
        // Whether a join got a slot is decided at its seq, for good.
        if (slotted(head, j.writer) !== slotted(whole, j.writer) || head.over.has(j.writer) !== whole.over.has(j.writer)) agrees = false
        if (RANK[stateOf(head, j.writer)] > RANK[stateOf(whole, j.writer)]) oneWay = false
      }
      if (head.rootSlot && !whole.rootSlot) agrees = false
      if (head.live.size > MAX_GROUP_WRITERS_PER_DIARY || head.frozen.size > MAX_FROZEN_WRITERS_PER_DIARY || head.released.size > MAX_WRITER_RELEASES_PER_DIARY) agrees = false
    }
    t.ok(agrees, 'round ' + round + ': every prefix agrees on the slots it sees, and the caps hold')
    t.ok(oneWay, 'round ' + round + ': a writer only moves none, live, frozen, released')
  }
  t.ok(orders >= 300 && prefixes >= 1000, 'checked ' + orders + ' orders and ' + prefixes + ' prefixes')
})

test('slotWalk: the rules one by one (#350)', (t) => {
  const W = (i) => K(0x9000 + i)
  const joinAll = (from, count, seq0 = 1) => {
    const out = []
    for (let i = 0; i < count; i++) out.push({ writer: W(from + i), on: true, seq: seq0 + i })
    return out
  }
  let wk = slotWalk(joinAll(0, 9), [], G)
  t.is(wk.live.size, MAX_GROUP_WRITERS_PER_DIARY, 'eight live writers')
  t.ok(wk.over.has(W(8)), 'the 9th never counts')
  t.ok(wk.bound)

  wk = slotWalk([{ writer: G, on: true, seq: 1 }, ...joinAll(0, 8, 2)], [], G)
  t.ok(wk.rootSlot, 'the root takes its slot')
  t.is(wk.live.size, MAX_GROUP_WRITERS_PER_DIARY - 1, 'seven others next to the root')
  t.ok(wk.over.has(W(7)))

  wk = slotWalk(joinAll(0, 8), [{ writer: G, cut: 0, seq: 20 }, { writer: G, cut: 3, seq: 21 }], G)
  t.alike([...wk.cut], [], 'a mark on the root stays out of the walk')
  t.is(wk.released.size, 0)

  wk = slotWalk(joinAll(0, 9, 2), [{ writer: W(0), cut: 0, seq: 1 }], G)
  t.alike([...wk.released], [], 'a cut before the writer is bound is ignored')
  t.alike([...wk.cut], [])
  t.ok(wk.over.has(W(8)))

  wk = slotWalk([...joinAll(0, 8), { writer: W(8), on: true, seq: 20 }], [{ writer: W(0), cut: 5, seq: 10 }], G)
  t.ok(wk.frozen.has(W(0)), 'a cut >= 1 freezes a live writer')
  t.ok(wk.live.has(W(8)), 'the 9th joined after the freeze counts')
  t.is(wk.cut.get(W(0)), 5)

  wk = slotWalk([...joinAll(0, 8), { writer: W(8), on: true, seq: 9 }], [{ writer: W(0), cut: 5, seq: 10 }], G)
  t.ok(wk.over.has(W(8)), 'a 9th joined before the freeze stays out for good')

  wk = slotWalk(joinAll(0, 8), [{ writer: W(0), cut: 5, seq: 10 }, { writer: W(0), cut: 9, seq: 11 }, { writer: W(0), cut: 2, seq: 12 }], G)
  t.is(wk.cut.get(W(0)), 2, 'the lowest cut wins')
  t.ok(wk.frozen.has(W(0)))
  t.is(wk.frozen.size, 1, 'a frozen writer cut again stays one frozen writer')
  wk = slotWalk(joinAll(0, 8), [{ writer: W(0), cut: 5, seq: 10 }, { writer: W(0), cut: 0, seq: 11 }, { writer: W(0), cut: 4, seq: 12 }], G)
  t.ok(wk.released.has(W(0)), 'cut 0 releases a frozen writer')
  t.is(wk.cut.get(W(0)), 0, 'a released writer takes no later cut')
  t.is(wk.frozen.size, 0)

  // R full: the next cut >= 1 applies to the records, the writer stays live.
  const marks = []
  for (let i = 0; i < MAX_FROZEN_WRITERS_PER_DIARY; i++) marks.push({ writer: W(i), cut: 1, seq: 100 + i })
  const joins = [...joinAll(0, 8), ...joinAll(8, 8, 200)]
  wk = slotWalk(joins, [...marks, { writer: W(8), cut: 3, seq: 300 }], G)
  t.is(wk.frozen.size, MAX_FROZEN_WRITERS_PER_DIARY, 'R frozen')
  t.ok(wk.live.has(W(8)), 'R full: a cut writer stays live and keeps its slot')
  t.is(wk.cut.get(W(8)), 3, 'R full: its cut still applies')
  t.is(wk.live.size, MAX_GROUP_WRITERS_PER_DIARY)
  wk = slotWalk([...joins, { writer: W(16), on: true, seq: 400 }], [...marks, { writer: W(8), cut: 3, seq: 300 }], G)
  t.ok(wk.over.has(W(16)), 'R full: no slot comes back')

  // K full: the next cut 0 applies, the writer keeps its state and slot.
  const cycle = []
  const zeros = []
  for (let i = 0; i < MAX_WRITER_RELEASES_PER_DIARY + 1; i++) {
    cycle.push({ writer: W(40 + i), on: true, seq: 1000 + i * 2 })
    zeros.push({ writer: W(40 + i), cut: 0, seq: 1001 + i * 2 })
  }
  wk = slotWalk(cycle, zeros, G)
  t.is(wk.released.size, MAX_WRITER_RELEASES_PER_DIARY, 'K releases')
  const last = W(40 + MAX_WRITER_RELEASES_PER_DIARY)
  t.ok(wk.live.has(last), 'K full: cut 0 keeps the writer in its slot')
  t.is(wk.cut.get(last), 0, 'K full: and nothing of it counts')

  t.is(slotWalk(joinAll(0, 2), [{ gap: true }], G).gap, true, 'a gap is reported')
  t.is(slotWalk([{ writer: W(0), on: false, seq: 1 }], [], G).bound, false, 'only off joins bind nothing')
  t.is(slotWalk([{ writer: W(0), on: false, seq: 1 }], [], G).live.size, 0, 'an off join takes no slot')
  for (const bad of [null, 'x', 7, [null, { writer: 'x', on: true, seq: 1 }]]) {
    t.is(slotWalk(bad, bad, G).live.size, 0, 'never throws on ' + JSON.stringify(bad))
  }
})

test('slotWalk: with no cut off the root it keeps the slots of the per-diary cap (#350)', (t) => {
  // The seeder's rule before the walk (liveGroupJoins): the
  // MAX_GROUP_WRITERS_PER_DIARY writers with the earliest on:true join, the
  // root's key holding one of them, off writers included.
  const before = (joins) => {
    const first = new Map()
    for (const j of joins) if (j.on && (!first.has(j.writer) || j.seq < first.get(j.writer))) first.set(j.writer, j.seq)
    const allowed = new Set()
    let room = MAX_GROUP_WRITERS_PER_DIARY
    if (first.has(G)) {
      allowed.add(G)
      room--
    }
    const list = [...first].filter(([w]) => w !== G).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    for (const [w] of list) {
      if (room <= 0) break
      allowed.add(w)
      room--
    }
    return [...allowed].sort()
  }
  const latestOff = (list, w) => {
    let last = null
    for (const j of list) if (j.writer === w && (last === null || j.seq > last.seq)) last = j
    return last !== null && !last.on
  }
  const rnd = mulberry32(0xe9a1)
  let same = 0
  let withOff = 0
  const rounds = 200
  for (let round = 0; round < rounds; round++) {
    const { joins } = walkHistory(rnd, 10 + Math.floor(rnd() * 50))
    // The root's join, when any, comes first (the creator binds it on
    // creating the group).
    const own = joins.filter((j) => j.writer !== G)
    const list = rnd() < 0.5 ? [{ writer: G, on: true, seq: 0 }, ...own] : own
    const wk = slotWalk(list, [], G)
    const counted = [...wk.live, ...wk.frozen, ...(wk.rootSlot ? [G] : [])].sort()
    if (JSON.stringify(counted) === JSON.stringify(before(list))) same++
    if (counted.some((w) => w !== G && latestOff(list, w))) withOff++
  }
  t.is(same, rounds, 'the same counted set in every history')
  t.ok(withOff > 0, 'histories with off writers counted were checked (' + withOff + ')')
})

test('diaryGroupKeys: a diary cut gives a slot back to a later join (#350)', (t) => {
  const join = (seq, writer, on = true) => ({ seq, record: groupJoinRecord({ group: G, writer, on, at: AT(seq) }) })
  const cut = (seq, writer, at) => ({ seq, record: groupCutRecord({ group: G, writer, cut: at, at: AT(seq) }) })
  const eight = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) {
    eight.push(join(i + 1, K(0xa000 + i)))
    eight.push(join(20 + i, K(0xa000 + i), false))
  }
  const ninth = K(0xa100)
  t.alike(diaryGroupKeys([...eight, join(40, ninth)]), [], 'the 9th alone is out')
  t.alike(diaryGroupKeys([...eight, cut(39, K(0xa000), 1), join(40, ninth)]), [G], 'after a freeze it counts')
  t.alike(diaryGroupKeys([...eight, cut(39, K(0xa000), 0), join(40, ninth)]), [G], 'after a release it counts')
  t.alike(diaryGroupKeys([...eight, join(40, ninth), cut(41, K(0xa000), 0)]), [], 'a cut after the join gives it nothing')
})

test('walkHasRoom: a new writer counts only where the walk has a live slot, after the caller\'s own events (#350)', (t) => {
  const G = K(0x7000)
  const ws = []
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY + 1; i++) ws.push(K(0x7100 + i))
  const joins = (n, from = 1) => ws.slice(0, n).map((writer, i) => ({ writer, on: true, seq: from + i }))
  t.ok(walkHasRoom([], [], G), 'an empty diary has room')
  t.ok(walkHasRoom(joins(MAX_GROUP_WRITERS_PER_DIARY - 1), [], G))
  t.absent(walkHasRoom(joins(MAX_GROUP_WRITERS_PER_DIARY), [], G), 'eight live: full')
  t.absent(walkHasRoom([{ writer: G, on: true, seq: 0 }, ...joins(MAX_GROUP_WRITERS_PER_DIARY - 1)], [], G), 'the root takes one slot')
  const full = joins(MAX_GROUP_WRITERS_PER_DIARY)
  t.absent(walkHasRoom(full, [], G, [{ kind: 'join', writer: ws[0], on: false }]), 'an off join frees nothing')
  t.ok(walkHasRoom(full, [], G, [{ kind: 'join', writer: ws[0], on: false }, { kind: 'cut', writer: ws[0], cut: 0 }]), 'a cut at 0 releases a slot')
  t.ok(walkHasRoom(full, [], G, [{ kind: 'cut', writer: ws[0], cut: 3 }]), 'a cut at 3 freezes one')
  const over = [...full, { writer: ws[MAX_GROUP_WRITERS_PER_DIARY], on: true, seq: 99 }]
  t.absent(walkHasRoom(over, [], G, [{ kind: 'cut', writer: ws[MAX_GROUP_WRITERS_PER_DIARY], cut: 0 }]), 'cutting a writer the walk never counted frees nothing')
  // Every release spent: a further cut at 0 keeps the writer's slot.
  const spent = []
  const marks = []
  let seq = 1
  for (let i = 0; i < MAX_WRITER_RELEASES_PER_DIARY; i++) {
    const writer = K(0x7300 + i)
    spent.push({ writer, on: true, seq: seq++ })
    marks.push({ writer, cut: 0, seq: seq++ })
  }
  for (let i = 0; i < MAX_GROUP_WRITERS_PER_DIARY; i++) spent.push({ writer: ws[i], on: true, seq: seq++ })
  t.absent(walkHasRoom(spent, marks, G, [{ kind: 'cut', writer: ws[0], cut: 0 }]), 'no release left: no room')
  t.ok(walkHasRoom(null, null, G, [null]), 'bad items read as an empty diary, never throwing')
  t.absent(walkHasRoom(full, [], G, 5), 'a bad event list: no room')
})

test('retiredWriterCut and replacedWriterCut: the cut a node marks on the own writer it replaces (#350)', (t) => {
  const header = (extra = {}) => ({ seq: 0, record: { type: 'group-writer', box: 'ab'.repeat(32), rejoin: null, ...extra } })
  const post = (seq) => ({ seq, record: { type: 'group-post' } })
  const rejoin = { writer: K(0x7400), seq: 3 }
  t.is(retiredWriterCut([header()]), 0, 'header only, no rejoin: released')
  t.is(retiredWriterCut([header({ rejoin })]), 1, 'header only with a rejoin: the generation still reads block 0')
  t.is(retiredWriterCut([header(), post(1), post(2)]), 3, 'more blocks: the length held')
  t.is(retiredWriterCut([post(2), header({ rejoin }), post(1)]), 3, 'any order of the held entries')
  t.is(retiredWriterCut([header({ box: null }), post(1)]), 2, 'a retired writer of a public group keeps its records')
  t.is(retiredWriterCut([post(1)]), null, 'block 0 not held: no cut')
  t.is(retiredWriterCut(null), null)
  t.is(replacedWriterCut([header({ box: null }), post(1)]), 0, 'a boxless writer of a private group is released whatever it holds')
  t.is(replacedWriterCut([header(), post(1)]), 2, 'a writer boxed to another key is cut like a retired one')
  t.is(replacedWriterCut([header({ rejoin })]), 1)
  t.is(replacedWriterCut([]), null)
})

// The slot walk reads the diary's joins and marks as the nodes hand them to
// the fold and to walkHasRoom (after the deletion fold): a deleted group-cut
// keeps its writer frozen or released, and a deleted join keeps its slot.
test('slot walk: a diary that deletes its own group-cut or group-join keeps the walk as written', (t) => {
  const ws = Array.from({ length: MAX_GROUP_WRITERS_PER_DIARY + 1 }, (_, i) => K(0x9a00 + i))
  const log = diaryLog()
  const joins = ws.slice(0, MAX_GROUP_WRITERS_PER_DIARY).map((w) => log.join(G, w))
  const released = log.mark(G, ws[0], 0)
  const frozen = log.mark(G, ws[1], 2)
  log.join(G, ws[MAX_GROUP_WRITERS_PER_DIARY])
  const walk = () => {
    const read = log.read(G)
    return { wk: slotWalk(read.joins, read.marks, G), room: walkHasRoom(read.joins, read.marks, G) }
  }
  const before = walk()
  t.ok(before.wk.released.has(ws[0]) && before.wk.frozen.has(ws[1]), 'the cuts released one writer and froze another')
  t.ok(before.wk.live.has(ws[MAX_GROUP_WRITERS_PER_DIARY]), 'the ninth writer took a freed slot')
  log.delete(released)
  log.delete(frozen)
  log.delete(joins[2])
  const after = walk()
  t.alike(walkView(after.wk), walkView(before.wk), 'the deletes change nothing in the walk')
  t.ok(after.wk.live.has(ws[2]), 'the writer whose join was deleted keeps its slot')
  t.is(after.room, before.room, 'walkHasRoom answers as before')
})

test('walkRecordsCut answers as diaryWriterCut from the group records alone (#350)', (t) => {
  const rnd = mulberry32(0x350a)
  const groups = [G, K(0x110)]
  const W = (i) => K(0x9100 + i)
  let checked = 0
  let differ = 0
  let cuts = 0
  let kept = 0
  let total = 0
  for (let round = 0; round < 40; round++) {
    const log = diaryLog()
    for (let i = 0; i < 40; i++) {
      const g = groups[Math.floor(rnd() * groups.length)]
      const w = W(Math.floor(rnd() * 12))
      const r = rnd()
      if (r < 0.15 && log.entries.length > 1) log.delete(1 + Math.floor(rnd() * (log.entries.length - 1)))
      else if (r < 0.6) log.join(g, w, rnd() < 0.85)
      else log.mark(g, w, rnd() < 0.4 ? 0 : 1 + Math.floor(rnd() * 4))
    }
    const entries = log.entries.slice()
    // Now and then the history as read skips a seq.
    if (round % 3 === 0) entries.splice(1 + Math.floor(rnd() * (entries.length - 1)), 1)
    const records = diaryWalkRecords(entries)
    kept += records.entries.length
    total += entries.length
    for (const g of groups) {
      for (let i = 0; i < 12; i++) {
        checked++
        const cut = diaryWriterCut(entries, g, W(i))
        if (cut !== null) cuts++
        if (walkRecordsCut(records, g, W(i)) !== cut) differ++
      }
    }
  }
  t.is(differ, 0, 'the same cut for each of ' + checked + ' writers')
  t.ok(cuts > 100, cuts + ' of them cut or released')
  t.ok(kept < total, 'kept ' + kept + ' of ' + total + ' records')
  t.is(walkRecordsCut(diaryWalkRecords(null), G, W(0)), null, 'nothing read, no cut')
})
