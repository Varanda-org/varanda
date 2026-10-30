const test = require('brittle')
const { createGroupIndex } = require('../lib/group-index')
const { groupHeader } = require('../lib/group')

const k = (c) => c.repeat(64)
const G1 = k('1')
const G2 = k('2')
const D1 = k('a')
const D2 = k('b')

function header (name, visibility = 'public') {
  return visibility === 'public'
    ? groupHeader({ diary: D1, name })
    : groupHeader({ diary: D1, visibility: 'private', join: 'approval', name: null, box: k('e') })
}

test('writers per group, groups per diary, left, removals', (t) => {
  const idx = createGroupIndex()
  t.ok(idx.addWriter(G1, G1, D1, 1))
  t.ok(idx.addWriter(G1, k('3'), D2, 4))
  t.ok(idx.addWriter(G2, k('4'), D2, 5))
  t.absent(idx.addWriter(G2, k('3'), D2, 6), 'a writer never moves to another group')
  t.absent(idx.addWriter(G1, k('3'), D1, 6), 'nor to another diary')
  t.absent(idx.addWriter(G1, 'x', D1, 1))
  t.absent(idx.addWriter(G1, k('5'), D1, 0), 'seq 0 is the certificate')

  t.alike(idx.page(G1, null, 64).items.map((i) => [i.key, i.diary, i.seq]), [[G1, D1, 1], [k('3'), D2, 4]])
  t.alike(idx.groupsOf(D2), [
    { group: G1, writer: k('3'), seq: 4, left: false },
    { group: G2, writer: k('4'), seq: 5, left: false }
  ])

  t.ok(idx.setLeft(k('3'), true))
  t.is(idx.page(G1).items[1].left, true, 'a writer that left stays listed')
  t.ok(idx.addWriter(G1, k('3'), D2, 7), 'a new live join clears left')
  t.alike(idx.groupsOf(D2)[0], { group: G1, writer: k('3'), seq: 7, left: false })

  t.ok(idx.removeDiary(D2))
  t.alike(idx.groupsOf(D2), [])
  t.alike(idx.page(G1).items.map((i) => i.key), [G1])
  t.is(idx.stats().groups, 1, 'an empty group without header is forgotten')
  t.ok(idx.removeWriter(G1))
  t.is(idx.stats().groups, 0)
  t.absent(idx.removeWriter(G1))
})

test('pages: ascending keys, exclusive cursor, next, visibility and lengths', (t) => {
  const idx = createGroupIndex()
  const keys = []
  for (let i = 0; i < 10; i++) {
    const key = i.toString(16).padStart(2, '0').repeat(32)
    keys.push(key)
    idx.addWriter(G1, key, i % 2 ? D2 : D1, i + 1)
  }
  const p1 = idx.page(G1, null, 4, { lengthOf: (w) => w === keys[0] ? 9 : 0 })
  t.alike(p1.items.map((i) => i.key), keys.slice(0, 4))
  t.is(p1.items[0].length, 9)
  t.is(p1.items[0].signed, 9, 'signed never below length')
  const signed = idx.page(G1, null, 2, { lengthOf: () => 3, signedOf: (w) => w === keys[0] ? 7 : 1 })
  t.alike(signed.items.map((i) => [i.length, i.signed]), [[3, 7], [3, 3]], 'signed length next to the contiguous one')
  t.is(idx.page(G1, null, 1, { signedOf: () => { throw new Error('x') } }).items[0].signed, 0, 'a throwing signedOf answers 0')
  t.is(p1.next, keys[3])
  const p2 = idx.page(G1, p1.next, 4)
  t.alike(p2.items.map((i) => i.key), keys.slice(4, 8))
  const p3 = idx.page(G1, p2.next, 4)
  t.alike(p3.items.map((i) => i.key), keys.slice(8))
  t.is(p3.next, null)
  const visible = idx.page(G1, null, 64, { visible: (diary) => diary === D1 })
  t.alike(visible.items.map((i) => i.key), keys.filter((_, i) => i % 2 === 0))
  t.alike(idx.page(G1, null, 64, { visible: () => { throw new Error('x') } }).items, [], 'a throwing filter hides')
  t.alike(idx.page(G2), { items: [], next: null })
  t.is(idx.page('zz'), null)
  t.is(idx.page(G1, 'zz'), null)
  t.is(idx.page(G1, null, 1000).items.length, 10, 'limit clamped to 64')
})

test('caps: groups and writers per group refuse new entries only', (t) => {
  const idx = createGroupIndex({ maxGroups: 2, maxWritersPerGroup: 2 })
  t.ok(idx.addWriter(G1, k('3'), D1, 1))
  t.ok(idx.addWriter(G1, k('4'), D1, 2))
  t.absent(idx.addWriter(G1, k('5'), D1, 3), 'group full')
  t.ok(idx.addWriter(G1, k('4'), D1, 9), 'an existing writer updates')
  t.ok(idx.addWriter(G2, k('6'), D2, 1))
  t.absent(idx.addWriter(k('7'), k('8'), D2, 1), 'index full')
  t.absent(idx.setHeader(k('7'), header('nova')), 'a header of a new group too')
  t.ok(idx.setHeader(G1, header('praia')))
  t.is(idx.stats().saturated, true)
  t.is(idx.stats().writers, 3)
  idx.removeGroup(G2)
  t.ok(idx.addWriter(k('7'), k('8'), D2, 1), 'room again after a removal')
})

