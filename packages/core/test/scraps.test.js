'use strict'

const test = require('brittle')
const { scrapRecord, scrapHideRecord, scrapWallRecord, deleteRecord, postRecord, formatRef } = require('../lib/records')
const { foldWall, wallOf, DEFAULT_WALL } = require('../lib/scraps')

const OWNER = 'a'.repeat(64)
const ANA = 'b'.repeat(64)
const BIA = 'c'.repeat(64)
const CAL = 'd'.repeat(64)
const T = (n) => new Date(Date.UTC(2026, 5, 1, 12, 0, n)).toISOString()

// A diary of { seq, record } with block 0 (the cert) left out.
const diary = (key, records) => ({ key, entries: records.map((record, i) => ({ seq: i + 1, record })) })
const scrap = (to, text, n, replyTo = null) => scrapRecord({ to, text, replyTo, at: T(n) })
const wall = (who, n = 0) => scrapWallRecord({ who, at: T(n) })

test('wall policy: default and the latest live scrap-wall wins', (t) => {
  t.is(DEFAULT_WALL, 'following')
  t.is(wallOf([]), 'following')
  const entries = (...records) => records.map((record, i) => ({ seq: i + 1, record }))
  const live = entries
  t.is(wallOf(live(postRecord({ text: 'x', at: T(0) }))), 'following', 'no scrap-wall')
  t.is(wallOf(live(wall('everyone'), wall('nobody'))), 'nobody', 'highest block wins')
  t.is(wallOf(live(wall('nobody'), wall('everyone'))), 'everyone')
  // A tombstone over the latest one brings back the previous policy.
  const e = entries(wall('everyone'), wall('nobody'), deleteRecord({ seq: 2, at: T(0) }))
  const out = foldWall({ owner: OWNER, ownerEntries: e, writers: [diary(ANA, [scrap(OWNER, 'oi', 1)])] })
  t.is(out.wall, 'everyone', 'a deleted scrap-wall no longer counts')
  t.is(out.scraps.length, 1)
})

test('following (default): only followed writers, evidence passed in', (t) => {
  const writers = [
    diary(ANA, [scrap(OWNER, 'da ana', 1)]),
    diary(BIA, [scrap(OWNER, 'da bia', 2)])
  ]
  const ownerEntries = diary(OWNER, []).entries
  const out = foldWall({ owner: OWNER, ownerEntries, writers, follows: new Map([[ANA, true]]) })
  t.is(out.wall, 'following')
  t.alike(out.scraps, [{ author: ANA, seq: 1, ref: formatRef({ author: ANA, seq: 1 }), text: 'da ana', at: T(1), replyTo: null, via: 'following' }])
  // The follow seq works as evidence, a plain object too; false, 0 and junk do not.
  t.is(foldWall({ owner: OWNER, ownerEntries, writers, follows: { [BIA]: 7 } }).scraps.length, 1)
  t.is(foldWall({ owner: OWNER, ownerEntries, writers, follows: { [ANA]: false, [BIA]: 0 } }).scraps.length, 0)
  t.is(foldWall({ owner: OWNER, ownerEntries, writers, follows: { [ANA]: 'yes', [BIA]: -1 } }).scraps.length, 0)
  t.is(foldWall({ owner: OWNER, ownerEntries, writers }).scraps.length, 0, 'no evidence shows nobody')
  t.is(foldWall({ owner: OWNER, ownerEntries, writers, follows: null }).scraps.length, 0)
  t.is(foldWall({ owner: OWNER, ownerEntries, writers, follows: new Map([[ANA, true], [BIA, true]]) }).scraps.length, 2)
})

test('everyone admits every writer and ignores follows', (t) => {
  const writers = [diary(ANA, [scrap(OWNER, 'a', 1)]), diary(BIA, [scrap(OWNER, 'b', 2)])]
  const out = foldWall({ owner: OWNER, ownerEntries: diary(OWNER, [wall('everyone')]).entries, writers })
  t.is(out.wall, 'everyone')
  t.alike(out.scraps.map((s) => [s.author, s.via]), [[BIA, 'everyone'], [ANA, 'everyone']])
})

test('nobody shows nothing, replies and followed writers included', (t) => {
  const ownerEntries = diary(OWNER, [scrap(ANA, 'oi ana', 1), wall('nobody', 2)]).entries
  const writers = [diary(ANA, [scrap(OWNER, 'resposta', 3, { author: OWNER, seq: 1 })])]
  const out = foldWall({ owner: OWNER, ownerEntries, writers, follows: new Map([[ANA, true]]) })
  t.alike(out, { wall: 'nobody', scraps: [] })
})

