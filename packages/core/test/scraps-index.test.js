'use strict'

// The recados pointers of the seeder's engagement index (scraps()): wall
// policy, owner hides, the reply exception and the caps applied at read
// time, deletion, purge and cursors, cross-checked against the pure fold
// of lib/scraps.js. No network.
const test = require('brittle')
const { createEngagementIndex, SCRAP_PER_WRITER, SCRAP_PER_PAGE, SCRAP_ROWS, SCRAP_HIDES } = require('../lib/engagement-index')
const { scrapRecord, scrapHideRecord, scrapWallRecord, deleteRecord, validRecordCopy } = require('../lib/records')
const { foldWall } = require('../lib/scraps')

const O = 'a'.repeat(64)
const NOW = Date.parse('2026-03-01T12:00:00.000Z')
const DAY = 86400000
// Canonical dates one second apart, all in the past for i < 100000.
const at = (i) => new Date(NOW - 100000000 + i * 1000).toISOString()
const k = (i) => (i + 1).toString(16).padStart(64, '0')

function diary (key) {
  const entries = []
  return {
    key,
    entries,
    push (record) {
      entries.push({ seq: entries.length + 1, record })
      return entries.length
    }
  }
}

// The seeder's two passes: each indexable block is added in seq order and a
// tombstone removes its target. `deletesFirst` runs every tombstone before
// any add (the scan ahead of the index cursor).
function load (diaries, { deletesFirst = false, ix = createEngagementIndex() } = {}) {
  if (deletesFirst) {
    for (const d of diaries) for (const { record } of d.entries) if (record.type === 'delete') ix.removeRecord(d.key, record.seq)
  }
  for (const d of diaries) {
    for (const { seq, record } of d.entries) {
      if (record.type === 'delete') {
        if (!deletesFirst) ix.removeRecord(d.key, record.seq)
      } else {
        ix.add(d.key, seq, validRecordCopy(record, seq))
      }
    }
  }
  return ix
}

const follows = (map) => (hex) => map[hex] ?? null
const pairs = (rows) => rows.map((r) => r.author + ':' + r.seq)

function read (ix, opts = {}, now = NOW) {
  return ix.scraps(O, now, opts)
}

// Every row of every page, following next.
function allPages (ix, opts = {}) {
  const rows = []
  let cursor = null
  for (let i = 0; i < 100; i++) {
    const page = ix.scraps(O, NOW, { ...opts, cursor })
    rows.push(...page.rows)
    if (page.next === null) return rows
    cursor = page.next
  }
  throw new Error('endless pages')
}

test('wall: following by default, everyone, nobody; the latest live wall wins and a delete falls back', (t) => {
  const W = k(1)
  const V = k(2)
  const o = diary(O)
  const w = diary(W)
  const v = diary(V)
  w.push(scrapRecord({ to: O, text: 'oi', at: at(1) }))
  v.push(scrapRecord({ to: O, text: 'olá', at: at(2) }))
  const ix = load([o, w, v])
  const fw = follows({ [W]: 9 })
  t.alike(read(ix, { followSeq: fw }), { rows: [{ author: W, seq: 1, followSeq: 9 }], next: null, hides: [], wall: null, truncated: false }, 'following: only the followed writer, with its follow seq')
  t.alike(read(ix).rows, [], 'following without evidence shows nobody')

  const ix2 = load([o, w, v])
  ix2.add(O, 1, validRecordCopy(scrapWallRecord({ who: 'everyone', at: at(3) }), 1))
  t.alike(read(ix2, { followSeq: fw }), { rows: [{ author: V, seq: 1, followSeq: null }, { author: W, seq: 1, followSeq: null }], next: null, hides: [], wall: 1, truncated: false }, 'everyone: every writer, followSeq null')
  ix2.add(O, 2, validRecordCopy(scrapWallRecord({ who: 'nobody', at: at(4) }), 2))
  ix2.add(O, 3, validRecordCopy(scrapHideRecord({ from: W, seq: 1, at: at(5) }), 3))
  t.alike(read(ix2, { followSeq: fw }), { rows: [], next: null, hides: [3], wall: 2, truncated: false }, 'nobody: no row, hides and wall still pointed')
  ix2.removeRecord(O, 2)
  t.is(read(ix2).wall, 1, 'deleting the latest wall falls back to the previous one')
  t.alike(pairs(read(ix2).rows), [V + ':1'], 'everyone again, minus the hidden scrap')
  ix2.removeRecord(O, 1)
  t.is(read(ix2).wall, null)
  t.alike(read(ix2, { followSeq: fw }).rows, [], 'no wall left: following, W hidden')
})

