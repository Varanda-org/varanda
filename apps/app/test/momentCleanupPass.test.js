'use strict'

const test = require('brittle')

const OWN = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-20T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()
const ref = (seq, author = OWN) => author + ':' + seq
// Newest first, like moments.read `past`: a higher seq is a newer moment.
const moment = (seq, author = OWN) => ({ seq, ref: ref(seq, author), text: '', at: iso(NOW - 3 * DAY + seq * 1000) })
const past = (...seqs) => seqs.sort((a, b) => b - a).map((seq) => moment(seq))
const entry = (seq, tries, state) => ({ ref: ref(seq), tries, state })
const errorOf = (message, extra = {}) => Object.assign(new Error(message), extra)
let start = 0
// A new query string loads a new planner module, which simulates a new process.
const loadPlanner = () => import('../src/momentCleanup.js?pass-test=' + ++start)
const load = () => import('../src/momentCleanupPass.js')

async function fixture (options = {}) {
  const { runCleanupPass } = await load()
  const { createCleanupPlanner } = await loadPlanner()
  const values = options.values ?? new Map()
  const log = []
  let exclusive = 0
  let writes = 0
  const store = {
    exclusive: async (fn) => {
      exclusive++
      return fn()
    },
    read: (identity) => values.get(identity) ?? null,
    write: async (identity, text) => {
      writes++
      if (options.writeFails && options.writeFails(writes, JSON.parse(text))) throw new Error('disco')
      values.set(identity, text)
    }
  }
  const ledger = () => JSON.parse(values.get(OWN) ?? '[]')
  let live = true
  let reads = 0
  const config = {
    store,
    identity: OWN,
    planner: createCleanupPlanner({ store, identity: OWN }),
    alive: () => live,
    now: () => NOW,
    listPast: async () => {
      reads++
      log.push(['listPast'])
      if (options.listPast) return options.listPast(reads, { stop: () => { live = false } })
      return options.past ?? past(1)
    },
    remove: async (target) => {
      log.push(['remove', target, ledger().find((e) => e.ref === target)])
      if (options.remove) return options.remove(target, { stop: () => { live = false } })
    }
  }
  return {
    values,
    log,
    ledger,
    config,
    removes: () => log.filter((row) => row[0] === 'remove').map((row) => row[1]),
    exclusive: () => exclusive,
    run: () => runCleanupPass(config)
  }
}

test('pass removes expired own moments oldest first, at most four, claiming before each remove', async (t) => {
  const f = await fixture({ past: past(1, 2, 3, 4, 5, 6) })
  t.is(await f.run(), 4)
  t.is(f.exclusive(), 1, 'runs inside the store lock')
  t.alike(f.removes(), [ref(1), ref(2), ref(3), ref(4)])
  for (const row of f.log.filter((r) => r[0] === 'remove')) {
    t.alike(row[2], { ref: row[1], tries: 1, state: 'pending' }, 'pending written before remove')
  }
  t.alike(f.ledger(), [1, 2, 3, 4].map((seq) => entry(seq, 1, 'done')))
  t.is(await f.run(), 0, 'the same planner never begins a second pass')
  t.is(f.log.filter((r) => r[0] === 'listPast').length, 5, 'one read per pass plus one per remove')
})

test('pass leaves recent, foreign and malformed moments alone', async (t) => {
  const recent = { seq: 7, ref: ref(7), text: '', at: iso(NOW - 2 * DAY + 1) }
  const boundary = { seq: 6, ref: ref(6), text: '', at: iso(NOW - 2 * DAY) }
  const foreign = moment(5, OTHER)
  const bad = { seq: 4, ref: ref(4), text: '', at: 'ontem' }
  const f = await fixture({ past: [recent, boundary, foreign, bad] })
  t.is(await f.run(), 1)
  t.alike(f.removes(), [ref(6)], 'exactly 48 h is old enough')
})

test('pass with an unreadable ledger makes no remove call and keeps the ledger', async (t) => {
  const values = new Map([[OWN, '{"no":1}']])
  const f = await fixture({ values, past: past(1, 2) })
  t.is(await f.run(), 0)
  t.alike(f.removes(), [])
  t.is(values.get(OWN), '{"no":1}')
})

