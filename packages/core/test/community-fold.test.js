'use strict'

const test = require('brittle')
const {
  GROUP_TYPES, MAX_GROUP_CUTS, MAX_GROUPS_PER_COMMUNITY,
  validateGroupHeader, validateWriterHeader, validateGroupRecord,
  groupHeader, writerHeader, groupPost, groupHide, groupAdmit, groupBan, groupMeta, groupAdmin, groupLeave,
  groupCreateRecord, communityAdmit, communityBan, communityHide, communityMetaCw, communityDrop, groupKey, groupSealed,
  buildGroup, buildCommunity
} = require('../lib/group')
const { K, AT, NOW, community, groupIn } = require('./helpers/groups')

const Z = K(0x9)
const A = K(0x2)
const B = K(0x3)
const X = K(0x4)
const Y = K(0x5)
const cwA = K(0x20)
const cwB = K(0x30)
const cwX = K(0x40)
const cwY = K(0x50)
const G1 = K(0x100)
const G2 = K(0x101)
const G3 = K(0x102)
const BOX = K(0x77)

const comm = (opts) => buildCommunity(opts.input ? opts.input() : opts)
const sorted = (set) => [...set].sort()

function normalize (c) {
  return {
    ...c,
    admins: sorted(c.admins),
    members: [...c.members].sort((a, b) => a[0] < b[0] ? -1 : 1),
    bans: [...c.bans].sort((a, b) => a[0] < b[0] ? -1 : 1),
    leaves: [...c.leaves].sort((a, b) => a[0] < b[0] ? -1 : 1),
    writers: sorted(c.writers),
    created: [...c.created].sort((a, b) => a[0] < b[0] ? -1 : 1)
  }
}

const v2Header = () => groupHeader({ diary: A, community: K(0xc0), member: cwA, name: 'Varanda', at: AT(0) })
const v2Community = () => groupHeader({ kind: 'community', diary: Z, name: 'Bairro', at: AT(0) })
const v2Writer = () => writerHeader({ group: G1, diary: A, member: cwA, at: AT(0) })

test('version 1 headers are legacy, whatever else they carry', (t) => {
  const v1Root = { type: 'group-header', v: 1, kind: 'group', diary: A, visibility: 'public', join: 'open', name: 'Varanda', box: null, at: AT(0) }
  const v1Writer = { type: 'group-writer', v: 1, group: G1, diary: A, box: null, rejoin: null, at: AT(0) }
  t.is(validateGroupHeader(v1Root), 'legacy')
  t.is(validateGroupHeader({ ...v1Root, extra: 1 }), 'legacy', 'before the exact keys')
  t.is(validateGroupHeader({ ...v1Root, kind: 'community' }), 'legacy')
  t.is(validateWriterHeader(v1Writer), 'legacy')
  t.is(validateWriterHeader({ ...v1Writer, member: null }), 'legacy')
  t.is(validateGroupRecord(v1Root, 0, { root: true }), 'legacy')
  t.is(validateGroupRecord(v1Writer, 0), 'legacy')
  t.is(validateGroupHeader({ ...v2Header(), v: 3 }), 'malformed')
  const legacyC = { key: K(0xc0), entries: [{ seq: 0, record: { ...v1Root, kind: 'community' } }] }
  const c = buildCommunity({ root: legacyC, writers: [], joins: new Map([[A, [{ writer: K(0xc0), on: true, seq: 1 }]]]) })
  t.is(c.creator, null)
  t.is(c.incomplete, true)
  const g = buildGroup({ root: { key: G1, entries: [{ seq: 0, record: v1Root }] }, writers: [], joins: new Map([[A, [{ writer: G1, on: true, seq: 1 }]]]) })
  t.is(g.kind, null, 'a v1 root folds to nothing')
})

test('group-header v2 shapes', (t) => {
  const h = v2Header()
  t.alike(Object.keys(h), ['type', 'v', 'kind', 'diary', 'community', 'member', 'visibility', 'join', 'name', 'box', 'at'])
  t.is(h.v, 2)
  t.is(validateGroupHeader(h), null)
  t.is(validateGroupHeader({ ...h, member: K(0xc0) }), null, 'the creator device CW may be C itself')
  t.is(validateGroupHeader(v2Community()), null)
  t.is(validateGroupHeader(groupHeader({ diary: A, community: K(0xc0), member: cwA, visibility: 'private', join: 'approval', box: BOX, at: AT(0) })), null)
  const rows = [
    ['not an object', null, 'malformed'],
    ['array', [], 'malformed'],
    ['too large', { ...h, name: 'x'.repeat(70000) }, 'too-large'],
    ['missing key', (() => { const { member, ...rest } = h; return rest })(), 'malformed'],
    ['extra key', { ...h, extra: 1 }, 'malformed'],
    ['wrong type', { ...h, type: 'group-writer' }, 'malformed'],
    ['v 0', { ...h, v: 0 }, 'malformed'],
    ['kind', { ...h, kind: 'circle' }, 'malformed'],
    ['diary', { ...h, diary: 'x' }, 'malformed'],
    ['join', { ...h, join: 'closed' }, 'malformed'],
    ['group without community', { ...h, community: null }, 'malformed'],
    ['group community not hex', { ...h, community: 'C' }, 'malformed'],
    ['group without member', { ...h, member: null }, 'malformed'],
    ['group member not hex', { ...h, member: 'A' + cwA.slice(1) }, 'malformed'],
    ['community naming a parent', { ...v2Community(), community: K(0xc1) }, 'malformed'],
    ['community with a member', { ...v2Community(), member: cwA }, 'malformed'],
    ['private community', { ...v2Community(), visibility: 'private', join: 'approval', name: null, box: BOX }, 'malformed'],
    ['community with a box', { ...v2Community(), box: BOX }, 'malformed'],
    ['public with a box', { ...h, box: BOX }, 'malformed'],
    ['visibility', { ...h, visibility: 'secret' }, 'malformed'],
    ['empty name', { ...h, name: '' }, 'name-length'],
    ['long name', { ...h, name: 'x'.repeat(81) }, 'name-length'],
    ['control chars', { ...h, name: 'a\u0007b' }, 'control-chars'],
    ['private open', { ...h, visibility: 'private', join: 'open', name: null, box: BOX }, 'malformed'],
    ['private named', { ...h, visibility: 'private', join: 'approval', name: 'x', box: BOX }, 'malformed'],
    ['private weak box', { ...h, visibility: 'private', join: 'approval', name: null, box: K(0) }, 'malformed'],
    ['private without box', { ...h, visibility: 'private', join: 'approval', name: null, box: null }, 'malformed'],
    ['date', { ...h, at: '2026-01-01' }, 'date-invalid']
  ]
  for (const [label, value, reason] of rows) t.is(validateGroupHeader(value), reason, label)
})

test('group-writer v2 shapes', (t) => {
  const w = v2Writer()
  t.alike(Object.keys(w), ['type', 'v', 'group', 'diary', 'member', 'box', 'rejoin', 'at'])
  t.is(validateWriterHeader(w), null)
  t.is(validateWriterHeader(writerHeader({ group: K(0xc0), diary: A, at: AT(0) })), null, 'a community writer names no member')
  t.is(validateWriterHeader({ ...w, rejoin: { writer: cwA, seq: 1 } }), null)
  t.is(validateWriterHeader({ ...w, box: BOX }), null)
  const rows = [
    ['not an object', 'x', 'malformed'],
    ['too large', { ...w, extra: 'x'.repeat(70000) }, 'too-large'],
    ['extra key', { ...w, extra: 1 }, 'malformed'],
    ['missing member', (() => { const { member, ...rest } = w; return rest })(), 'malformed'],
    ['v 3', { ...w, v: 3 }, 'malformed'],
    ['type', { ...w, type: 'group-header' }, 'malformed'],
    ['group', { ...w, group: 'x' }, 'malformed'],
    ['diary', { ...w, diary: null }, 'malformed'],
    ['member', { ...w, member: 'x' }, 'malformed'],
    ['box', { ...w, box: 'x' }, 'malformed'],
    ['weak box', { ...w, box: K(0) }, 'malformed'],
    ['rejoin seq 0', { ...w, rejoin: { writer: cwA, seq: 0 } }, 'malformed'],
    ['rejoin keys', { ...w, rejoin: { writer: cwA, seq: 1, x: 1 } }, 'malformed'],
    ['date', { ...w, at: 'yesterday' }, 'date-invalid']
  ]
  for (const [label, value, reason] of rows) t.is(validateWriterHeader(value), reason, label)
})

test('record types and community-core shapes', async (t) => {
  t.alike([...GROUP_TYPES], ['group-post', 'group-hide', 'group-admit', 'group-ban', 'group-meta', 'group-admin', 'group-leave', 'group-create', 'group-drop', 'group-key', 'group-sealed'])
  const CW = { community: true }
  const CR = { root: true, community: true }
  const create = groupCreateRecord({ group: G1, at: AT(1) })
  t.alike(Object.keys(create), ['type', 'group', 'seen', 'at'])
  // Only the community's creator creates groups, in C's root.
  t.is(validateGroupRecord(create, 1, CW), 'root-only', 'a create in a CW is root-only')
  t.is(validateGroupRecord(create, 1, CR), null)
  t.is(validateGroupRecord(create, 1, { root: true }), 'community-only')
  t.is(validateGroupRecord(create, 1), 'community-only')
  t.is(validateGroupRecord({ ...create, group: 'x' }, 1, CR), 'malformed')
  t.is(validateGroupRecord({ ...create, seen: { writer: cwA, seq: -1 } }, 1, CR), 'seen-invalid')
  t.is(validateGroupRecord({ ...create, seen: { writer: cwA, seq: 0 } }, 1, CR), null)
  t.is(validateGroupRecord({ ...create, seen: { writer: cwA, seq: 0 } }, 1, CW), 'root-only')

  const admit = communityAdmit({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }], at: AT(1) })
  t.alike(Object.keys(admit), ['type', 'group', 'member', 'on', 'cuts', 'seen', 'at'])
  t.is(admit.group, null)
  t.is(validateGroupRecord(admit, 1, CW), null)
  t.is(validateGroupRecord({ ...admit, group: G1 }, 1, CR), null)
  t.is(validateGroupRecord({ ...admit, group: 'x' }, 1, CW), 'malformed')
  t.is(validateGroupRecord(admit, 1), 'malformed', 'the community shape is not a group shape')
  t.is(validateGroupRecord(groupAdmit({ member: A, on: true, at: AT(1) }), 1, CW), 'malformed', 'nor the reverse')
  const many = (n) => Array.from({ length: n }, (_, i) => ({ writer: K(0x1000 + i), seq: 1 }))
  t.ok(communityAdmit({ member: A, on: false, cuts: many(MAX_GROUP_CUTS), at: AT(1) }))
  t.is(validateGroupRecord({ ...admit, cuts: many(MAX_GROUP_CUTS + 1) }, 1, CW), 'cuts-invalid')
  t.is(validateGroupRecord({ ...admit, cuts: [{ writer: cwA, seq: 1 }, { writer: cwA, seq: 2 }] }, 1, CW), 'cuts-invalid')

  const ban = communityBan({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }], at: AT(1) })
  t.alike(Object.keys(ban), ['type', 'group', 'member', 'on', 'cuts', 'lifts', 'seen', 'at'])
  t.is(validateGroupRecord(ban, 1, CW), null)
  t.is(validateGroupRecord({ ...ban, lifts: { writer: K(0xc0), seq: 1 } }, 1, CW), 'lifts-invalid')
  t.is(validateGroupRecord({ ...ban, on: false }, 1, CW), 'lifts-invalid')
  t.is(validateGroupRecord({ ...ban, on: false, lifts: { writer: K(0xc0), seq: 1 } }, 1, CW), null)
  t.is(validateGroupRecord({ ...ban, cuts: many(MAX_GROUP_CUTS + 1) }, 1, CW), 'cuts-invalid')

  const hide = communityHide({ group: G1, target: { writer: K(0x2000), seq: 1 }, on: true, at: AT(1) })
  t.alike(Object.keys(hide), ['type', 'group', 'target', 'on', 'seen', 'at'])
  t.is(validateGroupRecord(hide, 1, CW), null)
  t.is(validateGroupRecord({ ...hide, group: null }, 1, CW), 'malformed', 'C has no posts')
  t.is(validateGroupRecord({ ...hide, target: { writer: K(0x2000), seq: 0 } }, 1, CW), 'malformed')
  t.is(validateGroupRecord(groupHide({ target: { writer: K(0x2000), seq: 1 }, on: true, at: AT(1) }), 1, CW), 'malformed')
  await t.exception.all(async () => communityHide({ group: null, target: { writer: K(0x2000), seq: 1 }, on: true, at: AT(1) }), /malformed/)

  const leave = groupLeave({ cuts: [{ writer: cwA, seq: 2 }], at: AT(1) })
  t.alike(Object.keys(leave), ['type', 'seen', 'cuts', 'at'], 'the same shape in both core kinds')
  t.is(validateGroupRecord(leave, 1, CW), null)
  t.is(validateGroupRecord(leave, 1, CR), null)
  t.is(validateGroupRecord({ ...leave, cuts: many(9) }, 1, CW), 'cuts-invalid')
  t.is(validateGroupRecord({ ...leave, ends: [] }, 1, CW), 'malformed', 'no ends key')
  t.is(validateGroupRecord({ ...leave, ends: [] }, 1), 'malformed')

  const meta = groupMeta({ name: 'Bairro', join: 'open', at: AT(1) })
  const grant = groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }], at: AT(1) })
  t.is(validateGroupRecord(meta, 1, CR), null)
  t.is(validateGroupRecord(grant, 1, CR), null)
  t.is(validateGroupRecord(meta, 1, CW), 'root-only')
  t.is(validateGroupRecord(grant, 1, CW), 'root-only')
  t.is(validateGroupRecord({ ...grant, cuts: many(MAX_GROUP_CUTS + 1) }, 1, CR), 'cuts-invalid', 'MAX_GROUP_CUTS over CWs too')

  // The returning creator's repairs: a community meta and a drop, CW only.
  const cwMeta = communityMetaCw({ name: 'Bairro', join: 'approval', at: AT(1) })
  t.alike(Object.keys(cwMeta), ['type', 'group', 'name', 'join', 'seen', 'at'])
  t.is(cwMeta.group, null)
  t.is(validateGroupRecord(cwMeta, 1, CW), null)
  t.is(validateGroupRecord({ ...cwMeta, name: null }, 1, CW), null)
  t.is(validateGroupRecord({ ...cwMeta, group: G1 }, 1, CW), 'malformed', 'a CW meta acts on C only')
  t.is(validateGroupRecord({ ...cwMeta, join: 'closed' }, 1, CW), 'malformed')
  t.is(validateGroupRecord({ ...cwMeta, name: '' }, 1, CW), validateGroupRecord({ ...meta, name: '' }, 1, CR), 'names as the root meta')
  t.ok(validateGroupRecord({ ...cwMeta, name: '' }, 1, CW) !== null)
  t.is(validateGroupRecord({ ...cwMeta, seen: { writer: cwA, seq: -1 } }, 1, CW), 'seen-invalid')
  t.is(validateGroupRecord({ ...cwMeta, at: 'yesterday' }, 1, CW), 'date-invalid')
  t.is(validateGroupRecord(cwMeta, 1, CR), 'malformed', 'the root keeps its own meta shape')
  t.is(validateGroupRecord(cwMeta, 1), 'malformed', 'not a group shape')
  t.is(validateGroupRecord(cwMeta, 1, { root: true }), 'malformed')
  await t.exception.all(async () => communityMetaCw({ name: 'Bairro', join: 'x', at: AT(1) }), /malformed/)

  const drop = communityDrop({ group: G1, at: AT(1) })
  t.alike(Object.keys(drop), ['type', 'group', 'on', 'seen', 'at'])
  t.is(drop.on, true, 'a drop defaults to taking the group out')
  t.is(validateGroupRecord(drop, 1, CW), null)
  t.is(validateGroupRecord(communityDrop({ group: G1, on: false, at: AT(1) }), 1, CW), null, 'an undo')
  t.is(validateGroupRecord({ ...drop, on: 1 }, 1, CW), 'malformed')
  t.is(validateGroupRecord({ ...drop, on: null }, 1, CW), 'malformed')
  t.is(validateGroupRecord((() => { const { on, ...rest } = drop; return rest })(), 1, CW), 'malformed', 'the old shape without on')
  t.is(validateGroupRecord({ ...drop, group: null }, 1, CW), 'malformed')
  t.is(validateGroupRecord({ ...drop, group: 'x' }, 1, CW), 'malformed')
  t.is(validateGroupRecord({ ...drop, extra: 1 }, 1, CW), 'malformed')
  t.is(validateGroupRecord({ ...drop, seen: { writer: cwA, seq: -1 } }, 1, CW), 'seen-invalid')
  t.is(validateGroupRecord({ ...drop, at: 'yesterday' }, 1, CW), 'date-invalid')
  t.is(validateGroupRecord(drop, 1, CR), 'malformed', 'never on the root')
  t.is(validateGroupRecord(drop, 1), 'community-only')
  t.is(validateGroupRecord(drop, 1, { root: true }), 'community-only')
  await t.exception.all(async () => communityDrop({ group: null, at: AT(1) }), /malformed/)
  await t.exception.all(async () => communityDrop({ group: G1, on: 'yes', at: AT(1) }), /malformed/)

  const post = groupPost({ text: 'oi', at: AT(1) })
  t.is(validateGroupRecord(post, 1, CW), 'group-only')
  t.is(validateGroupRecord(post, 1, CR), 'group-only')
  const key = { type: 'group-key', kid: null, basis: [], keys: [{ writer: cwA, sealed: 'A'.repeat(128) }], auth: null, commit: K(0x55), at: AT(1) }
  const sealed = { type: 'group-sealed', kid: { writer: cwA, seq: 1 }, nonce: '0'.repeat(48), box: 'AAAAAAAAAAAAAAAAAAAAAAAA', at: AT(1) }
  t.is(validateGroupRecord(key, 1, CW), 'group-only')
  t.is(validateGroupRecord(sealed, 1, CR), 'group-only')

  for (const type of ['group-link', 'community-link']) {
    t.is(validateGroupRecord({ type, group: G1, community: K(0xc0), on: true, cuts: [], at: AT(1) }, 1, CR), 'malformed', type + ' is gone')
  }
})

