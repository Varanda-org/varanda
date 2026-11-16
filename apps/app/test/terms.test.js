'use strict'

// The terms acceptance record (src/terms.js) and the web store
// (src/termsStore.web.js). ES modules loaded through import(); storage is a
// fake globalThis.localStorage.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/terms.js')
const loadWeb = () => import('../src/termsStore.web.js')

const X = 'ab'.repeat(32)
const Y = 'cd'.repeat(32)
const T1 = '2026-10-27T12:00:00.000Z'
const T2 = '2026-10-28T12:00:00.000Z'
const key = (i) => i.toString(16).padStart(64, '0')
const rec = (members = {}, version = 1) => ({ v: 1, version, members })

test('isMemberKey', async (t) => {
  const { isMemberKey } = await load()
  t.ok(isMemberKey(X))
  for (const bad of ['AB'.repeat(32), 'ab'.repeat(31), 'zz'.repeat(32), '', null, 5]) t.not(isMemberKey(bad), String(bad))
})

test('termsRecordOf accepts valid records and returns a copy', async (t) => {
  const { termsRecordOf, MAX_MEMBERS } = await load()
  const r = rec({ [X]: { acceptedAt: T1, synced: false }, [Y]: { acceptedAt: T2, synced: true } }, 3)
  const out = termsRecordOf(r)
  t.alike(out, r)
  t.not(out === r)
  t.alike(termsRecordOf(rec({}, 9999)), rec({}, 9999))
  const full = {}
  for (let i = 0; i < MAX_MEMBERS; i++) full[key(i)] = { acceptedAt: T1, synced: false }
  t.ok(termsRecordOf(rec(full)))
})

test('termsRecordOf refuses every invalid shape', async (t) => {
  const { termsRecordOf, MAX_MEMBERS } = await load()
  const entry = { acceptedAt: T1, synced: false }
  const tooMany = {}
  for (let i = 0; i <= MAX_MEMBERS; i++) tooMany[key(i)] = entry
  const bad = [
    null, undefined, 1, 'x', [], [rec()],
    {},
    { v: 1, version: 1 },
    { ...rec(), extra: 1 },
    { v: 2, version: 1, members: {} },
    rec({}, 0), rec({}, 10000), rec({}, 1.5), rec({}, '1'),
    { v: 1, version: 1, members: [] },
    { v: 1, version: 1, members: null },
    rec({ ['AB'.repeat(32)]: entry }),
    rec({ short: entry }),
    rec({ [X]: null }),
    rec({ [X]: { acceptedAt: T1 } }),
    rec({ [X]: { acceptedAt: T1, synced: false, extra: 1 } }),
    rec({ [X]: { acceptedAt: T1, synced: 'no' } }),
    rec({ [X]: { acceptedAt: '2026-10-27', synced: false } }),
    rec({ [X]: { acceptedAt: '2026-10-27T12:00:00Z', synced: false } }),
    rec({ [X]: { acceptedAt: '2026-02-30T12:00:00.000Z', synced: false } }),
    rec({ [X]: { acceptedAt: 'lixo', synced: false } }),
    rec({ [X]: { acceptedAt: 5, synced: false } }),
    rec(tooMany)
  ]
  for (const b of bad) t.is(termsRecordOf(b), null, JSON.stringify(b))
  const evil = rec()
  Object.defineProperty(evil, 'members', { enumerable: true, get () { throw new Error('x') } })
  t.is(termsRecordOf(evil), null, 'a throwing getter')
})

