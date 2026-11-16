'use strict'

// Who voted for an option (src/ui/pollVoters.js): the pointed block counts only
// while no newer choice on the same poll follows it in the voter's diary.
const test = require('brittle')

const load = () => import('../src/ui/pollVoters.js')

const AUTHOR = 'aa'.repeat(32)
const V1 = 'b1'.repeat(32)
const V2 = 'b2'.repeat(32)
const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const choice = (seq, pick, at = iso(NOW - 60000), to = { author: AUTHOR, seq: 7 }) => ({ seq, record: { type: 'choice', to, pick, at } })
const peekOf = (key, entries) => ({ key, entries, profile: { name: 'Ana' }, username: 'ana' })
const map = (...peeks) => new Map(peeks.map((p) => [p.key, p]))

test('the tail read is bounded and starts at the pointed block', async (t) => {
  const { voterSeqs, TAIL_BLOCKS } = await load()
  t.alike(voterSeqs(5), [5, 6, 7, 8, 9, 10, 11, 12, 13])
  t.is(voterSeqs(5).length, TAIL_BLOCKS + 1)
  t.ok(voterSeqs(1).length <= 29, 'within PEEK_SEQS_MAX')
})

test('a voter whose pointed choice is still the last one is listed', async (t) => {
  const { confirmedVoters } = await load()
  const got = confirmedVoters([{ key: V1, seq: 3 }], map(peekOf(V1, [choice(3, 1)])), AUTHOR, 7, 1, NOW)
  t.alike(got, [{ key: V1, name: 'Ana', username: 'ana' }])
})

test('a later choice, a switch or a withdrawal, drops the row', async (t) => {
  const { confirmedVoters } = await load()
  const items = [{ key: V1, seq: 3 }]
  const switched = map(peekOf(V1, [choice(3, 1), choice(5, 0)]))
  t.alike(confirmedVoters(items, switched, AUTHOR, 7, 1, NOW), [], 'moved to another option')
  const withdrawn = map(peekOf(V1, [choice(3, 1), choice(6, null)]))
  t.alike(confirmedVoters(items, withdrawn, AUTHOR, 7, 1, NOW), [], 'withdrawn')
  const same = map(peekOf(V1, [choice(3, 1), choice(4, 1)]))
  t.alike(confirmedVoters(items, same, AUTHOR, 7, 1, NOW), [], 'a newer block of the same pick is the one the seeder should have named')
})

test('a later choice on another poll, or a later post, leaves the row', async (t) => {
  const { confirmedVoters } = await load()
  const other = choice(4, 0, iso(NOW - 1000), { author: AUTHOR, seq: 9 })
  const post = { seq: 5, record: { type: 'post', text: 'oi', at: iso(NOW - 1000), replyTo: null } }
  const got = confirmedVoters([{ key: V1, seq: 3 }], map(peekOf(V1, [choice(3, 1), other, post])), AUTHOR, 7, 1, NOW)
  t.is(got.length, 1)
})

test('a later choice dated in the future does not count yet, as the fold', async (t) => {
  const { confirmedVoters, MAX_FUTURE_MS } = await load()
  const items = [{ key: V1, seq: 3 }]
  t.is(MAX_FUTURE_MS, 86400000)
  const ahead = map(peekOf(V1, [choice(3, 1), choice(4, 0, iso(NOW + 2 * MAX_FUTURE_MS))]))
  t.is(confirmedVoters(items, ahead, AUTHOR, 7, 1, NOW).length, 1)
  const soon = map(peekOf(V1, [choice(3, 1), choice(4, 0, iso(NOW + MAX_FUTURE_MS - 1000))]))
  t.is(confirmedVoters(items, soon, AUTHOR, 7, 1, NOW).length, 0, 'inside the tolerance it counts')
})

test('a pointed choice dated in the future, missing or of another option is dropped', async (t) => {
  const { confirmedVoters, MAX_FUTURE_MS } = await load()
  const items = [{ key: V1, seq: 3 }, { key: V2, seq: 2 }]
  const future = peekOf(V1, [choice(3, 1, iso(NOW + 2 * MAX_FUTURE_MS))])
  t.alike(confirmedVoters(items, map(future), AUTHOR, 7, 1, NOW), [], 'future')
  t.alike(confirmedVoters(items, map(peekOf(V1, [choice(3, 0)])), AUTHOR, 7, 1, NOW), [], 'another option')
  t.alike(confirmedVoters(items, map(peekOf(V1, [])), AUTHOR, 7, 1, NOW), [], 'deleted or hidden: the peek holds no entry')
  t.alike(confirmedVoters(items, map(peekOf(V1, [choice(3, 1, 'não é data')])), AUTHOR, 7, 1, NOW), [], 'no valid date')
  t.alike(confirmedVoters(items, map(peekOf(V1, [choice(3, 1, iso(NOW - 1), { author: AUTHOR, seq: 8 })])), AUTHOR, 7, 1, NOW), [], 'another poll')
  t.alike(confirmedVoters(items, new Map(), AUTHOR, 7, 1, NOW), [], 'never peeked')
})

test('the module is pure and PollCard uses it', (t) => {
  const fs = require('fs')
  const path = require('path')
  const mod = fs.readFileSync(path.join(__dirname, '../src/ui/pollVoters.js'), 'utf8')
  t.absent(/\bimport\b[^\n]*from/.test(mod))
  t.absent(mod.includes('\u2014'))
  const card = fs.readFileSync(path.join(__dirname, '../src/ui/PollCard.js'), 'utf8')
  t.ok(card.includes('voterSeqs(it.seq)') && card.includes("from './pollVoters'"))
})