test('group-key auth shape', async (t) => {
  const P = { private: true }
  const keys = [{ writer: cwA, sealed: 'A'.repeat(128) }]
  const first = groupKey({ keys, commit: K(0x55), at: AT(1) })
  t.alike(Object.keys(first), ['type', 'kid', 'basis', 'keys', 'auth', 'commit', 'at'])
  t.is(first.auth, null)
  const cont = groupKey({ kid: { writer: cwA, seq: 1 }, keys, auth: { writer: K(0xc0), seq: 1 }, at: AT(1) })
  t.alike(Object.keys(cont), ['type', 'kid', 'basis', 'keys', 'auth', 'at'])
  t.alike(cont.auth, { writer: K(0xc0), seq: 1 })
  // `auth.seq` is the distributor's CW length, never 0 (block 0 is its header).
  t.is(validateGroupRecord({ ...cont, auth: { writer: K(0xc0), seq: 0 } }, 1, P), 'malformed', 'auth seq 0')
  await t.exception.all(async () => groupKey({ keys, commit: K(0x55), auth: { writer: K(0xc0), seq: 0 }, at: AT(1) }), /malformed/)
  t.is(validateGroupRecord(first, 1, P), null)
  t.is(validateGroupRecord({ ...first, auth: { writer: K(0xc0), seq: 3 } }, 1, P), null)
  t.is(validateGroupRecord({ ...first, auth: { writer: K(0xc0), seq: -1 } }, 1, P), 'malformed')
  t.is(validateGroupRecord({ ...first, auth: { writer: 'x', seq: 1 } }, 1, P), 'malformed')
  t.is(validateGroupRecord({ ...first, auth: { writer: K(0xc0), seq: 1, x: 1 } }, 1, P), 'malformed')
  t.is(validateGroupRecord({ ...cont, auth: 'C' }, 1, P), 'malformed')
  const { auth, ...noAuth } = first
  t.is(validateGroupRecord(noAuth, 1, P), 'malformed', 'auth is required')
  await t.exception.all(async () => groupKey({ keys, commit: K(0x55), auth: { writer: K(0xc0), seq: 1.5 }, at: AT(1) }), /malformed/)
  t.ok(groupSealed({ kid: { writer: cwA, seq: 1 }, nonce: '0'.repeat(48), box: 'AAAAAAAAAAAAAAAAAAAAAAAA', at: AT(1) }))
})

test('open community: members, leave and rejoin with a new CW', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }] })
  let c = comm(C)
  t.is(c.kind, 'community')
  t.is(c.name, 'Bairro')
  t.is(c.join, 'open')
  t.is(c.creator, Z)
  t.alike(sorted(c.admins), [Z])
  t.alike([...c.members].sort(), [[A, 'member'], [Z, 'member'], [X, 'member']].sort())
  t.alike(c.requests, [])
  t.alike(sorted(c.writers), [K(0xc0), cwA, cwX].sort())
  t.is(c.incomplete, false)

  const leave = C.push(cwX, groupLeave({ cuts: [{ writer: cwX, seq: C.len(cwX) }], at: C.at() }))
  c = comm(C)
  t.is(c.members.get(X), 'left')
  t.alike(c.leaves.get(X), leave)

  const cwX2 = K(0x41)
  C.addWriter(X, cwX2, { rejoin: leave })
  c = comm(C)
  t.is(c.members.get(X), 'member', 'a rejoining CW')
  t.is(c.leaves.has(X), false)
  t.ok(c.writers.has(cwX2))

  // A CW naming a member key is a group writer: header-invalid in C.
  const bad = K(0x42)
  C.logs.set(bad, { key: bad, diary: Y, entries: [{ seq: 0, record: writerHeader({ group: C.key, diary: Y, member: cwA, at: AT(0) }) }] })
  C.joins.set(Y, [{ writer: bad, on: true, seq: 1 }])
  c = comm(C)
  t.is(c.members.has(Y), false)
  t.is(c.writers.has(bad), false)
})

test('approval community: requests, admit, ban, unban, rejoin needs a new admit', (t) => {
  const C = community({
    creator: Z,
    join: 'approval',
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'requested' }, { diary: X, cw: cwX, status: 'banned' }]
  })
  let c = comm(C)
  t.is(c.members.get(A), 'member')
  t.is(c.members.get(B), 'requested')
  t.is(c.members.get(X), 'banned')
  t.alike(c.requests, [B])
  const banRef = c.bans.get(X)
  t.ok(banRef)

  C.push(C.key, communityAdmit({ member: B, on: true, cuts: [{ writer: cwB, seq: 1 }], at: C.at() }))
  C.push(C.key, communityBan({ member: X, on: false, lifts: banRef, cuts: [{ writer: cwX, seq: 1 }], at: C.at() }))
  c = comm(C)
  t.is(c.members.get(B), 'member')
  t.is(c.members.get(X), 'requested', 'unbanned, never admitted')
  t.is(c.bans.has(X), false)

  const leave = C.push(cwA, groupLeave({ cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  const cwA2 = K(0x21)
  C.addWriter(A, cwA2, { rejoin: leave })
  c = comm(C)
  t.is(c.members.get(A), 'requested', 'the old admit covers the old generation only')
  C.push(C.key, communityAdmit({ member: A, on: true, cuts: [{ writer: cwA2, seq: 1 }], at: C.at() }))
  c = comm(C)
  t.is(c.members.get(A), 'member')
})

test('admins from root grants with CW cuts', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }, { diary: X, cw: cwX, status: 'member' }], admins: [A] })
  let c = comm(C)
  t.alike(sorted(c.admins), [A, Z].sort())

  // An admin's ban in C counts; a non-admin's does not.
  C.push(cwB, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: 1 }], at: C.at() }))
  c = comm(C)
  t.is(c.members.get(X), 'member', 'B is no admin')
  const ban = C.push(cwA, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: 1 }], at: C.at() }))
  c = comm(C)
  t.is(c.members.get(X), 'banned')
  t.alike(c.bans.get(X), ban)

  // The shield: nobody bans the creator or an admin.
  C.push(cwA, communityBan({ member: Z, on: true, cuts: [{ writer: C.key, seq: 1 }], at: C.at() }))
  C.push(C.key, communityBan({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }], at: C.at() }))
  c = comm(C)
  t.is(c.members.get(Z), 'member')
  t.is(c.members.get(A), 'member')

  // A demotion cuts the admin's CW: what it wrote from the cut on is void.
  C.push(C.key, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  C.push(cwA, communityBan({ member: B, on: true, cuts: [{ writer: cwB, seq: 2 }], at: C.at() }))
  c = comm(C)
  t.alike(sorted(c.admins), [Z])
  t.is(c.members.get(X), 'banned', 'the ban before the cut stays')
  t.is(c.members.get(B), 'member', 'the ban after the cut is void')

  // A grant that does not list a CW gives that CW nothing.
  const D = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }] })
  const cwA9 = D.addWriter(A, K(0x29))
  D.push(D.key, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }], at: D.at() }))
  D.push(cwA9, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: 1 }], at: D.at() }))
  t.is(comm(D).members.get(X), 'member')
})

test('a left or banned admin is not listed', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }], admins: [A, B] })
  t.alike(sorted(comm(C).admins), [A, B, Z].sort())
  C.push(cwB, groupLeave({ cuts: [{ writer: cwB, seq: C.len(cwB) }], at: C.at() }))
  const c = comm(C)
  t.is(c.members.get(B), 'left')
  t.alike(sorted(c.admins), [A, Z].sort())
})

test('catalogue: Geral first from the root, duplicate and self creates ignored', (t) => {
  const C = community({
    creator: Z,
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }],
    admins: [A],
    creates: [{ by: Z, group: G1 }, { by: Z, group: G2 }]
  })
  let c = comm(C)
  t.is(c.general, G1, 'the first root create')
  t.alike(c.groups, [G1, G2].sort())
  t.alike(c.created.get(G1), { writer: C.key, seq: C.len(C.key) - 2, diary: Z })
  t.alike(c.created.get(G2), { writer: C.key, seq: C.len(C.key) - 1, diary: Z })

  C.push(C.key, groupCreateRecord({ group: G1, at: C.at() }))
  C.push(C.key, groupCreateRecord({ group: C.key, at: C.at() }))
  c = comm(C)
  t.is(c.created.get(G1).seq, C.len(C.key) - 4, 'a duplicate keeps the first')
  t.alike(c.groups, [G1, G2].sort(), 'naming C itself is skipped')

  // Geral is the root's first create by root seq.
  const D = community({ creator: Z, creates: [{ by: Z, group: G3 }, { by: Z, group: G1 }] })
  t.is(comm(D).general, G3)
})

test('catalogue: a create in a CW is root-only, an admin\'s included, and never enters the catalogue', (t) => {
  const C = community({
    creator: Z,
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }],
    admins: [A]
  })
  C.push(cwA, groupCreateRecord({ group: G2, at: C.at() }))
  C.push(cwB, groupCreateRecord({ group: G3, at: C.at() }))
  let c = comm(C)
  t.alike(sorted(c.admins), [A, Z].sort(), 'control: A is a C admin')
  t.is(c.general, null, 'an admin create never becomes Geral')
  t.alike(c.groups, [])
  t.is(c.created.has(G2), false, 'the admin create is not in the catalogue')
  t.is(c.created.has(G3), false)
  t.is(buildGroup(groupIn(C, { key: G2, diary: A }).input()).orphan, true, 'a group the admin made is an orphan')

  // A root create of the same group later counts, as the creator's.
  C.push(C.key, groupCreateRecord({ group: G2, at: C.at() }))
  c = comm(C)
  t.is(c.general, G2)
  t.is(c.created.get(G2).diary, Z)
  t.is(buildGroup(groupIn(C, { key: G2, diary: A }).input()).orphan, true, 'still not A\'s group')
  t.is(buildGroup(groupIn(C, { key: G2, diary: Z }).input()).orphan, false, 'the creator\'s group')
})

test('catalogue: at most 32 groups from the root, the 33rd is not created', (t) => {
  const creates = [{ by: Z, group: G1 }]
  for (let i = 0; i < MAX_GROUPS_PER_COMMUNITY; i++) creates.push({ by: Z, group: K(0x5000 + i) })
  creates.push({ by: Z, group: G2 })
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates })
  // Duplicates and CW creates take no slot.
  C.push(C.key, groupCreateRecord({ group: G1, at: C.at() }))
  C.push(cwA, groupCreateRecord({ group: G3, at: C.at() }))
  const c = comm(C)
  t.is(c.groups.length, MAX_GROUPS_PER_COMMUNITY)
  t.is(c.general, G1, 'Geral enters first')
  t.ok(c.groups.includes(G1))
  t.ok(c.groups.includes(K(0x5000)))
  t.ok(c.groups.includes(K(0x5000 + MAX_GROUPS_PER_COMMUNITY - 2)))
  t.absent(c.groups.includes(K(0x5000 + MAX_GROUPS_PER_COMMUNITY - 1)), 'the 33rd root create overflows')
  t.absent(c.groups.includes(G2))
  t.absent(c.groups.includes(G3))
  t.is(buildGroup(groupIn(C, { key: G2, diary: Z }).input()).orphan, true, 'an overflowing group is an orphan')
})

test('catalogue: a demoted admin cannot create at all, before or after its cut', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  C.push(cwA, groupCreateRecord({ group: G2, at: C.at() }))
  C.push(C.key, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  C.push(cwA, groupCreateRecord({ group: G3, at: C.at() }))
  let c = comm(C)
  t.alike(c.groups, [G1], 'neither the create before the cut nor the one after')
  t.alike(sorted(c.admins), [Z])

  // Re-granted, the admin still creates nothing.
  C.push(C.key, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  C.push(cwA, groupCreateRecord({ group: G2, at: C.at() }))
  c = comm(C)
  t.alike(sorted(c.admins), [A, Z].sort())
  t.alike(c.groups, [G1])
})

test('catalogue: a creator leave on the root withdraws only root creates after it', (t) => {
  // A leave written on the root bounds it at its own seq, whatever root cut
  // it lists (owner decision, cycle 12).
  const C = community({ creator: Z, creates: [{ by: Z, group: G1 }, { by: Z, group: G2 }] })
  t.alike(comm(C).groups, [G1, G2].sort())
  C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: 1 }], at: C.at() }))
  C.push(C.key, groupCreateRecord({ group: G3, at: C.at() }))
  const c = comm(C)
  t.alike(c.groups, [G1, G2].sort(), 'creates before the leave stay, a lower listed cut moves nothing')
  t.is(c.general, G1)
  t.is(c.members.get(Z), 'left')
})

test('records naming a group change nothing in C', (t) => {
  const C = community({
    creator: Z,
    join: 'approval',
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'requested' }, { diary: X, cw: cwX, status: 'member' }],
    admins: [A],
    creates: [{ by: Z, group: G1 }]
  })
  const before = normalize(comm(C))
  C.push(cwA, communityBan({ group: G1, member: X, on: true, cuts: [{ writer: K(0x4000), seq: 1 }], at: C.at() }))
  C.push(C.key, communityAdmit({ group: G1, member: B, on: true, cuts: [{ writer: K(0x3000), seq: 1 }], at: C.at() }))
  C.push(cwA, communityHide({ group: G1, target: { writer: K(0x4000), seq: 1 }, on: true, at: C.at() }))
  C.push(cwA, communityBan({ group: K(0xdead), member: X, on: true, at: C.at() }))
  const after = normalize(comm(C))
  t.alike({ ...after, last: null }, { ...before, last: null })
  t.is(after.last.writer, cwA, 'they are nodes of C\'s order')
})

test('emptyCommunity, unbound root and wrong kinds', (t) => {
  for (const input of [undefined, null, {}, { root: null }, { root: { key: 'x' } }, { root: { key: K(0xc0), entries: [] } }]) {
    const c = buildCommunity(input)
    t.is(c.kind, 'community')
    t.is(c.creator, null)
    t.is(c.general, null)
    t.alike(c.groups, [])
    t.is(c.incomplete, true)
  }
  const e = buildCommunity({})
  t.is(e.rootAuthority, false)
  t.alike(e.dropped, [])
  t.alike(Object.keys(e).sort(), ['admins', 'bans', 'created', 'creator', 'general', 'groups', 'incomplete', 'join', 'kind', 'last', 'lastLeave', 'cwDemote', 'rootAuthority', 'creatorConfirmSeq', 'leaveOf', 'leaveSetOf', 'confirmedLeaveOf', 'admittedCws', 'leaves', 'liveWriters', 'authorityWriters', 'members', 'name', 'requests', 'writers', 'dropped'].sort())

  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }], bindRoot: false })
  const c = comm(C)
  t.is(c.name, 'Bairro')
  t.is(c.join, 'open')
  t.is(c.creator, null)
  t.is(c.admins.size, 0)
  t.is(c.members.size, 0)
  t.alike(c.groups, [])
  t.is(c.incomplete, true)

  // A group root is no community, and a community root is no group.
  const B0 = community({ creator: Z })
  const g = groupIn(B0, { key: G1 })
  t.is(buildCommunity({ root: g.logs.get(G1), writers: [], joins: g.joins }).creator, null)
  t.is(buildGroup({ root: B0.logs.get(B0.key), writers: [], joins: B0.joins }).kind, null)

  const result = buildCommunity({ root: { key: K(0xc0), entries: { length: 1, get 0 () { throw new Error('x') } } } })
  t.is(result.incomplete, true, 'never throws')
})

// mulberry32
function rng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let x = a
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle (list, rand) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

test('buildCommunity is the same for any delivery order', (t) => {
  const C = community({
    creator: Z,
    join: 'approval',
    members: [
      { diary: A, cw: cwA, status: 'member' },
      { diary: B, cw: cwB, status: 'member' },
      { diary: X, cw: cwX, status: 'banned' },
      { diary: Y, cw: cwY, status: 'member' }
    ],
    admins: [A, B],
    creates: [{ by: Z, group: G1 }, { by: A, group: G2 }]
  })
  const banX = comm(C).bans.get(X)
  C.push(cwA, communityBan({ member: X, on: false, lifts: banX, cuts: [{ writer: cwX, seq: 1 }], at: C.at() }))
  C.push(cwB, groupCreateRecord({ group: G3, seen: { writer: cwA, seq: 2 }, at: C.at() }))
  C.push(C.key, groupAdmin({ member: B, on: false, cuts: [{ writer: cwB, seq: 1 }], at: C.at() }))
  const leave = C.push(cwY, groupLeave({ cuts: [{ writer: cwY, seq: C.len(cwY) }], at: C.at() }))
  const cwY2 = C.addWriter(Y, K(0x51), { rejoin: leave })
  C.push(cwA, communityAdmit({ member: Y, on: true, cuts: [{ writer: cwY2, seq: 1 }], at: C.at() }))
  C.push(cwA, communityBan({ group: G1, member: B, on: true, at: C.at() }))
  C.push(cwY2, groupCreateRecord({ group: K(0x103), at: C.at() }))

  const base = comm(C)
  t.is(base.members.get(X), 'requested')
  t.is(base.members.get(Y), 'member')
  t.alike(base.groups, [G1, G2].sort(), 'the demotion cut at 1 takes G3 out')
  t.alike(sorted(base.admins), [A, Z].sort())
  const expected = JSON.stringify(normalize(base))
  const rand = rng(0x5eed)
  let same = 0
  const orders = 240
  for (let i = 0; i < orders; i++) {
    const input = C.input()
    const root = { ...input.root, entries: shuffle(input.root.entries, rand) }
    const writers = shuffle(input.writers.map((w) => ({ ...w, entries: shuffle(w.entries, rand) })), rand)
    const joins = new Map(shuffle([...input.joins].map(([d, list]) => [d, shuffle(list, rand)]), rand))
    if (JSON.stringify(normalize(buildCommunity({ root, writers, joins, now: input.now }))) === expected) same++
  }
  t.is(same, orders)
})

// Group results with their Maps and Sets (the parent community's included)
// as sorted arrays, so two folds compare as text.
function stable (g) {
  return JSON.stringify(g, (k, v) => v instanceof Map
    ? [...v].sort((a, b) => a[0] < b[0] ? -1 : 1)
    : v instanceof Set ? [...v].sort() : v)
}
const shown = (g) => g.posts.filter((p) => !p.hidden).map((p) => p.writer + ':' + p.seq)
const gpost = (g, key, s) => g.push(key, groupPost({ text: 'p' + s, at: AT(s) }))
// An honest leave: the leave on the CW plus the diary turning it off.
const cwLeave = (C, cw, s) => {
  const ref = C.push(cw, groupLeave({ cuts: [{ writer: cw, seq: C.len(cw) }], at: AT(s) }))
  C.confirm(C.logs.get(cw).diary, cw)
  return ref
}
const wA = K(0x2000)
const wB = K(0x3000)
const wX = K(0x4000)
const wY = K(0x5000)