test('pass ends on an uncertain answer and spends the try', async (t) => {
  const values = new Map()
  const first = await fixture({ values, past: past(1, 2), remove: () => { throw errorOf('conexão encerrada', { uncertain: true }) } })
  t.is(await first.run(), 0)
  t.alike(first.removes(), [ref(1)])
  t.alike(first.ledger(), [entry(1, 1, 'uncertain')])
  const second = await fixture({ values, past: past(1, 2) })
  t.is(await second.run(), 2, 'the next open checks the list again and retries')
  t.alike(second.ledger(), [entry(1, 2, 'done'), entry(2, 1, 'done')])
})

test('pass restores the entry and ends on a refusal', async (t) => {
  const refusals = [
    errorOf('x', { queued: true }),
    errorOf('x', { code: 'LOCKED' }),
    errorOf('x', { code: 'CLOSED' }),
    errorOf('pedidos demais em andamento'),
    errorOf('conexão encerrada'),
    errorOf('sem conexão com o nó'),
    errorOf('sincronização já em andamento'),
    errorOf('sincronize com o semeador antes de publicar')
  ]
  for (const err of refusals) {
    const prior = JSON.stringify([entry(1, 2, 'failed')])
    const f = await fixture({ values: new Map([[OWN, prior]]), past: past(1, 2), remove: () => Promise.reject(err) })
    t.is(await f.run(), 0, err.message + ' ' + (err.code ?? err.queued))
    t.alike(f.removes(), [ref(1)], 'the pass ended')
    t.is(f.values.get(OWN), prior, 'no try spent')
    const fresh = await fixture({ past: past(1), remove: () => Promise.reject(err) })
    await fresh.run()
    t.alike(fresh.ledger(), [], 'a new entry is removed again')
  }
})

test('pass settles gone and failed answers and continues', async (t) => {
  const f = await fixture({
    past: past(1, 2, 3),
    remove: (target) => {
      if (target === ref(1)) throw errorOf('referência inválida')
      if (target === ref(2)) throw errorOf('disco cheio')
    }
  })
  t.is(await f.run(), 1)
  t.alike(f.removes(), [ref(1), ref(2), ref(3)])
  t.alike(f.ledger(), [entry(1, 1, 'gone'), entry(2, 1, 'failed'), entry(3, 1, 'done')])
})

test('pass never removes a ref again after three tries across opens', async (t) => {
  const values = new Map()
  for (let open = 1; open <= 4; open++) {
    const f = await fixture({ values, past: past(1), remove: () => { throw errorOf('falhou') } })
    await f.run()
    t.alike(f.removes(), open <= 3 ? [ref(1)] : [], 'open ' + open)
  }
  t.alike(JSON.parse(values.get(OWN)), [entry(1, 3, 'failed')])
})

test('pass counts a pending left by a crash as a spent try', async (t) => {
  const values = new Map([[OWN, JSON.stringify([entry(1, 2, 'pending')])]])
  const f = await fixture({ values, past: past(1), remove: () => { throw errorOf('falhou') } })
  await f.run()
  t.alike(f.removes(), [ref(1)])
  t.alike(f.ledger(), [entry(1, 3, 'failed')])
  const next = await fixture({ values, past: past(1) })
  t.is(await next.run(), 0)
  t.alike(next.removes(), [])
})

test('pass releases a moment that left the list before remove and continues', async (t) => {
  const prior = JSON.stringify([entry(1, 1, 'failed')])
  const f = await fixture({
    values: new Map([[OWN, prior]]),
    listPast: (n) => n === 1 ? past(1, 2) : past(2)
  })
  t.is(await f.run(), 1)
  t.alike(f.removes(), [ref(2)])
  t.alike(f.ledger(), [entry(1, 1, 'failed'), entry(2, 1, 'done')], 'the prior entry is back as it was')
})

test('pass releases and ends when the re-read fails', async (t) => {
  const f = await fixture({
    listPast: (n) => {
      if (n === 1) return past(1, 2)
      throw new Error('leitura')
    }
  })
  t.is(await f.run(), 0)
  t.alike(f.removes(), [])
  t.alike(f.ledger(), [], 'no try spent')
  t.is(f.log.length, 2, 'no further read')
})