test('termsDecision: the full table', async (t) => {
  const { termsDecision } = await load()
  const r = rec({ [X]: { acceptedAt: T1, synced: false } }, 2)
  const old = rec({ [X]: { acceptedAt: T1, synced: false } }, 1)
  const claim = { at: T1 }
  const d = (o) => termsDecision({ record: r, version: 2, member: X, claim: null, hosted: true, identityKnown: true, locked: true, ...o })

  t.is(d({ identityKnown: false }), 'loading', 'hosted, identity unknown, even with a record')
  t.is(d({ identityKnown: false, record: null }), 'loading')
  t.is(d({ identityKnown: false, member: null, locked: false }), 'loading', 'loading comes before the first ceremony row')
  t.is(d({ hosted: false, identityKnown: false, member: null }), 'accepted', 'identityKnown only matters when hosted')

  // Member known: the record decides, hosted or not.
  t.is(d({ record: null }), 'needed')
  t.is(d({ record: null, hosted: false }), 'needed')
  t.is(d({ record: null, claim }), 'needed', 'member known, nothing stored, a claim does not stand in for the record')
  t.is(d({ version: 3 }), 'updated')
  t.is(d({ version: 3, hosted: false }), 'updated')
  t.is(d({ version: 3, locked: false }), 'updated')
  t.is(d({}), 'accepted', 'member in record')
  t.is(d({ claim }), 'accepted', 'member in record with a claim')
  t.is(d({ locked: false }), 'accepted')
  t.is(d({ member: Y }), 'account', 'Sair then another passkey in the same page')
  t.is(d({ member: Y, claim }), 'bind', 'record has X, claim set, member Y')
  t.is(d({ member: Y, hosted: false }), 'account')
  t.is(d({ member: Y, hosted: false, claim }), 'bind')

  // Hosted, locked at Entrar, member unknown: an existing passkey enters
  // first; the gate (and the held check) comes after Entrar.
  t.is(d({ member: null }), 'accepted', 'locked, a member accepted this version on this device')
  t.is(d({ member: null, record: null }), 'accepted', 'locked, nothing stored: the gate waits for Entrar')
  t.is(d({ member: null, record: old }), 'accepted', 'locked, an older version: the gate waits for Entrar')
  t.is(d({ member: null, record: rec({}, 2) }), 'accepted', 'locked, an acceptance given before sign-in (members empty)')
  t.is(d({ member: null, record: null, claim }), 'accepted', 'locked, claim held')
  t.is(d({ member: undefined, record: null }), 'accepted', 'member undefined counts as unknown')

  // Hosted, unlocked, member unknown (a first passkey ceremony, Criar conta):
  // only this page load's claim lets it through, whatever is stored.
  t.is(d({ member: null, locked: false }), 'needed', 'record current, no claim')
  t.is(d({ member: null, locked: false, record: null }), 'needed', 'nothing stored, no claim')
  t.is(d({ member: null, locked: false, record: old }), 'needed', 'older version, no claim')
  t.is(d({ member: null, locked: false, record: rec({}, 2) }), 'needed', 'empty record, no claim')
  t.is(d({ member: null, locked: false, claim }), 'accepted', 'claim held')
  t.is(d({ member: null, locked: false, record: null, claim }), 'accepted', 'claim held, record not kept')
  t.is(d({ member: null, locked: false, record: old, claim }), 'accepted', 'claim held, older record')
  t.is(d({ member: null, locked: undefined }), 'needed', 'locked unknown fails closed')
  t.is(d({ member: null, locked: undefined, record: null }), 'needed')
  t.is(d({ member: null, locked: undefined, claim }), 'accepted')

  // Native/serve, member unknown: unchanged.
  t.is(d({ member: null, hosted: false }), 'accepted', 'native, record current')
  t.is(d({ member: null, hosted: undefined }), 'accepted')
  t.is(d({ member: null, hosted: false, locked: false }), 'accepted', 'native, unlocked')
  t.is(d({ member: null, hosted: false, record: null }), 'needed', 'native, nothing stored')
  t.is(d({ member: null, hosted: false, record: null, claim }), 'needed', 'native, nothing stored, claim')
  t.is(d({ member: null, hosted: undefined, record: old }), 'updated', 'native, older version')
  t.is(termsDecision(), 'needed', 'no arguments')
})

