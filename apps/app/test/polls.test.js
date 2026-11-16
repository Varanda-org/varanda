'use strict'

// Pure poll model (polls.js): the editor, the card, the honesty flags.
const test = require('brittle')

const load = () => import('../src/polls.js')

test('pollOf accepts 2..4 distinct trimmed options of 1..60 characters', async (t) => {
  const { pollOf } = await load()
  t.alike(pollOf({ options: ['a', 'b'] }), { options: ['a', 'b'] })
  t.alike(pollOf({ options: ['a', 'b', 'c', 'd'] }), { options: ['a', 'b', 'c', 'd'] })
  t.is(pollOf({ options: ['a'] }), null, 'one option')
  t.is(pollOf({ options: ['a', 'b', 'c', 'd', 'e'] }), null, 'five options')
  t.is(pollOf({ options: ['a', 'a'] }), null, 'duplicate')
  t.is(pollOf({ options: ['a', ''] }), null, 'empty')
  t.alike(pollOf({ options: ['a', ' b '] }), { options: ['a', ' b '] }, 'peer options are not required to be trimmed')
  t.is(pollOf({ options: ['a', '  '] }), null, 'blank')
  t.is(pollOf({ options: ['a', ' a'] }), null, 'duplicate after trim')
  t.ok(pollOf({ options: ['a', '\u{1f600}'.repeat(60)] }), '60 code points of 2 units each')
  t.is(pollOf({ options: ['a', '\u{1f600}'.repeat(61)] }), null, '61 code points')
  t.is(pollOf({ options: ['a', 'x'.repeat(61)] }), null, 'too long')
  t.ok(pollOf({ options: ['a', 'x'.repeat(60)] }))
  t.is(pollOf({ options: ['a', 'b'], extra: 1 }), null, 'extra key')
  t.is(pollOf({ options: ['a', 3] }), null)
  t.is(pollOf(null), null)
})

test('options that look the same are one option twice, as the contract says', async (t) => {
  const p = await load()
  for (const [a, b, name] of [
    ['Sim', 'Sim\u200b', 'a trailing zero-width space'],
    ['Sim', '\u200bSim', 'a leading zero-width space'],
    ['Sim', 'S\u00adim', 'a soft hyphen inside'],
    ['Sim agora', 'Sim  agora', 'a run of spaces inside'],
    ['Sim', '\uff33\uff49\uff4d', 'fullwidth letters'],
    ['Não', 'Na\u0303o', 'a decomposed accent']
  ]) {
    t.is(p.pollOf([a, b]), null, 'pollOf: ' + name)
    const s = p.editorSetOption(p.editorSetOption(p.editorInit(), 0, a), 1, b)
    t.is(p.editorPoll(s).error, p.NOTICES.duplicate, 'editor: ' + name)
  }
  t.is(p.pollOf(['a', '\u200b\u00ad']), null, 'an invisible-only option')
  t.is(p.editorPoll(p.editorSetOption(p.editorSetOption(p.editorInit(), 0, 'a'), 1, '\u200b')).error, p.NOTICES.emptyOption)
  t.alike(p.pollOf(['Sim', 'Sim!']), { options: ['Sim', 'Sim!'] }, 'different text stays distinct')
  const rpc = require('@varanda/rpc')
  for (const v of ['Sim', ' S\u00adim\u200b  agora ', '\uff33im', 'Na\u0303o', 'a\udb40\udc41b']) t.is(p.pollKey(v), rpc.poll.pollKey(v), 'pollKey in step with the contract: ' + JSON.stringify(v))
})

test('pollOf takes the real contract shapes', async (t) => {
  const { pollOf } = await load()
  t.alike(pollOf(['Sim', 'Não']), { options: ['Sim', 'Não'] }, 'bare array of a poll post')
  t.alike(pollOf({ options: ['Sim', 'Não'], totals: [3, 1], mine: null }), { options: ['Sim', 'Não'] }, 'group.topics summary, totals and mine ignored')
  t.alike(pollOf({ options: ['Sim', 'Não'], totals: [3, 1], mine: 1 }), { options: ['Sim', 'Não'] })
  t.is(pollOf(['a']), null)
  t.is(pollOf(['a', 'a']), null)
  t.is(pollOf({ options: ['a', 'b'], totals: [1, 2], mine: 0, extra: 1 }), null)
  t.is(pollOf('ab'), null)
  t.is(pollOf(undefined), null)
})