test('parent resolution: the community when it authorizes G, else orphan or incomplete', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  g.add(A, wA)
  gpost(g, wA, 5)
  const on = buildGroup(g.input())
  t.is(on.community.kind, 'community')
  t.alike(on.community.groups, [G1])
  t.is(on.orphan, false)
  t.is(on.incomplete, false)
  t.is(on.members.get(A), 'member')
  t.is(on.posts.length, 1)
  const input = C.input()
  const cases = [
    ['no community', null],
    ['another key', { ...input, root: { ...input.root, key: K(0xc1) } }],
    ['a root without block 0', { ...input, root: { key: C.key, entries: [] } }],
    ['an unbound root', { ...input, joins: new Map() }],
    ['a group root as parent', { ...input, root: { key: C.key, entries: [{ seq: 0, record: v2Header() }] } }]
  ]
  for (const [label, community] of cases) {
    const r = buildGroup(g.input({ community }))
    t.is(r.community, null, label)
    t.is(r.orphan, false, label)
    t.is(r.incomplete, true, label)
    t.is(r.posts.length, 1, label + ': readers still read')
  }
  const incomplete = buildGroup(g.input({ community: C.input({ drop: [cwA] }) }))
  t.ok(incomplete.community !== null && incomplete.incomplete, 'an incomplete C makes G incomplete')

  const D = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }] })
  const g2 = groupIn(D, { key: G1 })
  g2.add(A, wA)
  const orphan = buildGroup(g2.input())
  t.is(orphan.community, null)
  t.is(orphan.orphan, true, 'nobody created G in C')
  t.is(orphan.incomplete, false)
  t.is(orphan.members.get(A), 'member', 'the gate is off')

  const E = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  t.is(buildGroup(groupIn(E, { key: G1, diary: A }).input()).orphan, true, 'created by another diary than the header names')

  const creates = Array.from({ length: MAX_GROUPS_PER_COMMUNITY + 1 }, (_, i) => ({ by: Z, group: K(0x6000 + i) }))
  const F = community({ creator: Z, creates })
  t.is(buildGroup(groupIn(F, { key: K(0x6000 + MAX_GROUPS_PER_COMMUNITY) }).input()).orphan, true, 'the 33rd create is an orphan')
  t.is(buildGroup(groupIn(F, { key: K(0x6000) }).input()).orphan, false)

  const asRoot = buildGroup({ root: C.input().root, writers: [], joins: C.joins, community: C.input(), now: NOW })
  t.is(asRoot.kind, null, 'a community root given as root folds to the empty group')
  t.is(asRoot.incomplete, true)
})

test('parent resolution: G missing from an incomplete C is pending, never an orphan', (t) => {
  // The creator's root create of G has not reached this reader, and a CW
  // of C is missing: C is incomplete, so G is pending.
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A] })
  const g = groupIn(C, { key: G1 })
  g.add(A, wA)
  t.is(buildGroup(g.input()).orphan, true, 'control: a complete C without G makes it an orphan')
  const pending = buildGroup(g.input({ community: C.input({ drop: [cwA] }) }))
  t.is(pending.community, null)
  t.is(pending.orphan, false, 'C may still list G')
  t.is(pending.incomplete, true)
  t.is(pending.members.get(A), 'member', 'the gate is off')
  C.push(C.key, groupCreateRecord({ group: G1, at: C.at() }))
  t.is(buildGroup(g.input()).community.kind, 'community', 'the root create authorizes G')
  t.is(buildGroup(g.input({ community: C.input({ drop: [cwA] }) })).community.kind, 'community', 'whatever CW is missing')
  // Listed by another diary than the header names: an orphan even while C
  // is incomplete.
  const E = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  const other = groupIn(E, { key: G1, diary: A })
  const r = buildGroup(other.input({ community: E.input({ drop: [cwB] }) }))
  t.is(r.orphan, true)
  t.is(r.incomplete, false)
})

test('gate: a group writer binds only to a counted CW of its own diary', (t) => {
  const C = community({
    creator: Z,
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1 })
  const wNull = K(0x3001)
  const wForeign = K(0x3002)
  const wUnknown = K(0x3003)
  g.add(A, wA)
  g.logs.set(wNull, { key: wNull, diary: B, entries: [{ seq: 0, record: writerHeader({ group: G1, diary: B, at: AT(0) }) }] })
  g.joins.set(B, [{ writer: wNull, on: true, seq: 1 }])
  g.add(B, wForeign, { cw: cwA })
  g.add(B, wUnknown, { cw: K(0x7777) })
  for (const w of [wA, wNull, wForeign, wUnknown]) gpost(g, w, 5)
  const r = buildGroup(g.input())
  t.ok(r.writers.has(wA))
  for (const w of [wNull, wForeign, wUnknown]) t.absent(r.writers.has(w), 'header-invalid')
  t.is(r.incomplete, false, 'rejected writers are never awaited')
  t.absent(r.members.has(B))
  t.alike(shown(r), [wA + ':1'])

  g.add(B, wB)
  gpost(g, wB, 6)
  t.is(buildGroup(g.input()).members.get(B), 'member', 'a writer naming its own CW counts')
  const r2 = buildGroup(g.input({ community: C.input({ drop: [cwB] }) }))
  t.absent(r2.writers.has(wB), 'its CW is not held')
  t.is(r2.incomplete, true, 'and awaited while C is incomplete')
  t.absent(r2.writers.has(wForeign))
})

test('gate: a retired CW leaves the group, earlier posts stay; a rejoin with a new CW counts whatever its clock', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  g.add(A, wA)
  gpost(g, wA, 5)
  const leave = cwLeave(C, cwA, 50)
  gpost(g, wA, 60)
  const r = buildGroup(g.input())
  t.is(r.members.get(A), 'left')
  t.alike(shown(r), [wA + ':1'], 'the post after the leave is withdrawn, the earlier one stays')
  t.absent(r.requests.includes(A))

  // The rejoin's block 0 is timed before the leave: the new generation's
  // posts still count, since only the retired CW's writer is withdrawn.
  const cwA2 = C.addWriter(A, K(0x21), { rejoin: leave })
  const wA2 = K(0x2001)
  g.add(A, wA2, { cw: cwA2 })
  gpost(g, wA2, 10)
  const r2 = buildGroup(g.input())
  t.is(r2.members.get(A), 'member')
  t.alike(shown(r2).sort(), [wA + ':1', wA2 + ':1'].sort())
  t.ok(r2.writers.has(wA), 'the old writer still counts, its later records withdrawn')
})

test('gate: a C ban hides every record of the diary in G and bans it there; the unban restores', (t) => {
  const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  g.add(X, wX)
  const p = gpost(g, wX, 5)
  gpost(g, wX, 6)
  g.push(wX, groupHide({ target: p, on: true, at: AT(7) }))
  const ban = C.push(C.key, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: C.len(cwX) }], at: C.at() }))
  const r = buildGroup(g.input())
  t.is(r.members.get(X), 'banned')
  t.alike(shown(r), [], 'hidden from seq 0')
  t.absent(r.bans.has(X), 'G\'s own ban layer is untouched')
  C.push(C.key, communityBan({ member: X, on: false, lifts: ban, cuts: [{ writer: cwX, seq: C.len(cwX) }], at: C.at() }))
  const r2 = buildGroup(g.input())
  t.is(r2.members.get(X), 'member')
  t.alike(shown(r2), [wX + ':2'], 'restored, the author hide still holds')
})

test('gate: requests never list a diary that is out of C', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1, join: 'approval' })
  g.add(A, wA)
  t.alike(buildGroup(g.input()).requests, [A])
  cwLeave(C, cwA, 50)
  const r = buildGroup(g.input())
  t.is(r.members.get(A), 'left')
  t.alike(r.requests, [])
})

test('gate: the root is gated at diary level (its creator leaves C and comes back)', (t) => {
  const C = community({
    creator: Z,
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }],
    admins: [A],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1 })
  g.add(X, wX)
  gpost(g, G1, 5)
  gpost(g, wX, 6)
  // C's creator, who created G, leaves C on C's root above its create.
  const leave = cwLeave(C, C.key, 50)
  gpost(g, G1, 60)
  g.push(G1, groupBan({ member: X, on: true, at: AT(61) }))
  const out = buildGroup(g.input())
  t.is(out.members.get(Z), 'left')
  // C's admins list its bound creator whatever its status (the C output
  // rule), so the title follows C; the root's authority does not.
  t.absent(out.authorityWriters.has(G1), 'no creator powers while out of C')
  t.is(out.members.get(X), 'member', 'the root ban after the leave is withdrawn')
  t.alike(shown(out).sort(), [G1 + ':1', wX + ':1'].sort(), 'root records before the leave stay')
  t.is(out.orphan, false, 'the create below the root cut still counts')

  C.addWriter(Z, K(0x91), { rejoin: leave })
  const back = buildGroup(g.input())
  t.is(back.members.get(Z), 'member')
  t.ok(back.admins.has(Z), 'back in C, the creator regains the charter')
  // The leave was confirmed and the creator's diary marked nothing: the
  // unmarked G root never regains authority (owner decision, cycle 21).
  t.is(back.members.get(X), 'member', 'the root ban stays void after the return')
})

test('community authority: CW records act in G by C\'s layers at their position', (t) => {
  const C = community({
    creator: Z,
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }],
    admins: [A],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1 })
  g.add(X, wX).add(Y, wY).add(A, wA)
  gpost(g, wX, 5)
  const py = gpost(g, wY, 6)
  const ban = C.push(cwA, communityBan({ group: G1, member: X, on: true, at: AT(10) }))
  C.push(C.key, communityHide({ group: G1, target: py, on: true, at: AT(11) }))
  C.push(cwA, communityBan({ group: G2, member: Y, on: true, at: AT(12) }))
  C.push(cwX, communityBan({ group: G1, member: Y, on: true, at: AT(13) }))
  let r = buildGroup(g.input())
  t.is(r.members.get(X), 'banned', 'a C admin bans in G from its CW')
  t.alike(r.bans.get(X), ban, 'the ban an unban must lift sits in the CW')
  t.alike(shown(r), [], 'the C creator hides from C\'s root')
  t.is(r.members.get(Y), 'member', 'a ban naming another group and a non-admin CW ban change nothing')
  t.alike(sorted(r.admins), [A, Z].sort(), 'C\'s admins are listed, never a CW member')
  t.alike(sorted(r.writers), [G1, wX, wY, wA].sort(), 'CWs never count as G writers')

  t.is(validateGroupRecord(groupAdmin({ member: X, on: true, at: AT(1) }), 1, { community: true }), 'root-only', 'no group-admin from a CW')

  // A demotion cuts A's CW at its length: later CW records are void, the
  // earlier ban stays.
  C.push(C.key, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  C.push(cwA, communityBan({ group: G1, member: Y, on: true, at: AT(20) }))
  r = buildGroup(g.input())
  t.is(r.members.get(X), 'banned')
  t.is(r.members.get(Y), 'member', 'after the demotion cut')
  t.absent(r.admins.has(A))

  // A diary banned in C keeps no authority anywhere.
  C.push(C.key, communityBan({ member: A, on: true, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  r = buildGroup(g.input())
  t.is(r.members.get(X), 'member', 'the ban of a C-banned admin is void')
  t.is(r.members.get(A), 'banned')
})

test('community authority: C admins are shielded in G and need no admit', (t) => {
  const C = community({
    creator: Z,
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }],
    admins: [A],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1, join: 'approval' })
  g.add(A, wA).add(Y, wY)
  gpost(g, wA, 5)
  g.push(G1, groupAdmin({ member: Y, on: true, cuts: [{ writer: wY, seq: g.len(wY) }], at: AT(6) }))
  g.push(wY, groupBan({ member: A, on: true, at: AT(7) }))
  g.push(wY, groupAdmit({ member: A, on: false, at: AT(8) }))
  const r = buildGroup(g.input())
  t.is(r.members.get(A), 'member', 'a G admin cannot ban or unadmit a C admin')
  t.alike(shown(r), [wA + ':1'], 'its post needs no admit')
  t.absent(r.requests.includes(A))
  t.ok(r.admins.has(A) && r.admins.has(Y) && r.admins.has(Z))
  // A leave of G changes nothing in A's community authority.
  g.push(wA, groupLeave({ cuts: [{ writer: wA, seq: g.len(wA) }], at: AT(9) }))
  g.push(G1, groupAdmin({ member: Y, on: false, cuts: [{ writer: wY, seq: g.len(wY) }], at: AT(10) }))
  C.push(cwA, communityBan({ group: G1, member: Y, on: true, at: AT(11) }))
  const r2 = buildGroup(g.input())
  t.is(r2.members.get(A), 'left', 'left G')
  t.ok(r2.admins.has(A), 'still a C admin in G')
  t.is(r2.members.get(Y), 'banned', 'and its CW ban counts')
})

test('community: the writer cap ranks C admins by the root grant layer alone', (t) => {
  const N = 520
  const members = Array.from({ length: N }, (_, i) => ({ diary: K(0x10000 + i), cw: K(0x20000 + i), status: 'member' }))
  const late = 'f'.repeat(64)
  const C = community({ creator: Z, members: [...members, { diary: A, cw: late, status: 'member' }], admins: [A] })
  const target = members[0]
  C.push(late, communityBan({ member: target.diary, on: true, cuts: [{ writer: target.cw, seq: 1 }], at: C.at() }))
  const c = comm(C)
  t.is(c.incomplete, true, 'over the cap')
  t.ok(c.writers.has(late), 'the admin CW sorting last is kept')
  t.ok(c.bans.has(target.diary), 'so its ban counts')
  t.ok(c.admins.has(A))
})

test('property: a group under its community folds the same for every delivery order', (t) => {
  const C = community({
    creator: Z,
    join: 'approval',
    members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }, { diary: B, cw: cwB, status: 'member' }],
    admins: [A],
    creates: [{ by: Z, group: G1 }]
  })
  const g = groupIn(C, { key: G1, join: 'approval' })
  g.add(A, wA).add(X, wX).add(Y, wY).add(B, wB)
  gpost(g, wX, 5)
  gpost(g, wY, 6)
  const pb = gpost(g, wB, 7)
  gpost(g, G1, 8)
  g.push(G1, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: g.len(wX) }], at: AT(9) }))
  C.push(cwA, communityAdmit({ group: G1, member: Y, on: true, cuts: [{ writer: wY, seq: g.len(wY) }], at: AT(10) }))
  C.push(cwA, communityHide({ group: G1, target: pb, on: true, at: AT(11) }))
  const leave = cwLeave(C, cwY, 30)
  gpost(g, wY, 31)
  const cwY2 = C.addWriter(Y, K(0x51), { rejoin: leave })
  C.push(C.key, communityAdmit({ member: Y, on: true, cuts: [{ writer: cwY2, seq: 1 }], at: AT(12) }))
  const wY2 = K(0x5001)
  g.add(Y, wY2, { cw: cwY2 })
  gpost(g, wY2, 13)
  C.push(C.key, communityBan({ member: B, on: true, cuts: [{ writer: cwB, seq: C.len(cwB) }], at: AT(14) }))
  const base = buildGroup(g.input())
  t.is(base.members.get(B), 'banned')
  t.is(base.members.get(Y), 'member', 'admitted in G by the C admin; the new writer is covered by no admit')
  t.ok(base.requests.includes(Y), 'so it is asked again')
  const expected = stable(base)
  const rand = rng(0xc0ffee)
  let same = 0
  const orders = 120
  const mix = (input) => ({
    ...input,
    root: { ...input.root, entries: shuffle(input.root.entries, rand) },
    writers: shuffle(input.writers.map((w) => ({ ...w, entries: shuffle(w.entries, rand) })), rand),
    joins: new Map(shuffle([...input.joins].map(([d, list]) => [d, shuffle(list, rand)]), rand))
  })
  for (let i = 0; i < orders; i++) {
    if (stable(buildGroup(mix(g.input({ community: mix(C.input()) })))) === expected) same++
  }
  t.is(same, orders)
})

test('thousands of CW records fold in linear time', (t) => {
  const members = Array.from({ length: 200 }, (_, i) => ({ diary: K(0x10000 + i), cw: K(0x20000 + i), status: 'member' }))
  const C = community({ creator: Z, members: [...members, { diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  g.add(members[0].diary, wX)
  const p = gpost(g, wX, 5)
  const N = 6000
  for (let i = 0; i < N; i++) {
    C.push(cwA, communityHide({ group: i % 2 ? G1 : G2, target: p, on: i % 4 === 3, at: AT(10 + i) }))
  }
  for (const m of members) C.push(m.cw, communityHide({ group: G1, target: p, on: false, at: AT(10) }))
  const start = Date.now()
  const r = buildGroup(g.input())
  const ms = Date.now() - start
  t.ok(ms < 3000, N + members.length + ' CW records folded in ' + ms + ' ms')
  t.alike(shown(r), [], 'the last CW hide on G is on')
})

test('gate: diaries banned in C rank last at the group writer cap', (t) => {
  const N = 70
  const members = Array.from({ length: N }, (_, i) => ({ diary: K(0x10000 + i), cw: K(0x20000 + i), status: i === 0 ? 'banned' : 'member' }))
  const C = community({ creator: Z, members, creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  for (let i = 0; i < N; i++) for (let j = 0; j < 8; j++) g.add(members[i].diary, K(0x30000 + i * 8 + j))
  const r = buildGroup(g.input())
  t.is(r.incomplete, true, 'over the cap')
  t.ok(r.community !== null)
  t.is(r.community.members.get(members[0].diary), 'banned')
  t.absent([...r.writers].some((w) => w >= K(0x30000) && w < K(0x30008)), 'the writers of the diary banned in C go first')
  t.ok(r.writers.has(K(0x30008)), 'a member writer sorting right after them is kept')
})

test('lastLeave names the causally latest leave of every diary that ever left, whatever the clocks say', (t) => {
  const cwA2 = K(0x21)
  const cwA3 = K(0x22)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }] })
  const l1 = cwLeave(C, cwA, 50)
  C.addWriter(A, cwA2, { rejoin: l1 })
  // The newer leave carries the older clock.
  const l2 = cwLeave(C, cwA2, 10)
  let c = comm(C)
  t.alike(c.lastLeave.get(A), l2, 'by causal order, not by at')
  t.alike(c.leaves.get(A), l2, 'left now')
  C.addWriter(A, cwA3, { rejoin: l2 })
  const lx = cwLeave(C, cwX, 5)
  c = comm(C)
  t.is(c.members.get(A), 'member')
  t.absent(c.leaves.has(A), 'leaves keeps only the diaries left now')
  t.alike(c.lastLeave.get(A), l2, 'kept after the rejoin')
  t.alike(c.lastLeave.get(X), lx)
  t.absent(c.lastLeave.has(Z))

  // The same field in a group, for its own leaves.
  const D = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(D, { key: G1 })
  g.add(A, wA)
  const gl1 = g.push(wA, groupLeave({ cuts: [{ writer: wA, seq: g.len(wA) }], at: AT(40) }))
  g.add(A, K(0x2001), { rejoin: gl1, at: AT(41) })
  const gl2 = g.push(K(0x2001), groupLeave({ cuts: [{ writer: K(0x2001), seq: 1 }], at: AT(20) }))
  g.add(A, K(0x2002), { rejoin: gl2, at: AT(42) })
  const r = buildGroup(g.input())
  t.alike(r.lastLeave.get(A), gl2)
  t.absent(r.leaves.has(A))
  t.alike(buildCommunity({}).lastLeave, new Map(), 'the empty result carries it')
})

test('liveWriters: a leave whose cuts omit a CW still takes it out', (t) => {
  const cwA2 = K(0x21)
  const cwA3 = K(0x22)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }] })
  C.addWriter(A, cwA2)
  // A no-op record on the second device (it names a group C never created).
  C.push(cwA2, communityAdmit({ group: K(0x999), member: X, on: true, cuts: [], at: C.at() }))
  let c = comm(C)
  t.alike(sorted(c.liveWriters), sorted([C.key, cwA, cwA2]), 'control: every member CW and the bound root')
  // The other device leaves without having downloaded cwA2, then rejoins.
  const leave = C.push(cwA, groupLeave({ cuts: [{ writer: cwA, seq: C.len(cwA) }], at: AT(50) }))
  C.addWriter(A, cwA3, { rejoin: leave })
  c = comm(C)
  t.is(c.members.get(A), 'member')
  t.ok(c.liveWriters.has(cwA3), 'the rejoin CW')
  t.absent(c.liveWriters.has(cwA), 'the CW that left')
  t.absent(c.liveWriters.has(cwA2), 'the CW the leave never listed')
  t.ok(c.writers.has(cwA2), 'still counted for what it wrote before')
  t.alike(sorted(buildCommunity({}).liveWriters), [])
  t.alike(sorted(buildCommunity({}).authorityWriters), [])
})