test('withMember: fresh on a version change, keeps existing, caps dropping the oldest', async (t) => {
  const { withMember, MAX_MEMBERS, termsRecordOf } = await load()
  t.alike(withMember(null, 1, X, T1), rec({ [X]: { acceptedAt: T1, synced: false } }))
  t.alike(withMember(null, 1, null, T1), rec())

  const r = rec({ [X]: { acceptedAt: T1, synced: true } }, 1)
  t.alike(withMember(r, 2, Y, T2), rec({ [Y]: { acceptedAt: T2, synced: false } }, 2), 'another version starts over')
  t.alike(withMember(r, 2, null, T2), rec({}, 2))
  t.alike(withMember(r, 1, X, T2), r, 'an existing entry is kept as is')
  t.alike(withMember(r, 1, null, T2), r, 'member null: members unchanged')
  const both = withMember(r, 1, Y, T2)
  t.alike(both, rec({ [X]: { acceptedAt: T1, synced: true }, [Y]: { acceptedAt: T2, synced: false } }))
  t.alike(r, rec({ [X]: { acceptedAt: T1, synced: true } }, 1), 'input untouched')

  let full = null
  // key(5) is the oldest acceptance
  for (let i = 0; i < MAX_MEMBERS; i++) {
    const at = new Date(Date.UTC(2026, 0, i === 5 ? 1 : 10 + i)).toISOString()
    full = withMember(full, 1, key(i), at)
  }
  t.is(Object.keys(full.members).length, MAX_MEMBERS)
  const next = withMember(full, 1, X, T1)
  t.is(Object.keys(next.members).length, MAX_MEMBERS)
  t.ok(next.members[X])
  t.absent(next.members[key(5)], 'oldest dropped')
  t.ok(next.members[key(0)])
  t.ok(termsRecordOf(next))

  // The clock behind every stored date: the new member is the oldest, but it
  // is never the one dropped (or the gate would never open).
  const behind = withMember(full, 1, X, '2025-01-01T00:00:00.000Z')
  t.is(Object.keys(behind.members).length, MAX_MEMBERS)
  t.ok(behind.members[X], 'the member just added stays')
  t.absent(behind.members[key(5)], 'the oldest other acceptance goes')
})

test('withSynced and withoutMember', async (t) => {
  const { withSynced, withoutMember } = await load()
  const r = rec({ [X]: { acceptedAt: T1, synced: false }, [Y]: { acceptedAt: T2, synced: false } })
  const s = withSynced(r, X)
  t.is(s.members[X].synced, true)
  t.is(s.members[X].acceptedAt, T1)
  t.is(s.members[Y].synced, false)
  t.is(r.members[X].synced, false, 'input untouched')
  t.is(withSynced(r, 'ef'.repeat(32)), r, 'absent member: unchanged')
  t.is(withSynced(null, X), null)

  const w = withoutMember(r, X)
  t.alike(w, rec({ [Y]: { acceptedAt: T2, synced: false } }))
  t.ok(r.members[X], 'input untouched')
  t.is(withoutMember(r, 'ef'.repeat(32)), r)
  t.is(withoutMember(null, X), null)
})

