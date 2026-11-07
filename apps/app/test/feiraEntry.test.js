'use strict'

// Signup from a Feira listing link (src/feiraEntry.js). ES module loaded
// through import(); storage, clock and requests are fakes, nothing touches
// the network.
const test = require('brittle')

const load = () => import('../src/feiraEntry.js')
const loadInvite = () => import('../src/signupInvite.js')

const A = 'ab'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const CODE = 'F'.repeat(43)
const PERSONAL = 'p'.repeat(43)
const T0 = 1_800_000_000_000

function memoryStorage () {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) }
  }
}

function setup (f, clock = { t: T0 }) {
  const storage = memoryStorage()
  const holder = f.createFeiraEntry({ getStorage: () => storage, now: () => clock.t })
  return { storage, holder, clock }
}

function starter (answer) {
  const calls = []
  const start = async (body) => {
    calls.push(body)
    if (answer instanceof Error) throw answer
    return answer
  }
  return { calls, start }
}

function coded (code, uncertain) {
  const err = new Error(code)
  err.code = code
  if (uncertain) err.uncertain = true
  return err
}

test('new visitor: policy on, one start, the code held as the signup invite', async (t) => {
  const f = await load()
  const inv = await loadInvite()
  const { storage, holder } = setup(f)
  holder.capture({ author: A, seq: 3, origin: ORIGIN })
  const entry = holder.load(ORIGIN)
  const d = f.decideEntry({ entry, policy: { enabled: true }, required: true })
  t.alike(d, { action: 'start', body: { author: A, seq: 3 } })
  const { calls, start } = starter({ code: CODE })
  const r = await f.startEntry({ holder, entry, start, storage, now: T0 })
  t.alike(r, { ok: true, code: CODE })
  t.alike(calls, [{ author: A, seq: 3 }], 'exactly one request with { author, seq }')
  t.is(inv.readSignupInvite(storage, T0).code, CODE, 'stored under SIGNUP_INVITE_KEY')
  t.is(holder.load(ORIGIN).code, CODE, 'remembered as the Feira code')
  t.ok(storage.map.has(inv.SIGNUP_INVITE_KEY))
})

test('new visitor in the app: the caller holder keeps the code', async (t) => {
  const f = await load()
  const { holder } = setup(f)
  const entry = holder.capture({ author: A, seq: 3, origin: '' })
  const held = []
  const r = await f.startEntry({ holder, entry, start: starter({ code: CODE }).start, hold: (c) => { held.push(c); return { code: c } } })
  t.ok(r.ok)
  t.alike(held, [CODE])
  const failed = await f.startEntry({ holder, entry, start: starter({ code: CODE }).start, hold: () => null })
  t.is(failed.ok, false, 'a code that could not be held is not a success')
})

test('existing member: waits for the node, then opens the listing once', async (t) => {
  const f = await load()
  const { holder } = setup(f)
  holder.capture({ author: A, seq: 9, origin: ORIGIN })
  const entry = holder.load(ORIGIN)
  t.alike(f.decideEntry({ entry, signedIn: true, ready: false, policy: { enabled: true } }), { action: 'wait' })
  t.alike(f.decideEntry({ entry, signedIn: true, ready: true }), { action: 'open', author: A, seq: 9 })
  t.alike(holder.consume(ORIGIN), { author: A, seq: 9 })
  t.is(holder.consume(ORIGIN), null, 'consumed exactly once')
  t.alike(f.decideEntry({ entry: holder.load(ORIGIN), signedIn: true, ready: true }), { action: 'none' })
})

test('held personal invite: the existing flow, no start, the ref kept', async (t) => {
  const f = await load()
  const { holder } = setup(f)
  const entry = holder.capture({ author: A, seq: 2, origin: ORIGIN })
  const d = f.decideEntry({ entry, held: { code: PERSONAL }, policy: { enabled: true }, required: true })
  t.alike(d, { action: 'invite', feira: false })
  t.is(holder.load(ORIGIN).seq, 2, 'ref kept for after sign-up')
  t.is(f.limitRefusal({ err: coded('convite-invalido'), entry, held: { code: PERSONAL } }), null, 'a personal invite refusal is not the seller limit')
})

test('policy off or unknown: the calm invite screen, or the open network', async (t) => {
  const f = await load()
  const { holder } = setup(f)
  const entry = holder.capture({ author: A, seq: 2, origin: ORIGIN })
  for (const policy of [{ enabled: false }, null]) {
    const d = f.decideEntry({ entry, policy, required: true })
    t.is(d.action, 'needs-invite')
    t.ok(d.text.startsWith('Entre para falar com quem anunciou'))
    t.alike(f.decideEntry({ entry, policy, required: false }), { action: 'signup' })
  }
  t.absent(/\u2014/.test(f.ENTRY_INVITE_TEXT + f.LIMIT_TEXT + f.START_FAILED_TEXT + f.START_UNCERTAIN_TEXT + f.START_GONE_TEXT + f.ENTRY_TEXT))
})

