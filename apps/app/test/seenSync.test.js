'use strict'

const test = require('brittle')
const load = () => import('../src/seenSync.js')

const MEMBER = 'aa'.repeat(32)
const BLOB_A = 'A'.repeat(43744)
const BLOB_B = 'B'.repeat(43744)
const BLOB_W1 = 'C'.repeat(43744)
const BLOB_W2 = 'D'.repeat(43744)
const TOK = '0f'.repeat(16)
const AVISOS = { own: [TOK], pages: {} }
const NONE = { own: [], pages: {} }

function conflict (blob) {
  const err = new Error('Outro aparelho gravou antes.')
  err.code = 'conflito'
  err.hash = blob ? 'cc'.repeat(32) : '0'.repeat(64)
  err.blob = blob
  return err
}

function uncertain () {
  const err = new Error('indisponivel')
  err.code = 'indisponivel'
  err.uncertain = true
  return err
}

// Records every call in order. `finish` and `merges` are queues of answers;
// an Error in a queue is thrown.
function harness ({ read, finish = [], merges = [] }) {
  const calls = []
  let n = 0
  let w = 0
  const writeBlobs = [BLOB_W1, BLOB_W2]
  const take = (q, what) => {
    if (q.length === 0) throw new Error('unexpected ' + what)
    const v = q.shift()
    if (v instanceof Error) throw v
    return v
  }
  const http = {
    async seenStart ({ member, action }) {
      calls.push(['start', action])
      return { nonce: 'n' + (++n) + 'x'.repeat(50) }
    },
    async seenFinish (body) {
      calls.push(['finish', body.action, body.nonce.slice(0, 2), body.prevHash, body.blob === undefined ? undefined : body.blob.slice(0, 1)])
      if (body.action === 'read') return read
      return take(finish, 'finish')
    }
  }
  const request = async (method, params) => {
    if (method === 'seen.sign') {
      calls.push(['sign', params.action, params.nonce.slice(0, 2)])
      if (params.action === 'read') return { signature: 'ee'.repeat(64), prevHash: 'pp' }
      return { signature: 'ee'.repeat(64), blob: writeBlobs[w++], hash: 'hh', prevHash: 'pp' }
    }
    if (method === 'seen.merge') {
      calls.push(['merge', params.blob === null ? null : params.blob.slice(0, 1), params.unchanged, params.avisos.own.length])
      return take(merges, 'merge')
    }
    throw new Error('unknown method ' + method)
  }
  return { calls, http, request }
}

const res = (pending, extra = {}) => ({ avisos: { own: [TOK], pages: {} }, pending, dmChanged: false, groupChanged: false, caughtUp: [], ...extra })

test('constants', async (t) => {
  const { SEEN_CHANGED_DEBOUNCE_MS, SEEN_PASS_MIN_MS } = await load()
  t.is(SEEN_CHANGED_DEBOUNCE_MS, 30000)
  t.is(SEEN_PASS_MIN_MS, 60000)
})

test('fresh device: read finds nothing, merge, then one write and a recording merge', async (t) => {
  const { runSeenPass } = await load()
  const h = harness({
    read: { hash: null, blob: null },
    finish: [{ ok: true, hash: 'hh' }],
    merges: [res(true, { dmChanged: true }), res(false)]
  })
  const out = await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.alike(h.calls, [
    ['start', 'read'],
    ['sign', 'read', 'n1'],
    ['finish', 'read', 'n1', 'pp', undefined],
    ['merge', null, false, 1],
    ['start', 'write'],
    ['sign', 'write', 'n2'],
    ['finish', 'write', 'n2', 'pp', 'C'],
    ['merge', 'C', false, 0]
  ])
  t.is(out.pushed, true)
  t.is(out.dmChanged, true)
  t.is(out.groupChanged, false)
  t.is(out.error, null)
  t.alike(out.avisos, { own: [TOK], pages: {} })
})

