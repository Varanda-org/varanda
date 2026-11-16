'use strict'

// The perfil rico pointers of the seeder's engagement index (profileExtra()):
// the newest live profile-about and mood seq of an author, deletion falling
// back to the previous block, purge, and no effect on the other hints. The
// answer is an open object, so keys are asserted by name only. No network.
const test = require('brittle')
const { createEngagementIndex } = require('../lib/engagement-index')
const { profileAboutRecord, moodRecord, profileRecord, validRecordCopy } = require('../lib/records')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const at = (i) => new Date(Date.UTC(2026, 2, 1, 12, 0, i)).toISOString()

function add (ix, author, seq, record, opts = null) {
  return ix.add(author, seq, validRecordCopy(record, seq), opts)
}

test('profileExtra: null pointers for an unknown author and for one without blocks', (t) => {
  const ix = createEngagementIndex()
  t.is(ix.profileExtra(A).about, null)
  t.is(ix.profileExtra(A).mood, null)
  t.is(ix.profileExtra(undefined).about, null, 'a malformed key is total')
  add(ix, A, 1, profileRecord({ name: 'Ana', at: at(1) }))
  const got = ix.profileExtra(A)
  t.is(got.about, null)
  t.is(got.mood, null)
  t.is(ix.hints(A).profileSeq, 1, 'the profile hint is untouched')
})

test('profileExtra: the newest live block of each type wins, older or equal seqs never override', (t) => {
  const ix = createEngagementIndex()
  t.ok(add(ix, A, 1, profileAboutRecord({ about: 'um', at: at(1) })))
  t.ok(add(ix, A, 2, moodRecord({ emoji: '🙂', text: 'bem', at: at(2) })))
  t.ok(add(ix, A, 3, profileAboutRecord({ about: 'dois', at: at(3) })))
  t.ok(add(ix, A, 4, moodRecord({ emoji: '🎉', text: '', at: at(4) })))
  t.is(ix.profileExtra(A).about, 3)
  t.is(ix.profileExtra(A).mood, 4)
  t.ok(add(ix, A, 3, profileAboutRecord({ about: 'dois', at: at(3) })), 'a re-add is a no-op')
  t.is(ix.profileExtra(A).about, 3)
  t.is(ix.profileExtra(B).about, null, 'another author is unaffected')
  t.is(ix.stats().records, 4, 'each block holds one record slot, once')
})

test('profileExtra: a seq arriving out of order still leaves the highest as the pointer', (t) => {
  const ix = createEngagementIndex()
  add(ix, A, 5, profileAboutRecord({ about: 'cinco', at: at(5) }))
  add(ix, A, 2, profileAboutRecord({ about: 'dois', at: at(2) }))
  t.is(ix.profileExtra(A).about, 5)
})

test('profileExtra: deleting the newest block falls back to the previous live one, then to null', (t) => {
  const ix = createEngagementIndex()
  add(ix, A, 1, profileAboutRecord({ about: 'um', at: at(1) }))
  add(ix, A, 2, moodRecord({ emoji: '🙂', text: 'a', at: at(2) }))
  add(ix, A, 3, profileAboutRecord({ about: 'tres', at: at(3) }))
  add(ix, A, 4, moodRecord({ emoji: '🎉', text: 'b', at: at(4) }))
  t.ok(ix.removeRecord(A, 3))
  t.is(ix.profileExtra(A).about, 1, 'about falls back')
  t.is(ix.profileExtra(A).mood, 4, 'mood untouched')
  t.ok(ix.removeRecord(A, 4))
  t.is(ix.profileExtra(A).mood, 2)
  t.ok(ix.removeRecord(A, 1))
  t.ok(ix.removeRecord(A, 2))
  t.is(ix.profileExtra(A).about, null)
  t.is(ix.profileExtra(A).mood, null)
  t.is(ix.stats().records, 0, 'every slot was released')
  t.ok(add(ix, A, 3, profileAboutRecord({ about: 'tres', at: at(3) })), 'a tombstoned seq is not resurrected')
  t.is(ix.profileExtra(A).about, null)
})

test('profileExtra: a tombstone scanned before the block keeps it out (deletes first)', (t) => {
  const ix = createEngagementIndex()
  ix.removeRecord(A, 2)
  add(ix, A, 1, profileAboutRecord({ about: 'um', at: at(1) }))
  add(ix, A, 2, profileAboutRecord({ about: 'dois', at: at(2) }))
  add(ix, A, 3, moodRecord({ emoji: '🙂', text: '', at: at(3) }))
  t.is(ix.profileExtra(A).about, 1)
  t.is(ix.profileExtra(A).mood, 3)
})

test('profileExtra: profile.extra.delete tombstones every version in one append, so nothing falls back', (t) => {
  const ix = createEngagementIndex()
  add(ix, A, 1, profileAboutRecord({ about: 'um', at: at(1) }))
  add(ix, A, 2, moodRecord({ emoji: '🙂', text: 'a', at: at(2) }))
  add(ix, A, 3, profileAboutRecord({ about: 'tres', at: at(3) }))
  add(ix, A, 4, profileAboutRecord({ about: 'quatro', at: at(4) }))
  // The seeder applies the tombstones of blocks 5, 6 and 7 one by one.
  for (const seq of [1, 3, 4]) t.ok(ix.removeRecord(A, seq))
  t.is(ix.profileExtra(A).about, null, 'no older version comes back')
  t.is(ix.profileExtra(A).mood, 2, 'the other type is untouched')
  t.is(ix.stats().records, 1, 'the three slots were released')
})

test('profileExtra: removeDiary purges the pointers and frees the slots', (t) => {
  const ix = createEngagementIndex()
  add(ix, A, 1, profileAboutRecord({ about: 'um', at: at(1) }))
  add(ix, A, 2, moodRecord({ emoji: '🙂', text: 'a', at: at(2) }))
  add(ix, B, 1, profileAboutRecord({ about: 'b', at: at(1) }))
  ix.removeDiary(A)
  t.is(ix.profileExtra(A).about, null)
  t.is(ix.profileExtra(A).mood, null)
  t.is(ix.profileExtra(B).about, 1, 'another diary stays')
  t.is(ix.stats().records, 1)
  ix.clear()
  t.is(ix.profileExtra(B).about, null)
})

test('profileExtra: the answer carries the about and mood keys by name (later features add more)', (t) => {
  const ix = createEngagementIndex()
  const got = ix.profileExtra(A)
  t.ok('about' in got)
  t.ok('mood' in got)
})

test('profileExtra: a record refused at the per-author cap leaves no pointer', (t) => {
  const ix = createEngagementIndex({ perAuthorMax: 1 })
  t.ok(add(ix, A, 1, profileAboutRecord({ about: 'um', at: at(1) })))
  t.absent(add(ix, A, 2, moodRecord({ emoji: '🙂', text: 'a', at: at(2) })), 'refused: the cursor pauses')
  t.is(ix.profileExtra(A).about, 1)
  t.is(ix.profileExtra(A).mood, null)
})