test('limite: the Feira code refused at sign-up reads as the seller limit', async (t) => {
  const f = await load()
  const { storage, holder } = setup(f)
  holder.capture({ author: A, seq: 2, origin: ORIGIN })
  await f.startEntry({ holder, entry: holder.load(ORIGIN), start: starter({ code: CODE }).start, storage, now: T0 })
  const entry = holder.load(ORIGIN)
  const r = f.limitRefusal({ err: coded('convite-invalido'), entry, held: { code: CODE } })
  t.alike(r, { text: f.LIMIT_TEXT, drop: true })
  t.is(f.limitRefusal({ err: coded('lista-de-espera'), entry, held: { code: CODE } }), null)
  holder.forgetCode()
  t.is(holder.load(ORIGIN).code, null, 'the dropped code is forgotten, the ref stays')
})

test('start refusals: calm text, never asked again', async (t) => {
  const f = await load()
  const { holder } = setup(f)
  const entry = holder.capture({ author: A, seq: 2, origin: ORIGIN })
  const cases = [
    [coded('nao-encontrado'), f.START_GONE_TEXT, false],
    [coded('pedido-invalido'), f.START_FAILED_TEXT, false],
    [coded('indisponivel'), f.START_FAILED_TEXT, false],
    [coded('indisponivel', true), f.START_UNCERTAIN_TEXT, true]
  ]
  for (const [err, text, uncertain] of cases) {
    const { calls, start } = starter(err)
    const r = await f.startEntry({ holder, entry, start, storage: memoryStorage() })
    t.is(r.ok, false)
    t.is(r.text, text)
    t.is(r.uncertain, uncertain)
    t.is(calls.length, 1, 'one request')
  }
  const bad = await f.startEntry({ holder, entry, start: starter({ code: 'curto' }).start, storage: memoryStorage() })
  t.is(bad.uncertain, true)
  t.is(holder.load(ORIGIN).code, null, 'no code remembered')
})

test('cancelled authentication: the ref and the held code survive', async (t) => {
  const f = await load()
  const inv = await loadInvite()
  const clock = { t: T0 }
  const { storage, holder } = setup(f, clock)
  holder.capture({ author: A, seq: 4, origin: ORIGIN })
  await f.startEntry({ holder, entry: holder.load(ORIGIN), start: starter({ code: CODE }).start, storage, now: T0 })
  clock.t += 10 * 60000
  const again = holder.load(ORIGIN)
  t.is(again.seq, 4)
  t.is(again.code, CODE)
  const held = inv.readSignupInvite(storage, clock.t)
  t.alike(f.decideEntry({ entry: again, held, policy: { enabled: true }, required: true }), { action: 'invite', feira: true })
})

test('repeat return: the same link keeps the code and asks nothing again', async (t) => {
  const f = await load()
  const inv = await loadInvite()
  const { storage, holder } = setup(f)
  holder.capture({ author: A, seq: 4, origin: ORIGIN })
  const { calls, start } = starter({ code: CODE })
  await f.startEntry({ holder, entry: holder.load(ORIGIN), start, storage, now: T0 })
  const rec = holder.capture({ author: A, seq: 4, origin: ORIGIN })
  t.is(rec.code, CODE, 'same listing keeps its code')
  const d = f.decideEntry({ entry: rec, held: inv.readSignupInvite(storage, T0), policy: { enabled: true } })
  t.is(d.action, 'invite')
  t.is(calls.length, 1)
  const other = holder.capture({ author: A, seq: 5, origin: ORIGIN })
  t.is(other.code, null, 'a newer listing link replaces the entry')
})

test('expiry: an entry older than the TTL is dropped', async (t) => {
  const f = await load()
  const clock = { t: T0 }
  const { storage, holder } = setup(f, clock)
  holder.capture({ author: A, seq: 4, origin: ORIGIN })
  clock.t += f.FEIRA_ENTRY_TTL_MS + 1
  t.is(holder.load(ORIGIN), null)
  t.is(storage.map.has(f.FEIRA_ENTRY_KEY), false, 'removed from storage')
  t.is(f.decideEntry({ entry: null }).action, 'none')
})

test('other origin: another installation drops the ref', async (t) => {
  const f = await load()
  const { storage, holder } = setup(f)
  holder.capture({ author: A, seq: 4, origin: ORIGIN })
  t.is(holder.load('https://outra.example'), null)
  t.is(holder.load(ORIGIN), null, 'dropped, not kept for later')
  t.is(storage.map.has(f.FEIRA_ENTRY_KEY), false)
  t.is(holder.capture({ author: A, seq: 4, origin: 'http://evil.example' }), null, 'a bad origin is never held')
})

