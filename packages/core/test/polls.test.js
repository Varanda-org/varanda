'use strict'

const test = require('brittle')
const { pollOptions, foldPicks, livePick, tallyPoll } = require('../lib/polls')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const AUTHOR = 'd'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'
const POLL = { author: AUTHOR, seq: 5 }

const choice = (pick, to = POLL) => ({ type: 'choice', to: { author: to.author, seq: to.seq }, pick, at: AT })
const del = (seq) => ({ type: 'delete', seq, at: AT })

test('pollOptions: the options of a valid poll post, else null', (t) => {
  const post = { type: 'post', text: 'Vamos?', at: AT, replyTo: null, poll: ['Sim', 'Não'] }
  t.alike(pollOptions(post), ['Sim', 'Não'])
  const options = pollOptions(post)
  options.push('x')
  t.alike(post.poll, ['Sim', 'Não'], 'a fresh array')
  t.is(pollOptions({ type: 'post', text: 'oi', at: AT, replyTo: null }), null, 'a plain post')
  t.is(pollOptions({ ...post, poll: ['a'] }), null, 'an invalid poll')
  t.is(pollOptions(choice(0)), null, 'another type')
  for (const bad of [null, undefined, 5, 'post', []]) t.is(pollOptions(bad), null, String(bad))
})

test('foldPicks: one live pick per voter, null withdraws, out-of-range ignored', (t) => {
  const r = foldPicks([
    { voter: A, pick: 0 },
    { voter: B, pick: 1 },
    { voter: A, pick: 1 }, // revote
    { voter: C, pick: 2 }, // out of range for two options: ignored
    { voter: C, pick: 0 },
    { voter: C, pick: 3 }, // ignored, the earlier pick stays
    { voter: B, pick: null } // withdrawn
  ], 2)
  t.alike(r.totals, [1, 1])
  t.alike([...r.picks.entries()].sort(), [[A, 1], [C, 0]])
  t.alike(foldPicks([], 4).totals, [0, 0, 0, 0])
  t.alike(foldPicks([{ voter: A, pick: null }], 3).totals, [0, 0, 0], 'withdrawing without a vote is a no-op')
  t.alike(foldPicks([{ voter: A, pick: 1 }, { voter: A, pick: null }, { voter: A, pick: 0 }], 2).totals, [1, 0], 'vote again after a withdraw')
})

test('foldPicks: hostile ops and counts never throw', (t) => {
  const hostile = {}
  Object.defineProperty(hostile, 'voter', { get () { throw new Error('boom') } })
  const r = foldPicks([null, 5, hostile, { voter: 'x', pick: 0 }, { voter: A.toUpperCase(), pick: 0 }, { voter: A, pick: '0' }, { voter: A, pick: 0.5 }, { voter: A, pick: -1 }, { voter: A }, { voter: B, pick: 1 }], 2)
  t.alike(r.totals, [0, 1])
  t.is(r.picks.size, 1)
  for (const count of [0, 5, -1, 1.5, '2', null]) t.alike(foldPicks([{ voter: A, pick: 0 }], count).totals, [], 'count ' + String(count))
  t.alike(foldPicks(null, 2).totals, [0, 0])
  t.alike(foldPicks('ops', 2).totals, [0, 0])
})

test('livePick: the last live choice of one diary on one poll', (t) => {
  const entries = [
    { seq: 1, record: choice(0) },
    { seq: 2, record: choice(3, { author: AUTHOR, seq: 6 }) }, // another poll
    { seq: 3, record: choice(1) }
  ]
  t.alike(livePick({ entries, poll: POLL, count: 2 }), { pick: 1, seq: 3, at: AT })
  t.alike(livePick({ entries, poll: { author: AUTHOR, seq: 6 }, count: 4 }), { pick: 3, seq: 2, at: AT })
  t.is(livePick({ entries, poll: { author: AUTHOR, seq: 7 }, count: 2 }), null, 'never voted')
  t.alike(livePick({ entries: [...entries].reverse(), poll: POLL, count: 2 }), { pick: 1, seq: 3, at: AT }, 'block order, not entry order')
})