test('unchanged read with nothing pending: no write', async (t) => {
  const { runSeenPass } = await load()
  const h = harness({
    read: { hash: 'hh', blob: null, unchanged: true },
    merges: [res(false)]
  })
  const out = await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.alike(h.calls, [
    ['start', 'read'],
    ['sign', 'read', 'n1'],
    ['finish', 'read', 'n1', 'pp', undefined],
    ['merge', null, true, 1]
  ])
  t.is(out.pushed, false)
  t.is(out.error, null)
})

test('a read blob is passed to the merge with unchanged false', async (t) => {
  const { runSeenPass } = await load()
  const h = harness({ read: { hash: 'hh', blob: BLOB_A }, merges: [res(false, { groupChanged: true, caughtUp: ['bb'.repeat(32), 'nope'] })] })
  const out = await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.alike(h.calls[3], ['merge', 'A', false, 1])
  t.is(out.groupChanged, true)
  t.alike(out.caughtUp, ['bb'.repeat(32)])
})

test('conflict: merge the answered blob, then one follow-up write with a new nonce', async (t) => {
  const { runSeenPass } = await load()
  const h = harness({
    read: { hash: 'hh', blob: BLOB_A },
    finish: [conflict(BLOB_B), { ok: true, hash: 'h2' }],
    merges: [res(true), res(true), res(false)]
  })
  const out = await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.alike(h.calls, [
    ['start', 'read'],
    ['sign', 'read', 'n1'],
    ['finish', 'read', 'n1', 'pp', undefined],
    ['merge', 'A', false, 1],
    ['start', 'write'],
    ['sign', 'write', 'n2'],
    ['finish', 'write', 'n2', 'pp', 'C'],
    ['merge', 'B', false, 0],
    ['start', 'write'],
    ['sign', 'write', 'n3'],
    ['finish', 'write', 'n3', 'pp', 'D'],
    ['merge', 'D', false, 0]
  ])
  t.is(out.pushed, true)
  t.is(out.error, null)
})

test('the newest merge answer wins: newer notice marks from a conflict blob are not cut at the cap', async (t) => {
  const { runSeenPass } = await load()
  const hex = (i) => i.toString(16).padStart(32, '0')
  const older = []
  for (let i = 0; i < 256; i++) older.push(hex(1000 + i))
  // The conflict merge answers the node's whole merged view, newest first.
  const newer = [hex(1), hex(2)].concat(older.slice(0, 254))
  const h = harness({
    read: { hash: 'hh', blob: BLOB_A },
    finish: [conflict(BLOB_B), { ok: true, hash: 'h2' }],
    merges: [res(true, { avisos: { own: older, pages: {} } }), res(true, { avisos: { own: newer, pages: {} } }), res(false, { avisos: { own: newer, pages: {} } })]
  })
  const out = await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.is(out.error, null)
  t.alike(out.avisos.own.slice(0, 2), [hex(1), hex(2)], 'the newer marks lead')
  t.is(out.avisos.own.length, 256)
})

test('a conflito without a validated hash (not from seenFinish) stops the pass', async (t) => {
  const { runSeenPass } = await load()
  const bare = new Error('conflito')
  bare.code = 'conflito'
  const h = harness({
    read: { hash: 'hh', blob: BLOB_A },
    finish: [bare],
    merges: [res(true)]
  })
  const out = await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.is(out.error && out.error.code, 'conflito')
  t.is(h.calls.filter((c) => c[0] === 'merge').length, 1, 'no conflict merge')
})

test('conflict with no server blob merges null with unchanged false', async (t) => {
  const { runSeenPass } = await load()
  const h = harness({
    read: { hash: null, blob: null },
    finish: [conflict(null), { ok: true, hash: 'h2' }],
    merges: [res(true), res(true), res(false)]
  })
  await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.alike(h.calls[7], ['merge', null, false, 0])
})

test('a second conflict stops the pass', async (t) => {
  const { runSeenPass } = await load()
  const h = harness({
    read: { hash: 'hh', blob: BLOB_A },
    finish: [conflict(BLOB_B), conflict(BLOB_A)],
    merges: [res(true), res(true)]
  })
  const out = await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.is(h.calls.filter((c) => c[0] === 'start' && c[1] === 'write').length, 2)
  t.is(h.calls.filter((c) => c[0] === 'merge').length, 2)
  t.alike(h.calls[h.calls.length - 1], ['finish', 'write', 'n3', 'pp', 'D'])
  t.is(out.pushed, false)
  t.is(out.error.code, 'conflito')
})

