'use strict'

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')

let start = 0
// A new query string loads a new module, which simulates a new process.
const load = () => import('../src/momentCleanup.js?start=' + ++start)
const OWN = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const ref = (seq, author = OWN) => author + ':' + seq
const moment = (seq, at = iso(NOW - 3 * DAY), author = OWN) => ({ seq, ref: ref(seq, author), text: '', at })
const cand = (seq) => ({ ref: ref(seq), seq, at: iso(NOW - 3 * DAY) })
const entry = (seq, tries, state) => ({ ref: ref(seq), tries, state })

function memory (initial = []) {
  const values = new Map(initial)
  return {
    values,
    read: (identity) => values.has(identity) ? values.get(identity) : null,
    write: async (identity, text) => { values.set(identity, text) }
  }
}

const ledgerOf = (store, identity = OWN) => JSON.parse(store.values.get(identity))

async function begin (store, identity = OWN) {
  const m = await load()
  return m.createCleanupPlanner({ store, identity }).beginPass()
}

async function finish (pass, candidates, outcome = 'done') {
  const candidate = await pass.nextStep(candidates)
  await pass.claim(candidate.ref)
  await pass.settle(candidate.ref, outcome)
  return candidate
}

test('cleanup constants', async (t) => {
  const m = await load()
  t.is(m.MAX_PER_PASS, 4)
  t.is(m.MAX_TRIES, 3)
  t.is(m.MARGIN_MS, DAY)
  t.is(m.LEDGER_CAP, 256)
  t.is(m.PAST_CAP, 16)
})

test('expiredOwn keeps moments published at least 48 h ago', async (t) => {
  const { expiredOwn } = await load()
  const at = iso(NOW - 2 * DAY)
  t.alike(expiredOwn([moment(1, at)], OWN, NOW), [{ ref: ref(1), seq: 1, at }], 'exactly 48 h passes')
  t.alike(expiredOwn([moment(1, at)], OWN, NOW - 1), [], 'one ms earlier does not')
  t.alike(expiredOwn([moment(1, iso(NOW - DAY - 1))], OWN, NOW), [], 'expired but inside the margin')
})

test('expiredOwn drops foreign, malformed and duplicate items, oldest first', async (t) => {
  const { expiredOwn } = await load()
  const old = iso(NOW - 5 * DAY)
  const past = [
    moment(9),
    moment(8, iso(NOW - 3 * DAY), OTHER),
    { seq: 7, ref: OTHER + ':7', at: old },
    { seq: 6, ref: ref(5), at: old },
    { seq: 0, ref: ref(0), at: old },
    { seq: 1.5, ref: ref(1.5), at: old },
    { seq: '4', ref: ref(4), at: old },
    { seq: 3, ref: ref(3), at: 'ontem' },
    { seq: 3, ref: ref(3), at: NOW - 5 * DAY },
    { seq: 2, ref: ref(2).toUpperCase(), at: old },
    null,
    'x',
    [],
    moment(4, old),
    moment(4, old),
    moment(1, iso(NOW - 4 * DAY))
  ]
  t.alike(expiredOwn(past, OWN, NOW).map((item) => item.ref), [ref(4), ref(1), ref(9)])
  t.alike(expiredOwn(past, 'AB'.repeat(32), NOW), [], 'identity must be lowercase hex')
  t.alike(expiredOwn(null, OWN, NOW), [])
  t.alike(expiredOwn({ length: 1, 0: moment(1) }, OWN, NOW), [])
  t.alike(expiredOwn([moment(1)], OWN, NaN), [])
  const hostile = { get seq () { throw new Error('boom') } }
  t.alike(expiredOwn([hostile, moment(2)], OWN, NOW), [], 'a throwing item drops the list, never throws')
})