test('authorityWriters: a grant covers only the CWs it lists, a demotion at the CW length ends it', (t) => {
  const cwA2 = K(0x21)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }], admins: [A] })
  C.addWriter(A, cwA2)
  let c = comm(C)
  t.alike(sorted(c.liveWriters), sorted([C.key, cwA, cwA2, cwX]))
  t.alike(sorted(c.authorityWriters), sorted([C.key, cwA]), 'the creator root and the granted CW only')
  C.push(C.key, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: C.at() }))
  c = comm(C)
  t.alike(sorted(c.authorityWriters), [C.key], 'demoted at the CW length')
  t.ok(c.liveWriters.has(cwA), 'still live')
  const banned = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'banned' }, { diary: X, cw: cwX, status: 'left' }] })
  const b = comm(banned)
  t.is(b.members.get(A), 'banned')
  t.absent(b.liveWriters.has(cwA), 'a banned member')
  t.absent(b.liveWriters.has(cwX), 'a left member')
})

test('group liveWriters: a writer bound to a retired CW is out; authority follows the G layers', (t) => {
  const cwA3 = K(0x22)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  g.add(A, wA).add(X, wX)
  g.push(G1, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(3) }))
  let r = buildGroup(g.input())
  t.alike(sorted(r.liveWriters), sorted([G1, wA, wX]))
  t.alike(sorted(r.authorityWriters), sorted([G1, wX]), 'the creator root and the granted writer')
  const leave = cwLeave(C, cwA, 50)
  C.addWriter(A, cwA3, { rejoin: leave })
  g.add(A, wB, { cw: cwA3 })
  r = buildGroup(g.input())
  t.absent(r.liveWriters.has(wA), 'its CW retired in C')
  t.ok(r.liveWriters.has(wB), 'the writer on the new CW')
  g.push(G1, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: g.len(wX) }], at: AT(60) }))
  g.push(G1, groupAdmin({ member: X, on: false, cuts: [{ writer: wX, seq: g.len(wX) }], at: AT(59) }))
  r = buildGroup(g.input())
  t.absent(r.liveWriters.has(wX) || r.authorityWriters.has(wX), 'demoted and banned in G')
})

test('gate: a request never admitted in C neither posts nor acts in its groups', (t) => {
  const C = community({ creator: Z, join: 'approval', members: [{ diary: B, cw: cwB, status: 'requested' }, { diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  let c = comm(C)
  t.absent(c.admittedCws.has(cwB), 'a request')
  t.ok(c.admittedCws.has(cwX) && c.admittedCws.has(C.key))
  const g = groupIn(C, { key: G1 })
  g.add(B, wB).add(X, wX)
  gpost(g, wB, 5)
  gpost(g, wX, 6)
  // The G creator grants B, which then bans X.
  g.push(G1, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: g.len(wB) }], at: AT(7) }))
  g.push(wB, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: g.len(wX) }], at: AT(8) }))
  let r = buildGroup(g.input())
  t.alike(shown(r), [wX + ':1'], 'the request post is hidden in the open group')
  t.is(r.members.get(X), 'member', 'its ban counts for nothing')
  t.absent(r.liveWriters.has(wB) || r.authorityWriters.has(wB))
  // Admitted later: an admin vouched for it, so its records count.
  C.push(C.key, communityAdmit({ member: B, on: true, cuts: [{ writer: cwB, seq: 1 }], at: C.at() }))
  c = comm(C)
  t.ok(c.admittedCws.has(cwB))
  r = buildGroup(g.input())
  t.is(r.members.get(X), 'banned', 'now its ban counts')
  t.ok(r.liveWriters.has(wB) && r.authorityWriters.has(wB))
  t.ok(shown(r).includes(wB + ':1'), 'and its earlier post shows')
  // An open community admits every CW.
  const O = community({ creator: Z, members: [{ diary: B, cw: cwB, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  t.ok(comm(O).admittedCws.has(cwB))
  const go = groupIn(O, { key: G1 })
  go.add(B, wB)
  gpost(go, wB, 5)
  t.alike(shown(buildGroup(go.input())), [wB + ':1'])
})

test('no authority after leaving: a departed admin moderation never counts, with or without a G leave', (t) => {
  const setup = () => {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    const g = groupIn(C, { key: G1 })
    g.add(A, wA).add(X, wX).add(Y, wY)
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(2) }))
    return { C, g }
  }
  const ban = (g, member, w, s, by = wA) => g.push(by, groupBan({ member, on: true, cuts: [{ writer: w, seq: 1 }], at: AT(s) }))
  const gLeave = (g, w, s) => g.push(w, groupLeave({ cuts: [{ writer: w, seq: g.len(w) }], at: AT(s) }))

  // Control: the ban counts while A is in C.
  let { C, g } = setup()
  ban(g, X, wX, 10)
  t.is(buildGroup(g.input()).members.get(X), 'banned', 'control')

  // Left C, then appended a ban dated before the leave.
  ;({ C, g } = setup())
  cwLeave(C, cwA, 50)
  ban(g, X, wX, 40)
  let r = buildGroup(g.input())
  t.is(r.members.get(X), 'member', 'a backdated ban counts for nothing')
  t.absent(r.authorityWriters.has(wA))

  // An honest ban, a G leave, then the community leave: still void.
  ;({ C, g } = setup())
  ban(g, X, wX, 10)
  gLeave(g, wA, 20)
  cwLeave(C, cwA, 30)
  t.is(buildGroup(g.input()).members.get(X), 'member', 'earlier moderation is void even after a G leave')

  // The re-audit reproductions: a community leave whose `ends` names a G
  // leave the leaver fills in later is now malformed, so the leave never
  // counts and the CW never retires through it; and a plain leave followed
  // by a backdated ban and an appended G leave grants nothing.
  ;({ C, g } = setup())
  const forward = { type: 'group-leave', seen: null, cuts: [{ writer: cwA, seq: C.len(cwA) }], ends: [{ writer: wA, seq: 3 }], at: AT(30) }
  t.is(validateGroupRecord(forward, 1, { community: true }), 'malformed')
  cwLeave(C, cwA, 30)
  ban(g, X, wX, 10)
  gLeave(g, wA, 20)
  r = buildGroup(g.input())
  t.is(r.members.get(X), 'member', 'a G leave appended later grants nothing')
  t.absent(r.authorityWriters.has(wA))

  // A rejoining G writer of a departed diary has no authority either.
  ;({ C, g } = setup())
  const l1 = gLeave(g, wA, 5)
  g.add(A, wB, { rejoin: l1, at: AT(6) })
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(7) }))
  ban(g, X, wX, 8, wB)
  t.is(buildGroup(g.input()).members.get(X), 'banned', 'control: the rejoin writer moderates while A is in C')
  cwLeave(C, cwA, 30)
  t.is(buildGroup(g.input()).members.get(X), 'member', 'void once A left C')
})

test('a creator out of C has no root authority, whatever its latest community leave says', (t) => {
  const world = () => {
    const D = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
    const h = groupIn(D, { key: G1, name: 'Antes' })
    h.add(X, wX)
    h.push(G1, groupAdmin({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(10) }))
    h.push(G1, groupMeta({ name: 'Depois', join: 'open', at: AT(11) }))
    return { D, h }
  }
  let { D, h } = world()
  let r = buildGroup(h.input())
  t.ok(r.admins.has(X), 'control: the root grant counts')
  t.is(r.name, 'Depois', 'control: the rename counts')
  cwLeave(D, D.key, 50)
  r = buildGroup(h.input())
  t.absent(r.admins.has(X), 'a root grant from a creator out of C counts for nothing')
  t.is(r.name, 'Antes', 'nor does its rename, earlier ones included')
  t.absent(r.authorityWriters.has(G1))
  // The re-audit reproduction: a root G leave and a later community leave
  // appended by the departed creator never bring the root back.
  ;({ D, h } = world())
  const first = cwLeave(D, D.key, 50)
  h.push(G1, groupLeave({ cuts: [{ writer: G1, seq: h.len(G1) }], at: AT(55) }))
  D.addWriter(Z, K(0x93), { rejoin: first })
  cwLeave(D, K(0x93), 60)
  r = buildGroup(h.input())
  t.absent(r.admins.has(X), 'a later community leave changes nothing')
  t.is(r.name, 'Antes')
})

test('gate: no admission withdrawal takes the root from C\'s creator; a group an admin made is an orphan', (t) => {
  // G's creator is C's creator, always a member while it stays in C: an
  // admission withdrawal naming it, from the root or from an admin, is void.
  const C = community({ creator: Z, join: 'approval', members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  gpost(g, G1, 5)
  t.alike(shown(buildGroup(g.input())), [G1 + ':1'], 'control')
  C.push(C.key, communityAdmit({ member: Z, on: false, cuts: [{ writer: C.key, seq: C.len(C.key) }], at: C.at() }))
  C.push(cwA, communityAdmit({ member: Z, on: false, cuts: [{ writer: C.key, seq: C.len(C.key) }], at: C.at() }))
  t.is(comm(C).members.get(Z), 'member')
  t.alike(shown(buildGroup(g.input())), [G1 + ':1'], 'root posts stay')
  // The old scenario (an admin's group losing its root when the admin's
  // admission is withdrawn) has no parent at all now.
  const h = groupIn(C, { key: G2, diary: A })
  gpost(h, G2, 5)
  const r = buildGroup(h.input())
  t.is(r.orphan, true, 'an admin header names no group of C')
  t.is(r.community, null, 'the gate is off')
})

test('gate: admittedCws follows the current admission generation', (t) => {
  const cwB2 = K(0x31)
  const C = community({ creator: Z, join: 'approval', members: [{ diary: B, cw: cwB, status: 'requested' }], creates: [{ by: Z, group: G1 }] })
  // An old-generation admit names a future CW with cut 0.
  C.push(C.key, communityAdmit({ member: B, on: true, cuts: [{ writer: cwB, seq: 1 }, { writer: cwB2, seq: 0 }], at: C.at() }))
  const leave = cwLeave(C, cwB, 50)
  C.addWriter(B, cwB2, { rejoin: leave })
  const c = comm(C)
  t.is(c.members.get(B), 'requested', 'the rejoin needs a new admit')
  t.absent(c.admittedCws.has(cwB2), 'a requested diary rejoin CW is not admitted')
  const g = groupIn(C, { key: G1 })
  g.add(B, wB, { cw: cwB2 })
  gpost(g, wB, 60)
  t.alike(shown(buildGroup(g.input())), [], 'its post stays hidden')
})

test('gate: an admission withdrawn in C hides the diary records in its groups until admitted again', (t) => {
  const C = community({ creator: Z, join: 'approval', members: [{ diary: B, cw: cwB, status: 'member' }, { diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  g.add(B, wB).add(X, wX)
  gpost(g, wB, 5)
  g.push(G1, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: g.len(wB) }], at: AT(6) }))
  g.push(wB, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(7) }))
  let r = buildGroup(g.input())
  t.alike(shown(r), [wB + ':1'], 'control: admitted, its post shows')
  t.is(r.members.get(X), 'banned', 'control: its ban counts')
  C.push(C.key, communityAdmit({ member: B, on: false, cuts: [{ writer: cwB, seq: 1 }], at: C.at() }))
  t.absent(comm(C).admittedCws.has(cwB), 'withdrawn')
  r = buildGroup(g.input())
  t.alike(shown(r), [], 'its earlier post is hidden')
  t.is(r.members.get(X), 'member', 'and its ban counts for nothing')
  t.absent(r.liveWriters.has(wB) || r.authorityWriters.has(wB))
  C.push(C.key, communityAdmit({ member: B, on: true, cuts: [{ writer: cwB, seq: 1 }], at: C.at() }))
  r = buildGroup(g.input())
  t.alike(shown(r), [wB + ':1'], 'admitted again, visible')
  t.is(r.members.get(X), 'banned')
  // Leaving keeps the earlier post visible (A1).
  const L = community({ creator: Z, join: 'approval', members: [{ diary: B, cw: cwB, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const h = groupIn(L, { key: G1 })
  h.add(B, wB)
  gpost(h, wB, 5)
  cwLeave(L, cwB, 50)
  t.ok(comm(L).admittedCws.has(cwB), 'a leave withdraws no admission')
  t.alike(shown(buildGroup(h.input())), [wB + ':1'])
})

test('gate: a G admin who left C loses the shield and the title, also after rejoining C', (t) => {
  const cwA2 = K(0x21)
  const wA2 = K(0x2001)
  const world = () => {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    const g = groupIn(C, { key: G1, join: 'approval' })
    g.add(A, wA).add(B, wB)
    g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(2) }))
    g.push(G1, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(3) }))
    return { C, g }
  }
  let { C, g } = world()
  const ban = () => g.push(wB, groupBan({ member: A, on: true, cuts: [{ writer: wA, seq: g.len(wA) }], at: AT(60) }))
  ban()
  t.not(buildGroup(g.input()).members.get(A), 'banned', 'control: a current admin is shielded')
  ;({ C, g } = world())
  cwLeave(C, cwA, 50)
  ban()
  let r = buildGroup(g.input())
  t.ok(r.bans.has(A), 'a departed admin has no shield: the ban counts')
  t.is(r.members.get(A), 'left', 'its status is out of G')
  t.absent(r.admins.has(A))

  ;({ C, g } = world())
  const leave = cwLeave(C, cwA, 50)
  C.addWriter(A, cwA2, { rejoin: leave })
  g.add(A, wA2, { cw: cwA2 })
  r = buildGroup(g.input())
  t.absent(r.admins.has(A), 'back in C on a device the grant never listed: no title')
  t.is(r.members.get(A), 'requested', 'and it waits for an admit in an approval group')
  t.ok(r.requests.includes(A))
  g.push(G1, groupAdmin({ member: A, on: true, cuts: [{ writer: wA2, seq: 1 }], at: AT(70) }))
  r = buildGroup(g.input())
  t.ok(r.admins.has(A), 're-granted on the new writer')
  t.is(r.members.get(A), 'member')
})

test('gate: the root of a departed creator anchors on the first leave of its current leave set', (t) => {
  const cwZ2 = K(0x92)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  const g = groupIn(C, { key: G1 })
  gpost(g, G1, 10)
  cwLeave(C, C.key, 20)
  gpost(g, G1, 30)
  t.alike(shown(buildGroup(g.input())), [G1 + ':1'], 'control: the post after the leave is withdrawn')
  // A second leave of the same leave set, on the creator's other CW, dated
  // far ahead.
  C.push(cwZ2, groupLeave({ cuts: [{ writer: cwZ2, seq: C.len(cwZ2) }], at: AT(5000) }))
  const r = buildGroup(g.input())
  t.ok(r.community !== null, 'G still under its community')
  t.alike(shown(r), [G1 + ':1'], 'the posts after the first leave stay withdrawn')
})

test('gate: an open community counts a rejoining CW on its binding join, before it writes anything', (t) => {
  // The node sequence: X leaves an open C; community.join writes a new CW
  // naming the leave and binds it, then a new Geral writer naming that CW,
  // which posts.
  const cwX2 = K(0x41)
  const wX2 = K(0x4001)
  const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1 })
  g.add(X, wX)
  gpost(g, wX, 5)
  const leave = cwLeave(C, cwX, 10)
  C.addWriter(X, cwX2, { rejoin: leave })
  g.add(X, wX2, { cw: cwX2 })
  gpost(g, wX2, 20)
  const c = comm(C)
  t.is(c.members.get(X), 'member')
  t.ok(c.liveWriters.has(cwX2) && c.admittedCws.has(cwX2), 'the rejoin CW is live and admitted')
  const r = buildGroup(g.input())
  t.alike(shown(r), [wX + ':1', wX2 + ':1'], 'the earlier post (A1) and the new one show')
  t.ok(r.liveWriters.has(wX2))
  // An approval community still needs the admission.
  const D = community({ creator: Z, join: 'approval', members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const dl = cwLeave(D, cwX, 10)
  D.addWriter(X, cwX2, { rejoin: dl })
  t.absent(comm(D).admittedCws.has(cwX2))
})

test('catalogue: a second leave never orphans the groups the creator made below its root cut', (t) => {
  const cwZ2 = K(0x92)
  const flows = [
    // Each later leave names the root at the first leave's cut: a leave
    // omitting the root would cut it at 0, withdrawing the C ban below.
    ['a leave on another device', (C, leave) => {
      C.push(cwZ2, groupLeave({ cuts: [{ writer: cwZ2, seq: C.len(cwZ2) }, { writer: C.key, seq: leave.seq }], at: AT(40) }))
    }],
    ['a leave on a fresh device dated far ahead', (C, leave) => {
      C.push(cwZ2, groupLeave({ cuts: [{ writer: cwZ2, seq: C.len(cwZ2) }, { writer: C.key, seq: leave.seq }], at: AT(5000) }))
    }],
    ['leave, rejoin, leave', (C, leave) => {
      C.addWriter(Z, K(0x94), { rejoin: leave })
      C.push(K(0x94), groupLeave({ cuts: [{ writer: K(0x94), seq: C.len(K(0x94)) }, { writer: C.key, seq: leave.seq }], at: AT(60) }))
    }]
  ]
  for (const [label, second] of flows) {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    const g = groupIn(C, { key: G1 })
    g.add(X, wX)
    gpost(g, wX, 5)
    // The creator bans X in C, then leaves above the ban.
    C.push(C.key, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: C.len(cwX) }], at: C.at() }))
    const leave = cwLeave(C, C.key, 30)
    second(C, leave)
    t.ok(comm(C).groups.includes(G1), label + ': still listed')
    const r = buildGroup(g.input())
    t.is(r.orphan, false, label)
    t.ok(r.community !== null, label + ': the gate stays on')
    t.alike(shown(r), [], label + ': a C ban still hides posts in G')
  }
  // A create in a CW never counts, before or after a demotion cut.
  const D = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A] })
  D.push(D.key, groupAdmin({ member: A, on: false, cuts: [{ writer: cwA, seq: D.len(cwA) }], at: D.at() }))
  D.push(cwA, groupCreateRecord({ group: G1, at: D.at() }))
  t.absent(comm(D).groups.includes(G1), 'a create after the demotion cut never counts')
  // And a create on a writer after that writer's own leave never counts.
  const E = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A] })
  cwLeave(E, cwA, 10)
  E.push(cwA, groupCreateRecord({ group: G1, at: AT(5) }))
  t.absent(comm(E).groups.includes(G1), 'a create appended after its writer left, whatever its clock')
})