test('an uncertain write is not repeated and not recorded as merged', async (t) => {
  const { runSeenPass } = await load()
  const h = harness({
    read: { hash: 'hh', blob: BLOB_A },
    finish: [uncertain()],
    merges: [res(true)]
  })
  const out = await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.alike(h.calls, [
    ['start', 'read'],
    ['sign', 'read', 'n1'],
    ['finish', 'read', 'n1', 'pp', undefined],
    ['merge', 'A', false, 1],
    ['start', 'write'],
    ['sign', 'write', 'n2'],
    ['finish', 'write', 'n2', 'pp', 'C']
  ])
  t.is(out.pushed, false)
  t.is(out.error.uncertain, true)
})

test('a failed read stops before any merge', async (t) => {
  const { runSeenPass } = await load()
  const h = harness({ read: null, merges: [] })
  h.http.seenStart = async () => { const e = new Error('x'); e.code = 'nao-vinculado'; throw e }
  const out = await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })
  t.is(h.calls.length, 0)
  t.is(out.error.code, 'nao-vinculado')
  t.is(out.avisos, null)
})

test('avisos sent to the node are cut to the merge limits', async (t) => {
  const { cleanAvisos } = await load()
  const own = []
  for (let i = 0; i < 300; i++) own.push(i.toString(16).padStart(32, '0'))
  const pages = {}
  for (let i = 0; i < 6; i++) pages['page:' + String(i).repeat(64)] = own.slice(0, 40)
  pages.bogus = [TOK]
  const out = cleanAvisos({ own: own.concat(['BAD']), pages })
  t.is(out.own.length, 256)
  t.is(out.own[0], own[0])
  t.is(Object.keys(out.pages).length, 4)
  t.ok(Object.values(out.pages).every((l) => l.length === 32))
  t.absent(Object.hasOwn(out.pages, 'bogus'))
  t.alike(cleanAvisos(undefined), NONE)
})

// Scheduler

function clock () {
  let t = 1000000
  let id = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: t + ms }); return id },
    clearTimer: (h) => { timers.delete(h) },
    timers,
    advance (ms) {
      t += ms
      for (const [h, v] of [...timers]) {
        if (v.at <= t) { timers.delete(h); v.fn() }
      }
    }
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

function scheduler (opts = {}) {
  const { createSeenScheduler } = opts.create
  const c = clock()
  const runs = []
  let ok = opts.canRun === undefined ? true : opts.canRun
  const s = createSeenScheduler({
    run: async (reason) => { runs.push(reason); if (opts.runImpl) return opts.runImpl(reason) },
    canRun: () => ok,
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer
  })
  return { s, c, runs, set: (v) => { ok = v } }
}

test('scheduler: offline skips the pass', async (t) => {
  const mod = await load()
  const { s, runs } = scheduler({ create: mod, canRun: false })
  s.wake('visible')
  s.wake('unlock')
  s.wake('poll')
  await tick()
  t.alike(runs, [])
})

test('scheduler: minimum interval between passes, unlock bypasses it', async (t) => {
  const mod = await load()
  const { s, c, runs } = scheduler({ create: mod })
  s.wake('visible')
  await tick()
  s.wake('poll')
  await tick()
  t.alike(runs, ['visible'])
  c.advance(30000)
  s.wake('visible')
  await tick()
  t.alike(runs, ['visible'])
  s.wake('unlock')
  await tick()
  t.alike(runs, ['visible', 'unlock'])
  c.advance(60000)
  s.wake('poll')
  await tick()
  t.alike(runs, ['visible', 'unlock', 'poll'])
})

test('scheduler: changed is debounced and coalesced', async (t) => {
  const mod = await load()
  const { s, c, runs } = scheduler({ create: mod })
  s.wake('changed')
  c.advance(10000)
  s.wake('changed')
  c.advance(10000)
  s.wake('changed')
  await tick()
  t.alike(runs, [])
  c.advance(10000)
  await tick()
  t.alike(runs, ['changed'])
  c.advance(60000)
  await tick()
  t.alike(runs, ['changed'])
})