test('hides: hidden scraps leave, hides are listed newest first and capped, a deleted hide restores', (t) => {
  const W = k(1)
  const o = diary(O)
  const w = diary(W)
  for (let i = 0; i < 3; i++) w.push(scrapRecord({ to: O, text: 'r' + i, at: at(i) }))
  o.push(scrapHideRecord({ from: W, seq: 2, at: at(10) }))
  o.push(scrapHideRecord({ from: W, seq: 2, at: at(11) }))
  o.push(scrapHideRecord({ from: k(9), seq: 1, at: at(12) }))
  const ix = load([o, w])
  const fw = follows({ [W]: 4 })
  t.alike(pairs(read(ix, { followSeq: fw }).rows), [W + ':3', W + ':1'])
  t.alike(read(ix).hides, [3, 2, 1])
  ix.removeRecord(O, 1)
  t.alike(pairs(read(ix, { followSeq: fw }).rows), [W + ':3', W + ':1'], 'a second hide of the same scrap still hides it')
  ix.removeRecord(O, 2)
  t.alike(pairs(read(ix, { followSeq: fw }).rows), [W + ':3', W + ':2', W + ':1'], 'its last hide deleted: shown again')
  t.alike(read(ix).hides, [3])

  const many = diary(O)
  for (let i = 0; i < SCRAP_HIDES + 5; i++) many.push(scrapHideRecord({ from: W, seq: 100 + i, at: at(i) }))
  const big = load([many])
  const hides = read(big).hides
  t.is(hides.length, SCRAP_HIDES)
  t.is(hides[0], SCRAP_HIDES + 5)
  t.is(hides.at(-1), 6, 'the newest ' + SCRAP_HIDES)
})

test('reply exception: the lowest live reply per original, dated no earlier, not far ahead; a hidden one keeps the slot', (t) => {
  const W = k(1)
  const X = k(2)
  const o = diary(O)
  const w = diary(W)
  const x = diary(X)
  const o1 = o.push(scrapRecord({ to: W, text: 'oi W', at: at(10) })) // 1
  const o2 = o.push(scrapRecord({ to: W, text: 'de novo', at: at(20) })) // 2
  const oX = o.push(scrapRecord({ to: X, text: 'oi X', at: at(10) })) // 3
  const reply = (seq, i) => scrapRecord({ to: O, text: 'resposta', replyTo: { author: O, seq }, at: at(i) })
  w.push(reply(o1, 5)) // 1: earlier than the original, never admitted
  w.push(reply(o1, 11)) // 2: the winner for o1
  w.push(reply(o1, 12)) // 3: second reply, not admitted
  w.push(scrapRecord({ to: O, text: 'solto', at: at(13) })) // 4: no replyTo
  w.push(reply(oX, 14)) // 5: an original addressed to X, not W
  w.push(scrapRecord({ to: O, text: 'longe', replyTo: { author: O, seq: o2 }, at: new Date(NOW + 2 * DAY).toISOString() })) // 6: far ahead
  w.push(reply(o2, 21)) // 7: the winner for o2
  w.push(reply(99, 22)) // 8: a missing original
  x.push(reply(oX, 15)) // X 1: X's own reply
  const ix = load([o, w, x])
  t.alike(read(ix).rows, [{ author: W, seq: 7, followSeq: null }, { author: X, seq: 1, followSeq: null }, { author: W, seq: 2, followSeq: null }], 'one reply per original, followSeq null')
  t.alike(pairs(read(ix, {}, NOW + 3 * DAY).rows), [W + ':6', W + ':7', X + ':1', W + ':2'].filter((p) => p !== W + ':7'), 'once the clock catches up, the earlier block takes the o2 slot')

  ix.removeRecord(W, 2)
  t.alike(pairs(read(ix).rows), [W + ':7', X + ':1', W + ':3'], 'the writer deletes the winner: the next reply surfaces')

  ix.add(W, 9, validRecordCopy(reply(o1, 16), 9))
  t.alike(pairs(read(ix).rows), [W + ':7', X + ':1', W + ':3'], 'a later third reply stays out')
  ix.add(O, 4, validRecordCopy(scrapHideRecord({ from: W, seq: 3, at: at(30) }), 4))
  t.alike(pairs(read(ix).rows), [W + ':7', X + ':1'], 'a hidden winner keeps the slot: the third reply does not surface')

  ix.removeRecord(O, o2)
  t.alike(pairs(read(ix).rows), [X + ':1'], 'the original deleted: its reply is not admitted')
  t.alike(pairs(read(ix, { followSeq: follows({ [W]: 5 }) }).rows), [W + ':8', W + ':7', W + ':9', X + ':1', W + ':5', W + ':4', W + ':1'], 'followed: every live, unhidden, not future scrap, replies included')
})