test('search: public names only, rank, member count, key order, at most 20', (t) => {
  const idx = createGroupIndex()
  const exact = k('c')
  const prefix = k('d')
  const popular = k('f')
  idx.setHeader(exact, header('Cadeiras'))
  idx.setHeader(prefix, header('Cadeiras da praia'))
  idx.setHeader(popular, header('Cadeiras de praia'))
  idx.setHeader(k('9'), header(null, 'private'))
  idx.addWriter(popular, k('3'), D1, 1)
  idx.addWriter(popular, k('4'), D2, 1)
  idx.addWriter(prefix, k('5'), D1, 1)
  const r = idx.search('cadeiras')
  t.alike(r.groups, [
    { group: exact, name: 'Cadeiras', members: 0 },
    { group: popular, name: 'Cadeiras de praia', members: 2 },
    { group: prefix, name: 'Cadeiras da praia', members: 1 }
  ], 'each hit carries the display name as the header wrote it')
  t.is(r.more, false)
  t.alike(idx.search('cad-pra').groups.map((g) => g.group), [popular, prefix])
  t.alike(idx.search('cadeiras', (g) => g !== popular).groups.map((g) => g.group), [exact, prefix])
  idx.setLeft(k('4'), true)
  t.is(idx.search('cadeiras').groups[1].members, 1, 'a writer that left is not a member')
  t.is(idx.search('a'), null, 'malformed segment')
  t.is(idx.search(42), null)

  const many = createGroupIndex()
  for (let i = 0; i < 25; i++) many.setHeader(i.toString(16).padStart(2, '0').repeat(32), header('roda ' + i))
  const page = many.search('roda')
  t.is(page.groups.length, 20)
  t.is(page.more, true)
  t.is(page.groups[0].group, '00'.repeat(32), 'ties by key')

  idx.setHeader(exact, null)
  t.absent(idx.search('cadeiras').groups.some((g) => g.group === exact), 'a forgotten header leaves search')
})

test('header: a public root keeps its display name, a private one none', (t) => {
  const idx = createGroupIndex()
  t.ok(idx.setHeader(G1, header('Cadeiras da Praia')))
  t.alike(idx.header(G1), { kind: 'group', visibility: 'public', join: 'open', diary: D1, name: 'Cadeiras da Praia' })
  t.ok(idx.setHeader(G2, header(null, 'private')))
  t.is(idx.header(G2).name, null)
  t.alike(idx.search('cadeiras').groups, [{ group: G1, name: 'Cadeiras da Praia', members: 0 }])
})

test('groupsOf: one row per group, the newest live join, left only when every writer left', (t) => {
  const idx = createGroupIndex()
  // D1 joined G1 from many devices (one writer each).
  let added = 0
  for (let i = 1; i <= 300; i++) if (idx.addWriter(G1, i.toString(16).padStart(64, '0'), D1, i * 2)) added++
  t.is(added, 300)
  idx.addWriter(G2, k('3'), D1, 5)
  idx.addWriter(G2, k('4'), D1, 9)
  const newest = (300).toString(16).padStart(64, '0')
  t.alike(idx.groupsOf(D1), [
    { group: G1, writer: newest, seq: 600, left: false },
    { group: G2, writer: k('4'), seq: 9, left: false }
  ])
  idx.setLeft(k('4'), true)
  t.alike(idx.groupsOf(D1)[1], { group: G2, writer: k('3'), seq: 5, left: false }, 'a live join wins over a newer one that left')
  idx.setLeft(k('3'), true)
  t.alike(idx.groupsOf(D1)[1], { group: G2, writer: k('4'), seq: 9, left: true }, 'left only when every writer left')
  t.alike(idx.groupsOf(D1, (group, writer) => writer !== newest)[0].seq, 598, 'the filter applies before the choice')
  t.alike(idx.groupsOf(D1, (group) => group !== G1).map((g) => g.group), [G2])
  t.alike(idx.groupsOf(D1, () => { throw new Error('x') }), [], 'a throwing filter hides')

  const many = createGroupIndex()
  for (let i = 0; i < 70; i++) many.addWriter(i.toString(16).padStart(64, '0'), (1000 + i).toString(16).padStart(64, '0'), D2, 1)
  t.is(many.groupsOf(D2).length, 64, 'at most MAX_GROUPS_PER_DIARY rows')

  // 64 groups left, then one joined whose key sorts after all of them.
  const left = createGroupIndex()
  for (let i = 0; i < 64; i++) {
    const w = (2000 + i).toString(16).padStart(64, '0')
    left.addWriter(i.toString(16).padStart(64, '0'), w, D2, 1)
    left.setLeft(w, true)
  }
  left.addWriter(k('f'), k('9'), D2, 2)
  const rows = left.groupsOf(D2)
  t.is(rows.length, 64)
  t.alike(rows[0], { group: k('f'), writer: k('9'), seq: 2, left: false }, 'the current membership is never capped away')
})

test('writer: the row of one writer, a copy, null once removed or unknown', (t) => {
  const idx = createGroupIndex()
  t.is(idx.writer(G1), null)
  t.ok(idx.addWriter(G1, G1, D1, 3))
  const row = idx.writer(G1)
  t.alike(row, { group: G1, diary: D1, seq: 3, left: false })
  row.diary = D2
  t.is(idx.writer(G1).diary, D1, 'a copy')
  idx.setLeft(G1, true)
  t.is(idx.writer(G1).left, true)
  idx.removeDiary(D1)
  t.is(idx.writer(G1), null)
  t.is(idx.writer({ toString: () => { throw new Error('x') } }), null)
})