test('scheduler: changed inside the minimum interval waits for it to end', async (t) => {
  const mod = await load()
  const { s, c, runs } = scheduler({ create: mod })
  s.wake('visible')
  await tick()
  s.wake('changed')
  c.advance(30000)
  await tick()
  t.alike(runs, ['visible'])
  c.advance(29999)
  await tick()
  t.alike(runs, ['visible'])
  c.advance(1)
  await tick()
  t.alike(runs, ['visible', 'changed'])
})

test('scheduler: one pass in flight', async (t) => {
  const mod = await load()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { s, runs } = scheduler({ create: mod, runImpl: () => gate })
  s.wake('unlock')
  await tick()
  s.wake('visible')
  s.wake('poll')
  await tick()
  t.alike(runs, ['unlock'])
  t.is(s.running, true)
  release()
  await tick()
  t.is(s.running, false)
  t.alike(runs, ['unlock'], 'visible and poll during a pass are not replayed')
})

test('scheduler: an unlock during a pass runs once right after it', async (t) => {
  const mod = await load()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { s, runs } = scheduler({ create: mod, runImpl: (reason) => runs.length === 1 ? gate : undefined })
  s.wake('visible')
  await tick()
  s.wake('unlock')
  s.wake('unlock')
  await tick()
  t.alike(runs, ['visible'])
  release()
  await tick()
  await tick()
  t.alike(runs, ['visible', 'unlock'])
  t.is(s.running, false)
})

test('scheduler: online inside the minimum interval waits for it to end', async (t) => {
  const mod = await load()
  const { s, c, runs } = scheduler({ create: mod })
  s.wake('visible')
  await tick()
  c.advance(20000)
  s.wake('online')
  await tick()
  t.alike(runs, ['visible'])
  t.is(c.timers.size, 1)
  c.advance(40000)
  await tick()
  t.alike(runs, ['visible', 'changed'])
})

test('scheduler: online with no recent pass runs at once', async (t) => {
  const mod = await load()
  const { s, runs } = scheduler({ create: mod })
  s.wake('online')
  await tick()
  t.alike(runs, ['online'])
})

test('snapshotBefore takes the snapshot once, right before the first merge', async (t) => {
  const { snapshotBefore } = await load()
  let n = 0
  const calls = []
  const { request, snap } = snapshotBefore(async (m) => { calls.push([m, snap.value]); return {} }, 'seen.merge', () => ++n)
  await request('seen.sign', {})
  t.is(snap.taken, false)
  t.is(n, 0)
  await request('seen.merge', {})
  await request('seen.merge', {})
  t.is(n, 1)
  t.is(snap.value, 1)
  t.alike(calls, [['seen.sign', null], ['seen.merge', 1], ['seen.merge', 1]])
})

test('ackCaughtUp acknowledges caughtUp groups at the snapshot versions of the same epoch', async (t) => {
  const { ackCaughtUp } = await load()
  const g1 = 'a'.repeat(64)
  const g2 = 'b'.repeat(64)
  const g3 = 'c'.repeat(64)
  const cur = Object.freeze({ epoch: 2, map: Object.freeze({ [g1]: 1, [g2]: 4 }) })
  const next = ackCaughtUp(cur, [g1, g2, g3], { epoch: 2, versions: { [g1]: 3, [g2]: 4 } })
  t.alike(next, { epoch: 2, map: { [g1]: 3, [g2]: 4 } }, 'g3 has no known version and is left alone')
  t.is(ackCaughtUp(cur, [g1], { epoch: 3, versions: { [g1]: 9 } }), cur, 'another epoch changes nothing')
  t.is(ackCaughtUp(cur, [g2], { epoch: 2, versions: { [g2]: 4 } }), cur, 'nothing new keeps the same object')
  t.is(ackCaughtUp(cur, [g1], null), cur, 'no merge went out: nothing acknowledged')
  t.is(ackCaughtUp(cur, [g2], { epoch: 2, versions: { [g2]: 3 } }), cur, 'a group opened during the pass keeps its newer acknowledgement')
})