test('followed: under following only the followed writers and the ones the owner addressed are walked; everyone ignores it', (t) => {
  const W = k(1)
  const X = k(2)
  const V = k(3)
  const o = diary(O)
  const w = diary(W)
  const x = diary(X)
  const v = diary(V)
  const oX = o.push(scrapRecord({ to: X, text: 'oi X', at: at(10) }))
  w.push(scrapRecord({ to: O, text: 'seguido', at: at(11) }))
  x.push(scrapRecord({ to: O, text: 'resposta', replyTo: { author: O, seq: oX }, at: at(12) }))
  x.push(scrapRecord({ to: O, text: 'solto', at: at(13) }))
  v.push(scrapRecord({ to: O, text: 'estranho', at: at(14) }))
  const ix = load([o, w, x, v])
  // V claims a follow seq but is not a committed follow target: not walked.
  const fw = follows({ [W]: 4, [V]: 9 })
  t.alike(read(ix, { followSeq: fw, followed: [W, W, 'junk'] }).rows, [{ author: X, seq: 1, followSeq: null }, { author: W, seq: 1, followSeq: 4 }], 'W followed, X by the reply exception, V left out')
  t.alike(pairs(read(ix, { followSeq: fw }).rows), [V + ':1', X + ':1', W + ':1'], 'without followed: every writer is walked')
  t.alike(pairs(read(ix, { followSeq: fw, followed: [] }).rows), [X + ':1'], 'no follow: only the reply exception')
  ix.add(O, 2, validRecordCopy(scrapWallRecord({ who: 'everyone', at: at(20) }), 2))
  t.alike(pairs(read(ix, { followSeq: fw, followed: [] }).rows), [V + ':1', X + ':2', X + ':1', W + ':1'], 'everyone: followed is ignored')
})

test('reply exception: the winner does not depend on add order', (t) => {
  const W = k(1)
  const o = diary(O)
  o.push(scrapRecord({ to: W, text: 'oi', at: at(10) }))
  const ix = createEngagementIndex()
  load([o], { ix })
  // Blocks handed out of order (a re-add after a rebuild is in order, but
  // the index must not care): 3 first, then 2.
  ix.add(W, 3, validRecordCopy(scrapRecord({ to: O, text: 'b', replyTo: { author: O, seq: 1 }, at: at(12) }), 3))
  ix.add(W, 2, validRecordCopy(scrapRecord({ to: O, text: 'a', replyTo: { author: O, seq: 1 }, at: at(11) }), 2))
  t.alike(pairs(read(ix).rows), [W + ':2'])
})

