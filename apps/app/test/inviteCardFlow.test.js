'use strict'

// The invite card arrival controller (src/inviteCardFlow.js). ES module loaded
// through import(). Signatures are real: the fake node's inviteCard.verify
// calls the core verifier, as both nodes do.
const test = require('brittle')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const rpc = require('@varanda/rpc')
const { signInviteCard, verifyInviteCard, isInviteCardExpired } = require('@varanda/core/lib/invite-card')

const load = () => import('../src/inviteCardFlow.js')

const CODE = 'aB3_-'.repeat(8) + 'xyz'
const CODE2 = 'Z'.repeat(43)
const ASSOCIATION = 'a'.repeat(64)
const NOW = 1_800_000_000_000
const EXPIRES = Math.floor(NOW / 1000) + 7 * 24 * 60 * 60
const ARRIVAL_DM = 'Oi! Cheguei pelo seu convite.'
const ORIGIN = 'https://varanda.example'

function makeCard ({ code = CODE, expires = EXPIRES, keyPair = crypto.keyPair(), message = 'Vem comigo.' } = {}) {
  const member = b4a.toString(keyPair.publicKey, 'hex')
  const fields = { code, design: 'cordel', name: 'Ana', message, expires, member }
  const signature = signInviteCard({ ...fields, association: ASSOCIATION }, keyPair)
  const url = rpc.buildInviteCardUrl({ origin: ORIGIN, ...fields, signature })
  const body = url.slice(url.indexOf('#c1.') + 4)
  return { member, body, record: { v: 1, code, body, at: NOW } }
}

function fakeNode ({ clockNow = NOW, usage = false, fail = null } = {}) {
  const calls = []
  const answers = {}
  async function request (method, params) {
    calls.push({ method, params })
    if (method === 'inviteCard.verify') {
      if (usage) throw Object.assign(new Error('método desconhecido'), { code: 'USAGE' })
      if (fail) throw fail
      const { signature, ...fields } = params
      const r = verifyInviteCard({ ...fields, association: ASSOCIATION }, signature)
      if (r.ok && isInviteCardExpired(fields.expires, Math.floor(clockNow / 1000))) return { ok: false, reason: 'expired' }
      return r
    }
    if (Object.hasOwn(answers, method)) {
      const a = answers[method]
      if (a instanceof Error) throw a
      return typeof a === 'function' ? a(params) : a
    }
    return {}
  }
  const writes = () => calls.filter((c) => c.method === 'follow.add' || c.method === 'dm.send')
  return { request, calls, answers, writes }
}

const linkedStatus = (member, username = 'ana') => async (m) => ({
  linked: true,
  username,
  usernameRecord: { member: m, username }
})

test('ok path: verified card of a linked member with a matching username', async (t) => {
  const { resolveInviteCard, canAttribute, cardRecordId } = await load()
  const { member, record } = makeCard()
  const node = fakeNode()
  const statusCalls = []
  const r = await resolveInviteCard({
    record,
    heldCode: CODE,
    request: node.request,
    accountStatus: async (m) => { statusCalls.push(m); return linkedStatus(member)(m) },
    nodeReady: true,
    now: NOW
  })
  t.is(r.signature, 'ok')
  t.is(r.membership, 'linked')
  t.is(r.expired, false)
  t.is(r.member, member)
  t.is(r.username, 'ana')
  t.is(r.card.name, 'Ana')
  t.is(r.card.design, 'cordel')
  t.is(r.recordId, cardRecordId(record))
  t.ok(Object.isFrozen(r))
  t.ok(canAttribute(r))
  t.alike(statusCalls, [member])
  t.is(node.calls.length, 1)
  t.is(node.calls[0].method, 'inviteCard.verify')
  t.is(node.calls[0].params.code, CODE)
  t.is(node.writes().length, 0, 'resolving never writes')
})