test('withHeld: synced entry, fresh on a version change, existing kept, capped, invalid inputs refused', async (t) => {
  const { withHeld, withMember, MAX_MEMBERS, termsRecordOf, termsDecision } = await load()
  t.alike(withHeld(null, 2, X, T1), rec({ [X]: { acceptedAt: T1, synced: true } }, 2), 'nothing stored')
  t.alike(withHeld(undefined, 2, X, T1), rec({ [X]: { acceptedAt: T1, synced: true } }, 2))

  const r = rec({ [Y]: { acceptedAt: T1, synced: false } }, 1)
  t.alike(withHeld(r, 2, X, T2), rec({ [X]: { acceptedAt: T2, synced: true } }, 2), 'another version starts over')
  t.alike(withHeld(r, 1, X, T2), rec({ [Y]: { acceptedAt: T1, synced: false }, [X]: { acceptedAt: T2, synced: true } }, 1), 'added beside the others')
  t.alike(r, rec({ [Y]: { acceptedAt: T1, synced: false } }, 1), 'input untouched')
  t.is(withHeld(r, 1, Y, T2), r, 'an existing entry at that version is kept unchanged')
  t.is(r.members[Y].synced, false, 'its synced flag is not touched')

  const held = withHeld(null, 2, X, T1)
  t.ok(termsRecordOf(held), 'a valid record')
  const dec = (record) => termsDecision({ record, version: 2, member: X, claim: null, hosted: true, identityKnown: true, locked: false })
  t.is(dec(null), 'needed')
  t.is(dec(held), 'accepted', 'the held acceptance opens the gate for that member')
  t.is(termsDecision({ record: held, version: 2, member: Y, claim: null, hosted: true, identityKnown: true, locked: false }), 'account', 'and only for that member')
  t.is(termsDecision({ record: held, version: 3, member: X, claim: null, hosted: true, identityKnown: true, locked: false }), 'updated', 'and only for that version')

  const bad = [
    [r, 1, null, T1], [r, 1, undefined, T1], [r, 1, 'AB'.repeat(32), T1], [r, 1, 'ab'.repeat(31), T1], [r, 1, 5, T1],
    [r, 1, X, null], [r, 1, X, undefined], [r, 1, X, ''], [r, 1, X, 'lixo'], [r, 1, X, '2026-10-27T12:00:00Z'],
    [r, 1, X, '2026-02-30T12:00:00.000Z'], [r, 1, X, 5],
    [r, 0, X, T1], [r, 10000, X, T1], [r, 1.5, X, T1], [r, '1', X, T1], [r, null, X, T1]
  ]
  for (const args of bad) t.is(withHeld(...args), r, JSON.stringify(args.slice(1)))
  t.is(withHeld(null, 1, null, T1), null, 'nothing stored and nothing valid: still nothing')

  let full = null
  // key(5) is the oldest acceptance
  for (let i = 0; i < MAX_MEMBERS; i++) {
    const at = new Date(Date.UTC(2026, 0, i === 5 ? 1 : 10 + i)).toISOString()
    full = withMember(full, 1, key(i), at)
  }
  const next = withHeld(full, 1, X, T1)
  t.is(Object.keys(next.members).length, MAX_MEMBERS)
  t.alike(next.members[X], { acceptedAt: T1, synced: true })
  t.absent(next.members[key(5)], 'oldest dropped')
  const behind = withHeld(full, 1, X, '2025-01-01T00:00:00.000Z')
  t.ok(behind.members[X], 'the member just added stays even when it is the oldest')
  t.absent(behind.members[key(5)])
  t.ok(termsRecordOf(behind))
})

test('heldKey', async (t) => {
  const { heldKey } = await load()
  t.is(heldKey(X, 2), X + '#2')
})

test('shouldAskHeld: every gate', async (t) => {
  const { shouldAskHeld } = await load()
  const ok = { hosted: true, member: X, claim: null, decision: 'needed', online: true, entry: undefined }
  t.is(shouldAskHeld(ok), true)
  for (const decision of ['needed', 'updated', 'account']) t.is(shouldAskHeld({ ...ok, decision }), true, decision)
  t.is(shouldAskHeld({ ...ok, online: undefined }), true, 'unknown online counts as online')
  t.is(shouldAskHeld({ ...ok, claim: undefined }), true)
  t.is(shouldAskHeld({ ...ok, entry: null }), true)
  for (const decision of ['accepted', 'bind', 'loading', undefined, 'x']) t.is(shouldAskHeld({ ...ok, decision }), false, 'decision ' + decision)
  for (const hosted of [false, undefined, 'true', 1]) t.is(shouldAskHeld({ ...ok, hosted }), false, 'hosted ' + hosted)
  for (const member of [null, undefined, 'AB'.repeat(32), 'ab'.repeat(31), '']) t.is(shouldAskHeld({ ...ok, member }), false, 'member ' + member)
  t.is(shouldAskHeld({ ...ok, claim: { at: T1 } }), false, 'claim present')
  t.is(shouldAskHeld({ ...ok, online: false }), false, 'offline')
  for (const state of ['asking', 'held', 'none', 'failed', 'timeout']) t.is(shouldAskHeld({ ...ok, entry: { state } }), false, 'asked already: ' + state)
  t.is(shouldAskHeld(), false)
})