test('scheduler: a failed pass sets no retry timer', async (t) => {
  const mod = await load()
  const { s, c, runs } = scheduler({ create: mod, runImpl: () => { throw new Error('boom') } })
  s.wake('unlock')
  await tick()
  t.is(c.timers.size, 0)
  c.advance(600000)
  await tick()
  t.alike(runs, ['unlock'])
  t.is(s.running, false)
})

test('scheduler: canRun is checked when the debounce fires', async (t) => {
  const mod = await load()
  const { s, c, runs, set } = scheduler({ create: mod })
  s.wake('changed')
  set(false)
  c.advance(30000)
  await tick()
  t.alike(runs, [])
})

test('scheduler: stop clears timers and ignores later wakes', async (t) => {
  const mod = await load()
  const { s, c, runs } = scheduler({ create: mod })
  s.wake('changed')
  t.is(c.timers.size, 1)
  s.stop()
  t.is(c.timers.size, 0)
  s.wake('unlock')
  c.advance(60000)
  await tick()
  t.alike(runs, [])
})

test('reportAvisosSeen keeps earlier pending marks when a reload reports only its first page', async (t) => {
  const { reportAvisosSeen } = await load()
  const own = 'f'.repeat(64)
  const h = (n) => n.toString(16).padStart(32, '0')
  let pending = { own: [], pages: {} }
  let r = reportAvisosSeen(pending, null, own, [h(1), h(2), h(3)], own)
  t.is(r.fresh, true, 'a first report is a local mark')
  pending = r.pending
  r = reportAvisosSeen(pending, null, own, [h(4), h(1)], own)
  t.is(r.fresh, true)
  t.alike(r.pending.own, [h(4), h(1), h(2), h(3)], 'the new report goes first; marks of the pages before stay')
  r = reportAvisosSeen(r.pending, null, own, [h(1), h(2)], own)
  t.is(r.fresh, false, 'nothing new: no wake')
  t.alike(reportAvisosSeen(pending, null, 'e'.repeat(64), [h(9)], own), { pending, fresh: false }, 'another identity is ignored')
})

test('reportAvisosSeen skips rows the last merge holds, so a pass never wakes the next one', async (t) => {
  const { reportAvisosSeen, dropSent, cleanAvisos } = await load()
  const own = 'f'.repeat(64)
  const h = (n) => n.toString(16).padStart(32, '0')
  const page = 'page:' + 'a'.repeat(64)
  let pending = { own: [], pages: {} }
  pending = reportAvisosSeen(pending, null, own, [h(1), h(2)], own).pending
  pending = reportAvisosSeen(pending, null, page, [h(5)], own).pending
  const sent = cleanAvisos(pending)
  // A mark reported while the pass runs stays pending after it.
  pending = reportAvisosSeen(pending, null, own, [h(3)], own).pending
  pending = dropSent(pending, sent)
  t.alike(pending, { own: [h(3)], pages: {} })
  const merged = { own: [h(3), h(2), h(1)], pages: { [page]: [h(5)] } }
  // After the pass, the screen reports its rows again (the remote fold).
  const again = reportAvisosSeen({ own: [], pages: {} }, merged, own, [h(1), h(2), h(3)], own)
  t.is(again.fresh, false, 'rows the node already holds wake nothing')
  t.alike(again.pending.own, [])
  const pageAgain = reportAvisosSeen({ own: [], pages: {} }, merged, page, [h(5)], own)
  t.is(pageAgain.fresh, false)
  t.alike(pageAgain.pending.pages, {}, 'no empty page entry')
  const newer = reportAvisosSeen({ own: [], pages: {} }, merged, own, [h(4), h(1)], own)
  t.is(newer.fresh, true)
  t.alike(newer.pending.own, [h(4)])
})