test('node not ready gives wait without any call', async (t) => {
  const { resolveInviteCard, canAttribute } = await load()
  const { record } = makeCard()
  const node = fakeNode()
  const r = await resolveInviteCard({ record, heldCode: CODE, request: node.request, accountStatus: async () => { throw new Error('no') }, nodeReady: false, now: NOW })
  t.is(r.signature, 'wait')
  t.is(r.membership, null)
  t.is(node.calls.length, 0)
  t.absent(canAttribute(r))
})

test('bad signature: another key signed it', async (t) => {
  const { resolveInviteCard, canAttribute } = await load()
  const signer = crypto.keyPair()
  const claimed = crypto.keyPair()
  const member = b4a.toString(claimed.publicKey, 'hex')
  const fields = { code: CODE, design: 'cordel', name: 'Ana', message: 'Vem comigo.', expires: EXPIRES, member }
  const signature = signInviteCard({ ...fields, association: ASSOCIATION }, signer)
  const url = rpc.buildInviteCardUrl({ origin: ORIGIN, ...fields, signature })
  const record = { v: 1, code: CODE, body: url.slice(url.indexOf('#c1.') + 4), at: NOW }
  let asked = false
  const r = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode().request, accountStatus: async () => { asked = true; return { linked: true } }, nodeReady: true, now: NOW })
  t.is(r.signature, 'bad')
  t.is(r.membership, null)
  t.is(r.card, null)
  t.is(r.member, null)
  t.absent(asked, 'no status lookup for a bad card')
  t.absent(canAttribute(r))
})

test('a fragment transplanted onto another code is bad', async (t) => {
  const { resolveInviteCard } = await load()
  const { body } = makeCard()
  const record = { v: 1, code: CODE2, body, at: NOW }
  const r = await resolveInviteCard({ record, heldCode: CODE2, request: fakeNode().request, accountStatus: linkedStatus(), nodeReady: true, now: NOW })
  t.is(r.signature, 'bad')
})

test('a card for a code the app no longer holds is bad', async (t) => {
  const { resolveInviteCard } = await load()
  const { record } = makeCard()
  const node = fakeNode()
  for (const heldCode of [CODE2, null, undefined]) {
    const r = await resolveInviteCard({ record, heldCode, request: node.request, accountStatus: linkedStatus(), nodeReady: true, now: NOW })
    t.is(r.signature, 'bad')
  }
  t.is(node.calls.length, 0)
})

test('a garbled record is bad', async (t) => {
  const { resolveInviteCard } = await load()
  const node = fakeNode()
  for (const record of [null, {}, { code: CODE, body: 'zz', at: NOW }, { code: CODE, body: 1, at: NOW }]) {
    const r = await resolveInviteCard({ record, heldCode: CODE, request: node.request, accountStatus: linkedStatus(), nodeReady: true, now: NOW })
    t.is(r.signature, 'bad')
  }
  t.is(node.calls.length, 0)
})

test('unknown method on an old node is bad', async (t) => {
  const { resolveInviteCard } = await load()
  const { record } = makeCard()
  const r = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode({ usage: true }).request, accountStatus: linkedStatus(), nodeReady: true, now: NOW })
  t.is(r.signature, 'bad')
  t.is(r.membership, null)
})

test('a transient verify failure gives wait', async (t) => {
  const { resolveInviteCard } = await load()
  const { record } = makeCard()
  const fail = Object.assign(new Error('tempo esgotado'), { code: 'TIMEOUT' })
  const r = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode({ fail }).request, accountStatus: linkedStatus(), nodeReady: true, now: NOW })
  t.is(r.signature, 'wait')
})

test('unlinked member cannot be attributed', async (t) => {
  const { resolveInviteCard, canAttribute } = await load()
  const { record } = makeCard()
  for (const status of [{ linked: false, username: 'ana' }, {}, null]) {
    const r = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode().request, accountStatus: async () => status, nodeReady: true, now: NOW })
    t.is(r.signature, 'ok')
    t.is(r.membership, 'unlinked')
    t.is(r.username, null)
    t.absent(canAttribute(r))
  }
})