test('future: a scrap dated more than a day ahead is never shown and never takes a cap slot', (t) => {
  const W = k(1)
  const w = diary(W)
  for (let i = 0; i < 30; i++) w.push(scrapRecord({ to: O, text: 'futuro', at: new Date(NOW + 2 * DAY + i).toISOString() }))
  w.push(scrapRecord({ to: O, text: 'perto', at: new Date(NOW + DAY - 1000).toISOString() }))
  w.push(scrapRecord({ to: O, text: 'agora', at: at(1) }))
  const ix = load([w])
  t.alike(pairs(read(ix, { followSeq: follows({ [W]: 1 }) }).rows), [W + ':31', W + ':32'])
})

test('caps: 20 per writer and 500 per page, counted over admitted writers only, paged by 50 with exclusive cursors', (t) => {
  const diaries = []
  const map = {}
  // 30 followed writers with 25 scraps each, 40 strangers with 25 each.
  for (let i = 0; i < 70; i++) {
    const d = diary(k(i))
    for (let j = 0; j < 25; j++) d.push(scrapRecord({ to: O, text: 'x', at: at(i * 7 + j * 3) }))
    if (i < 30) map[k(i)] = 1000 + i
    diaries.push(d)
  }
  const ix = load(diaries)
  const fw = follows(map)
  const first = read(ix, { followSeq: fw })
  t.is(first.rows.length, SCRAP_ROWS)
  const rows = allPages(ix, { followSeq: fw })
  t.is(rows.length, SCRAP_PER_PAGE, 'the page holds ' + SCRAP_PER_PAGE)
  t.is(new Set(pairs(rows)).size, rows.length, 'no duplicates across pages')
  t.ok(rows.every((r) => map[r.author] === r.followSeq), 'only admitted writers, each with its follow seq')
  const perWriter = new Map()
  for (const r of rows) perWriter.set(r.author, (perWriter.get(r.author) || 0) + 1)
  t.ok([...perWriter.values()].every((n) => n <= SCRAP_PER_WRITER), 'at most ' + SCRAP_PER_WRITER + ' per writer')
  // The reference: each followed writer's 20 newest, then the 500 newest.
  const expected = []
  for (let i = 0; i < 30; i++) {
    const mine = []
    for (let j = 0; j < 25; j++) mine.push({ atMs: Date.parse(at(i * 7 + j * 3)), author: k(i), seq: j + 1 })
    mine.sort((a, b) => b.atMs - a.atMs || b.seq - a.seq)
    expected.push(...mine.slice(0, SCRAP_PER_WRITER))
  }
  expected.sort((a, b) => b.atMs - a.atMs || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || b.seq - a.seq)
  t.alike(pairs(rows), pairs(expected.slice(0, SCRAP_PER_PAGE)), 'newest first: at desc, author asc, seq desc')

  const hidden = (hex) => hex !== k(0)
  t.ok(allPages(ix, { followSeq: fw, visible: hidden }).every((r) => r.author !== k(0)), 'an invisible writer is never listed')
  t.is(allPages(ix, { visible: (hex) => hex === k(40) || hex === k(1), followSeq: follows({ [k(40)]: 3, [k(1)]: 4 }) }).length, 2 * SCRAP_PER_WRITER, 'strangers made visible and followed count, the rest do not')
})

test('cursor: malformed answers null; the cursor is exclusive in page order', (t) => {
  const W = k(1)
  const w = diary(W)
  w.push(scrapRecord({ to: O, text: 'oi', at: at(1) }))
  const ix = load([w])
  for (const cursor of ['x', '1.' + W, '1.' + W + '.0', '99999999999999999.' + W + '.1', 5, {}]) t.is(read(ix, { cursor }), null, String(cursor))
  t.is(ix.scraps('A'.repeat(64), NOW), null, 'a malformed owner')
  t.is(ix.scraps(O, NaN), null, 'a malformed clock')
  t.alike(read(ix, { cursor: '0.' + W + '.1', followSeq: follows({ [W]: 1 }) }).rows, [], 'a cursor older than every row ends the list')
  t.is(read(ix, { cursor: '99999999999999.' + W + '.1', followSeq: follows({ [W]: 1 }) }).rows.length, 1, 'a cursor newer than every row lists them all')
})