test('decodeEntry: untrusted storage is rebuilt field by field', async (t) => {
  const f = await load()
  const ok = { v: 1, author: A, seq: 1, origin: ORIGIN, at: T0, code: null }
  t.ok(f.decodeEntry(JSON.stringify(ok), T0))
  const bad = [
    { ...ok, v: 2 }, { ...ok, author: A.toUpperCase() }, { ...ok, seq: 0 }, { ...ok, seq: '1' },
    { ...ok, origin: 'https://x.example/path' }, { ...ok, code: 'curto' }, { ...ok, at: T0 + 120000 }
  ]
  for (const o of bad) t.is(f.decodeEntry(JSON.stringify(o), T0), null, JSON.stringify(o))
  t.is(f.decodeEntry('{', T0), null)
  t.is(f.decodeEntry('x'.repeat(600), T0), null)
  const rec = f.decodeEntry(JSON.stringify({ ...ok, extra: 1, __proto__: { polluted: true } }), T0)
  t.alike(Object.keys(rec).sort(), ['at', 'author', 'code', 'origin', 'seq', 'v'])
  t.ok(Object.isFrozen(rec))
})

test('storage that throws: memory keeps the entry for this load', async (t) => {
  const f = await load()
  const broken = { getItem () { throw new Error('x') }, setItem () { throw new Error('x') }, removeItem () { throw new Error('x') } }
  const holder = f.createFeiraEntry({ getStorage: () => broken, now: () => T0 })
  holder.capture({ author: A, seq: 4, origin: ORIGIN })
  t.is(holder.load(ORIGIN).seq, 4)
  holder.drop()
  t.is(holder.load(ORIGIN), null)
})

test('feiraEntry: a failed start is offered again only for passing refusals', async (t) => {
  const { startRetryable } = await load()
  t.ok(startRetryable({ ok: false, code: 'indisponivel', uncertain: false }), 'a 429 or a busy service may pass')
  t.ok(startRetryable({ ok: false, code: 'indisponivel', uncertain: true }), 'an unknown outcome costs the seller nothing until used')
  t.absent(startRetryable({ ok: false, code: 'nao-encontrado' }), 'a gone listing stays gone')
  t.absent(startRetryable({ ok: false, code: 'pedido-invalido' }))
  t.absent(startRetryable({ ok: true, code: 'x' }))
  t.absent(startRetryable(null))
})

test('a refused write never brings back an older listing', async (t) => {
  const f = await load()
  const { storage, holder } = setup(f)
  holder.capture({ author: A, seq: 1, origin: ORIGIN })
  storage.setItem = () => { throw new Error('quota') }
  holder.capture({ author: A, seq: 2, origin: ORIGIN })
  t.is(holder.load(ORIGIN).seq, 2, 'memory wins over the stale stored record')
  t.is(holder.consume(ORIGIN).seq, 2)
  t.is(holder.load(ORIGIN), null)
})

test('a code held while the start was in flight is never replaced', async (t) => {
  const f = await load()
  const { storage, holder } = setup(f)
  const entry = holder.capture({ author: A, seq: 3, origin: ORIGIN })
  let pasted = null
  const start = async () => {
    pasted = PERSONAL
    return { code: CODE }
  }
  let holds = 0
  const r = await f.startEntry({ holder, entry, start, storage, hold: () => { holds++; return true }, isHeld: () => pasted !== null })
  t.absent(r.ok)
  t.ok(r.superseded)
  t.is(holds, 0, 'the late Feira code is not held')
  t.is(holder.load(ORIGIN).code, null, 'nor remembered as the Feira code')
  t.absent(f.startRetryable(r), 'nothing to ask again')
})

test('a Google return that refused the Feira code reads as the seller limit', async (t) => {
  const f = await load()
  const { storage, holder } = setup(f)
  const entry = holder.capture({ author: A, seq: 4, origin: ORIGIN })
  t.is(f.returnLimit({ returnInvite: 'convite recusado', entry }), null, 'no Feira code asked: an ordinary refusal')
  const { start } = starter({ code: CODE })
  t.ok((await f.startEntry({ holder, entry, start, storage })).ok)
  const coded = holder.load(ORIGIN)
  t.alike(f.returnLimit({ returnInvite: 'convite recusado', entry: coded }), { text: f.LIMIT_TEXT })
  t.is(f.returnLimit({ returnInvite: '', entry: coded }), null, 'no refusal on this load')
})

test('entryOffer: "Pedir entrada" only for a start that may be pressed', async (t) => {
  const { entryOffer } = await load()
  t.is(entryOffer({ action: 'start' }), true)
  t.is(entryOffer({ action: 'invite' }), false)
  t.is(entryOffer({ action: 'needs-invite' }), false)
  t.is(entryOffer({ action: null }), false)
  t.is(entryOffer({ action: 'start', limited: true }), false)
  t.is(entryOffer({ action: 'start', blocked: true }), false)
  t.is(entryOffer({ action: 'start', tried: true }), false)
  t.is(entryOffer({ action: 'start', tried: true, retry: true }), true)
  t.is(entryOffer(), false)
})