test('username mismatch gives username null', async (t) => {
  const { resolveInviteCard, canAttribute } = await load()
  const { member, record } = makeCard()
  const statuses = [
    { linked: true, username: 'ana', usernameRecord: { member: 'b'.repeat(64), username: 'ana' } },
    { linked: true, username: 'ana', usernameRecord: { member, username: 'bia' } },
    { linked: true, username: 'ana' },
    { linked: true, usernameRecord: { member } }
  ]
  for (const status of statuses) {
    const r = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode().request, accountStatus: async () => status, nodeReady: true, now: NOW })
    t.is(r.membership, 'linked')
    t.is(r.username, null)
    t.ok(canAttribute(r))
  }
})

test('offline status gives membership unknown, never attribution', async (t) => {
  const { resolveInviteCard, canAttribute } = await load()
  const { member, record } = makeCard()
  const r = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode().request, accountStatus: async () => { throw new Error('offline') }, nodeReady: true, now: NOW })
  t.is(r.signature, 'ok')
  t.is(r.membership, 'unknown')
  t.is(r.member, member)
  t.is(r.username, null)
  t.absent(canAttribute(r))
})

test('expired: record older than a day, card past expires, node says expired', async (t) => {
  const { resolveInviteCard, canAttribute } = await load()
  const { record } = makeCard()
  // Locally expired cards are terminal: no verify, no account lookup.
  let calls = 0
  const counted = (fn) => (...a) => { calls++; return fn(...a) }
  const late = await resolveInviteCard({ record, heldCode: CODE, request: counted(fakeNode().request), accountStatus: counted(linkedStatus()), nodeReady: true, now: NOW + 24 * 60 * 60 * 1000 + 1 })
  t.is(late.signature, 'bad')
  t.is(late.expired, true)
  t.absent(canAttribute(late))

  const short = makeCard({ expires: Math.floor(NOW / 1000) - 60 })
  const past = await resolveInviteCard({ record: short.record, heldCode: CODE, request: counted(fakeNode().request), accountStatus: counted(linkedStatus()), nodeReady: true, now: NOW })
  t.is(past.expired, true)
  t.absent(canAttribute(past))
  t.is(calls, 0, 'no verify and no account lookup for an expired card')

  // The node's clock runs two days ahead: it answers reason 'expired'.
  const nodeLate = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode({ clockNow: (EXPIRES + 2 * 24 * 60 * 60) * 1000 }).request, accountStatus: linkedStatus(), nodeReady: true, now: NOW })
  t.is(nodeLate.signature, 'bad')
  t.is(nodeLate.expired, true)
  t.is(nodeLate.membership, null)
  t.absent(canAttribute(nodeLate))
})

test('recordId changes when the record is replaced', async (t) => {
  const { cardRecordId } = await load()
  const { record } = makeCard()
  t.is(cardRecordId(record), cardRecordId({ ...record }))
  t.not(cardRecordId(record), cardRecordId({ ...record, at: NOW + 1 }))
  t.not(cardRecordId(record), cardRecordId(makeCard().record))
  t.is(cardRecordId(null), null)
})

async function attributed () {
  const { resolveInviteCard } = await load()
  const { member, record } = makeCard()
  const result = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode().request, accountStatus: linkedStatus(member), nodeReady: true, now: NOW })
  return { member, result }
}

test('arrival actions: zero writes before a tap, one write per tap', async (t) => {
  const { arrivalActions } = await load()
  const { member, result } = await attributed()
  const node = fakeNode()
  node.answers['dm.lookup'] = { box: 'c'.repeat(64) }
  const actions = arrivalActions({ request: node.request, result, member, text: ARRIVAL_DM, guard: () => true })
  t.is(node.calls.length, 0, 'nothing by construction')
  t.is(await actions.follow(), 'done')
  t.alike(node.writes(), [{ method: 'follow.add', params: { key: member } }])
  t.is(await actions.oi(), 'sent')
  t.alike(node.calls.map((c) => c.method), ['follow.add', 'dm.lookup', 'dm.send'])
  t.alike(node.calls[1].params, { member })
  t.alike(node.calls[2].params, { to: member, text: ARRIVAL_DM })
  t.not(node.calls[2].params.text, result.card.message, 'never the card message')
})