test('predicates: a throwing visible hides the writer, a throwing or bogus followSeq is no follow', (t) => {
  const W = k(1)
  const w = diary(W)
  w.push(scrapRecord({ to: O, text: 'oi', at: at(1) }))
  const ix = load([w])
  t.alike(read(ix, { visible: () => { throw new Error('x') }, followSeq: () => 1 }).rows, [])
  t.alike(read(ix, { followSeq: () => { throw new Error('x') } }).rows, [])
  for (const bogus of [0, -1, 1.5, '3', true]) t.alike(read(ix, { followSeq: () => bogus }).rows, [], String(bogus))
})

test('deletion and purge: a deleted scrap leaves in either pass order; a purged writer leaves; an owner drop keeps the writers', (t) => {
  const W = k(1)
  for (const deletesFirst of [false, true]) {
    const o = diary(O)
    const w = diary(W)
    o.push(scrapWallRecord({ who: 'everyone', at: at(1) }))
    w.push(scrapRecord({ to: O, text: 'a', at: at(2) }))
    w.push(scrapRecord({ to: O, text: 'b', at: at(3) }))
    w.push(deleteRecord({ seq: 1, at: at(4) }))
    const ix = load([o, w], { deletesFirst })
    t.alike(pairs(read(ix).rows), [W + ':2'], 'the tombstoned scrap is out' + (deletesFirst ? ' (scan first)' : ''))
    const before = ix.stats().records
    ix.removeRecord(W, 2)
    t.is(ix.stats().records, before - 1, 'the record slot is released')
    t.alike(read(ix).rows, [])
  }
  const o = diary(O)
  const w = diary(W)
  o.push(scrapWallRecord({ who: 'everyone', at: at(1) }))
  w.push(scrapRecord({ to: O, text: 'a', at: at(2) }))
  const ix = load([o, w])
  ix.removeDiary(O)
  t.alike(read(ix), { rows: [], next: null, hides: [], wall: null, truncated: false }, 'the dropped owner policy is forgotten: following again')
  load([o], { ix })
  t.alike(pairs(read(ix).rows), [W + ':1'], 'the writers\' pointers outlive the owner drop')
  ix.removeDiary(W)
  t.alike(read(ix).rows, [], 'a purged writer leaves')
  t.is(ix.stats().records, 1)
  ix.clear()
  t.alike(read(ix).wall, null)
})

test('bounded: a request examines at most SCRAP_SCAN pointers and says truncated', (t) => {
  const W = k(1)
  const ix = createEngagementIndex()
  const n = 26000
  for (let i = 1; i <= n; i++) ix.add(O, i, validRecordCopy(scrapRecord({ to: W, text: 'o', at: at(50000) }), i))
  // Every reply is dated before its original: each costs two steps.
  for (let i = 1; i <= n; i++) ix.add(W, i, validRecordCopy(scrapRecord({ to: O, text: 'r', replyTo: { author: O, seq: i }, at: at(1) }), i))
  const t0 = Date.now()
  const page = read(ix)
  t.ok(Date.now() - t0 < 2000, 'answered in ' + (Date.now() - t0) + ' ms')
  t.is(page.truncated, true)
  t.alike(page.rows, [])
})

