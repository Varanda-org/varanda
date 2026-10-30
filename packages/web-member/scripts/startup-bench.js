'use strict'

// Startup bench of the browser sync (lib/sync.js): how long a returning
// visit waits from runSync until the run publishes its reader (the moment
// borrowed member reads can start), with the counts that explain it. Not a
// test (CI never runs it); numbers from Node do not match a browser, the
// counts are what compare.
//
//   node scripts/startup-bench.js [--follows N] [--blocks M] [--own K]
//                                 [--idb] [--runs R] [--json]
//
// N followed diaries of M blocks each are stored as replicas, the own diary
// has K blocks (its certificate, N follow records, posts). Storage is in
// memory, or fake-indexeddb with --idb. The run dials a closed loopback
// port, so only the startup is measured.

const net = require('node:net')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, followRecord, postRecord } = require('@varanda/core/lib/records')
const { memoryStorage } = require('../lib/storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function parseArgs (argv) {
  const opts = { follows: 50, blocks: 20, own: 200, idb: false, runs: 3, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--idb') opts.idb = true
    else if (a === '--json') opts.json = true
    else if (a === '--follows' || a === '--blocks' || a === '--own' || a === '--runs') {
      const n = Number(argv[++i])
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('valor inválido para ' + a)
      opts[a.slice(2)] = n
    } else {
      throw new Error('opção desconhecida: ' + a)
    }
  }
  if (opts.runs < 1) opts.runs = 1
  return opts
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

// A followed diary of `blocks` blocks (block 0 its certificate) stored as a
// replica in the node storage.
async function storeFollow (storage, assocKp, blocks) {
  const source = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await source.ready()
  const key = hex(source.key)
  const batch = [memberCertRecord(createCert({ member: key }, assocKp))]
  for (let i = 1; i < blocks; i++) batch.push(postRecord({ text: 'poste ' + i, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }))
  await source.append(batch)
  const replica = await store.openReplica(storage, key)
  const a = source.replicate(true)
  const b = replica.replicate(false)
  a.pipe(b).pipe(a)
  await replica.download({ start: 0, end: source.length }).done()
  a.destroy()
  b.destroy()
  await replica.close()
  await source.close()
  return key
}

async function fixture ({ follows, blocks, own, idb }) {
  let storage
  if (idb) {
    require('fake-indexeddb/auto')
    const { idbNodeStorage } = require('../lib/node-storage')
    storage = await idbNodeStorage('varanda-startup-bench-' + process.pid)
  } else {
    const { memoryNodeStorage } = require('../lib/node-storage')
    storage = memoryNodeStorage()
  }
  const assocKp = generateAssociationKeyPair()
  const keyPair = crypto.keyPair()
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair, mediaKeyPair: crypto.keyPair() }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, createCert({ member: ownHex }, assocKp))
  const keys = []
  for (let i = 0; i < follows; i++) keys.push(await storeFollow(storage, assocKp, Math.max(1, blocks)))
  const diary = await store.openDiary(storage, keyPair)
  try {
    for (const key of keys) await store.appendRecord(diary, followRecord({ key, on: true }))
    let i = 0
    while (diary.length < own) await store.appendRecord(diary, postRecord({ text: 'meu poste ' + (++i) }))
  } finally {
    await diary.close()
  }
  await store.writeFollows(storage, keys)
  await store.writeFollowsMigrated(storage)
  return { storage, ownHex, keys }
}

// Counters over node-store while a run is measured: the counts cover the
// whole run (after the abort only the startup's own work finishes, the
// follow fold included), the time ends at the reader.
function instrument () {
  const original = { replicaExists: store.replicaExists, openReplica: store.openReplica, openDiary: store.openDiary }
  const c = { existence: 0, opens: 0, inflight: 0, peak: 0, ownReads: 0, measuring: false }
  store.replicaExists = async function (...args) {
    if (c.measuring) c.existence++
    return original.replicaExists.apply(this, args)
  }
  store.openReplica = async function (...args) {
    if (!c.measuring) return original.openReplica.apply(this, args)
    c.opens++
    c.peak = Math.max(c.peak, ++c.inflight)
    try {
      return await original.openReplica.apply(this, args)
    } finally {
      c.inflight--
    }
  }
  store.openDiary = async function (...args) {
    const core = await original.openDiary.apply(this, args)
    if (!c.measuring) return core
    const get = core.get.bind(core)
    core.get = (index, opts) => {
      if (c.measuring && index >= 1) c.ownReads++
      return get(index, opts)
    }
    return core
  }
  return {
    counters: c,
    restore () { Object.assign(store, original) }
  }
}

async function measure (storage, url, c) {
  const { runSync } = require('../lib/sync')
  Object.assign(c, { existence: 0, opens: 0, inflight: 0, peak: 0, ownReads: 0, measuring: true })
  const ac = new AbortController()
  let published = null
  const start = process.hrtime.bigint()
  const run = runSync({
    storage,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    retryMinMs: 1000,
    retryMaxMs: 2000,
    socketCloseMs: 50,
    signal: ac.signal,
    reader: {
      set () {
        if (published !== null) return
        published = Number(process.hrtime.bigint() - start) / 1e6
        ac.abort()
      },
      clear () {}
    }
  })
  const result = await run
  c.measuring = false
  if (published === null) throw new Error('a sincronização terminou sem publicar o leitor: ' + JSON.stringify(result.errors))
  return { ms: published, existence: c.existence, opens: c.opens, peakOpens: c.peak, ownReads: c.ownReads }
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const { storage } = await fixture(opts)
  const url = 'ws://127.0.0.1:' + (await deadPort()) + '/seeder'
  const probe = instrument()
  const runs = []
  try {
    for (let i = 0; i < opts.runs; i++) runs.push(await measure(storage, url, probe.counters))
  } finally {
    probe.restore()
    if (typeof storage.close === 'function') await storage.close()
  }
  const times = runs.map((r) => r.ms).sort((a, b) => a - b)
  const summary = {
    follows: opts.follows,
    blocks: opts.blocks,
    own: opts.own,
    storage: opts.idb ? 'fake-indexeddb' : 'memória',
    runs: runs.length,
    medianMs: Math.round(times[Math.floor(times.length / 2)] * 10) / 10,
    minMs: Math.round(times[0] * 10) / 10,
    existence: runs[runs.length - 1].existence,
    opens: runs[runs.length - 1].opens,
    peakOpens: runs[runs.length - 1].peakOpens,
    ownReads: runs[runs.length - 1].ownReads
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...summary, each: runs }) + '\n')
    return
  }
  const lines = [
    'seguidos ' + summary.follows + ' x ' + summary.blocks + ' blocos, diário próprio ' + summary.own + ' blocos, ' + summary.storage + ', ' + summary.runs + ' execuções',
    'até publicar o leitor: mediana ' + summary.medianMs + ' ms, mínimo ' + summary.minMs + ' ms',
    'checagens de existência: ' + summary.existence,
    'réplicas abertas: ' + summary.opens + ' (pico simultâneo ' + summary.peakOpens + ')',
    'leituras de blocos do diário próprio: ' + summary.ownReads
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

main().catch((err) => {
  process.stderr.write('erro: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