test('heldGate: waits only while a young question is in flight', async (t) => {
  const { heldGate, TERMS_HELD_WAIT_MS } = await load()
  t.is(TERMS_HELD_WAIT_MS, 4000)
  const asking = { state: 'asking', at: 1000 }
  for (const decision of ['needed', 'updated', 'account']) t.is(heldGate({ decision, entry: asking, elapsedMs: 0 }), 'wait', decision)
  t.is(heldGate({ decision: 'needed', entry: asking, elapsedMs: TERMS_HELD_WAIT_MS - 1 }), 'wait')
  t.is(heldGate({ decision: 'needed', entry: asking, elapsedMs: TERMS_HELD_WAIT_MS }), 'show', 'the wait is over')
  t.is(heldGate({ decision: 'needed', entry: asking, elapsedMs: 60000 }), 'show')
  for (const elapsedMs of [-1, NaN, Infinity, undefined, '0', null]) t.is(heldGate({ decision: 'needed', entry: asking, elapsedMs }), 'show', 'elapsed ' + elapsedMs)
  for (const state of ['held', 'none', 'failed', 'timeout', 'x']) t.is(heldGate({ decision: 'needed', entry: { state }, elapsedMs: 0 }), 'show', state)
  for (const entry of [undefined, null, 'asking', ['asking']]) t.is(heldGate({ decision: 'needed', entry, elapsedMs: 0 }), 'show', 'entry ' + JSON.stringify(entry))
  for (const decision of ['accepted', 'bind', 'loading', undefined]) t.is(heldGate({ decision, entry: asking, elapsedMs: 0 }), 'show', 'decision ' + decision)
  t.is(heldGate(), 'show')
})

test('heldSettle: only an entry still asking moves; a late held is a timeout; settled entries latch', async (t) => {
  const { heldSettle, heldGate, TERMS_HELD_WAIT_MS } = await load()
  const asking = { state: 'asking', at: 1000 }
  t.alike(heldSettle(asking, 'held', 10), { state: 'held' })
  t.alike(heldSettle(asking, 'held', TERMS_HELD_WAIT_MS - 1), { state: 'held' })
  t.alike(heldSettle(asking, 'held', TERMS_HELD_WAIT_MS), { state: 'timeout' }, 'a held answer after the wait is ignored')
  for (const elapsed of [-1, NaN, undefined]) t.alike(heldSettle(asking, 'held', elapsed), { state: 'timeout' }, 'elapsed ' + elapsed)
  for (const outcome of ['none', 'failed', 'timeout']) t.alike(heldSettle(asking, outcome, 10), { state: outcome }, outcome)
  // The App timer may fire a little early, or with no usable elapsed time:
  // a timeout still ends the wait, so the gate is never left asking.
  for (const elapsed of [TERMS_HELD_WAIT_MS - 1, 0, -1, NaN, undefined]) {
    const e = heldSettle(asking, 'timeout', elapsed)
    t.alike(e, { state: 'timeout' }, 'timeout at ' + elapsed)
    t.is(heldGate({ decision: 'needed', entry: e, elapsedMs: 0 }), 'show', 'shown after a timeout at ' + elapsed)
  }
  t.alike(heldSettle(asking, 'none', TERMS_HELD_WAIT_MS * 2), { state: 'none' })
  t.is(heldSettle(asking, 'x', 10), asking, 'unknown outcome: unchanged')
  t.is(heldSettle(asking, undefined, 10), asking)

  // The latch: none, failed and timeout never become held, nor move at all.
  for (const state of ['none', 'failed', 'timeout', 'held']) {
    const e = { state }
    for (const outcome of ['held', 'none', 'failed', 'timeout']) t.is(heldSettle(e, outcome, 0), e, state + ' then ' + outcome)
  }
  t.is(heldSettle(undefined, 'held', 0), undefined)
  t.is(heldSettle(null, 'held', 0), null)

  // A timeout shows the gate, and a held answer arriving afterwards keeps it.
  const timedOut = heldSettle(asking, 'timeout', TERMS_HELD_WAIT_MS)
  t.is(heldGate({ decision: 'needed', entry: timedOut, elapsedMs: 0 }), 'show')
  const late = heldSettle(timedOut, 'held', 0)
  t.alike(late, { state: 'timeout' })
  t.is(heldGate({ decision: 'needed', entry: late, elapsedMs: 0 }), 'show')
})