test('catalogue: creates by a departed device on another CW never count, and never displace a creator', (t) => {
  const cwA2 = K(0x21)
  // A departed admin, from a fresh CW or one its grant lists, backdates a
  // create.
  for (const [label, listed] of [['a fresh CW', false], ['a CW its grant lists', true]]) {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A] })
    C.addWriter(A, cwA2)
    if (listed) C.push(C.key, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: 1 }, { writer: cwA2, seq: 1 }], at: C.at() }))
    cwLeave(C, cwA, 50)
    C.push(cwA2, groupCreateRecord({ group: G3, at: AT(1) }))
    t.absent(comm(C).groups.includes(G3), label)
  }

  // A foreign create naming an existing group never orphans it.
  const D = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A] })
  D.push(cwA, groupCreateRecord({ group: G2, at: AT(1) }))
  D.push(D.key, groupCreateRecord({ group: G2, at: AT(90) }))
  const d = comm(D)
  t.alike(d.groups, [G2], 'listed once')
  const own = groupIn(D, { key: G2, diary: Z })
  const r = buildGroup(own.input())
  t.is(r.orphan, false, 'the creator header still resolves')
  t.ok(r.community !== null)
  t.is(buildGroup(groupIn(D, { key: G2, diary: A }).input()).orphan, true, 'a header by the admin is an orphan: the catalogue is the creator\'s')

  // A departed creator filling the catalogue from a fresh CW, or from the
  // root after its cut: none counts, and the creates below the cut stay.
  const E = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  cwLeave(E, E.key, 50)
  E.addWriter(Z, cwA2)
  for (let i = 0; i < 31; i++) E.push(cwA2, groupCreateRecord({ group: K(0x7000 + i), at: AT(1) }))
  E.push(E.key, groupCreateRecord({ group: G3, at: AT(1) }))
  E.push(cwA, groupCreateRecord({ group: G2, at: AT(61) }))
  t.alike(comm(E).groups, [G1], 'the backdated creates do not count, nor root creates above the cut nor an admin create')
})

test('no authority after leaving: an old CW of a diary that left on a sibling and rejoined bans nothing', (t) => {
  const cw2 = K(0x22)
  const cw3 = K(0x23)
  const world = () => {
    const C = community({
      creator: Z,
      members: [{ diary: A, cw: cwA, status: 'member' }, { diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }],
      admins: [A],
      creates: [{ by: Z, group: G1 }]
    })
    const g = groupIn(C, { key: G1 })
    g.add(Y, wY)
    gpost(g, wY, 5)
    // A's sibling CW2 leaves C; A rejoins on CW3 and is granted there.
    C.addWriter(A, cw2)
    const leave = C.push(cw2, groupLeave({ cuts: [{ writer: cw2, seq: C.len(cw2) }], at: C.at() }))
    C.addWriter(A, cw3, { rejoin: leave })
    C.push(C.key, groupAdmin({ member: A, on: true, cuts: [{ writer: cw3, seq: 1 }], at: C.at() }))
    return { C, g }
  }
  const bans = (C, cw) => {
    const seen = { writer: cw3, seq: 0 }
    C.push(cw, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: C.len(cwX) }], seen, at: C.at() }))
    C.push(cw, communityBan({ group: G1, member: Y, on: true, seen, at: C.at() }))
  }
  let { C, g } = world()
  t.ok(comm(C).admins.has(A), 'control: A is a C admin on CW3')
  bans(C, cw3)
  t.is(comm(C).members.get(X), 'banned', 'control: from CW3 the C ban counts')
  t.is(buildGroup(g.input()).members.get(Y), 'banned', 'control: and so does the G ban')
  ;({ C, g } = world())
  bans(C, cwA)
  const c = comm(C)
  t.ok(c.admins.has(A))
  t.is(c.members.get(X), 'member', 'a group: null ban from the old CW1 is void')
  t.absent(c.bans.has(X))
  const r = buildGroup(g.input())
  t.is(r.members.get(Y), 'member', 'a group: G ban from the old CW1 is void')
  t.alike(shown(r), [wY + ':1'])
})

test('a C admin who left and rejoined on a fresh CW is no admin until re-granted, in C and in its groups', (t) => {
  const cwA2 = K(0x21)
  const wA2 = K(0x2001)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: B, cw: cwB, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1, join: 'approval' })
  g.add(B, wB)
  g.push(G1, groupAdmin({ member: B, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(2) }))
  g.add(A, wA)
  gpost(g, wA, 3)
  let r = buildGroup(g.input())
  t.ok(r.admins.has(A), 'control: a C admin is a G admin')
  t.is(r.members.get(A), 'member', 'control: no admit needed')
  t.alike(shown(r), [wA + ':1'])

  const leave = cwLeave(C, cwA, 10)
  C.addWriter(A, cwA2, { rejoin: leave })
  g.add(A, wA2, { cw: cwA2 })
  gpost(g, wA2, 20)
  const c = comm(C)
  t.is(c.members.get(A), 'member', 'back in the open C')
  t.absent(c.admins.has(A), 'not in C.admins: the grant never listed the fresh CW')
  r = buildGroup(g.input())
  t.absent(r.admins.has(A), 'no C admin title in G')
  t.is(r.members.get(A), 'requested', 'no approval exemption')
  t.ok(r.requests.includes(A))
  t.alike(shown(r), [], 'its posts wait for an admit, the one never admitted before its leave included')
  g.push(wB, groupBan({ member: A, on: true, cuts: [{ writer: wA2, seq: g.len(wA2) }], at: AT(30) }))
  r = buildGroup(g.input())
  t.is(r.members.get(A), 'banned', 'no shield: a G admin ban counts')

  // Re-granted on the fresh CW, A is a C admin again (and shielded in G).
  C.push(C.key, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA2, seq: 1 }], at: C.at() }))
  t.ok(comm(C).admins.has(A))
  r = buildGroup(g.input())
  t.ok(r.admins.has(A))
  t.not(r.members.get(A), 'banned')
})

test('a community creator who left C is no admin of C nor shielded in its groups until back', (t) => {
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  const g = groupIn(C, { key: G1, join: 'approval' })
  g.add(Z, wB, { cw: C.key })
  t.ok(comm(C).admins.has(Z), 'control')
  const leave = C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(50) }))
  C.push(cwA, communityBan({ group: G1, member: Z, on: true, cuts: [{ writer: wB, seq: 1 }], at: AT(60) }))
  let c = comm(C)
  t.absent(c.admins.has(Z), 'not an admin of C after leaving')
  const r = buildGroup(g.input())
  t.absent(r.community.admins.has(Z))
  t.ok(r.bans.has(Z), 'a community admin ban of it counts in G')
  t.absent(r.admins.has(Z))
  // Back as a member on a new CW: admin of C again.
  C.addWriter(Z, K(0x23), { rejoin: leave })
  c = comm(C)
  t.is(c.members.get(Z), 'member')
  t.ok(c.admins.has(Z), 'admin again while a member')
})

test('a leave written on an already retired CW never counts', (t) => {
  const cwX2 = K(0x41)
  const wX2 = K(0x4001)
  const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const leave = cwLeave(C, cwX, 10)
  C.addWriter(X, cwX2, { rejoin: leave })
  // A no-op on the new CW, so the old device can name it.
  const noop = C.push(cwX2, communityAdmit({ group: K(0x999), member: Z, on: true, cuts: [], at: AT(20) }))
  const g = groupIn(C, { key: G1 })
  g.add(X, wX2, { cw: cwX2 })
  gpost(g, wX2, 25)
  const before = comm(C)
  // The old device appends leaves: one dated later, one naming the new CW.
  C.push(cwX, groupLeave({ cuts: [{ writer: cwX, seq: C.len(cwX) }], at: AT(500) }))
  C.push(cwX, groupLeave({ seen: noop, cuts: [{ writer: cwX, seq: C.len(cwX) }, { writer: cwX2, seq: C.len(cwX2) }], at: AT(501) }))
  const c = comm(C)
  t.is(c.members.get(X), 'member', 'still a member on the new CW')
  t.ok(c.liveWriters.has(cwX2), 'the new CW stays live')
  t.absent(c.leaves.has(X))
  t.alike(c.lastLeave.get(X), leave, 'the stale leaves are no leaves')
  t.alike(sorted(c.liveWriters), sorted(before.liveWriters))
  const r = buildGroup(g.input())
  t.is(r.members.get(X), 'member')
  t.alike(shown(r), [wX2 + ':1'], 'its post stays visible')
})

test('a stolen retired sibling never retires, unadmits or unbounds its owner', (t) => {
  const cwXb = K(0x42)
  const cwX2 = K(0x41)
  const wX2 = K(0x4001)
  const wXb = K(0x4002)
  const setup = (join = 'open') => {
    const C = community({ creator: Z, join, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(X, cwXb)
    if (join === 'approval') C.push(C.key, communityAdmit({ member: X, on: true, cuts: [{ writer: cwX, seq: 1 }, { writer: cwXb, seq: 1 }], at: C.at() }))
    const L1 = cwLeave(C, cwX, 20)
    C.addWriter(X, cwX2, { rejoin: L1 })
    if (join === 'approval') C.push(C.key, communityAdmit({ member: X, on: true, cuts: [{ writer: cwX2, seq: 1 }], at: AT(30) }))
    return { C, L1 }
  }

  // The stolen sibling backdates a leave whose cuts list the new device.
  let { C } = setup()
  C.push(cwXb, groupLeave({ cuts: [{ writer: cwXb, seq: C.len(cwXb) }, { writer: cwX2, seq: 1 }], at: AT(10) }))
  let c = comm(C)
  t.is(c.members.get(X), 'member', 'the owner stays a member')
  t.ok(c.liveWriters.has(cwX2), 'its new device stays live')
  const g = groupIn(C, { key: G1 })
  g.add(X, wX2, { cw: cwX2 })
  gpost(g, wX2, 40)
  t.alike(shown(buildGroup(g.input())), [wX2 + ':1'])

  // Approval: a plain backdated leave of the same set never unadmits it.
  ;({ C } = setup('approval'))
  t.ok(comm(C).admittedCws.has(cwX2), 'control')
  C.push(cwXb, groupLeave({ cuts: [{ writer: cwXb, seq: C.len(cwXb) }], at: AT(10) }))
  c = comm(C)
  t.ok(c.admittedCws.has(cwX2), 'the gen-1 admit still covers the current generation')
  t.is(c.members.get(X), 'member')

  // In a closed set each device keeps its own leave as its boundary (owner
  // decision, cycle 10): a device without a leave ends at the leave the
  // rejoin names; the stolen device's own backdated leave hides what was
  // written through that device itself (accepted residual).
  ;({ C } = setup())
  const h = groupIn(C, { key: G1 })
  h.add(X, wXb, { cw: cwXb })
  gpost(h, wXb, 15)
  t.alike(shown(buildGroup(h.input())), [wXb + ':1'], 'no leave on B: its history below the named leave stays visible')
  C.push(cwXb, groupLeave({ cuts: [{ writer: cwXb, seq: C.len(cwXb) }], at: AT(5) }))
  t.alike(shown(buildGroup(h.input())), [], 'the residual: B own backdated leave hides what B wrote')
})

test('a stolen creator device never reaches the community root', (t) => {
  const cwZb = K(0x92)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZb)
  C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(50) }))
  t.ok(comm(C).groups.includes(G1), 'control: the departed creator groups stay')
  C.push(cwZb, groupLeave({ cuts: [{ writer: cwZb, seq: C.len(cwZb) }, { writer: C.key, seq: 0 }], at: AT(51) }))
  const c = comm(C)
  t.ok(c.groups.includes(G1), 'a leave on another device listing the root at 0 withdraws nothing there')
  t.is(c.general, G1)
})

test('a rejoin naming a stale leave folds the same in the community and its groups', (t) => {
  const cwX2 = K(0x41)
  const cwX3 = K(0x43)
  const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const L1 = cwLeave(C, cwX, 10)
  C.addWriter(X, cwX2, { rejoin: L1 })
  const stale = cwLeave(C, cwX, 20)
  C.addWriter(X, cwX3, { rejoin: stale })
  const c = comm(C)
  t.is(c.members.get(X), 'member')
  t.ok(c.liveWriters.has(cwX2))
  t.absent(c.liveWriters.has(cwX3), 'a device naming a stale leave is of no current generation')
  t.alike(c.lastLeave.get(X), L1)
  const g = groupIn(C, { key: G1 })
  g.add(X, K(0x4003), { cw: cwX3 })
  t.absent(buildGroup(g.input()).liveWriters.has(K(0x4003)))
})

test('a stolen sibling cut never voids the leave its owner rejoin names', (t) => {
  const cwXb = K(0x42)
  const cwX2 = K(0x41)
  const cwX2b = K(0x44)
  const cwX3 = K(0x45)
  const wX2 = K(0x4001)
  // Generation 0: the stolen sibling lists the device that wrote L1.
  let C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(X, cwXb)
  const L1 = cwLeave(C, cwX, 20)
  C.addWriter(X, cwX2, { rejoin: L1 })
  C.push(cwXb, groupLeave({ cuts: [{ writer: cwXb, seq: C.len(cwXb) }, { writer: cwX, seq: 1 }], at: AT(10) }))
  let c = comm(C)
  t.is(c.members.get(X), 'member')
  t.ok(c.liveWriters.has(cwX2), 'the rejoin device stays live')
  const g = groupIn(C, { key: G1 })
  g.add(X, wX2, { cw: cwX2 })
  gpost(g, wX2, 40)
  t.alike(shown(buildGroup(g.input())), [wX2 + ':1'], 'its posts stay visible')

  // Generation 1: siblings cwX2 and cwX2b; L2 on cwX2, rejoin cwX3; the
  // stolen cwX2b lists cwX2.
  C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  const l1 = cwLeave(C, cwX, 20)
  C.addWriter(X, cwX2, { rejoin: l1 })
  C.addWriter(X, cwX2b, { rejoin: l1 })
  const L2 = cwLeave(C, cwX2, 40)
  C.addWriter(X, cwX3, { rejoin: L2 })
  C.push(cwX2b, groupLeave({ cuts: [{ writer: cwX2b, seq: C.len(cwX2b) }, { writer: cwX2, seq: 1 }], at: AT(35) }))
  c = comm(C)
  t.is(c.members.get(X), 'member')
  t.ok(c.liveWriters.has(cwX3), 'the gen-2 device stays live')
})

test('an open leave set ends a device at its own leave, not a sibling listing it', (t) => {
  const cwXb = K(0x42)
  const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(X, cwXb)
  const g = groupIn(C, { key: G1 })
  g.add(X, wX)
  gpost(g, wX, 15)
  C.push(cwX, groupLeave({ cuts: [{ writer: cwX, seq: C.len(cwX) }, { writer: cwXb, seq: 1 }], at: AT(20) }))
  C.push(cwXb, groupLeave({ cuts: [{ writer: cwXb, seq: C.len(cwXb) }, { writer: cwX, seq: 1 }], at: AT(10) }))
  t.alike(shown(buildGroup(g.input())), [wX + ':1'], 'the post before the owner leave stays visible')
})