test('arrival actions: no dm.send without a box', async (t) => {
  const { arrivalActions } = await load()
  const { member, result } = await attributed()
  for (const answer of [{ box: null }, null, {}]) {
    const node = fakeNode()
    node.answers['dm.lookup'] = answer
    const actions = arrivalActions({ request: node.request, result, member, text: ARRIVAL_DM, guard: () => true })
    t.is(await actions.oi(), 'nodm')
    t.is(node.writes().length, 0)
  }
  const node = fakeNode()
  node.answers['dm.lookup'] = new Error('falhou')
  const actions = arrivalActions({ request: node.request, result, member, text: ARRIVAL_DM, guard: () => true })
  t.is(await actions.oi(), 'failed')
  t.is(node.writes().length, 0)
})

test('arrival actions: uncertain results do not resend', async (t) => {
  const { arrivalActions } = await load()
  const { member, result } = await attributed()
  const node = fakeNode()
  node.answers['follow.add'] = Object.assign(new Error('x'), { uncertain: true })
  node.answers['dm.lookup'] = { box: 'c'.repeat(64) }
  node.answers['dm.send'] = Object.assign(new Error('x'), { uncertain: true })
  const actions = arrivalActions({ request: node.request, result, member, text: ARRIVAL_DM, guard: () => true })
  t.is(await actions.follow(), 'uncertain')
  t.is(await actions.oi(), 'uncertain')
  t.is(node.calls.filter((c) => c.method === 'follow.add').length, 1)
  t.is(node.calls.filter((c) => c.method === 'dm.send').length, 1)

  node.answers['follow.add'] = new Error('recusado')
  t.is(await actions.follow(), 'failed')
  t.is(node.calls.filter((c) => c.method === 'follow.add').length, 2, 'only the second tap writes again')
})

test('arrival actions: guard checked before each write', async (t) => {
  const { arrivalActions } = await load()
  const { member, result } = await attributed()

  const stale = fakeNode()
  const off = arrivalActions({ request: stale.request, result, member, text: ARRIVAL_DM, guard: () => false })
  t.is(await off.follow(), 'stale')
  t.is(await off.oi(), 'stale')
  t.is(stale.calls.length, 0)

  // The identity changes while dm.lookup is in flight.
  let current = true
  const node = fakeNode()
  node.answers['dm.lookup'] = () => { current = false; return { box: 'c'.repeat(64) } }
  const actions = arrivalActions({ request: node.request, result, member, text: ARRIVAL_DM, guard: () => current })
  t.is(await actions.oi(), 'stale')
  t.is(node.writes().length, 0)

  const noGuard = fakeNode()
  t.is(await arrivalActions({ request: noGuard.request, result, member, text: ARRIVAL_DM }).follow(), 'stale')
  t.is(noGuard.calls.length, 0)
})

test('arrival actions: no write without canAttribute', async (t) => {
  const { resolveInviteCard, arrivalActions } = await load()
  const { member, record } = makeCard()
  const offline = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode().request, accountStatus: async () => { throw new Error('offline') }, nodeReady: true, now: NOW })
  const unlinked = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode().request, accountStatus: async () => ({ linked: false }), nodeReady: true, now: NOW })
  const expired = await resolveInviteCard({ record, heldCode: CODE, request: fakeNode().request, accountStatus: linkedStatus(member), nodeReady: true, now: NOW + 2 * 24 * 60 * 60 * 1000 })
  const { result: good } = await attributed()
  const cases = [
    [offline, member],
    [unlinked, member],
    [expired, member],
    [null, member],
    [good, member] // good result, but for another card's member
  ]
  const node = fakeNode()
  node.answers['dm.lookup'] = { box: 'c'.repeat(64) }
  for (const [result, who] of cases) {
    const target = result === good ? 'd'.repeat(64) : who
    const actions = arrivalActions({ request: node.request, result, member: target, text: ARRIVAL_DM, guard: () => true })
    t.is(await actions.follow(), 'stale')
    t.is(await actions.oi(), 'stale')
  }
  t.is(node.calls.length, 0)
})