test('pass releases when the app stops before remove', async (t) => {
  const f = await fixture({
    listPast: (n, { stop }) => {
      if (n === 2) stop()
      return past(1, 2)
    }
  })
  t.is(await f.run(), 0)
  t.alike(f.removes(), [])
  t.alike(f.ledger(), [])
})

test('pass settles the answer and stops when the app stops during remove', async (t) => {
  const f = await fixture({ past: past(1, 2), remove: (target, { stop }) => stop() })
  t.is(await f.run(), 1)
  t.alike(f.removes(), [ref(1)])
  t.alike(f.ledger(), [entry(1, 1, 'done')])
})

test('pass settles stale non-terminal entries as gone only when the list was not truncated', async (t) => {
  const prior = [entry(7, 1, 'failed'), entry(8, 2, 'uncertain'), entry(9, 1, 'pending'), entry(10, 1, 'done'), entry(1, 1, 'failed')]
  const f = await fixture({ values: new Map([[OWN, JSON.stringify(prior)]]), past: past(1) })
  t.is(await f.run(), 1)
  t.alike(f.ledger(), [entry(7, 1, 'gone'), entry(8, 2, 'gone'), entry(9, 1, 'gone'), entry(10, 1, 'done'), entry(1, 2, 'done')])

  const full = Array.from({ length: 16 }, (_, i) => 100 + i)
  const g = await fixture({ values: new Map([[OWN, JSON.stringify(prior)]]), past: past(...full), remove: () => { throw errorOf('falhou') } })
  await g.run()
  t.alike(g.ledger().slice(0, 5), prior, '16 items: entries untouched')

  const short = full.slice(0, 15)
  const h = await fixture({ values: new Map([[OWN, JSON.stringify(prior)]]), past: past(...short), remove: () => { throw errorOf('falhou') } })
  await h.run()
  t.alike(h.ledger().slice(0, 5), [entry(7, 1, 'gone'), entry(8, 2, 'gone'), entry(9, 1, 'gone'), entry(10, 1, 'done'), entry(1, 1, 'gone')],
    '15 items: the list was not truncated')
})

test('pass ends when the ledger cannot be written', async (t) => {
  const claimFails = await fixture({ past: past(1, 2), writeFails: () => true })
  t.is(await claimFails.run(), 0)
  t.alike(claimFails.removes(), [], 'no remove without a claim on disk')

  const settleFails = await fixture({ past: past(1, 2), writeFails: (n, entries) => entries.every((e) => e.state !== 'pending') })
  t.is(await settleFails.run(), 0)
  t.alike(settleFails.removes(), [ref(1)])
  t.alike(settleFails.ledger(), [entry(1, 1, 'pending')], 'the next open counts it as a spent try')
})

test('pass leaves the claim pending when the release after a refusal cannot be written', async (t) => {
  const f = await fixture({
    past: past(1, 2),
    remove: () => { throw errorOf('conexão encerrada') },
    writeFails: (n) => n === 2
  })
  t.is(await f.run(), 0)
  t.alike(f.removes(), [ref(1)], 'the pass ended')
  t.alike(f.ledger(), [entry(1, 1, 'pending')], 'the next open counts it as a spent try')
})

test('overlapping passes on one planner run once', async (t) => {
  const f = await fixture({ past: past(1, 2) })
  const [a, b] = await Promise.all([f.run(), f.run()])
  t.alike([a, b].sort(), [0, 2])
  t.alike(f.removes(), [ref(1), ref(2)], 'each moment removed once')
  t.alike(f.ledger(), [entry(1, 1, 'done'), entry(2, 1, 'done')])
})

test('pass ends without writing when the first read fails', async (t) => {
  const f = await fixture({ listPast: () => { throw new Error('leitura') } })
  t.is(await f.run(), 0)
  t.alike(f.removes(), [])
  t.is(f.values.size, 0)
})

test('pass does nothing when the app is already stopped', async (t) => {
  const f = await fixture({ past: past(1) })
  f.config.alive = () => false
  t.is(await f.run(), 0)
  t.is(f.log.length, 0)
  f.config.alive = () => true
  t.is(await f.run(), 1, 'the pass was not spent')
})