test('closed set: each device keeps its own leave as its boundary, whatever leave the rejoin names', (t) => {
  const w1 = K(0x46)
  const w2 = K(0x47)
  const w3 = K(0x48)
  const w4 = K(0x49)
  const g1 = K(0x4006)
  const g2 = K(0x4007)
  const g3 = K(0x4008)
  const setup = () => {
    const C = community({ creator: Z, members: [{ diary: X, cw: w1, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(X, w2)
    C.addWriter(X, w3)
    const g = groupIn(C, { key: G1 })
    g.add(X, g1, { cw: w1 }).add(X, g2, { cw: w2 }).add(X, g3, { cw: w3 })
    gpost(g, g1, 18)
    gpost(g, g2, 19)
    gpost(g, g3, 20)
    // The owner leaves C from w3, listing every device.
    const L3 = C.push(w3, groupLeave({ cuts: [{ writer: w1, seq: C.len(w1) }, { writer: w2, seq: C.len(w2) }, { writer: w3, seq: C.len(w3) }], at: AT(50) }))
    // The thief appends on the stolen w1 a leave seen after L3, dated early.
    const L1 = C.push(w1, groupLeave({ seen: L3, cuts: [], at: AT(-1000) }))
    return { C, g, L1, L3 }
  }
  for (const named of ['L1', 'L3']) {
    const { C, g, L1, L3 } = setup()
    C.addWriter(X, w4, { rejoin: named === 'L1' ? L1 : L3 })
    const c = comm(C)
    t.is(c.members.get(X), 'member', named)
    t.alike(c.leaveOf.get(w3), L3, named + ': leaveOf names each device own leave')
    t.alike(c.leaveOf.get(w1), L1)
    t.absent(c.leaveOf.has(w2))
    const shownNow = shown(buildGroup(g.input()))
    t.ok(shownNow.includes(g3 + ':1'), named + ': the owner posts on w3 stay visible')
    // A sibling without a leave ends at the named leave: visible when the
    // rejoin names the owner's leave (nodes name their own device's leave).
    if (named === 'L3') t.ok(shownNow.includes(g2 + ':1'), 'a sibling without a leave stays visible below the named leave')
    // Accepted residual (owner decision A): what was written through the
    // stolen device itself is hidden by its own backdated leave.
    t.absent(shownNow.includes(g1 + ':1'), named + ': residual, w1 own post hidden')
  }
})

test('gate: a CW a community unban did not list stays banned in C and in its groups', (t) => {
  const cwX2 = K(0x41)
  const wX2 = K(0x4001)
  const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(X, cwX2)
  const g = groupIn(C, { key: G1 })
  g.add(X, wX, { cw: cwX }).add(X, wX2, { cw: cwX2 })
  const ban = C.push(C.key, communityBan({ member: X, on: true, cuts: [{ writer: cwX, seq: C.len(cwX) }, { writer: cwX2, seq: C.len(cwX2) }], at: C.at() }))
  gpost(g, wX2, 40)
  C.push(C.key, communityBan({ member: X, on: false, lifts: ban, cuts: [{ writer: cwX, seq: C.len(cwX) }], at: C.at() }))
  let c = comm(C)
  t.is(c.members.get(X), 'member')
  t.absent(c.liveWriters.has(cwX2), 'the unlisted CW is not live in C')
  t.ok(c.liveWriters.has(cwX))
  let r = buildGroup(g.input())
  t.alike(shown(r), [], 'the post written through it during the ban stays hidden')
  t.absent(r.liveWriters.has(wX2))
  t.ok(r.liveWriters.has(wX))
  // An unban that lists it restores everything.
  C.push(C.key, communityBan({ member: X, on: false, lifts: ban, cuts: [{ writer: cwX2, seq: C.len(cwX2) }], at: C.at() }))
  c = comm(C)
  t.ok(c.liveWriters.has(cwX2))
  r = buildGroup(g.input())
  t.alike(shown(r), [wX2 + ':1'])
  t.ok(r.liveWriters.has(wX2))
})

test('the creator root carries no authority in C after any creator leave, from any device', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const setup = () => {
    const C = community({ creator: Z, join: 'approval', members: [{ diary: A, cw: cwA, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }, { diary: X, cw: cwX, status: 'requested' }], admins: [A], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    return C
  }
  const after = (C) => {
    C.push(C.key, groupAdmin({ member: Y, on: true, cuts: [{ writer: cwY, seq: C.len(cwY) }], at: AT(60) }))
    C.push(C.key, groupMeta({ name: 'Bairro', join: 'open', at: AT(61) }))
    C.push(C.key, communityAdmit({ member: X, on: true, cuts: [{ writer: cwX, seq: 1 }], at: AT(62) }))
    return comm(C)
  }
  // Open set: the creator leaves from its second CW, listing the root, and
  // its diary confirms it.
  let C = setup()
  const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.confirm(Z, cwZ2)
  let c = after(C)
  t.ok(c.admins.has(A), 'a grant below the root cut still counts')
  t.absent(c.admins.has(Y), 'a later root grant is void')
  t.is(c.join, 'approval', 'a later root meta is void')
  t.is(c.members.get(X), 'requested', 'a later root admit is void')
  t.ok(c.groups.includes(G1), 'the catalogue is intact')

  // Closed set: the creator rejoins naming its own leave; the same holds and
  // it still admits through its new CW.
  C = setup()
  const L2 = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.confirm(Z, cwZ2)
  t.alike(L2, L)
  C.addWriter(Z, cwZ3, { rejoin: L2 })
  c = after(C)
  t.is(c.members.get(Z), 'member')
  t.ok(c.admins.has(A))
  t.absent(c.admins.has(Y))
  t.is(c.join, 'approval')
  t.ok(c.groups.includes(G1))
  C.push(cwZ3, communityAdmit({ member: X, on: true, cuts: [{ writer: cwX, seq: 1 }], at: AT(70) }))
  t.is(comm(C).members.get(X), 'member', 'the creator admits through its new CW')

  // A confirmed creator leave that does not touch the root gives no bound
  // (cycle 14): the root keeps its powers.
  C = setup()
  C.push(cwZ2, groupLeave({ cuts: [{ writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.confirm(Z, cwZ2)
  c = after(C)
  t.ok(c.admins.has(A), 'an earlier grant counts')
  t.ok(c.admins.has(Y), 'and so does a later one')
  t.ok(c.groups.includes(G1), 'creates keep their protection')

  // A stolen sibling's forged low cut, never confirmed, next to the
  // creator's real confirmed leave never orphans a group.
  C = setup()
  const cwZ4 = K(0x94)
  C.addWriter(Z, cwZ4)
  C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.confirm(Z, cwZ2)
  C.push(cwZ4, groupLeave({ cuts: [{ writer: C.key, seq: 0 }, { writer: cwZ4, seq: C.len(cwZ4) }], at: AT(40) }))
  c = comm(C)
  t.ok(c.groups.includes(G1))
  t.is(c.general, G1)
})

test('an open set ends a leave-free device at the latest leave listing it', (t) => {
  const cwXb = K(0x42)
  const cwXs = K(0x43)
  const wXb = K(0x4002)
  const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(X, cwXb)
  C.addWriter(X, cwXs)
  const g = groupIn(C, { key: G1 })
  g.add(X, wXb, { cw: cwXb })
  gpost(g, wXb, 20)
  // The owner's real leave lists the leave-free device; a stolen sibling
  // appends an earlier one listing it too.
  C.push(cwX, groupLeave({ cuts: [{ writer: cwX, seq: C.len(cwX) }, { writer: cwXb, seq: 1 }], at: AT(30) }))
  C.push(cwXs, groupLeave({ cuts: [{ writer: cwXs, seq: C.len(cwXs) }, { writer: cwXb, seq: 1 }], at: AT(10) }))
  t.alike(shown(buildGroup(g.input())), [wXb + ':1'], 'the post before the owner leave stays visible')
})

test('a forged leave on the retired root bounds it only at its own seq', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  for (const closed of [false, true]) {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }, { by: Z, group: G2 }] })
    C.addWriter(Z, cwZ2)
    // The creator leaves from cwZ2, listing the root at its length X.
    const L1 = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
    // A thief holding the root appends a leave there listing the root at 0,
    // dated early, then a grant.
    C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: 0 }], at: AT(1) }))
    C.push(C.key, groupAdmin({ member: Y, on: true, cuts: [{ writer: cwY, seq: C.len(cwY) }], at: AT(60) }))
    if (closed) C.addWriter(Z, cwZ3, { rejoin: L1 })
    const label = closed ? 'closed: ' : 'open: '
    const c = comm(C)
    t.alike(c.groups, [G1, G2].sort(), label + 'the catalogue stays')
    t.is(c.general, G1, label + 'Geral stays')
    t.ok(c.admins.has(A), label + 'a grant below X stays')
    t.absent(c.admins.has(Y), label + 'a root grant at or above X is void')
  }
})

test('while the creator is out, root creates after its recorded cut never count', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const cwZ4 = K(0x94)
  const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.addWriter(Z, cwZ4)
  const cut = C.len(C.key)
  const L1 = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: cut }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.push(C.key, groupCreateRecord({ group: G3, at: AT(60) }))
  t.alike(comm(C).groups, [G1, G3].sort(), 'unconfirmed, a leave on another device bounds nothing')
  C.confirm(Z, cwZ2)
  t.alike(comm(C).groups, [G1], 'open set, confirmed: a create after X does not count')
  // A stolen sibling's unconfirmed leave listing a higher cut moves nothing.
  C.push(cwZ4, groupLeave({ cuts: [{ writer: C.key, seq: cut + 1 }, { writer: cwZ4, seq: C.len(cwZ4) }], at: AT(55) }))
  t.alike(comm(C).groups, [G1], 'an unconfirmed forged cut moves nothing')
  // After the rejoin naming the creator's leave, the limit is its cut.
  C.addWriter(Z, cwZ3, { rejoin: L1 })
  t.alike(comm(C).groups, [G1], 'closed set: still not counted')
})

test('confirmed leaves: a thief on the retired root grants and creates nothing once the creator leave is confirmed', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  for (const named of [null, 'cwZ2', 'root']) {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
    C.confirm(Z, cwZ2)
    C.push(C.key, groupAdmin({ member: A, on: true, cuts: [{ writer: cwA, seq: C.len(cwA) }], at: AT(55) }))
    C.push(C.key, groupCreateRecord({ group: G3, at: AT(56) }))
    const R = C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(60) }))
    // A new device returns naming either leave: the confirmed one bounds.
    if (named !== null) C.addWriter(Z, cwZ3, { rejoin: named === 'root' ? R : L })
    const c = comm(C)
    const label = named === null ? 'open' : 'closed naming ' + named
    t.alike(c.groups, [G1], label + ': the thief create does not count')
    t.absent(c.admins.has(A), label + ': nor its grant')
    if (named === null) t.alike(c.confirmedLeaveOf.get(Z), L, 'the confirmed leave a new device names')
  }
})

test('confirmed leaves: a stolen current CW forging a leave hides none of the owner other devices', (t) => {
  const w1 = K(0x46)
  const w2 = K(0x47)
  const w4 = K(0x49)
  const g2 = K(0x4007)
  const C = community({ creator: Z, members: [{ diary: X, cw: w1, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(X, w2)
  const g = groupIn(C, { key: G1 })
  g.add(X, g2, { cw: w2 })
  gpost(g, g2, 20)
  gpost(g, g2, 21)
  const forged = C.push(w1, groupLeave({ cuts: [{ writer: w1, seq: C.len(w1) }], at: AT(-100000) }))
  t.alike(shown(buildGroup(g.input())), [g2 + ':1', g2 + ':2'], 'open: unconfirmed, it withdraws nothing on w2')
  C.addWriter(X, w4, { rejoin: forged })
  t.alike(shown(buildGroup(g.input())), [g2 + ':1', g2 + ':2'], 'after a new device names it, still nothing')
})

test('confirmed leaves: a stolen sibling forged low root cut voids nothing next to a confirmed creator leave', (t) => {
  const cwZ2 = K(0x92)
  const cwZ4 = K(0x94)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.addWriter(Z, cwZ4)
  C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.confirm(Z, cwZ2)
  C.push(cwZ4, groupLeave({ cuts: [{ writer: C.key, seq: 0 }, { writer: cwZ4, seq: C.len(cwZ4) }], at: AT(40) }))
  const c = comm(C)
  t.ok(c.admins.has(A), 'the earlier root grant stays')
  t.alike(c.groups, [G1])
})

test('confirmed leaves: the interim rule applies until the diary off join arrives', (t) => {
  const cwZ2 = K(0x92)
  const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.push(C.key, groupCreateRecord({ group: G3, at: AT(56) }))
  // Until a confirmation arrives only a leave written on the root bounds
  // it, at its own seq: the thief's root leave comes after the create.
  C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(60) }))
  t.alike(comm(C).groups, [G1, G3].sort(), 'interim: only the root leave bounds, at its own seq')
  C.confirm(Z, cwZ2)
  t.alike(comm(C).groups, [G1], 'confirmed: the creator leave bounds')
})

test('confirmed leaves: an honest leave from one device withdraws a later post on another', (t) => {
  const w1 = K(0x46)
  const w2 = K(0x47)
  const g2 = K(0x4007)
  const C = community({ creator: Z, members: [{ diary: X, cw: w1, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(X, w2)
  const g = groupIn(C, { key: G1 })
  g.add(X, g2, { cw: w2 })
  gpost(g, g2, 20)
  const L = C.push(w1, groupLeave({ cuts: [{ writer: w1, seq: C.len(w1) }, { writer: w2, seq: C.len(w2) }], at: AT(30) }))
  g.push(g2, groupPost({ text: 'depois', seen: { writer: w1, seq: L.seq }, at: AT(40) }))
  t.alike(shown(buildGroup(g.input())), [g2 + ':1', g2 + ':2'], 'unconfirmed: nothing withdrawn on w2')
  C.confirm(X, w1)
  t.alike(shown(buildGroup(g.input())), [g2 + ':1'], 'confirmed: the post after the leave is withdrawn')
})

test('confirmed leaves: a departed creator G root is bounded only by a confirmed leave or one on C root', (t) => {
  const cwZ2 = K(0x92)
  const setup = () => {
    const C = community({ creator: Z, creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    const g = groupIn(C, { key: G1 })
    gpost(g, G1, 10)
    const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(30) }))
    g.push(G1, groupPost({ text: 'depois', seen: null, at: AT(40) }))
    return { C, g, L }
  }
  let { C, g } = setup()
  t.alike(shown(buildGroup(g.input())), [G1 + ':1', G1 + ':2'], 'unconfirmed and not on C root: no withdrawal')
  C.confirm(Z, cwZ2)
  t.alike(shown(buildGroup(g.input())), [G1 + ':1'], 'confirmed: the root post after it is withdrawn')
  ;({ C, g } = setup())
  C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(35) }))
  t.alike(shown(buildGroup(g.input())), [G1 + ':1'], 'a leave written on C root bounds it too')
})

test('interim rule: an unconfirmed forged sibling leave never bounds the root, also after a rejoin naming it', (t) => {
  const cwZ4 = K(0x94)
  const cwZ3 = K(0x93)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ4)
  const forged = C.push(cwZ4, groupLeave({ cuts: [{ writer: C.key, seq: 0 }, { writer: cwZ4, seq: C.len(cwZ4) }], at: AT(40) }))
  let c = comm(C)
  t.alike(c.groups, [G1], 'open: the catalogue stays')
  t.is(c.general, G1, 'and Geral')
  t.ok(c.admins.has(A), 'and the grants')
  C.addWriter(Z, cwZ3, { rejoin: forged })
  C.push(C.key, groupAdmin({ member: Y, on: true, cuts: [{ writer: cwY, seq: C.len(cwY) }], at: AT(60) }))
  c = comm(C)
  t.is(c.members.get(Z), 'member')
  t.alike(c.groups, [G1], 'closed: the catalogue stays')
  t.ok(c.admins.has(A))
  t.ok(c.admins.has(Y), 'the creator keeps its root powers: a later root grant counts')
})

test('interim rule: a creator leave on the root device bounds it at its own seq, confirmed or not', (t) => {
  for (const confirmed of [false, true]) {
    const C = community({ creator: Z, members: [{ diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(50) }))
    if (confirmed) C.confirm(Z, C.key)
    C.push(C.key, groupAdmin({ member: Y, on: true, cuts: [{ writer: cwY, seq: C.len(cwY) }], at: AT(60) }))
    C.push(C.key, groupCreateRecord({ group: G3, at: AT(61) }))
    const c = comm(C)
    const label = confirmed ? 'confirmed: ' : 'unconfirmed: '
    t.alike(c.groups, [G1], label + 'a root create after it does not count')
    t.absent(c.admins.has(Y), label + 'nor a root grant')
  }
})

test('group-cut: the creator diary mark ends the G root authority, even after the creator returns', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const setup = ({ mark = true, markBy = Z, leave = true } = {}) => {
    const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    const g = groupIn(C, { key: G1 })
    g.add(X, wX).add(Y, wY)
    // A grant below the cut.
    g.push(G1, groupAdmin({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(40) }))
    const L = leave ? C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) })) : null
    if (leave) C.confirm(Z, cwZ2)
    if (mark) g.mark(markBy, G1, leave ? g.len(G1) : 0)
    // A thief holding the G root bans X and renames G, then the creator is back.
    g.push(G1, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: g.len(wX) }], at: AT(60) }))
    g.push(G1, groupMeta({ name: 'Roubado', join: 'open', at: AT(61) }))
    if (leave) C.addWriter(Z, cwZ3, { rejoin: L })
    return buildGroup(g.input())
  }
  let r = setup()
  t.is(r.community.members.get(Z), 'member', 'the creator is back')
  t.is(r.members.get(X), 'member', 'the thief ban after the cut never counts')
  t.ok(r.admins.has(Y), 'a grant below the cut still counts')
  t.is(r.name, 'Varanda', 'a root meta above the cut is void')
  t.absent(r.authorityWriters.has(G1), 'the root has no authority')
  // With no creator leave, a mark from another diary at cut 0 would void
  // everything if it counted.
  r = setup({ markBy: X, leave: false })
  t.is(r.members.get(X), 'banned', 'a mark from another diary is ignored')
  r = setup({ mark: false, leave: false })
  t.is(r.members.get(X), 'banned', 'with no creator leave an unmarked root keeps its powers')
  t.is(r.name, 'Roubado')
  // After a confirmed creator leave, an unmarked root carries no authority
  // at all (owner decision, cycle 21).
  r = setup({ mark: false })
  t.is(r.members.get(X), 'member', 'without a mark after a confirmed leave the root ban is void')
  t.is(r.name, 'Varanda')
  t.absent(r.admins.has(Y), 'and so is its grant below the leave')
  t.is(r.rootCut, 0)
})

test('group-cut: a creator diary read with a gap keeps the G root powerless once the creator has left C', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const build = (left) => {
    const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    const g = groupIn(C, { key: G1 })
    g.add(X, wX)
    if (left) {
      const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
      C.confirm(Z, cwZ2)
      C.addWriter(Z, cwZ3, { rejoin: L })
    }
    g.push(G1, groupBan({ member: X, on: true, cuts: [{ writer: wX, seq: g.len(wX) }], at: AT(60) }))
    // The creator's diary as read has a hole: a mark may be missing.
    const input = g.input()
    input.marks = new Map([[Z, [{ gap: true }]]])
    return buildGroup(input)
  }
  t.is(build(true).members.get(X), 'member', 'after a leave and a return, the root acts on nothing')
  t.is(build(false).members.get(X), 'banned', 'a creator that never left keeps its root powers')
})

test('groupCutHistory: the marks of a diary for a group, and a gap flag', (t) => {
  const { groupCutHistory } = require('../lib/group')
  const { groupCutRecord, groupJoinRecord } = require('../lib/records')
  const entries = [
    { seq: 0, record: { type: 'member-cert' } },
    { seq: 1, record: groupJoinRecord({ group: G1, writer: G1, on: true, at: AT(1) }) },
    { seq: 2, record: groupCutRecord({ group: G1, writer: G1, cut: 4, at: AT(2) }) },
    { seq: 3, record: groupCutRecord({ group: G2, writer: G2, cut: 1, at: AT(3) }) }
  ]
  t.alike(groupCutHistory(entries, G1), [{ writer: G1, cut: 4, seq: 2 }])
  t.alike(groupCutHistory([entries[0], entries[2]], G1), [{ writer: G1, cut: 4, seq: 2 }, { gap: true }], 'a hole below a mark')
})

test('a returning creator demotes through its CW an admin a thief granted on the root', (t) => {
  const { communityDemote } = require('../lib/group')
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const D = B
  const cwD = cwB
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: D, cw: cwD, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  // The thief, holding the creating device, grants D on the root before the
  // creator notices; the creator then leaves from cwZ2 and comes back.
  C.push(C.key, groupAdmin({ member: D, on: true, cuts: [{ writer: cwD, seq: C.len(cwD) }], at: AT(40) }))
  const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.confirm(Z, cwZ2)
  C.addWriter(Z, cwZ3, { rejoin: L })
  let c = comm(C)
  t.ok(c.admins.has(D), 'the grant below the cut stands')
  // A demotion from another diary's CW is ignored.
  C.push(cwA, communityDemote({ member: D, seen: c.last, at: AT(60) }))
  t.ok(comm(C).admins.has(D), 'only the creator demotes this way')
  c = comm(C)
  C.push(cwZ3, communityDemote({ member: D, seen: c.last, at: AT(61) }))
  c = comm(C)
  t.absent(c.admins.has(D), 'the creator CW demotion counts')
  C.push(cwZ3, communityBan({ member: D, on: true, cuts: [{ writer: cwD, seq: C.len(cwD) }], seen: c.last, at: AT(62) }))
  t.is(comm(C).members.get(D), 'banned', 'and then a ban works')
  t.is(validateGroupRecord({ ...communityDemote({ member: D, at: AT(1) }), on: true }, 1, { community: true }), 'root-only', 'a CW never grants')
})