test('livePick: withdraw, out-of-range, deletes and invalid records', (t) => {
  t.is(livePick({ entries: [{ seq: 1, record: choice(1) }, { seq: 2, record: choice(null) }], poll: POLL, count: 2 }), null, 'withdrawn')
  t.alike(livePick({ entries: [{ seq: 1, record: choice(1) }, { seq: 2, record: choice(3) }], poll: POLL, count: 2 }), { pick: 1, seq: 1, at: AT }, 'an out-of-range pick is ignored')
  t.alike(livePick({ entries: [{ seq: 1, record: choice(0) }, { seq: 2, record: choice(1) }, { seq: 3, record: del(2) }], poll: POLL, count: 2 }), { pick: 0, seq: 1, at: AT }, 'a deleted choice is no choice')
  t.is(livePick({ entries: [{ seq: 1, record: choice(0) }, { seq: 2, record: del(1) }], poll: POLL, count: 2 }), null, 'the only choice deleted')
  t.alike(livePick({ entries: [{ seq: 1, record: choice(0) }, { seq: 2, record: { ...choice(1), extra: 1 } }], poll: POLL, count: 2 }), { pick: 0, seq: 1, at: AT }, 'an invalid record is skipped')
  t.alike(livePick({ entries: [{ seq: 1, record: choice(0) }, { seq: 1, record: choice(1) }], poll: POLL, count: 2 }), { pick: 0, seq: 1, at: AT }, 'a repeated seq counts once')
  t.is(livePick({ entries: [{ seq: 0, record: choice(0) }], poll: POLL, count: 2 }), null, 'seq 0 is the certificate')
  for (const poll of [null, {}, { author: 'x', seq: 5 }, { author: AUTHOR, seq: 0 }, AUTHOR + ':5']) {
    t.is(livePick({ entries: [{ seq: 1, record: choice(0) }], poll, count: 2 }), null, 'poll ' + JSON.stringify(poll))
  }
  for (const count of [0, 5, undefined]) t.is(livePick({ entries: [{ seq: 1, record: choice(0) }], poll: POLL, count }), null, 'count ' + count)
  t.is(livePick({ entries: null, poll: POLL, count: 2 }), null)
  t.is(livePick(), null)
})

test('livePick and tallyPoll: a choice dated more than a day ahead counts from its date', (t) => {
  const now = Date.parse(AT)
  const ahead = new Date(now + 86400001).toISOString()
  const edge = new Date(now + 86400000).toISOString()
  const entries = [{ seq: 1, record: choice(0) }, { seq: 2, record: { ...choice(1), at: ahead } }]
  t.alike(livePick({ entries, poll: POLL, count: 2, now }), { pick: 0, seq: 1, at: AT }, 'the earlier pick stays')
  t.is(livePick({ entries: entries.slice(1), poll: POLL, count: 2, now }), null, 'a lone future choice is no vote')
  t.alike(livePick({ entries, poll: POLL, count: 2, now: now + 1 }), { pick: 1, seq: 2, at: ahead }, 'counts once the clock is within a day')
  t.alike(livePick({ entries: [{ seq: 1, record: { ...choice(1), at: edge } }], poll: POLL, count: 2, now }), { pick: 1, seq: 1, at: edge }, 'exactly a day ahead counts')
  const withdraw = [{ seq: 1, record: choice(1) }, { seq: 2, record: { ...choice(null), at: ahead } }]
  t.alike(livePick({ entries: withdraw, poll: POLL, count: 2, now }), { pick: 1, seq: 1, at: AT }, 'a future withdraw waits too')
  t.alike(tallyPoll({ poll: POLL, count: 2, now, voters: [{ voter: A, entries }, { voter: B, entries: entries.slice(1) }] }).totals, [1, 0])
  t.alike(tallyPoll({ poll: POLL, count: 2, now: now + 1, voters: [{ voter: A, entries }, { voter: B, entries: entries.slice(1) }] }).totals, [0, 2])
  t.alike(livePick({ entries, poll: POLL, count: 2 }), { pick: 1, seq: 2, at: ahead }, 'defaults to the real clock (AT is long past)')
})

test('tallyPoll: totals and live picks over voter diaries', (t) => {
  const voters = [
    { voter: A, entries: [{ seq: 1, record: choice(0) }, { seq: 2, record: choice(2) }] },
    { voter: B, entries: [{ seq: 4, record: choice(2) }, { seq: 9, record: choice(null) }] },
    { voter: C, entries: [{ seq: 1, record: choice(1) }, { seq: 2, record: choice(7) }] },
    { voter: AUTHOR, entries: [{ seq: 6, record: choice(2) }] }, // the author votes too
    { voter: A, entries: [{ seq: 1, record: choice(1) }] } // listed twice: the first listing counts
  ]
  const r = tallyPoll({ poll: POLL, count: 3, voters })
  t.alike(r.totals, [0, 1, 2])
  t.is(r.picks.get(A), 2)
  t.is(r.picks.get(C), 1)
  t.is(r.picks.get(AUTHOR), 2)
  t.absent(r.picks.has(B), 'withdrawn')
  t.alike(tallyPoll({ poll: POLL, count: 2, voters }).totals, [1, 1], 'a pick out of a two-option poll is ignored, the earlier one stays')
  t.alike(tallyPoll({ poll: POLL, count: 2, voters: [null, 5, { voter: 'x', entries: [] }] }).totals, [0, 0])
  t.alike(tallyPoll({ poll: POLL, count: 9, voters }).totals, [])
  t.alike(tallyPoll().totals, [])
})
