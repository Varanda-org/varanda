'use strict'

const test = require('brittle')
const { MOMENT_SEEN_MAX, normalizeMomentSeen, markMomentSeen, mergeMomentSeen, momentSeenRefs, sameMomentSeen } = require('../lib/moment-seen')

const author = (i) => i.toString(16).padStart(64, 'a')
const entry = (i, t, seq = i + 1) => ({ author: author(i), seq, t })

test('normalize: valid entries once each with the newest t, oldest first, the newest kept at the cap', (t) => {
  t.is(MOMENT_SEEN_MAX, 132)
  t.alike(normalizeMomentSeen('x'), [])
  t.alike(normalizeMomentSeen([null, { author: 'x', seq: 1, t: 1 }, entry(1, 5, 0), entry(1, -1), entry(1, 1, 4294967296), entry(2, 3)]), [entry(2, 3)])
  t.alike(normalizeMomentSeen([entry(1, 9), entry(2, 3), entry(1, 4)]), [entry(2, 3), entry(1, 9)])
  const many = []
  for (let i = 0; i < MOMENT_SEEN_MAX + 3; i++) many.push(entry(i, 100 + i))
  const out = normalizeMomentSeen(many)
  t.is(out.length, MOMENT_SEEN_MAX)
  t.is(out[0].t, 103)
})

test('mark: a new moment is added, a repeated one changes nothing, a late clock never makes it the oldest at the cap', (t) => {
  const a = markMomentSeen([], { author: author(1), seq: 2 }, 50)
  t.is(a.changed, true)
  t.alike(a.entries, [entry(1, 50)])
  const again = markMomentSeen(a.entries, { author: author(1), seq: 2 }, 90)
  t.is(again.changed, false)
  t.alike(again.entries, [entry(1, 50)], 'keeps its first time')
  t.is(markMomentSeen([], { author: 'x', seq: 1 }, 1).changed, false)
  t.is(markMomentSeen([], { author: author(1), seq: 0 }, 1).changed, false)
  t.is(markMomentSeen([], { author: author(1), seq: 1 }, -1).changed, false)

  const full = []
  for (let i = 0; i < MOMENT_SEEN_MAX; i++) full.push(entry(i, 1000 + i))
  const late = markMomentSeen(full, { author: author(900), seq: 1 }, 10)
  t.is(late.changed, true)
  t.is(late.entries.length, MOMENT_SEEN_MAX)
  t.ok(late.entries.some((e) => e.author === author(900)), 'the new mark survives the cap')
})

test('merge: union with the newer t, commutative and idempotent; refs and sameMomentSeen ignore times', (t) => {
  const a = [entry(1, 10), entry(2, 5)]
  const b = [entry(1, 30), entry(3, 7)]
  const ab = mergeMomentSeen(a, b)
  t.alike(ab, mergeMomentSeen(b, a))
  t.alike(ab, [entry(2, 5), entry(3, 7), entry(1, 30)])
  t.alike(mergeMomentSeen(ab, b), ab)
  t.alike(momentSeenRefs(ab), [author(2) + ':3', author(3) + ':4', author(1) + ':2'])
  t.ok(sameMomentSeen([entry(1, 1)], [entry(1, 99)]))
  t.absent(sameMomentSeen([entry(1, 1)], [entry(1, 1), entry(2, 1)]))
})