test('bounded: replies flooded before the winner (backdated or far ahead) cost nothing; the eligible one is admitted', (t) => {
  const W = k(1)
  const o = diary(O)
  const w = diary(W)
  const o1 = o.push(scrapRecord({ to: W, text: 'oi', at: at(50000) }))
  const o2 = o.push(scrapRecord({ to: W, text: 'de novo', at: at(50000) }))
  const reply = (seq, when) => scrapRecord({ to: O, text: 'r', replyTo: { author: O, seq }, at: when })
  const flood = 21000 // each alone is more than SCRAP_SCAN
  for (let i = 0; i < flood; i++) w.push(reply(o1, at(1)))
  const far = new Date(NOW + 2 * DAY).toISOString()
  for (let i = 0; i < flood; i++) w.push(reply(o2, far))
  const win1 = w.push(reply(o1, at(50001)))
  const win2 = w.push(reply(o2, at(50002)))
  const ix = load([o, w])
  const t0 = Date.now()
  const page = read(ix)
  t.ok(Date.now() - t0 < 2000, 'answered in ' + (Date.now() - t0) + ' ms')
  t.alike(page, { rows: [{ author: W, seq: win2, followSeq: null }, { author: W, seq: win1, followSeq: null }], next: null, hides: [], wall: null, truncated: false }, 'both winners admitted, not truncated')
  const ref = foldWall({ owner: O, ownerEntries: o.entries, writers: [w], follows: {}, now: NOW })
  t.alike(pairs(page.rows), ref.scraps.map((s) => s.author + ':' + s.seq), 'same as foldWall')
  t.alike(read(load([w, o])), page, 'the originals indexed after their replies: same answer')
  ix.removeRecord(W, win1)
  t.alike(read(ix), { rows: [{ author: W, seq: win2, followSeq: null }], next: null, hides: [], wall: null, truncated: false }, 'the winner deleted: only backdated replies are left for o1')
  t.alike(pairs(read(ix, {}, NOW + 3 * DAY).rows), [W + ':' + (flood + 1)], 'once the clock catches up, the first far reply takes the o2 slot')
})

// A seeded generator: the same cases on every run.
function rng (seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

test('cross-check: random pages fold like lib/scraps.js foldWall (under the caps)', (t) => {
  const rand = rng(7)
  const pick = (list) => list[Math.floor(rand() * list.length)]
  let cases = 0
  for (let round = 0; round < 150; round++) {
    const writers = [k(1), k(2), k(3), k(4)]
    const o = diary(O)
    const ds = writers.map(diary)
    const map = {}
    for (const w of writers) if (rand() < 0.5) map[w] = 1 + Math.floor(rand() * 50)
    const deletable = new Map(ds.map((d) => [d.key, []]))
    deletable.set(O, [])
    const time = () => rand() < 0.08 ? new Date(NOW + 2 * DAY).toISOString() : at(Math.floor(rand() * 40))
    for (let step = 0; step < 30; step++) {
      const r = rand()
      if (r < 0.15) {
        deletable.get(O).push(o.push(scrapRecord({ to: pick(writers), text: 'o', at: time() })))
      } else if (r < 0.22) {
        const d = pick(ds)
        if (d.entries.length > 0) deletable.get(O).push(o.push(scrapHideRecord({ from: d.key, seq: 1 + Math.floor(rand() * d.entries.length), at: at(step) })))
      } else if (r < 0.27) {
        deletable.get(O).push(o.push(scrapWallRecord({ who: pick(['following', 'everyone', 'nobody', 'following']), at: at(step) })))
      } else if (r < 0.85) {
        const d = pick(ds)
        const own = o.entries.filter((e) => e.record.type === 'scrap')
        const replyTo = own.length > 0 && rand() < 0.6 ? { author: O, seq: pick(own).seq } : null
        deletable.get(d.key).push(d.push(scrapRecord({ to: rand() < 0.9 ? O : k(7), text: 'w', replyTo, at: time() })))
      } else {
        const d = pick([o, ...ds])
        const list = deletable.get(d.key)
        if (list.length > 0) d.push(deleteRecord({ seq: list.splice(Math.floor(rand() * list.length), 1)[0], at: at(step) }))
      }
    }
    const ix = load([o, ...ds], { deletesFirst: rand() < 0.5 })
    const got = allPages(ix, { followSeq: follows(map) })
    const ref = foldWall({ owner: O, ownerEntries: o.entries, writers: ds, follows: map, now: NOW })
    const want = ref.scraps.map((s) => ({ author: s.author, seq: s.seq, followSeq: s.via === 'following' ? map[s.author] : null }))
    if (want.length > SCRAP_PER_WRITER) continue
    cases++
    t.alike(got, want, 'round ' + round)
  }
  t.ok(cases > 100, cases + ' rounds compared')
})