test('reply exception under following', (t) => {
  const ownerEntries = diary(OWNER, [
    scrap(ANA, 'oi ana', 1), // seq 1: left on Ana's page
    scrap(BIA, 'oi bia', 2), // seq 2: left on Bia's page
    postRecord({ text: 'um post', at: T(3) }) // seq 3: not a scrap
  ]).entries
  const reply = (seq) => ({ author: OWNER, seq })
  const writers = [
    diary(ANA, [scrap(OWNER, 'resposta da ana', 4, reply(1))]),
    diary(BIA, [scrap(OWNER, 'bia responde a ana', 5, reply(1))]), // names a scrap addressed to Ana
    diary(CAL, [scrap(OWNER, 'cal responde ao post', 6, reply(3)), scrap(OWNER, 'cal inventa', 7, reply(99))])
  ]
  const out = foldWall({ owner: OWNER, ownerEntries, writers })
  t.alike(out.scraps.map((s) => [s.author, s.via]), [[ANA, 'reply']], 'only the addressee answering a live scrap of the owner')
  t.alike(out.scraps[0].replyTo, { author: OWNER, seq: 1 })
  // Replying to a scrap by another author does not count.
  const other = diary(ANA, [scrap(OWNER, 'x', 4, { author: BIA, seq: 1 })])
  t.is(foldWall({ owner: OWNER, ownerEntries, writers: [other] }).scraps.length, 0)
})

test('reply exception: one reply per original, the first block', (t) => {
  const ownerEntries = diary(OWNER, [scrap(ANA, 'oi ana', 1), scrap(ANA, 'de novo', 2)]).entries
  const reply = (seq) => ({ author: OWNER, seq })
  const writers = [diary(ANA, [
    scrap(OWNER, 'r1 a 1', 3, reply(1)),
    scrap(OWNER, 'r2 a 1', 4, reply(1)),
    scrap(OWNER, 'r1 a 2', 5, reply(2)),
    scrap(OWNER, 'avulso', 6)
  ])]
  const out = foldWall({ owner: OWNER, ownerEntries, writers })
  t.alike(out.scraps.map((s) => s.text), ['r1 a 2', 'r1 a 1'], 'one per original, the plain scrap is refused')
  // Delete the first reply: the next one takes its place.
  const writers2 = [{ key: ANA, entries: [...writers[0].entries, { seq: 5, record: deleteRecord({ seq: 1, at: T(7) }) }] }]
  t.alike(foldWall({ owner: OWNER, ownerEntries, writers: writers2 }).scraps.map((s) => s.text), ['r1 a 2', 'r2 a 1'])
  // The original deleted by the owner no longer opens the exception.
  const gone = [...ownerEntries, { seq: 3, record: deleteRecord({ seq: 1, at: T(8) }) }]
  t.alike(foldWall({ owner: OWNER, ownerEntries: gone, writers }).scraps.map((s) => s.text), ['r1 a 2'])
  // A followed writer is admitted either way; the bound only limits the exception.
  const followed = foldWall({ owner: OWNER, ownerEntries, writers, follows: { [ANA]: true } })
  t.is(followed.scraps.length, 4)
  t.alike([...new Set(followed.scraps.map((s) => s.via))], ['following'])
})

test('hides: owner hides one scrap; deleting the hide shows it again', (t) => {
  const writers = [diary(ANA, [scrap(OWNER, 'um', 1), scrap(OWNER, 'dois', 2)])]
  const follows = { [ANA]: true }
  const hide = scrapHideRecord({ from: ANA, seq: 1, at: T(5) })
  const out = foldWall({ owner: OWNER, ownerEntries: diary(OWNER, [hide]).entries, writers, follows })
  t.alike(out.scraps.map((s) => s.text), ['dois'])
  const unhidden = [{ seq: 1, record: hide }, { seq: 2, record: deleteRecord({ seq: 1, at: T(6) }) }]
  t.alike(foldWall({ owner: OWNER, ownerEntries: unhidden, writers, follows }).scraps.map((s) => s.text), ['dois', 'um'])
  // A hide names (writer, seq): the same seq of another writer is untouched, and so is a hide in a writer's own diary.
  const other = [diary(BIA, [scrap(OWNER, 'bia', 3)])]
  t.is(foldWall({ owner: OWNER, ownerEntries: diary(OWNER, [hide]).entries, writers: other, follows: { [BIA]: true } }).scraps.length, 1)
  const hideBy = [diary(ANA, [scrap(OWNER, 'um', 1), scrapHideRecord({ from: ANA, seq: 1, at: T(5) })])]
  t.is(foldWall({ owner: OWNER, ownerEntries: [], writers: hideBy, follows }).scraps.length, 1, 'only the owner hides')
  // Hidden under everyone too, and a hidden reply stays hidden.
  const ownerEntries = diary(OWNER, [wall('everyone'), hide]).entries
  t.alike(foldWall({ owner: OWNER, ownerEntries, writers }).scraps.map((s) => s.text), ['dois'])
})

