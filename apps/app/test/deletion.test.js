'use strict'

// Pure deletion helpers (src/deletion.js): a leaf ES module with no imports.
const test = require('brittle')

const load = () => import('../src/deletion.js')

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const AVATAR = { core: 'c'.repeat(64), start: 0, blocks: 1 }

const profile = (seq, name = 'Ana', avatar, at = '2026-10-01T10:00:00.000Z', bio = '') => ({
  seq,
  record: avatar ? { type: 'profile', name, bio, at, avatar } : { type: 'profile', name, bio, at }
})

test('canDelete: only the own author', async (t) => {
  const d = await load()
  t.ok(d.canDelete({ author: A, seq: 3 }, A))
  t.not(d.canDelete({ author: B, seq: 3 }, A), 'a stranger')
  t.not(d.canDelete({ author: A, seq: 3 }, null), 'no identity')
  t.not(d.canDelete({ author: A, seq: 0 }, A), 'block 0')
  t.not(d.canDelete({ author: A }, A), 'no seq')
  t.not(d.canDelete(null, A))
})

test('deleteRef: a stranger original through a repost is never deletable', async (t) => {
  const d = await load()
  t.is(d.deleteRef({ author: A, seq: 4 }, A), A + ':4')
  const original = { author: B, seq: 9, repostedBy: { author: A } }
  t.is(d.deleteRef(original, A), null)
})

test('deletePostRows: hides the original and its reposts without moving the cursor', async (t) => {
  const d = await load()
  const row = (seq, record) => ({ seq, entry: { seq, record } })
  const rows = [
    row(9, { type: 'post', text: 'keep', quote: { author: A, seq: 4 } }),
    row(8, { type: 'repost', to: { author: A, seq: 4 }, on: true }),
    row(7, { type: 'repost', to: { author: B, seq: 4 }, on: true }),
    row(6, { type: 'repost', to: { author: A, seq: 5 }, on: true }),
    row(5, { type: 'repost', to: { author: A, seq: 4 }, on: false }),
    row(4, { type: 'post', text: 'deleted', media: [{ core: B }] }),
    { seq: 3, invalid: { seq: 3, reason: 'malformed' } },
    row(2, { type: 'repost', to: { author: A.toUpperCase(), seq: 4 }, on: true })
  ]
  const before = JSON.stringify(rows)
  const result = d.deletePostRows(rows, A + ':4', A)
  t.alike(result.filter((r) => r.entry).map((r) => r.seq), [9, 7, 6], 'keeps quotes and unrelated reposts')
  for (const seq of [8, 5, 4, 2]) {
    t.alike(result.find((r) => r.seq === seq), { seq, invalid: { seq, reason: 'deleted' } }, 'drops content at ' + seq)
  }
  t.alike(result.map((r) => r.seq), rows.map((r) => r.seq), 'all paging slots stay')
  t.is(result[0], rows[0], 'unchanged rows retain identity')
  t.is(result[6], rows[6], 'keeps existing invalid slots')
  t.is(JSON.stringify(rows), before, 'does not mutate the input')
  t.alike(d.deletePostRows(result, A + ':4', A), result, 'idempotent')
  t.alike(d.deletePostRows(rows, B + ':4', A).filter((r) => r.entry).map((r) => r.seq), [9, 8, 6, 5, 4, 2], 'same seq with another author keeps the own post')
})

test('profileVersions: a plain block with its avatar twin is one version', async (t) => {
  const d = await load()
  const v = d.profileVersions([profile(1), profile(2, 'Ana', AVATAR)])
  t.is(v.length, 1)
  t.is(v[0].seq, 1)
  t.alike(v[0].seqs, [1, 2])
  t.is(v[0].avatar, true)
})

test('profileVersions: newest first, any input order', async (t) => {
  const d = await load()
  const v = d.profileVersions([
    profile(5, 'Cris', null, '2026-10-03T10:00:00.000Z'),
    profile(1, 'Ana'),
    { seq: 3, record: { type: 'post', text: 'oi', at: '2026-10-02T10:00:00.000Z' } },
    profile(4, 'Beto', null, '2026-10-02T11:00:00.000Z')
  ])
  t.alike(v.map((x) => x.seq), [5, 4, 1])
  t.alike(v.map((x) => x.name), ['Cris', 'Beto', 'Ana'])
})

test('profileVersions: never group the other order or unequal fields', async (t) => {
  const d = await load()
  t.is(d.profileVersions([profile(1, 'Ana', AVATAR), profile(2, 'Ana')]).length, 2, 'avatar first')
  t.is(d.profileVersions([profile(1, 'Ana'), profile(2, 'Ana', AVATAR, '2026-10-02T10:00:00.000Z')]).length, 2, 'other at')
  t.is(d.profileVersions([profile(1, 'Ana'), profile(2, 'Bia', AVATAR)]).length, 2, 'other name')
  t.is(d.profileVersions([profile(1, 'Ana'), profile(3, 'Ana', AVATAR)]).length, 2, 'not adjacent')
  t.is(d.profileVersions([profile(1, 'Ana', AVATAR), profile(2, 'Ana', AVATAR)]).length, 2, 'both avatars')
})

test('profileVersions: tolerates junk', async (t) => {
  const d = await load()
  t.alike(d.profileVersions(null), [])
  t.alike(d.profileVersions([null, {}, { seq: 1 }, { seq: 'x', record: { type: 'profile' } }]), [])
})