test('a returning creator demotes through its CW a G admin a thief granted on the G root', (t) => {
  const { communityDemote } = require('../lib/group')
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  const g = groupIn(C, { key: G1 })
  g.add(X, wX).add(Y, wY)
  g.push(G1, groupAdmin({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(40) }))
  const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.confirm(Z, cwZ2)
  g.mark(Z, G1, g.len(G1))
  C.addWriter(Z, cwZ3, { rejoin: L })
  let r = buildGroup(g.input())
  t.ok(r.admins.has(Y), 'the G grant below the mark stands')
  // From another diary's CW: ignored.
  C.push(cwX, communityDemote({ group: G1, member: Y, seen: r.last, at: AT(60) }))
  t.ok(buildGroup(g.input()).admins.has(Y))
  r = buildGroup(g.input())
  C.push(cwZ3, communityDemote({ group: G1, member: Y, seen: r.last, at: AT(61) }))
  r = buildGroup(g.input())
  t.absent(r.admins.has(Y), 'the creator CW demotion of a G admin counts')
  C.push(cwZ3, communityBan({ group: G1, member: Y, on: true, cuts: [{ writer: wY, seq: g.len(wY) }], seen: r.last, at: AT(62) }))
  t.is(buildGroup(g.input()).members.get(Y), 'banned', 'and then a ban in G works')
})

test('a creator CW demotion counts only once the diary shows the creating device lost its powers', (t) => {
  const { communityDemote } = require('../lib/group')
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  // C: no creator leave at all (a stolen current secondary CW), an
  // unconfirmed leave, then a confirmed one.
  for (const mode of ['none', 'unconfirmed', 'confirmed']) {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    let cw = cwZ2
    if (mode !== 'none') {
      const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
      if (mode === 'confirmed') C.confirm(Z, cwZ2)
      C.addWriter(Z, cwZ3, { rejoin: L })
      cw = cwZ3
    }
    C.push(cw, communityDemote({ member: A, seen: comm(C).last, at: AT(60) }))
    t.is(comm(C).admins.has(A), mode !== 'confirmed', 'C, ' + mode)
  }
  // G: no leave (a stolen current secondary CW demotes), no mark, then a
  // mark (the creator's leave confirmed in both). A gap alone, or no mark
  // after a confirmed leave, voids the root grant itself (gRootCut 0).
  for (const mode of ['no leave', 'no mark', 'mark']) {
    const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    const g = groupIn(C, { key: G1 })
    g.add(X, wX).add(Y, wY)
    g.push(G1, groupAdmin({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(40) }))
    let cw = cwZ2
    if (mode !== 'no leave') {
      const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
      C.confirm(Z, cwZ2)
      if (mode === 'mark') g.mark(Z, G1, g.len(G1))
      C.addWriter(Z, cwZ3, { rejoin: L })
      cw = cwZ3
    }
    const input = () => g.input()
    C.push(cw, communityDemote({ group: G1, member: Y, seen: buildGroup(input()).last, at: AT(61) }))
    t.is(buildGroup(input()).admins.has(Y), mode === 'no leave', 'G, ' + mode)
  }
})

test('exact confirmation: only a group-confirm naming the leave writer, seq and digest confirms it', (t) => {
  const { leaveDigest } = require('../lib/group')
  const cwZ2 = K(0x92)
  const setup = () => {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    return C
  }
  const later = (C) => {
    C.push(C.key, groupAdmin({ member: Y, on: true, cuts: [{ writer: cwY, seq: C.len(cwY) }], at: AT(70) }))
    return comm(C)
  }
  // A key-copy holder's leave lands on cwZ2 first (listing the root at 0);
  // the owner's own leave after it is stale on that writer. A confirm naming
  // the owner's leave confirms nothing counted: the attacker's leave never
  // bounds the root.
  let C = setup()
  C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: 0 }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(40) }))
  const own = groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) })
  const L = C.push(cwZ2, own)
  C.confirmRaw(Z, cwZ2, L.seq, leaveDigest(own))
  let c = later(C)
  t.ok(c.admins.has(A), 'the earlier grant stands: the attacker leave bounds nothing')
  t.alike(c.groups, [G1])
  t.is(c.cwDemote, false)

  // A confirm whose digest names another record at that seq (a divergent
  // copy) confirms nothing.
  C = setup()
  const real = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.confirmRaw(Z, cwZ2, real.seq, leaveDigest(groupLeave({ cuts: [{ writer: C.key, seq: 0 }], at: AT(50) })))
  c = later(C)
  t.ok(c.admins.has(Y), 'not confirmed: no root bound yet')
  t.alike(c.confirmedLeaveOf.get(Z), undefined)

  // An off join alone confirms nothing anymore.
  C = setup()
  C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  const joins = C.joins.get(Z)
  joins.push({ writer: cwZ2, on: false, seq: joins.length + 1 })
  c = later(C)
  t.ok(c.admins.has(Y), 'an off join does not confirm')
  t.is(c.cwDemote, false)

  // The exact confirm does.
  C = setup()
  C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
  C.confirm(Z, cwZ2)
  c = later(C)
  t.absent(c.admins.has(Y), 'confirmed: a later root grant is void')
  t.is(c.cwDemote, true)
})

test('a creator facing a root key copy that left on the root can demote through its CW', (t) => {
  const { communityDemote } = require('../lib/group')
  const D = B
  const cwD = cwB
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  for (const onRoot of [true, false]) {
    const C = community({ creator: Z, members: [{ diary: D, cw: cwD, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    // The key-copy holder grants D on the root, then leaves: on the root
    // itself, or (a secondary-CW-only thief) on cwZ2.
    C.push(C.key, groupAdmin({ member: D, on: true, cuts: [{ writer: cwD, seq: C.len(cwD) }], at: AT(40) }))
    const L = onRoot
      ? C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(50) }))
      : C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
    C.addWriter(Z, cwZ3, { rejoin: L })
    let c = comm(C)
    const label = onRoot ? 'on-root leave: ' : 'secondary CW only: '
    t.is(c.cwDemote, onRoot, label + 'cwDemote')
    t.ok(c.admins.has(D), label + 'the grant stands until demoted')
    C.push(cwZ3, communityDemote({ member: D, seen: c.last, at: AT(60) }))
    c = comm(C)
    t.is(c.admins.has(D), !onRoot, label + 'the creator CW demotion')
    C.push(cwZ3, communityBan({ member: D, on: true, cuts: [{ writer: cwD, seq: C.len(cwD) }], seen: c.last, at: AT(61) }))
    t.is(comm(C).members.get(D), onRoot ? 'banned' : 'member', label + 'a ban once demoted')
  }
})

test('rootAuthority: only a confirmed creator leave bounding the root, or a leave on the root, ends it', (t) => {
  const cwZ2 = K(0x92)
  const world = () => {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }] })
    C.addWriter(Z, cwZ2)
    return C
  }
  let C = world()
  t.is(comm(C).rootAuthority, true, 'no leave')
  // A leave on a secondary CW of the creator listing the root, never confirmed.
  C.push(cwZ2, groupLeave({ cuts: [{ writer: cwZ2, seq: C.len(cwZ2) }, { writer: C.key, seq: C.len(C.key) }].sort((x, y) => x.writer.localeCompare(y.writer)), at: AT(40) }))
  let c = comm(C)
  t.absent(c.authorityWriters.has(C.key), 'the root is retired by generation')
  t.is(c.rootAuthority, true, 'an unconfirmed leave off the root keeps it')
  t.is(c.cwDemote, false)
  C.confirm(Z, cwZ2)
  c = comm(C)
  t.is(c.rootAuthority, false, 'the confirmed leave bounds the root')
  t.is(c.cwDemote, true)
  C = world()
  C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(40) }))
  t.is(comm(C).rootAuthority, false, 'a leave on the root bounds it, unconfirmed')
})

test('rootAuthority: a trailing block a community root rejects never keeps it after a confirmed leave', (t) => {
  const cwZ2 = K(0x92)
  const world = () => {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }] })
    C.addWriter(Z, cwZ2)
    // A group-post is not valid on a community root: the fold skips it, but
    // the root's contiguous length (what the node lists) includes it.
    C.push(C.key, groupPost({ text: 'p', at: AT(30) }))
    return C
  }
  let C = world()
  t.is(comm(C).rootAuthority, true, 'no leave')
  C = world()
  C.push(cwZ2, groupLeave({ cuts: [{ writer: cwZ2, seq: C.len(cwZ2) }, { writer: C.key, seq: C.len(C.key) }].sort((x, y) => x.writer.localeCompare(y.writer)), at: AT(40) }))
  C.confirm(Z, cwZ2)
  const c = comm(C)
  t.is(c.rootAuthority, false, 'the confirmed leave at the contiguous length ends it')
  t.is(c.cwDemote, true)
})

test('group-cut: after a confirmed creator leave and a return, an unmarked G root acts on nothing written after the return', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const setup = ({ leave = true, mark = false } = {}) => {
    const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }, { diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    const g = groupIn(C, { key: G1, join: 'approval' })
    g.add(X, wX).add(Y, wY).add(A, wA)
    g.push(G1, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(39) }))
    g.push(G1, groupAdmit({ member: A, on: true, cuts: [{ writer: wA, seq: 1 }], at: AT(40) }))
    if (leave) {
      const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
      C.confirm(Z, cwZ2)
      if (mark) g.mark(Z, G1, g.len(G1))
      C.addWriter(Z, cwZ3, { rejoin: L })
    }
    // Written on the G root after the return (a thief holding it).
    g.push(G1, groupAdmin({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(60) }))
    g.push(G1, groupMeta({ name: 'Roubado', join: 'approval', at: AT(61) }))
    g.push(G1, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(62) }))
    g.push(G1, groupBan({ member: A, on: true, cuts: [{ writer: wA, seq: g.len(wA) }], at: AT(63) }))
    return buildGroup(g.input())
  }
  let r = setup()
  t.is(r.community.members.get(Z), 'member', 'the creator is back')
  t.is(r.rootCut, 0, 'unmarked: the root carries no authority at any seq')
  t.absent(r.admins.has(Y), 'unmarked: the grant does not count')
  t.is(r.name, 'Varanda', 'unmarked: the meta does not count')
  t.not(r.members.get(X), 'member', 'unmarked: the admit does not count')
  t.not(r.members.get(Y), 'member', 'unmarked: nor the earlier admit')
  t.not(r.members.get(A), 'banned', 'unmarked: the ban does not count')
  t.absent(r.authorityWriters.has(G1))
  r = setup({ mark: true })
  t.ok(r.rootCut > 0, 'marked: the cut applies')
  t.is(r.members.get(Y), 'member', 'marked: the admit below the cut stands')
  t.absent(r.admins.has(Y), 'marked: the grant above the cut does not count')
  t.is(r.name, 'Varanda')
  t.not(r.members.get(X), 'member')
  t.is(r.members.get(A), 'member', 'marked: the ban above the cut does not count')
  r = setup({ leave: false })
  t.is(r.rootCut, null, 'no leave: no cut')
  t.ok(r.admins.has(Y), 'no leave: the grant counts')
  t.is(r.name, 'Roubado')
  t.is(r.members.get(X), 'member')
  t.is(r.members.get(A), 'banned')
})

test('group-cut: only marks written before the creator first confirmed leave of C count', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  // The creator diary: the confirm of its first leave at diary seq 10.
  const setup = ({ marks = [] } = {}) => {
    const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    const g = groupIn(C, { key: G1, join: 'approval' })
    g.add(X, wX).add(Y, wY)
    g.push(G1, groupAdmit({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(40) }))
    const cut = g.len(G1)
    const L = C.push(cwZ2, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }], at: AT(50) }))
    C.confirm(Z, cwZ2, 10)
    C.addWriter(Z, cwZ3, { rejoin: L })
    // Written on the G root after the return (a thief holding it).
    g.push(G1, groupAdmit({ member: X, on: true, cuts: [{ writer: wX, seq: 1 }], at: AT(60) }))
    for (const m of marks) g.mark(Z, G1, m.cut === 'now' ? g.len(G1) : m.cut === 'leave' ? cut : m.cut, m.seq)
    return buildGroup(g.input())
  }
  let r = setup({ marks: [{ cut: 'now', seq: 20 }] })
  t.is(r.rootCut, 0, 'a mark written after the confirm never lifts the zero')
  t.not(r.members.get(Y), 'member', 'so the admit below it does not count')
  t.not(r.members.get(X), 'member', 'nor the admit after the return')
  r = setup({ marks: [{ cut: 'leave', seq: 5 }] })
  t.ok(r.rootCut > 0, 'a mark written before the confirm counts')
  t.is(r.members.get(Y), 'member', 'the admit below the cut stands')
  t.not(r.members.get(X), 'member', 'the admit above the cut does not count')
  const before = r.rootCut
  r = setup({ marks: [{ cut: 'leave', seq: 5 }, { cut: 1, seq: 20 }] })
  t.is(r.rootCut, before, 'a later mark never moves the cut')
  t.is(r.members.get(Y), 'member')
  r = setup({ marks: [{ cut: 'leave', seq: 10 }] })
  t.is(r.rootCut, 0, 'a mark at the confirm seq itself does not count')
})

const byWriter = (cuts) => cuts.sort((x, y) => x.writer.localeCompare(y.writer))

test('a confirmed creator leave of a later set touching the root bounds it', (t) => {
  const cwZ3 = K(0x93)
  const cwZ4 = K(0x94)
  const cwZ5 = K(0x95)
  const C = community({ creator: Z, members: [{ diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ4)
  // Set 0: a forged leave on a stolen secondary device, never confirmed,
  // not touching the root.
  const forged = C.push(cwZ4, groupLeave({ cuts: [{ writer: cwZ4, seq: C.len(cwZ4) }], at: AT(40) }))
  C.addWriter(Z, cwZ3, { rejoin: forged })
  // Set 1: a confirmed leave that does not touch the root.
  const L1 = C.push(cwZ3, groupLeave({ cuts: [{ writer: cwZ3, seq: C.len(cwZ3) }], at: AT(50) }))
  C.confirm(Z, cwZ3, 20)
  let c = comm(C)
  t.is(c.rootAuthority, true, 'no confirmed leave touches the root yet')
  t.is(c.cwDemote, false)
  t.is(c.creatorConfirmSeq, Infinity)
  C.addWriter(Z, cwZ5, { rejoin: L1 })
  // Set 2: a confirmed leave listing the root.
  const cut = C.len(C.key)
  C.push(cwZ5, groupLeave({ cuts: byWriter([{ writer: cwZ5, seq: C.len(cwZ5) }, { writer: C.key, seq: cut }]), at: AT(60) }))
  C.confirm(Z, cwZ5, 30)
  // A thief holding the root writes above the listed cut.
  C.push(C.key, groupAdmin({ member: Y, on: true, cuts: [{ writer: cwY, seq: C.len(cwY) }], at: AT(70) }))
  C.push(C.key, groupCreateRecord({ group: G3, at: AT(71) }))
  c = comm(C)
  t.is(c.rootAuthority, false, 'the later confirmed leave bounds the root')
  t.is(c.cwDemote, true)
  t.is(c.creatorConfirmSeq, 30, 'the confirm of the bounding leave')
  t.alike(c.groups, [G1], 'a root create above the cut does not count')
  t.absent(c.admins.has(Y), 'nor a root grant')
})

test('creatorConfirmSeq: finite only with a confirmed leave bounding the root', (t) => {
  const cwZ2 = K(0x92)
  const world = () => {
    const C = community({ creator: Z, members: [{ diary: Y, cw: cwY, status: 'member' }] })
    C.addWriter(Z, cwZ2)
    return C
  }
  let C = world()
  t.is(comm(C).creatorConfirmSeq, Infinity, 'no leave')
  // A confirmed leave that does not touch the root.
  C.push(cwZ2, groupLeave({ cuts: [{ writer: cwZ2, seq: C.len(cwZ2) }], at: AT(40) }))
  C.confirm(Z, cwZ2, 7)
  t.is(comm(C).creatorConfirmSeq, Infinity, 'a confirmed leave off the root')
  // An unconfirmed leave on the root bounds it, but nothing confirms it.
  C = world()
  C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(40) }))
  let c = comm(C)
  t.is(c.rootAuthority, false)
  t.is(c.creatorConfirmSeq, Infinity, 'an unconfirmed leave on the root')
  C.confirm(Z, C.key, 9)
  c = comm(C)
  t.is(c.creatorConfirmSeq, 9, 'confirmed, it is the confirm seq')
  // A confirmed leave listing the root.
  C = world()
  C.push(cwZ2, groupLeave({ cuts: byWriter([{ writer: cwZ2, seq: C.len(cwZ2) }, { writer: C.key, seq: C.len(C.key) }]), at: AT(40) }))
  C.confirm(Z, cwZ2, 11)
  t.is(comm(C).creatorConfirmSeq, 11)
})

test('a returning creator repairs the name, join and catalogue a thief changed on the root', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const D = B
  const cwD = cwB
  const world = ({ leave = true } = {}) => {
    const C = community({ creator: Z, join: 'approval', members: [{ diary: A, cw: cwA, status: 'member' }, { diary: D, cw: cwD, status: 'member' }], admins: [A], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    // The thief holding the root opens the community, renames it and fills
    // the catalogue before the leave on the root.
    C.push(C.key, groupMeta({ name: 'Ladroes', join: 'open', at: AT(40) }))
    C.push(C.key, groupCreateRecord({ group: G2, at: AT(41) }))
    C.push(C.key, groupCreateRecord({ group: G3, at: AT(42) }))
    let L = null
    if (leave) L = C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(50) }))
    C.addWriter(Z, cwZ3, L === null ? {} : { rejoin: L })
    return C
  }
  let C = world()
  let c = comm(C)
  t.is(c.cwDemote, true, 'the root powers ended')
  t.is(c.join, 'open', 'the thief meta below the leave counts')
  t.is(c.name, 'Ladroes')
  t.alike(c.groups, sorted([G1, G2, G3]))
  // Another diary's CW repairs nothing.
  C.push(cwA, communityMetaCw({ name: 'Outro', join: 'approval', seen: c.last, at: AT(60) }))
  C.push(cwA, communityDrop({ group: G2, seen: c.last, at: AT(61) }))
  c = comm(C)
  t.is(c.join, 'open', 'not from another diary')
  t.alike(c.groups, sorted([G1, G2, G3]))
  C.push(cwZ3, communityMetaCw({ name: 'Bairro', join: 'approval', seen: c.last, at: AT(62) }))
  C.push(cwZ3, communityDrop({ group: G2, seen: c.last, at: AT(63) }))
  C.push(cwZ3, communityDrop({ group: G3, seen: c.last, at: AT(64) }))
  C.push(cwZ3, communityDrop({ group: G1, seen: c.last, at: AT(65) }))
  C.push(cwZ3, communityDrop({ group: K(0x1ff), seen: c.last, at: AT(66) }))
  c = comm(C)
  t.is(c.join, 'approval', 'the creator CW meta sets join')
  t.is(c.name, 'Bairro', 'and the name')
  t.alike(c.groups, [G1], 'the drops take the junk groups out')
  t.is(c.general, G1, 'Geral is never dropped')
  t.ok(c.created.has(G1))
  t.absent(c.created.has(K(0x1ff)), 'a drop never creates')
  t.alike(sorted(c.admins), sorted([A, Z]), 'a meta or drop never grants')
  t.is(buildGroup(groupIn(C, { key: G2 }).input()).orphan, true, 'a dropped group is an orphan')
  t.is(buildGroup(groupIn(C, { key: G1 }).input()).orphan, false, 'Geral stays attached')
  // The latest CW meta in causal order wins.
  C.push(cwZ3, communityMetaCw({ name: 'Bairro Novo', join: 'open', seen: c.last, at: AT(70) }))
  c = comm(C)
  t.is(c.name, 'Bairro Novo')
  t.is(c.join, 'open')

  // Without the gate (no leave on the root, none confirmed) the root keeps
  // its powers and a CW repairs nothing.
  C = world({ leave: false })
  c = comm(C)
  t.is(c.rootAuthority, true)
  t.is(c.cwDemote, false)
  C.push(cwZ3, communityMetaCw({ name: 'Bairro', join: 'approval', seen: c.last, at: AT(60) }))
  C.push(cwZ3, communityDrop({ group: G2, seen: c.last, at: AT(61) }))
  c = comm(C)
  t.is(c.join, 'open', 'no CW meta while the root has authority')
  t.is(c.name, 'Ladroes')
  t.alike(c.groups, sorted([G1, G2, G3]), 'no CW drop while the root has authority')
})