test('reportAvisosSeen caps tokens and keeps the most recently reported pages', async (t) => {
  const { reportAvisosSeen, SEEN_OWN_MAX, SEEN_PAGE_TOKENS_MAX, SEEN_PAGES_MAX } = await load()
  const own = 'f'.repeat(64)
  const h = (n) => n.toString(16).padStart(32, '0')
  const many = Array.from({ length: 300 }, (_, i) => h(i + 1))
  const r = reportAvisosSeen({ own: [], pages: {} }, null, own, many, own)
  t.is(r.pending.own.length, SEEN_OWN_MAX)
  let pending = { own: [], pages: {} }
  for (let i = 0; i < SEEN_PAGES_MAX + 1; i++) {
    pending = reportAvisosSeen(pending, null, 'page:' + i.toString(16).repeat(64), many.slice(0, 40), own).pending
  }
  const keys = Object.keys(pending.pages)
  t.is(keys.length, SEEN_PAGES_MAX)
  t.absent(keys.includes('page:' + '0'.repeat(64)), 'the oldest reported page leaves')
  t.is(pending.pages[keys[0]].length, SEEN_PAGE_TOKENS_MAX)
  const bad = reportAvisosSeen({ own: [], pages: {} }, null, own, ['nope', 7, h(0xab).toUpperCase()], own)
  t.alike(bad.pending.own, [])
  t.is(bad.fresh, false)
})

test('reportAvisosSeen offers only what a merge can carry and never re-offers a delivered token', async (t) => {
  const { reportAvisosSeen, dropSent, rememberSent, cleanAvisos, SEEN_PAGE_TOKENS_MAX } = await load()
  const own = 'f'.repeat(64)
  const h = (n) => n.toString(16).padStart(32, '0')
  const page = 'page:' + 'a'.repeat(64)
  // 40 seen notices on screen, newest first: the merge keeps 32 per page.
  const onScreen = Array.from({ length: 40 }, (_, i) => h(i + 1))
  const delivered = new Set()
  let pending = { own: [], pages: {} }
  let merged = null
  let wakes = 0
  for (let pass = 0; pass < 6; pass++) {
    const r = reportAvisosSeen(pending, merged, page, onScreen, own, delivered)
    if (r.fresh) wakes++
    pending = r.pending
    const sent = cleanAvisos(pending)
    pending = dropSent(pending, sent)
    rememberSent(delivered, sent)
    // The node's window keeps the newest 32 offered tokens of the page.
    const held = (merged && merged.pages[page]) || []
    merged = { own: [], pages: { [page]: sent.pages[page] ? sent.pages[page].concat(held).slice(0, SEEN_PAGE_TOKENS_MAX) : held } }
  }
  t.is(wakes, 1, 'one local mark, one pass: the eight past the cap are never offered')
  t.alike(merged.pages[page], onScreen.slice(0, SEEN_PAGE_TOKENS_MAX))

  // A token the document cut is not offered again in the same session.
  const cut = { own: [h(2)], pages: {} }
  const again = reportAvisosSeen({ own: [], pages: {} }, cut, own, [h(1), h(2)], own, new Set([h(1)]))
  t.is(again.fresh, false)
  t.alike(again.pending.own, [])
})

test('rememberSent keeps the newest tokens up to its cap', async (t) => {
  const { rememberSent } = await load()
  const h = (n) => n.toString(16).padStart(32, '0')
  const set = new Set()
  rememberSent(set, { own: [h(1), h(2)], pages: { ['page:' + 'b'.repeat(64)]: [h(3)] } }, 3)
  t.alike([...set], [h(1), h(2), h(3)])
  rememberSent(set, { own: [h(1), h(4)], pages: {} }, 3)
  t.alike([...set], [h(3), h(1), h(4)], 'resent tokens move to the newest end; the oldest leaves')
})

test('blocksChanged: any merge of the pass that brought a change reports it', async (t) => {
  const { runSeenPass } = await load()
  const quiet = harness({ read: { hash: null, blob: null }, finish: [], merges: [res(false)] })
  t.is((await runSeenPass({ member: MEMBER, request: quiet.request, http: quiet.http, avisos: AVISOS })).blocksChanged, false)
  const h = harness({
    read: { hash: null, blob: null },
    finish: [{ ok: true, hash: 'hh' }],
    merges: [res(true, { blocksChanged: true }), res(false)]
  })
  t.is((await runSeenPass({ member: MEMBER, request: h.request, http: h.http, avisos: AVISOS })).blocksChanged, true)
})