test('the editor adds and removes within 2..4 and builds a trimmed poll', async (t) => {
  const p = await load()
  let s = p.editorInit()
  t.is(s.options.length, 2)
  t.absent(p.editorCanRemove(s))
  t.is(p.editorRemoveOption(s, 0), s, 'never below two')
  t.is(p.editorPoll(s).error, p.NOTICES.emptyOption)
  s = p.editorSetOption(s, 0, '  Sim ')
  s = p.editorSetOption(s, 1, 'Não')
  t.alike(p.editorPoll(s), { ok: true, poll: { options: ['Sim', 'Não'] } })
  s = p.editorAddOption(p.editorAddOption(s))
  t.is(s.options.length, 4)
  t.absent(p.editorCanAdd(s))
  t.is(p.editorAddOption(s), s, 'never above four')
  s = p.editorSetOption(s, 2, 'Talvez')
  s = p.editorSetOption(s, 3, ' Sim')
  t.is(p.editorPoll(s).error, p.NOTICES.duplicate, 'distinct after trim')
  s = p.editorRemoveOption(s, 3)
  t.is(s.options.length, 3)
  t.is(p.editorPoll(p.editorSetOption(s, 0, 'x'.repeat(61))).error, p.NOTICES.tooLong)
  t.ok(p.editorPoll(p.editorSetOption(s, 0, '\u{1f600}'.repeat(60))).ok, 'counted in code points')
  t.is(p.editorPoll(p.editorSetOption(s, 0, '\u{1f600}'.repeat(61))).error, p.NOTICES.tooLong)
  t.is(p.editorSetOption(s, 9, 'z'), s, 'bad index changes nothing')
})

test('the card carries totals as a claim, the own pick and the public vote notice', async (t) => {
  const { pollCard, NOTICES } = await load()
  const poll = { options: ['Sim', 'Não', 'Talvez'] }
  const c = pollCard({ poll, totals: { counts: [3, 1, 0], complete: true }, own: undefined })
  t.is(c.total, 4)
  t.is(c.totalLabel, '4 votos')
  t.alike(c.options.map((o) => o.percent), [75, 25, 0])
  t.is(c.options[1].countLabel, '1 voto')
  t.ok(c.claimed, 'totals are a seeder claim')
  t.absent(c.incomplete)
  t.absent(c.ownKnown)
  t.is(c.notice, NOTICES.publicVote, 'notice before the first vote')
  const v = pollCard({ poll, totals: { counts: [3, 1, 0] }, own: 1 })
  t.is(v.own, 1)
  t.ok(v.options[1].own)
  t.is(v.notice, null, 'no notice after voting')
  t.ok(v.incomplete, 'incomplete unless the seeder says complete')
  const none = pollCard({ poll, totals: null, own: null })
  t.is(none.total, null)
  t.is(none.totalsNote, NOTICES.noTotals)
  t.ok(none.incomplete)
  t.is(pollCard({ poll, totals: { counts: [1, 2] } }).claimed, false, 'wrong length is no claim')
  t.is(pollCard({ poll, totals: { counts: [1, -2, 3] } }).claimed, false, 'bad count is no claim')
  t.is(pollCard({ poll, own: 7 }).own, null, 'out of range pick')
  t.is(pollCard({ poll: { options: ['a'] } }), null, 'invalid poll')
  t.is(pollCard({ poll, totals: { counts: [0, 0, 0] } }).options[0].percent, 0)
})

test('the card reads the real totals and poll shapes', async (t) => {
  const { pollCard } = await load()
  const summary = { options: ['Sim', 'Não'], totals: [2, 2], mine: 1 }
  const fromTopics = pollCard({ poll: summary, totals: summary.totals, own: summary.mine })
  t.alike(fromTopics.options.map((o) => o.count), [2, 2])
  t.alike(fromTopics.options.map((o) => o.percent), [50, 50])
  t.is(fromTopics.own, 1)
  t.ok(fromTopics.incomplete, 'a bare array does not say it is complete')
  const done = pollCard({ poll: ['Sim', 'Não'], totals: { totals: [1, 3], indexing: false, complete: true } })
  t.is(done.total, 4)
  t.absent(done.incomplete)
  const indexing = pollCard({ poll: ['Sim', 'Não'], totals: { totals: [], indexing: true, complete: false } })
  t.is(indexing.claimed, false, 'no counts while the seeder indexes')
  t.ok(indexing.incomplete)
  const half = pollCard({ poll: ['Sim', 'Não'], totals: { totals: [1, 3], indexing: true, complete: true } })
  t.ok(half.incomplete, 'indexing wins over complete')
  t.is(pollCard({ poll: ['Sim', 'Não'], totals: [1, 2, 3] }).claimed, false, 'wrong length')
  t.is(pollCard({ poll: ['Sim', 'Não'], totals: [1, -2] }).claimed, false, 'bad count')
})

test('nextPick writes a pick, takes it back on a second tap and never guesses', async (t) => {
  const { pollCard, nextPick } = await load()
  const poll = { options: ['a', 'b'] }
  t.alike(nextPick(pollCard({ poll, own: null }), 1), { write: true, pick: 1 })
  t.alike(nextPick(pollCard({ poll, own: 1 }), 1), { write: true, pick: null })
  t.alike(nextPick(pollCard({ poll, own: 0 }), 1), { write: true, pick: 1 })
  t.alike(nextPick(pollCard({ poll }), 1), { write: false }, 'own pick not read yet')
  t.alike(nextPick(pollCard({ poll, own: null }), 5), { write: false })
})

test('the module is pure and has no em dash or method names', async (t) => {
  const fs = require('fs')
  const src = fs.readFileSync(require('path').join(__dirname, '../src/polls.js'), 'utf8')
  t.absent(/\bimport\b[^\n]*from/.test(src), 'no imports')
  t.absent(src.includes('\u2014'))
  t.absent(/'(poll|group|diary)\.[a-z]+'/.test(src))
})