test('shouldSyncTerms: true only when every gate is open', async (t) => {
  const { shouldSyncTerms } = await load()
  const record = rec({ [X]: { acceptedAt: T1, synced: false } }, 2)
  const ok = {
    hosted: true,
    termsOk: true,
    ready: true,
    online: true,
    locked: false,
    setupDone: true,
    recovering: false,
    onceSync: false,
    member: X,
    record,
    version: 2,
    attempted: false
  }
  t.is(shouldSyncTerms(ok), true)
  t.is(shouldSyncTerms({ ...ok, online: undefined }), true, 'unknown online counts as online')
  const off = {
    hosted: false,
    termsOk: false,
    ready: false,
    online: false,
    locked: true,
    setupDone: false,
    recovering: true,
    onceSync: true,
    member: null,
    record: null,
    version: 3,
    attempted: true
  }
  for (const k of Object.keys(off)) t.is(shouldSyncTerms({ ...ok, [k]: off[k] }), false, k)
  t.is(shouldSyncTerms({ ...ok, locked: undefined }), false, 'locked must be exactly false')
  t.is(shouldSyncTerms({ ...ok, member: Y }), false, 'member not in record')
  t.is(shouldSyncTerms({ ...ok, record: rec({ [X]: { acceptedAt: T1, synced: true } }, 2) }), false, 'already synced')
  t.is(shouldSyncTerms(), false)
})

test('termsSyncStep: every transition', async (t) => {
  const { termsSyncStep: step, TERMS_SYNC_MAX } = await load()
  t.is(TERMS_SYNC_MAX, 3)
  t.alike(step(undefined, 'start'), { count: 1, state: 'busy' })
  const busy = { count: 2, state: 'busy' }
  t.alike(step(busy, 'ok'), { count: 2, state: 'done' })
  t.alike(step(busy, 'fail'), { count: 2, state: 'transient' })
  t.alike(step(busy, 'nao-vinculado'), { count: 2, state: 'so-aparelho' })
  t.alike(step(busy, 'generation'), { count: 1, state: 'retry' }, 'the attempt is given back')
  t.alike(step({ count: 0, state: 'busy' }, 'generation'), { count: 0, state: 'retry' })
  // Settle events only act on a run in flight.
  for (const state of ['done', 'transient', 'retry', 'so-aparelho']) {
    const e = { count: 1, state }
    for (const ev of ['ok', 'fail', 'nao-vinculado', 'generation']) t.is(step(e, ev), e, state + ' ' + ev)
  }
  t.is(step(undefined, 'ok'), undefined)
  t.is(step(undefined, 'online'), undefined)
  t.is(step(undefined, 'rearm'), undefined)
  // start: counts up, except after a 'done' (a fresh acceptance)
  t.alike(step({ count: 2, state: 'retry' }, 'start'), { count: 3, state: 'busy' })
  t.alike(step({ count: 1, state: 'done' }, 'start'), { count: 1, state: 'busy' })
  // online: transient under the cap only
  t.alike(step({ count: 2, state: 'transient' }, 'online'), { count: 2, state: 'retry' })
  const spent = { count: 3, state: 'transient' }
  t.is(step(spent, 'online'), spent, 'cap reached')
  const so = { count: 1, state: 'so-aparelho' }
  t.is(step(so, 'online'), so, 'so-aparelho is sticky')
  // rearm: so-aparelho is forgotten; transient is armed again, its count kept
  t.is(step(so, 'rearm'), undefined)
  t.alike(step({ count: 2, state: 'transient' }, 'rearm'), { count: 2, state: 'retry' }, 'the attempt cap is not reset')
  t.is(step(spent, 'rearm'), spent, 'cap reached')
  for (const state of ['done', 'retry']) {
    const e = { count: 1, state }
    t.is(step(e, 'rearm'), e, state)
  }
  // online or rearm while a run is in flight: it runs again if it fails
  const flying = { count: 1, state: 'busy' }
  const marked = step(flying, 'rearm')
  t.alike(marked, { count: 1, state: 'busy', again: true })
  t.is(step(marked, 'rearm'), marked, 'already marked')
  t.alike(step(marked, 'nao-vinculado'), { count: 1, state: 'retry' }, 'link confirmed meanwhile: tried again')
  t.alike(step(marked, 'fail'), { count: 1, state: 'retry' })
  t.alike(step(marked, 'ok'), { count: 1, state: 'done' })
  t.alike(step(flying, 'online'), { count: 1, state: 'busy', again: true })
  t.alike(step(step(flying, 'online'), 'fail'), { count: 1, state: 'retry' }, 'back online meanwhile: tried again')
  const last = { count: TERMS_SYNC_MAX, state: 'busy' }
  t.is(step(last, 'online'), last, 'online never re-arms past the cap')
  t.is(step(last, 'rearm'), last, 'rearm never re-arms past the cap')
  t.alike(step(step(flying, 'online'), 'start'), { count: 2, state: 'busy' }, 'a new run clears the mark')
  // drop: always forgotten
  for (const state of ['busy', 'done', 'transient', 'retry', 'so-aparelho']) {
    t.is(step({ count: 1, state }, 'drop'), undefined, state)
  }
  const e = { count: 1, state: 'done' }
  t.is(step(e, 'nonsense'), e)
})