test('outcomeOf maps the node answers', async (t) => {
  const { outcomeOf } = await load()
  const coded = (code) => Object.assign(new Error('x'), { code })
  t.is(outcomeOf(Object.assign(new Error('conexão encerrada'), { uncertain: true })), 'uncertain', 'uncertain wins')
  t.is(outcomeOf({ queued: true }), 'refused')
  t.is(outcomeOf(Object.assign(new Error('conexão encerrada'), { queued: true, uncertain: true })), 'refused', 'never sent wins over uncertain')
  t.is(outcomeOf(coded('LOCKED')), 'refused')
  t.is(outcomeOf(coded('CLOSED')), 'refused')
  for (const message of [
    'pedidos demais em andamento', 'conexão encerrada', 'sem conexão com o nó', 'sincronização já em andamento',
    'sincronize com o semeador antes de publicar', 'identidade bloqueada: entre com a passkey', 'sessão encerrada'
  ]) t.is(outcomeOf(new Error(message)), 'refused', message)
  t.is(outcomeOf(new Error('referência inválida')), 'gone')
  t.is(outcomeOf(new Error('outra coisa')), 'failed')
  t.is(outcomeOf(null), 'failed')
  t.is(outcomeOf(undefined), 'failed')
  t.is(outcomeOf('texto'), 'failed')
})

test('cleanup refusals match the outbox retry messages', async (t) => {
  const outboxSource = fs.readFileSync(path.join(__dirname, '../src/outbox.js'), 'utf8')
  const cleanupSource = fs.readFileSync(path.join(__dirname, '../src/momentCleanup.js'), 'utf8')
  const retryNames = outboxSource.match(/const RETRY_MESSAGES\s*=\s*\[([^\]]*)\]/)?.[1].match(/\b[A-Z][A-Z0-9_]*\b/g) ?? []
  const refusalNames = cleanupSource.match(/const refusals\s*=\s*new Set\(\[([^\]]*)\]\)/)?.[1].match(/\b[A-Z][A-Z0-9_]*\b/g) ?? []
  t.ok(retryNames.length >= 7, 'outbox.js RETRY_MESSAGES must contain at least seven constant names; check for a renamed declaration')
  t.ok(refusalNames.length >= 7, 'momentCleanup.js refusals must contain at least seven constant names; check for a renamed declaration')
  t.alike([...refusalNames].sort(), [...retryNames].sort(), 'both lists contain the same constant names')
  const outbox = await import('../src/outbox.js')
  const { outcomeOf } = await load()
  for (const name of retryNames) {
    t.is(outcomeOf(new Error(outbox[name])), 'refused', name + ' is refused before sending')
  }
  t.is(outcomeOf(new Error('boom')), 'failed', 'an unrelated message is still a failure')
})

test('cleanup caps a pass at four picks and writes the ledger shape', async (t) => {
  const store = memory()
  const pass = await begin(store)
  const candidates = [1, 2, 3, 4, 5].map(cand)
  for (const seq of [1, 2, 3, 4]) t.alike(await finish(pass, candidates), cand(seq))
  t.is(await pass.nextStep(candidates), null, 'four picks exhaust the pass')
  t.alike(ledgerOf(store), [1, 2, 3, 4].map((seq) => entry(seq, 1, 'done')))
})

test('cleanup begins once per identity in the module lifetime', async (t) => {
  const m = await load()
  const store = memory()
  const planner = m.createCleanupPlanner({ store, identity: OWN })
  t.ok(planner.beginPass())
  t.is(planner.beginPass(), null)
  t.is(m.createCleanupPlanner({ store, identity: OWN }).beginPass(), null, 'recreating a planner cannot reset the start')
  t.ok(m.createCleanupPlanner({ store, identity: OTHER }).beginPass(), 'another identity has its own pass')
  t.exception(() => m.createCleanupPlanner({ store, identity: 'x' }))
})

test('cleanup picks absent and retryable entries only', async (t) => {
  const store = memory([[OWN, JSON.stringify([
    entry(1, 1, 'done'), entry(2, 1, 'gone'), entry(3, 3, 'failed'), entry(4, 2, 'failed'),
    entry(5, 1, 'uncertain'), entry(6, 1, 'pending')
  ])]])
  const pass = await begin(store)
  const candidates = [1, 2, 3, 4, 5, 6, 7].map(cand)
  const picked = []
  for (let i = 0; i < 4; i++) picked.push((await finish(pass, candidates, 'failed')).seq)
  t.alike(picked, [4, 5, 6, 7])
  const ledger = ledgerOf(store)
  t.alike(ledger.find((e) => e.ref === ref(4)), entry(4, 3, 'failed'))
  t.alike(ledger.find((e) => e.ref === ref(6)), entry(6, 2, 'failed'), 'a crash pending counted its try')
  t.alike(ledger.find((e) => e.ref === ref(7)), entry(7, 1, 'failed'))
})