test('self-addressed and misaddressed scraps are refused', (t) => {
  const ownerEntries = diary(OWNER, [wall('everyone'), scrap(OWNER, 'comigo mesmo', 1), scrap(ANA, 'para a ana', 2)]).entries
  const writers = [
    diary(OWNER, [scrap(OWNER, 'self', 3)]), // the owner as a candidate writer
    diary(ANA, [scrap(ANA, 'self da ana', 4), scrap(BIA, 'para a bia', 5), scrap(OWNER, 'certo', 6)])
  ]
  const out = foldWall({ owner: OWNER, ownerEntries, writers })
  t.alike(out.scraps.map((s) => s.text), ['certo'])
  t.is(foldWall({ owner: OWNER, ownerEntries: [], writers: [diary(OWNER, [scrap(OWNER, 'self', 1)])], follows: { [OWNER]: true } }).scraps.length, 0)
})

test('order: at descending, then author, then seq', (t) => {
  const ownerEntries = diary(OWNER, [wall('everyone')]).entries
  const writers = [
    diary(BIA, [scrap(OWNER, 'bia 10', 10)]),
    diary(ANA, [scrap(OWNER, 'ana 10 a', 10), scrap(OWNER, 'ana 5', 5), scrap(OWNER, 'ana 10 b', 10)]),
    diary(CAL, [scrap(OWNER, 'cal 20', 20)])
  ]
  const out = foldWall({ owner: OWNER, ownerEntries, writers })
  t.alike(out.scraps.map((s) => s.text), ['cal 20', 'ana 10 b', 'ana 10 a', 'bia 10', 'ana 5'])
  // The same on any input order.
  const rev = foldWall({ owner: OWNER, ownerEntries, writers: [...writers].reverse() })
  t.alike(rev, out)
})

test('robustness: junk input, invalid records, duplicates and no mutation', (t) => {
  t.alike(foldWall(), { wall: 'following', scraps: [] })
  t.alike(foldWall({ owner: 'x' }), { wall: 'following', scraps: [] })
  t.alike(foldWall({ owner: OWNER, ownerEntries: 'x', writers: 7 }), { wall: 'following', scraps: [] })
  const good = scrap(OWNER, 'ok', 1)
  const hostile = { type: 'scrap', to: OWNER, replyTo: null, at: T(2) }
  Object.defineProperty(hostile, 'text', { enumerable: true, get () { throw new Error('boom') } })
  const writers = [
    null,
    { key: 'nope', entries: [] },
    { key: ANA, entries: [null, 5, { seq: 0, record: good }, { seq: 1, record: { ...good, text: '' } }, { seq: 2, record: hostile }, { seq: 3, record: { ...good, extra: 1 } }, { seq: 4, record: good }, { seq: 4, record: scrap(OWNER, 'dup', 9) }] },
    { key: ANA, entries: [{ seq: 1, record: scrap(OWNER, 'repetido', 1) }] }
  ]
  const out = foldWall({ owner: OWNER, ownerEntries: [], writers, follows: { [ANA]: true } })
  t.alike(out.scraps.map((s) => [s.seq, s.text]), [[4, 'ok']], 'only the valid record at its own block, one diary per writer')
  // Inputs are not mutated and outputs are copies.
  const clean = { owner: OWNER, ownerEntries: diary(OWNER, [scrap(ANA, 'q', 1)]).entries, writers: [diary(ANA, [scrap(OWNER, 'r', 2, { author: OWNER, seq: 1 })])], follows: new Map() }
  const before = JSON.stringify(clean.writers) + JSON.stringify(clean.ownerEntries)
  const res = foldWall(clean)
  t.is(res.scraps.length, 1)
  res.scraps[0].text = 'changed'
  res.scraps[0].replyTo.seq = 9
  t.is(JSON.stringify(clean.writers) + JSON.stringify(clean.ownerEntries), before)
  t.is(good.text, 'ok')
})

test('reply winner does not depend on the order entries are listed', (t) => {
  const ownerEntries = diary(OWNER, [scrap(ANA, 'oi ana', 1)]).entries
  const reply = { author: OWNER, seq: 1 }
  const ana = diary(ANA, [scrap(OWNER, 'primeira', 3, reply), scrap(OWNER, 'segunda', 4, reply)])
  const forward = foldWall({ owner: OWNER, ownerEntries, writers: [ana] })
  const reversed = foldWall({ owner: OWNER, ownerEntries, writers: [{ key: ANA, entries: [...ana.entries].reverse() }] })
  t.alike(forward.scraps.map((s) => s.text), ['primeira'])
  t.alike(reversed, forward)
  // The owner's entries listed backwards fold the same (latest wall, hides).
  const owned = diary(OWNER, [wall('everyone'), wall('following')]).entries
  t.is(foldWall({ owner: OWNER, ownerEntries: [...owned].reverse(), writers: [ana] }).wall, 'following')
})