test('termsSyncAttempted: done with a fresh unsynced entry does not block', async (t) => {
  const { termsSyncAttempted: attempted } = await load()
  const unsynced = { acceptedAt: T1, synced: false }
  const synced = { acceptedAt: T1, synced: true }
  t.is(attempted(undefined, unsynced), false)
  t.is(attempted({ count: 1, state: 'retry' }, unsynced), false)
  t.is(attempted({ count: 1, state: 'done' }, unsynced), false)
  t.is(attempted({ count: 1, state: 'done' }, synced), true)
  t.is(attempted({ count: 1, state: 'done' }, null), true)
  for (const state of ['busy', 'transient', 'so-aparelho']) {
    t.is(attempted({ count: 1, state }, unsynced), true, state)
  }
})

test('formatAcceptedAt is DD/MM/AAAA in local time', async (t) => {
  const { formatAcceptedAt } = await load()
  t.is(formatAcceptedAt(new Date(2026, 9, 7, 12).toISOString()), '07/10/2026')
  t.is(formatAcceptedAt('lixo'), '')
  t.is(formatAcceptedAt(null), '')
})

function fakeStorage (t, impl) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => impl() })
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete globalThis.localStorage
  })
}

test('termsStore.web: round trip under varanda-terms', async (t) => {
  const { loadTermsRecord, saveTermsRecord } = await loadWeb()
  const { STORAGE_KEY } = await load()
  const map = new Map()
  const storage = { getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)) }
  fakeStorage(t, () => storage)
  t.is(await loadTermsRecord(), null, 'empty')
  const r = rec({ [X]: { acceptedAt: T1, synced: false } }, 2)
  t.is(await saveTermsRecord(r), true)
  t.is(STORAGE_KEY, 'varanda-terms')
  t.alike(JSON.parse(map.get('varanda-terms')), r)
  t.alike(await loadTermsRecord(), r)
  t.is(await saveTermsRecord({ v: 1 }), false, 'invalid record not saved')
  map.set('varanda-terms', '{nope')
  t.is(await loadTermsRecord(), null, 'corrupt JSON')
  map.set('varanda-terms', JSON.stringify({ ...r, extra: 1 }))
  t.is(await loadTermsRecord(), null, 'invalid shape')
})

