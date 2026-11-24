'use strict'

// A CW an admit covers without listing it (autoAdmit, #350) keeps the
// admission of its generation after it retires, as a listed CW does and as
// a CW a grant covers does (docs/protocol.md, "Only admitted community
// writers count"): its G writers' records from before the leave stay
// visible, and only authority goes.

const test = require('brittle')
const { groupPost, groupLeave, communityAdmit, buildGroup, buildCommunity } = require('../lib/group')
const { K, community, groupIn } = require('./helpers/groups')

const Z = K(0x9)
const A = K(0x2)
const CMG = K(0xc0)
const G = K(0x100)
const cwA = K(0x20)
const cwA2 = K(0x21)
const wA2 = K(0x201)

const visible = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.writer + ':' + p.seq)

// An approval community whose root admits A on cwA; A's second device cwA2
// is listed by a second admit or only covered by the first. A posts in G
// from a G writer bound to cwA2, then leaves C from `from`.
function run (t, { listed, from }) {
  const name = (listed ? 'listed' : 'covered') + ', leave on ' + (from === cwA2 ? 'cwA2' : 'cwA')
  const C = community({ key: CMG, creator: Z, join: 'approval', members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G }] })
  C.addWriter(A, cwA2)
  if (listed) C.push(CMG, communityAdmit({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }, { writer: cwA2, seq: 1 }], at: C.at() }))
  const g = groupIn(C, { key: G, diary: Z, name: 'Varanda' })
  g.add(A, wA2, { cw: cwA2 })
  g.push(wA2, groupPost({ text: 'antes', at: C.at() }))
  let c = buildCommunity(C.input())
  t.ok(c.admittedCws.has(cwA2), name + ': control, admitted before the leave')
  t.alike(visible(buildGroup(g.input())), [wA2 + ':1'], name + ': control, visible before the leave')
  const cuts = from === cwA2 ? [{ writer: cwA2, seq: C.len(cwA2) }] : [{ writer: cwA, seq: C.len(cwA) }, { writer: cwA2, seq: C.len(cwA2) }]
  C.push(from, groupLeave({ cuts, at: C.at() }))
  C.confirm(A, from)
  c = buildCommunity(C.input())
  t.absent(c.liveWriters.has(cwA2), name + ': control, the CW retired')
  t.ok(c.admittedCws.has(cwA2), name + ': the retired CW keeps its admission')
  const r = buildGroup(g.input())
  t.alike(visible(r), [wA2 + ':1'], name + ': the earlier post stays after the CW retires')
  t.absent(r.authorityWriters.has(wA2), name + ': no authority after the CW retires')
  return { admitted: c.admittedCws.has(cwA2), visible: visible(r) }
}

test('approval community: a CW the admit covers keeps its earlier group posts after it retires, as a listed one', (t) => {
  for (const from of [cwA2, cwA]) {
    t.alike(run(t, { listed: false, from }), run(t, { listed: true, from }), 'the covered CW ends as the listed one')
  }
})