test('the root bound comes from the earliest set with a confirmed leave touching it: a later set never lowers it', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const C = community({ creator: Z, members: [{ diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  const k = C.len(C.key)
  C.push(C.key, groupCreateRecord({ group: G2, at: AT(41) }))
  C.push(C.key, groupCreateRecord({ group: G3, at: AT(42) }))
  // Set 0: a confirmed leave listing the root at its full length X.
  const L0 = C.push(cwZ2, groupLeave({ cuts: byWriter([{ writer: cwZ2, seq: C.len(cwZ2) }, { writer: C.key, seq: C.len(C.key) }]), at: AT(50) }))
  C.confirm(Z, cwZ2, 20)
  let c = comm(C)
  t.alike(c.groups, sorted([G1, G2, G3]), 'set 0 bounds the root after every create')
  // Set 1: the creator returns and leaves again from a device whose copy of
  // the root is behind, listing the root at k < X.
  C.addWriter(Z, cwZ3, { rejoin: L0 })
  C.push(cwZ3, groupLeave({ cuts: byWriter([{ writer: cwZ3, seq: C.len(cwZ3) }, { writer: C.key, seq: k }]), at: AT(60) }))
  C.confirm(Z, cwZ3, 30)
  c = comm(C)
  t.alike(c.groups, sorted([G1, G2, G3]), 'the creates in [k, X) still count')
  t.is(c.general, G1, 'Geral stays')
  t.is(c.rootAuthority, false)
  t.is(c.creatorConfirmSeq, 20, 'the confirm of the earliest bounding set')
})

test('a returning creator repairs outlive the CW retiring, cut only at a confirmed bound', (t) => {
  const { communityDemote } = require('../lib/group')
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const cwZ4 = K(0x94)
  const D = B
  const cwD = cwB
  const world = () => {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: D, cw: cwD, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    // A thief holding the root renames C, fills the catalogue and grants D.
    C.push(C.key, groupMeta({ name: 'Ladroes', join: 'open', at: AT(40) }))
    C.push(C.key, groupCreateRecord({ group: G2, at: AT(41) }))
    C.push(C.key, groupCreateRecord({ group: G3, at: AT(42) }))
    C.push(C.key, groupAdmin({ member: D, on: true, cuts: [{ writer: cwD, seq: C.len(cwD) }], at: AT(43) }))
    const L = C.push(cwZ2, groupLeave({ cuts: byWriter([{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }]), at: AT(50) }))
    C.confirm(Z, cwZ2, 10)
    C.addWriter(Z, cwZ3, { rejoin: L })
    C.addWriter(Z, cwZ4, { rejoin: L })
    C.push(cwZ3, communityMetaCw({ name: 'Bairro', join: 'approval', at: AT(60) }))
    C.push(cwZ3, communityDrop({ group: G2, at: AT(61) }))
    C.push(cwZ3, communityDemote({ member: D, at: AT(62) }))
    return C
  }
  const repaired = (c, label) => {
    t.is(c.name, 'Bairro', label + ': the CW meta counts')
    t.alike(c.groups, sorted([G1, G3]), label + ': the CW drop counts')
    t.absent(c.admins.has(D), label + ': the CW demotion counts')
  }
  let C = world()
  repaired(comm(C), 'live CW')
  // (a) A copy of the CW key appends a leave on it: unconfirmed, it voids
  // none of the repairs.
  C.push(cwZ3, groupLeave({ cuts: [{ writer: cwZ3, seq: C.len(cwZ3) }], at: AT(70) }))
  repaired(comm(C), 'after an unconfirmed leave on that CW')
  // (b) The creator's own confirmed leave, written above them.
  C.confirm(Z, cwZ3, 20)
  repaired(comm(C), 'after a confirmed leave above them')
  // A repair appended above that confirmed leave is void.
  C.push(cwZ3, communityDrop({ group: G3, at: AT(80) }))
  C.push(cwZ3, communityMetaCw({ name: 'Depois', join: 'open', at: AT(81) }))
  repaired(comm(C), 'above the confirmed leave on that CW')

  // A confirmed leave on a sibling device bounds the CW at the cut it lists.
  C = world()
  const cut = C.len(cwZ3)
  C.push(cwZ4, groupLeave({ cuts: byWriter([{ writer: cwZ3, seq: cut }, { writer: cwZ4, seq: C.len(cwZ4) }]), at: AT(70) }))
  C.confirm(Z, cwZ4, 20)
  repaired(comm(C), 'below a sibling leave cut')
  C.push(cwZ3, communityDrop({ group: G3, at: AT(80) }))
  t.alike(comm(C).groups, sorted([G1, G3]), 'a drop at or above the listed cut is void')
})

test('a returning creator G demotion outlives its CW retiring', (t) => {
  const { communityDemote } = require('../lib/group')
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const cwZ4 = K(0x94)
  const C = community({ creator: Z, members: [{ diary: X, cw: cwX, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  const g = groupIn(C, { key: G1 })
  g.add(X, wX).add(Y, wY)
  g.push(G1, groupAdmin({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(40) }))
  const L = C.push(cwZ2, groupLeave({ cuts: byWriter([{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }]), at: AT(50) }))
  C.confirm(Z, cwZ2)
  g.mark(Z, G1, g.len(G1))
  C.addWriter(Z, cwZ3, { rejoin: L })
  C.push(cwZ3, communityDemote({ group: G1, member: Y, at: AT(61) }))
  t.absent(buildGroup(g.input()).admins.has(Y), 'live CW')
  // The creator stays in C through a new device, so the G root grant would
  // count again without the demotion.
  const L2 = C.push(cwZ3, groupLeave({ cuts: [{ writer: cwZ3, seq: C.len(cwZ3) }], at: AT(70) }))
  C.addWriter(Z, cwZ4, { rejoin: L2 })
  t.is(comm(C).members.get(Z), 'member')
  t.absent(buildGroup(g.input()).admins.has(Y), 'after an unconfirmed leave on that CW')
  C.confirm(Z, cwZ3)
  t.absent(buildGroup(g.input()).admins.has(Y), 'after a confirmed leave above it')
})

test('repairs pre-seeded on a creator CW while the root had its powers never count; on the CW of the return they do', (t) => {
  const { communityDemote } = require('../lib/group')
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const D = B
  const cwD = cwB
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }, { diary: D, cw: cwD, status: 'member' }, { diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.push(C.key, groupMeta({ name: 'Ladroes', join: 'open', at: AT(40) }))
  C.push(C.key, groupCreateRecord({ group: G2, at: AT(41) }))
  C.push(C.key, groupAdmin({ member: D, on: true, cuts: [{ writer: cwD, seq: C.len(cwD) }], at: AT(43) }))
  const g = groupIn(C, { key: G1 })
  g.add(Y, wY)
  g.push(G1, groupAdmin({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(44) }))
  // A holder of the cwZ2 key seeds repairs on it before the leave.
  C.push(cwZ2, communityMetaCw({ name: 'Semeado', join: 'approval', at: AT(45) }))
  C.push(cwZ2, communityDrop({ group: G2, at: AT(46) }))
  C.push(cwZ2, communityDemote({ member: D, at: AT(47) }))
  C.push(cwZ2, communityDemote({ group: G1, member: Y, at: AT(48) }))
  const L = C.push(cwZ2, groupLeave({ cuts: byWriter([{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }]), at: AT(50) }))
  C.confirm(Z, cwZ2, 10)
  g.mark(Z, G1, g.len(G1))
  let c = comm(C)
  t.is(c.cwDemote, true, 'the root powers ended')
  t.is(c.name, 'Ladroes', 'a CW meta of the root time never counts')
  t.is(c.join, 'open')
  t.alike(c.groups, sorted([G1, G2]), 'a CW drop of the root time never counts')
  t.ok(c.admins.has(D), 'a C demotion of the root time never counts')
  // Back in C, so the G root grant below the mark stands again.
  C.addWriter(Z, cwZ3, { rejoin: L })
  t.ok(buildGroup(g.input()).admins.has(Y), 'a G demotion of the root time never counts, marked root or not')
  C.push(cwZ3, communityMetaCw({ name: 'Bairro', join: 'approval', at: AT(60) }))
  C.push(cwZ3, communityDrop({ group: G2, at: AT(61) }))
  C.push(cwZ3, communityDemote({ member: D, at: AT(62) }))
  C.push(cwZ3, communityDemote({ group: G1, member: Y, at: AT(63) }))
  c = comm(C)
  t.is(c.name, 'Bairro', 'the CW of the return repairs the name')
  t.alike(c.groups, [G1], 'and the catalogue')
  t.absent(c.admins.has(D), 'and demotes in C')
  t.absent(buildGroup(g.input()).admins.has(Y), 'and in G')
})

test('a G demotion on a creator CW needs the C gate: a G mark alone never opens it', (t) => {
  const { communityDemote } = require('../lib/group')
  const cwZ2 = K(0x92)
  const C = community({ creator: Z, members: [{ diary: Y, cw: cwY, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  const g = groupIn(C, { key: G1 })
  g.add(Y, wY)
  g.push(G1, groupAdmin({ member: Y, on: true, cuts: [{ writer: wY, seq: 1 }], at: AT(40) }))
  g.mark(Z, G1, g.len(G1))
  C.push(cwZ2, communityDemote({ group: G1, member: Y, at: AT(50) }))
  t.is(comm(C).cwDemote, false, 'no C gate')
  t.ok(buildGroup(g.input()).admins.has(Y), 'the G demotion does not count')
})

test('a confirmed creator leave that does not list a CW of its generation voids that CW repairs', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const cwZ4 = K(0x94)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.push(C.key, groupCreateRecord({ group: G2, at: AT(41) }))
  const L = C.push(cwZ2, groupLeave({ cuts: byWriter([{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }]), at: AT(50) }))
  C.confirm(Z, cwZ2, 10)
  C.addWriter(Z, cwZ3, { rejoin: L })
  C.addWriter(Z, cwZ4, { rejoin: L })
  C.push(cwZ3, communityDrop({ group: G2, at: AT(60) }))
  t.alike(comm(C).groups, [G1], 'the drop counts')
  // Set 1: a confirmed leave on cwZ4 that lists only itself.
  C.push(cwZ4, groupLeave({ cuts: [{ writer: cwZ4, seq: C.len(cwZ4) }], at: AT(70) }))
  C.confirm(Z, cwZ4, 20)
  t.alike(comm(C).groups, sorted([G1, G2]), 'the unlisted CW keeps no repair')
})

test('a CW drop has an undo: the latest counted drop of a group wins, Geral is never dropped', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.push(C.key, groupCreateRecord({ group: G2, at: AT(41) }))
  C.push(C.key, groupCreateRecord({ group: G3, at: AT(42) }))
  const L = C.push(cwZ2, groupLeave({ cuts: byWriter([{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }]), at: AT(50) }))
  C.confirm(Z, cwZ2)
  C.addWriter(Z, cwZ3, { rejoin: L })
  let c = comm(C)
  t.alike(c.dropped, [], 'nothing dropped yet')
  C.push(cwZ3, communityDrop({ group: G2, at: AT(60) }))
  C.push(cwZ3, communityDrop({ group: G3, at: AT(61) }))
  c = comm(C)
  t.alike(c.groups, [G1])
  t.alike(c.dropped, sorted([G2, G3]), 'dropped lists the groups taken out')
  C.push(cwZ3, communityDrop({ group: G2, on: false, at: AT(62) }))
  c = comm(C)
  t.alike(c.groups, sorted([G1, G2]), 'the undo puts the group back')
  t.alike(c.dropped, [G3])
  t.ok(c.created.has(G2))
  C.push(cwZ3, communityDrop({ group: G1, at: AT(63) }))
  C.push(cwZ3, communityDrop({ group: K(0x1ff), at: AT(64) }))
  C.push(cwZ3, communityDrop({ group: K(0x1fe), on: false, at: AT(65) }))
  c = comm(C)
  t.alike(c.groups, sorted([G1, G2]), 'a drop of Geral is ignored, an undo never creates')
  t.alike(c.dropped, [G3], 'neither Geral nor a group never created is listed')
  t.is(c.general, G1)
  C.push(cwZ3, communityDrop({ group: G2, at: AT(66) }))
  c = comm(C)
  t.alike(c.groups, [G1], 'dropped again: the latest wins')
  t.alike(c.dropped, sorted([G2, G3]))
  t.is(buildGroup(groupIn(C, { key: G2 }).input()).orphan, true, 'a dropped group is an orphan')
  C.push(cwZ3, communityDrop({ group: G2, on: false, at: AT(67) }))
  t.is(buildGroup(groupIn(C, { key: G2 }).input()).orphan, false, 'a restored group is attached again')
})

test('a sibling confirmed leave that does not list a CW with its own confirmed leave keeps that CW repairs', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const cwZ4 = K(0x94)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.addWriter(Z, cwZ2)
  C.push(C.key, groupCreateRecord({ group: G2, at: AT(41) }))
  const L = C.push(cwZ2, groupLeave({ cuts: byWriter([{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }]), at: AT(50) }))
  C.confirm(Z, cwZ2, 10)
  C.addWriter(Z, cwZ3, { rejoin: L })
  C.addWriter(Z, cwZ4, { rejoin: L })
  C.push(cwZ3, communityDrop({ group: G2, at: AT(60) }))
  // cwZ3 leaves itself above its repair, confirmed.
  C.push(cwZ3, groupLeave({ cuts: [{ writer: cwZ3, seq: C.len(cwZ3) }], at: AT(65) }))
  C.confirm(Z, cwZ3, 20)
  t.alike(comm(C).groups, [G1], 'the drop below its own confirmed leave counts')
  // Set 1 again: a confirmed extra leave on cwZ4 that does not list cwZ3.
  C.push(cwZ4, groupLeave({ cuts: [{ writer: cwZ4, seq: C.len(cwZ4) }], at: AT(70) }))
  C.confirm(Z, cwZ4, 30)
  t.alike(comm(C).groups, [G1], 'its own leave bounds it: the sibling leave voids nothing more')
})

test('an on-root set-0 leave keeps the repair gate at 0 after a later confirmed bounding leave of set 1', (t) => {
  const cwZ3 = K(0x93)
  const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
  C.push(C.key, groupCreateRecord({ group: G2, at: AT(41) }))
  // Set 0: an unconfirmed leave on the root itself.
  const L = C.push(C.key, groupLeave({ cuts: [{ writer: C.key, seq: C.len(C.key) }], at: AT(50) }))
  C.addWriter(Z, cwZ3, { rejoin: L })
  C.push(cwZ3, communityDrop({ group: G2, at: AT(60) }))
  t.alike(comm(C).groups, [G1], 'the generation-1 drop counts under the on-root bound')
  // Set 1: a confirmed leave on cwZ3 above the drop that lists a root cut.
  C.push(cwZ3, groupLeave({ cuts: byWriter([{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ3, seq: C.len(cwZ3) }]), at: AT(70) }))
  C.confirm(Z, cwZ3, 20)
  const c = comm(C)
  t.is(c.cwDemote, true)
  t.alike(c.groups, [G1], 'the later confirmed leave never raises the gate over the drop')
})

test('a CW generation counts its header rejoin only when the diary earliest on-join names it', (t) => {
  const cwZ2 = K(0x92)
  const cwZ3 = K(0x93)
  const world = (opts) => {
    const C = community({ creator: Z, members: [{ diary: A, cw: cwA, status: 'member' }], creates: [{ by: Z, group: G1 }] })
    C.addWriter(Z, cwZ2)
    C.push(C.key, groupCreateRecord({ group: G2, at: AT(41) }))
    const L = C.push(cwZ2, groupLeave({ cuts: byWriter([{ writer: C.key, seq: C.len(C.key) }, { writer: cwZ2, seq: C.len(cwZ2) }]), at: AT(50) }))
    C.confirm(Z, cwZ2, 10)
    C.addWriter(Z, cwZ3, { rejoin: L, ...opts(L) })
    C.push(cwZ3, communityDrop({ group: G2, at: AT(60) }))
    C.L = L
    return C
  }
  let c = comm(world(() => ({})))
  t.alike(c.groups, [G1], 'the matching rejoin in the join: generation 1, the drop counts')
  t.ok(c.authorityWriters.has(cwZ3))
  for (const [label, opts] of [
    ['a join without rejoin', () => ({ joinRejoin: null })],
    ['a join naming another leave', (L) => ({ joinRejoin: { writer: L.writer, seq: L.seq + 1 } })],
    ['a malformed join rejoin', (L) => ({ joinRejoin: { writer: L.writer } })]
  ]) {
    c = comm(world(opts))
    t.alike(c.groups, sorted([G1, G2]), label + ': generation 0, the drop never counts')
    t.absent(c.authorityWriters.has(cwZ3), label + ': retired')
  }
  // Only the earliest on-join counts: a later one naming the rejoin never
  // lifts the generation.
  const C = world(() => ({ joinRejoin: null }))
  const list = C.joins.get(Z)
  list.push({ writer: cwZ3, on: true, seq: list.length + 1, rejoin: { writer: C.L.writer, seq: C.L.seq } })
  t.alike(comm(C).groups, sorted([G1, G2]), 'a later on-join naming the rejoin: still generation 0')
})