test('hiding a reply keeps its slot, only the writer delete frees it', (t) => {
  const reply = { author: OWNER, seq: 1 }
  const originals = [scrap(ANA, 'oi ana', 1)]
  const ana = diary(ANA, [scrap(OWNER, 'primeira', 3, reply), scrap(OWNER, 'segunda', 4, reply)])
  const hidden = diary(OWNER, [...originals, scrapHideRecord({ from: ANA, seq: 1, at: T(5) })]).entries
  t.alike(foldWall({ owner: OWNER, ownerEntries: hidden, writers: [ana] }).scraps, [], 'the second reply does not take over')
  // The writer deleting the first reply frees the slot for the second.
  const deleted = { key: ANA, entries: [...ana.entries, { seq: 3, record: deleteRecord({ seq: 1, at: T(6) }) }] }
  t.alike(foldWall({ owner: OWNER, ownerEntries: hidden, writers: [deleted] }).scraps.map((s) => s.text), ['segunda'])
  // The same under a followed writer: the hidden one stays hidden, the other shows by following.
  const followed = foldWall({ owner: OWNER, ownerEntries: hidden, writers: [ana], follows: { [ANA]: true } })
  t.alike(followed.scraps.map((s) => s.text), ['segunda'])
})

test('a reply dated before its original is not admitted as a reply', (t) => {
  const ownerEntries = diary(OWNER, [scrap(ANA, 'oi ana', 10)]).entries
  const reply = { author: OWNER, seq: 1 }
  const early = diary(ANA, [scrap(OWNER, 'pre-escrita', 9, reply)])
  t.is(foldWall({ owner: OWNER, ownerEntries, writers: [early] }).scraps.length, 0)
  t.is(foldWall({ owner: OWNER, ownerEntries, writers: [early], follows: { [ANA]: true } }).scraps.length, 1, 'a followed writer is admitted anyway')
  // It does not take the slot: a later real reply is admitted.
  const both = diary(ANA, [scrap(OWNER, 'pre-escrita', 9, reply), scrap(OWNER, 'real', 11, reply)])
  t.alike(foldWall({ owner: OWNER, ownerEntries, writers: [both] }).scraps.map((s) => s.text), ['real'])
  // The same instant is admitted.
  const same = diary(ANA, [scrap(OWNER, 'no mesmo instante', 10, reply)])
  t.is(foldWall({ owner: OWNER, ownerEntries, writers: [same] }).scraps.length, 1)
})

test('future-dated scraps are dropped beyond the 24 h skew', (t) => {
  const now = Date.parse(T(0))
  const day = 86400000
  const ownerEntries = diary(OWNER, [wall('everyone')]).entries
  const at = (ms) => new Date(now + ms).toISOString()
  const writers = [diary(ANA, [
    scrapRecord({ to: OWNER, text: 'agora', at: at(0) }),
    scrapRecord({ to: OWNER, text: 'quase 24h', at: at(day) }),
    scrapRecord({ to: OWNER, text: 'depois de 24h', at: at(day + 1) }),
    scrapRecord({ to: OWNER, text: 'ano que vem', at: at(365 * day) })
  ])]
  t.alike(foldWall({ owner: OWNER, ownerEntries, writers, now }).scraps.map((s) => s.text), ['quase 24h', 'agora'])
  // Later on the clock they show.
  t.is(foldWall({ owner: OWNER, ownerEntries, writers, now: now + 2 * day }).scraps.length, 3)
  // Under following too, and a junk clock falls back to the real one.
  t.is(foldWall({ owner: OWNER, ownerEntries: [], writers, follows: { [ANA]: true }, now }).scraps.length, 2)
  t.is(foldWall({ owner: OWNER, ownerEntries, writers, now: 'x' }).scraps.length, 3, 'the real clock is 2026-11, past the 2026-06 test dates but not the far future')
})

test('a reply whose to is not the owner is refused', (t) => {
  const ownerEntries = diary(OWNER, [scrap(ANA, 'oi ana', 1)]).entries
  const reply = { author: OWNER, seq: 1 }
  const writers = [diary(ANA, [scrap(BIA, 'resposta na pagina errada', 3, reply)])]
  t.is(foldWall({ owner: OWNER, ownerEntries, writers }).scraps.length, 0)
  t.is(foldWall({ owner: OWNER, ownerEntries: [...ownerEntries, { seq: 2, record: wall('everyone') }], writers }).scraps.length, 0)
})