test('cleanup never picks a ref after three tries across opens', async (t) => {
  const store = memory()
  for (let open = 1; open <= 3; open++) {
    const pass = await begin(store)
    t.alike(await finish(pass, [cand(1)], open === 2 ? 'uncertain' : 'failed'), cand(1), 'open ' + open)
  }
  t.alike(ledgerOf(store), [entry(1, 3, 'failed')])
  const pass = await begin(store)
  t.is(await pass.nextStep([cand(1)]), null)
})

test('cleanup counts a pending left by a crash as a spent try', async (t) => {
  const store = memory()
  for (let open = 1; open <= 3; open++) {
    const pass = await begin(store)
    const candidate = await pass.nextStep([cand(1)])
    t.ok(candidate, 'open ' + open)
    await pass.claim(candidate.ref)
    t.alike(ledgerOf(store), [entry(1, open, 'pending')])
  }
  t.is(await (await begin(store)).nextStep([cand(1)]), null)
})

test('cleanup release restores the prior entry or removes a new one', async (t) => {
  const store = memory([[OWN, JSON.stringify([entry(1, 2, 'uncertain')])]])
  const pass = await begin(store)
  await pass.claim((await pass.nextStep([cand(1), cand(2)])).ref)
  t.alike(ledgerOf(store), [entry(1, 3, 'pending')])
  await pass.release(ref(1))
  t.alike(ledgerOf(store), [entry(1, 2, 'uncertain')])
  const next = await pass.nextStep([cand(1), cand(2)])
  t.alike(next, cand(2), 'a released ref is not picked again in the same pass')
  await pass.claim(next.ref)
  await pass.release(next.ref)
  t.alike(ledgerOf(store), [entry(1, 2, 'uncertain')])
  const again = await begin(store)
  t.alike(await again.nextStep([cand(1)]), cand(1), 'no try spent')
})

test('cleanup steps must follow pick, claim, settle', async (t) => {
  const store = memory()
  const pass = await begin(store)
  await t.exception(pass.claim(ref(1)), 'claim without a pick')
  const candidate = await pass.nextStep([cand(1), cand(2)])
  t.is(await pass.nextStep([cand(2)]), null, 'one pick at a time')
  await t.exception(pass.settle(candidate.ref, 'done'), 'settle without a claim')
  await t.exception(pass.release(candidate.ref), 'release without a claim')
  await pass.claim(candidate.ref)
  await t.exception(pass.settle(candidate.ref, 'pending'), 'pending is not an outcome')
  await t.exception(pass.settle(candidate.ref, 'refused'), 'refused is not an outcome')
  await pass.settle(candidate.ref, 'gone')
  t.alike(ledgerOf(store), [entry(1, 1, 'gone')])
})

test('cleanup stops on an unreadable ledger and never overwrites it', async (t) => {
  const bad = [
    'nope', '{}', JSON.stringify([{ ref: ref(1), tries: 1 }]),
    JSON.stringify([{ ref: ref(1), tries: 0, state: 'done' }]),
    JSON.stringify([{ ref: ref(1), tries: 4, state: 'done' }]),
    JSON.stringify([{ ref: ref(1), tries: 1, state: 'refused' }]),
    JSON.stringify([{ ref: ref(1, OTHER), tries: 1, state: 'done' }]),
    JSON.stringify([{ ref: ref(0), tries: 1, state: 'done' }]),
    JSON.stringify([{ ref: ref(1), tries: 1, state: 'done', extra: 1 }]),
    JSON.stringify([entry(1, 1, 'done'), entry(1, 1, 'gone')]),
    JSON.stringify(Array.from({ length: 257 }, (_, i) => entry(i + 1, 1, 'done')))
  ]
  for (const text of bad) {
    const store = memory([[OWN, text]])
    const pass = await begin(store)
    await t.exception(pass.settleStale([]))
    t.is(await pass.nextStep([cand(5)]), null, 'the pass stopped')
    const next = await begin(store)
    t.is(await next.nextStep([cand(5)]), null)
    t.is(store.values.get(OWN), text)
  }
})