test('termsStore.web: a locked reload keeps the acceptance', async (t) => {
  const { loadTermsRecord, saveTermsRecord } = await loadWeb()
  const { termsDecision, withMember } = await load()
  const map = new Map()
  const storage = { getItem: (k) => map.has(k) ? map.get(k) : undefined, setItem: (k, v) => map.set(k, String(v)) }
  fakeStorage(t, () => storage)
  const dec = (record, o) => termsDecision({ record, version: 2, member: null, claim: null, hosted: true, identityKnown: true, locked: true, ...o })

  t.is(dec(await loadTermsRecord()), 'accepted', 'nothing stored: locked, the gate waits for Entrar')
  t.is(dec(await loadTermsRecord(), { member: X }), 'needed', 'nothing stored, after Entrar')

  await saveTermsRecord(rec({ [X]: { acceptedAt: T1, synced: false } }, 2))
  let loaded = await loadTermsRecord()
  t.is(dec(loaded), 'accepted', 'locked reload, member accepted')
  t.is(dec(loaded, { locked: false }), 'needed', 'unlocked before the shell knows the key')
  t.is(dec(loaded, { member: Y }), 'account', 'another account is asked after its passkey')
  t.is(dec(loaded, { version: 3 }), 'accepted', 'a new version waits for Entrar')
  t.is(dec(loaded, { version: 3, member: X }), 'updated', 'a new version asks again after Entrar')

  const saved = withMember(null, 2, null, T1)
  t.alike(saved, rec({}, 2))
  await saveTermsRecord(saved)
  loaded = await loadTermsRecord()
  t.is(dec(loaded), 'accepted', 'locked reload, acceptance given before sign-in')
  t.is(dec(loaded, { member: Y }), 'account', 'the stored acceptance names no member')
})

test('termsStore.web: a throwing or missing storage never throws', async (t) => {
  const { loadTermsRecord, saveTermsRecord } = await loadWeb()
  const r = rec({ [X]: { acceptedAt: T1, synced: false } })
  let impl = () => { throw new Error('SecurityError') }
  fakeStorage(t, () => impl())
  t.is(await loadTermsRecord(), null)
  t.is(await saveTermsRecord(r), false)
  impl = () => ({ getItem () { throw new Error('x') }, setItem () { throw new Error('QuotaExceeded') } })
  t.is(await loadTermsRecord(), null)
  t.is(await saveTermsRecord(r), false)
  impl = () => undefined
  t.is(await loadTermsRecord(), null)
  t.is(await saveTermsRecord(r), false)
})

test('the terms gate keeps its legal words on the shared frame', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Termos.js'), 'utf8')
  for (const word of [
    "const ACCEPT_LABEL = 'Aceitar e continuar'",
    "const BLOCKED_TEXT = 'Sem aceitar, não é possível entrar no Varanda.'",
    "const BLOCKED_CREATE_TEXT = 'Sem aceitar, não é possível criar uma conta ou uma passkey nova.'",
    "const NEEDED_TEXT = 'Antes de usar o Varanda, leia e aceite os Termos de Uso e a Política de Privacidade.'",
    'OptionList', 'block large', "icon='file-text'", 'aria-expanded'
  ]) t.ok(src.includes(word), word)
  t.is(src.split('onPress={onAccept}').length - 1, 1, 'only the accept button accepts')
})

// The accept button is a short label, so the sentence above it is what asks
// the person to read and accept both documents: it must stay on the gate.
test('the terms gate shows the consent sentence above the accept button', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'Termos.js'), 'utf8')
  const gate = src.slice(src.indexOf('if (gate) {'), src.indexOf('onPress={onAccept}'))
  t.ok(gate.includes('<Stepper'), 'the gate renders the Stepper')
  t.ok(gate.includes('hint={gateText(reason, version)}'), 'the gate Stepper renders the consent sentence')
  for (const word of [
    "const NEEDED_TEXT = 'Antes de usar o Varanda, leia e aceite os Termos de Uso e a Política de Privacidade.'",
    "const ACCOUNT_TEXT = 'Esta conta ainda não aceitou os Termos de Uso e a Política de Privacidade neste aparelho. Leia e aceite para continuar.'"
  ]) t.ok(src.includes(word), word)
  const start = src.indexOf('function gateText (reason, version) {')
  t.ok(start !== -1, 'gateText exists')
  const body = src.slice(start, src.indexOf('\n}\n', start))
  t.is(body, [
    'function gateText (reason, version) {',
    "  if (reason === 'updated') return 'Os Termos de Uso e a Política de Privacidade mudaram. Leia e aceite a versão ' + version + ' para continuar.'",
    "  if (reason === 'account') return ACCOUNT_TEXT",
    '  return NEEDED_TEXT'
  ].join('\n'), 'gateText returns the updated, account and needed sentences')
})
