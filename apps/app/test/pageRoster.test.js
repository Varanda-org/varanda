// The roster view and op builders of a page (src/pageRoster.js): pure.
'use strict'

const test = require('brittle')

const load = () => import('../src/pageRoster.js')
const key = (c) => c.repeat(64)
const OWNER = key('a')
const A1 = key('b')
const A2 = key('c')
const NEW = key('d')
const READ = { page: key('e'), owner: OWNER, admins: [A2, A1], gen: 3, seq: 7 }
const ctx = { nonce: 'n'.repeat(43), at: '2026-01-01T00:00:00.000Z' }

test('rows list the owner first and sections are Dono and Administradores', async (t) => {
  const { rosterRows } = await load()
  const r = rosterRows(READ)
  t.alike(r.rows, [{ key: OWNER, role: 'owner' }, { key: A2, role: 'admin' }, { key: A1, role: 'admin' }])
  t.alike(r.sections, [{ title: 'Dono', keys: [OWNER] }, { title: 'Administradores', keys: [A2, A1] }])
  t.alike(rosterRows({ ...READ, admins: [] }).sections, [{ title: 'Dono', keys: [OWNER] }])
})

test('rows drop bad keys, repeats, the owner among admins, and cap at 16 admins', async (t) => {
  const { rosterRows, MAX_ADMINS } = await load()
  t.is(MAX_ADMINS, 16)
  const many = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(64, '1'))
  t.is(rosterRows({ owner: OWNER, admins: many }).admins.length, 16)
  const r = rosterRows({ owner: OWNER, admins: [A1, A1, OWNER, 'zz', null, A2] })
  t.alike(r.admins, [A1, A2])
  t.alike(rosterRows(null).rows, [])
  t.alike(rosterRows({ owner: 'nope', admins: 'x' }).sections, [])
})

test('rows carry keys only, never a name or a label', async (t) => {
  const { rosterRows } = await load()
  for (const row of rosterRows(READ).rows) t.alike(Object.keys(row).sort(), ['key', 'role'])
})

test('hasInvite and hasOffer honor the member and the expiry', async (t) => {
  const { hasInvite, hasOffer } = await load()
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const status = { invites: [{ member: NEW, gen: 4, expiresAt: '2026-01-02T00:00:00.000Z' }, { member: A1, gen: 4, expiresAt: '2025-12-31T00:00:00.000Z' }], offer: { to: NEW, exp: '2026-01-03T00:00:00.000Z' } }
  t.is(hasInvite(status, NEW, now), true)
  t.is(hasInvite(status, A1, now), false, 'expired')
  t.is(hasInvite(status, A2, now), false)
  t.is(hasInvite({}, NEW, now), false)
  t.is(hasInvite(status, 'bad', now), false)
  t.is(hasOffer(status, NEW, now), true)
  t.is(hasOffer(status, A1, now), false)
  t.is(hasOffer({ offer: { to: NEW, exp: '2025-01-01T00:00:00.000Z' } }, NEW, now), false)
  t.is(hasOffer({ offer: null }, NEW, now), false)
  t.is(hasOffer(null, NEW, now), false)
})

test('inviteOp builds the resulting roster with a blank signature for the node', async (t) => {
  const { inviteOp } = await load()
  t.alike(inviteOp(READ, NEW, ctx), {
    member: NEW,
    gen: 4,
    rosterSignature: '',
    roster: { owner: OWNER, admins: [A1, A2, NEW], prev: 7, at: ctx.at, nonce: ctx.nonce }
  })
})

test('removeOp, transferAcceptOp, offerOp, acceptOp, closeOp and moveOp shapes', async (t) => {
  const { removeOp, transferAcceptOp, offerOp, cancelOfferOp, acceptOp, closeOp, moveOp } = await load()
  t.alike(removeOp(READ, A1, ctx), { gen: 4, owner: OWNER, admins: [A2], prev: 7, at: ctx.at, nonce: ctx.nonce })
  t.alike(transferAcceptOp(READ, A1, ctx), { gen: 4, owner: A1, admins: [OWNER, A2].sort(), prev: 7, at: ctx.at, nonce: ctx.nonce })
  t.alike(offerOp(READ, NEW, { ...ctx, exp: '2026-01-05T00:00:00.000Z' }), { to: NEW, exp: '2026-01-05T00:00:00.000Z', gen: 3, at: ctx.at, nonce: ctx.nonce })
  t.alike(cancelOfferOp(READ, ctx), { to: null, exp: null, gen: 3, at: ctx.at, nonce: ctx.nonce }, 'the cancel names no one at the current gen')
  t.alike(acceptOp({ gen: 4, rosterSignature: 'c'.repeat(128) }, ctx), { gen: 4, rosterSignature: 'c'.repeat(128), at: ctx.at, nonce: ctx.nonce })
  t.alike(closeOp(READ, ctx), { gen: 4, at: ctx.at, nonce: ctx.nonce })
  t.alike(moveOp(READ, NEW, { ...ctx, fromSeq: 12 }), { to: NEW, gen: 3, fromSeq: 12, owner: OWNER, admins: [A2, A1], at: ctx.at, nonce: ctx.nonce })
})

test('builders do not touch the page.read answer they were given', async (t) => {
  const { inviteOp, removeOp, transferAcceptOp } = await load()
  const read = { ...READ, admins: [A2, A1] }
  inviteOp(read, NEW, ctx)
  removeOp(read, A1, ctx)
  transferAcceptOp(read, A1, ctx)
  t.alike(read.admins, [A2, A1])
})

test('limits are duplicated with their service values', async (t) => {
  const { MAX_OWNED, MAX_ADMINS, MAX_FEED_KEYS } = await load()
  t.is(MAX_OWNED, 8)
  t.is(MAX_ADMINS, 16)
  t.is(MAX_FEED_KEYS, 64)
})