test('cleanup stops when the ledger loses a ref seen in the pass', async (t) => {
  const store = memory([[OWN, JSON.stringify([entry(1, 1, 'failed')])]])
  const pass = await begin(store)
  const candidate = await pass.nextStep([cand(2)])
  store.values.set(OWN, '[]')
  await t.exception(pass.claim(candidate.ref))
  t.is(store.values.get(OWN), '[]')
})

test('cleanup stale sweep settles missing non-terminal entries only when untruncated', async (t) => {
  const initial = JSON.stringify([
    entry(1, 1, 'pending'), entry(2, 1, 'failed'), entry(3, 2, 'uncertain'), entry(4, 1, 'done'), entry(5, 1, 'failed')
  ])
  const store = memory([[OWN, initial]])
  const pass = await begin(store)
  t.is(await pass.settleStale([moment(5)]), 3)
  t.alike(ledgerOf(store), [
    entry(1, 1, 'gone'), entry(2, 1, 'gone'), entry(3, 2, 'gone'), entry(4, 1, 'done'), entry(5, 1, 'failed')
  ])
  await t.exception(pass.settleStale([]), 'only once per pass')

  const full = memory([[OWN, initial]])
  const truncated = Array.from({ length: 16 }, (_, i) => moment(100 + i))
  t.is(await (await begin(full)).settleStale(truncated), 0)
  t.is(full.values.get(OWN), initial, '16 items may be truncated: untouched')

  const odd = memory([[OWN, initial]])
  t.is(await (await begin(odd)).settleStale(null), 0)
  t.is(odd.values.get(OWN), initial)
})

test('cleanup eviction drops only done and gone, oldest first', async (t) => {
  const entries = Array.from({ length: 256 }, (_, i) => entry(i + 1, 1, i === 5 ? 'gone' : i === 2 ? 'done' : 'failed'))
  entries[0] = entry(1, 1, 'pending')
  entries[1] = entry(2, 3, 'uncertain')
  const store = memory([[OWN, JSON.stringify(entries)]])
  const pass = await begin(store)
  await finish(pass, [cand(1000)], 'failed')
  let ledger = ledgerOf(store)
  t.is(ledger.length, 256)
  t.absent(ledger.some((e) => e.ref === ref(3)), 'the oldest done went first')
  t.ok(ledger.some((e) => e.ref === ref(6)))
  t.alike(ledger.slice(0, 2), [entry(1, 1, 'pending'), entry(2, 3, 'uncertain')])
  await finish(pass, [cand(1001)], 'failed')
  ledger = ledgerOf(store)
  t.absent(ledger.some((e) => e.ref === ref(6)), 'then the gone one')
  const before = store.values.get(OWN)
  const candidate = await pass.nextStep([cand(1002)])
  await t.exception(pass.claim(candidate.ref), 'nothing left to evict')
  t.is(store.values.get(OWN), before, 'failed, uncertain and pending entries are kept')
  t.is(await pass.nextStep([cand(1003)]), null, 'a full ledger stops the pass')
})

test('cleanup file store keeps identities apart and validates the ledger', async (t) => {
  const m = await load()
  let file = null
  const store = m.createCleanupFileStore({ read: async () => file, write: async (text) => { file = text } })
  t.is(await store.read(OWN), null)
  await Promise.all([
    store.write(OWN, JSON.stringify([entry(1, 1, 'done')])),
    store.write(OTHER, JSON.stringify([{ ref: ref(2, OTHER), tries: 2, state: 'failed' }]))
  ])
  t.alike(JSON.parse(await store.read(OWN)), [entry(1, 1, 'done')])
  t.alike(JSON.parse(await store.read(OTHER)), [{ ref: ref(2, OTHER), tries: 2, state: 'failed' }])
  await t.exception(store.write(OWN, JSON.stringify([{ ref: ref(2, OTHER), tries: 1, state: 'done' }])), 'another identity ref')
  await t.exception(store.write(OWN, 'nope'))
  await t.exception(store.write(OWN, null))
  await t.exception(store.read('x'))
  t.alike(JSON.parse(await store.read(OWN)), [entry(1, 1, 'done')])
  file = '[]'
  await t.exception(store.read(OWN), 'a malformed document')
})
