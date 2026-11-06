'use strict'

// Startup bench of the browser sync (lib/sync.js): how long a returning
// visit waits from runSync until the run publishes its reader (the moment
// borrowed member reads can start), with the counts that explain it. Not a
// test (CI never runs it); numbers from Node do not match a browser, the
// counts are what compare.
//
//   node scripts/startup-bench.js [--follows N] [--blocks M] [--own K]
//                                 [--idb] [--issued] [--js-verify] [--reads]
//                                 [--runs R] [--json]
//
// N followed diaries of M blocks each are stored as replicas, the own diary
// has K blocks (its certificate, N follow records, posts). Storage is in
// memory, or fake-indexeddb with --idb. The run dials a closed loopback
// port, so only the startup is measured. --issued: v2 certificates from an
// issuer and a username record in every diary, as the account service
// makes them. --js-verify: signatures are checked with sodium-javascript,
// as the web bundle does (Node's native binding is about 60x faster).
// --reads: once the reader is published, the app's first reads run on the
// lent cores (feed.read limit 20, profile.read of every author,
// engagement.read), timed one after the other as the node's chain runs
// them. Every run starts with an empty signature memo, as a page load does.

const net = require('node:net')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createCert, createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, followRecord, postRecord } = require('@varanda/core/lib/records')
const { clearMemo } = require('@varanda/core/lib/verified')
const { memoryStorage } = require('../lib/storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function parseArgs (argv) {
  const opts = { follows: 50, blocks: 20, own: 200, idb: false, issued: false, jsVerify: false, reads: false, runs: 3, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--idb') opts.idb = true
    else if (a === '--json') opts.json = true
    else if (a === '--issued') opts.issued = true
    else if (a === '--js-verify') opts.jsVerify = true
    else if (a === '--reads') opts.reads = true
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

// The member certificate of `member`: v1 from the association, or v2 from
// `issuer` ({ kp, cert }) when given.
function memberCert (member, assocKp, issuer) {
  return issuer === null ? createCert({ member }, assocKp) : createIssuedCert({ member }, issuer.kp, issuer.cert)
}

// A followed diary of `blocks` blocks (block 0 its certificate, block 1 a
// username record with an issuer) stored as a replica in the node storage.
async function storeFollow (storage, assocKp, blocks, issuer, i) {
  const source = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await source.ready()
  const key = hex(source.key)
  const batch = [memberCertRecord(memberCert(key, assocKp, issuer))]
  if (issuer !== null) batch.push(createUsernameRecord({ member: key, username: 'seguida' + i }, issuer.kp, issuer.cert))
  while (batch.length < blocks) batch.push(postRecord({ text: 'poste ' + batch.length, at: new Date(Date.UTC(2026, 0, 1, 0, 0, batch.length)).toISOString() }))
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

async function fixture ({ follows, blocks, own, idb, issued }) {
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
  let issuer = null
  if (issued) {
    const kp = crypto.keyPair()
    issuer = { kp, cert: createIssuerCert({ issuer: hex(kp.publicKey) }, assocKp) }
  }
  const keyPair = crypto.keyPair()
  const ctx = { storage, association: hex(assocKp.publicKey), keyPair, mediaKeyPair: crypto.keyPair() }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, memberCert(ownHex, assocKp, issuer))
  const keys = []
  for (let i = 0; i < follows; i++) keys.push(await storeFollow(storage, assocKp, Math.max(1, blocks), issuer, i))
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
  return { storage, association: ctx.association, ownHex, keys }
}

// Counters over node-store while a run is measured: the counts cover the
// whole run (after the abort only the startup's own work finishes, the
// follow fold included), the time ends at the reader.
function instrument ({ jsVerify }) {
  const original = { replicaExists: store.replicaExists, openReplica: store.openReplica, openDiary: store.openDiary }
  const c = { existence: 0, opens: 0, inflight: 0, peak: 0, ownReads: 0, verifies: 0, verifyMs: 0, measuring: false }
  // The copy @varanda/core lib/verified.js checks signatures with.
  const sigCrypto = require(require.resolve('hypercore-crypto', { paths: [require('node:path').dirname(require.resolve('@varanda/core/lib/verified'))] }))
  const nativeVerify = sigCrypto.verify
  const sodiumJs = jsVerify ? require('sodium-javascript') : null
  sigCrypto.verify = function (message, signature, publicKey) {
    if (!c.measuring) return nativeVerify.call(this, message, signature, publicKey)
    const t = process.hrtime.bigint()
    try {
      return sodiumJs === null ? nativeVerify.call(this, message, signature, publicKey) : sodiumJs.crypto_sign_verify_detached(signature, message, publicKey)
    } finally {
      c.verifies++
      c.verifyMs += Number(process.hrtime.bigint() - t) / 1e6
    }
  }
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
    restore () {
      Object.assign(store, original)
      sigCrypto.verify = nativeVerify
    }
  }
}

// The app's first reads on the cores the run lends, one after the other.
async function firstReads (api, { storage, association, ownHex, keys }) {
  const ctx = { storage, association, cores: { diary: api.diary, replica: api.replica, group: api.group } }
  const timed = async (read) => {
    if (!api.hold()) throw new Error('a sincronização não emprestou os núcleos')
    const start = process.hrtime.bigint()
    try {
      await read()
    } finally {
      api.release()
    }
    return Number(process.hrtime.bigint() - start) / 1e6
  }
  return {
    feed: await timed(() => ops.feedRead(ctx, { limit: 20 })),
    profile: await timed(() => ops.profileRead(ctx, { authors: [ownHex, ...keys] })),
    engagement: await timed(() => ops.engagementRead(ctx, { refs: keys.slice(0, 20).map((k) => k + ':2') }))
  }
}

async function measure (f, url, c, reads) {
  const { runSync } = require('../lib/sync')
  const storage = f.storage
  clearMemo()
  Object.assign(c, { existence: 0, opens: 0, inflight: 0, peak: 0, ownReads: 0, verifies: 0, verifyMs: 0, measuring: true })
  const ac = new AbortController()
  let published = null
  let timings = null
  let readError = null
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
      set (api) {
        if (published !== null) return
        published = Number(process.hrtime.bigint() - start) / 1e6
        if (!reads) return ac.abort()
        firstReads(api, f).then((t) => { timings = t }, (err) => { readError = err }).finally(() => ac.abort())
      },
      clear () {}
    }
  })
  const result = await run
  c.measuring = false
  if (published === null) throw new Error('a sincronização terminou sem publicar o leitor: ' + JSON.stringify(result.errors))
  if (readError !== null) throw readError
  const out = { ms: published, existence: c.existence, opens: c.opens, peakOpens: c.peak, ownReads: c.ownReads, verifies: c.verifies, verifyMs: c.verifyMs }
  if (timings !== null) Object.assign(out, { feedMs: timings.feed, profileMs: timings.profile, engagementMs: timings.engagement })
  return out
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const f = await fixture(opts)
  const storage = f.storage
  const url = 'ws://127.0.0.1:' + (await deadPort()) + '/seeder'
  const probe = instrument(opts)
  const runs = []
  try {
    for (let i = 0; i < opts.runs; i++) runs.push(await measure(f, url, probe.counters, opts.reads))
  } finally {
    probe.restore()
    if (typeof storage.close === 'function') await storage.close()
  }
  const median = (pick) => {
    const v = runs.map(pick).sort((a, b) => a - b)
    return Math.round(v[Math.floor(v.length / 2)] * 10) / 10
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
    ownReads: runs[runs.length - 1].ownReads,
    certs: opts.issued ? 'v2 + nome de usuário' : 'v1',
    verify: opts.jsVerify ? 'sodium-javascript' : 'nativa',
    verifies: runs[runs.length - 1].verifies,
    verifyMs: median((r) => r.verifyMs)
  }
  if (opts.reads) Object.assign(summary, { feedMs: median((r) => r.feedMs), profileMs: median((r) => r.profileMs), engagementMs: median((r) => r.engagementMs) })
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...summary, each: runs }) + '\n')
    return
  }
  const lines = [
    'seguidos ' + summary.follows + ' x ' + summary.blocks + ' blocos, diário próprio ' + summary.own + ' blocos, ' + summary.storage + ', certificados ' + summary.certs + ', verificação ' + summary.verify + ', ' + summary.runs + ' execuções',
    'até publicar o leitor: mediana ' + summary.medianMs + ' ms, mínimo ' + summary.minMs + ' ms',
    'checagens de existência: ' + summary.existence,
    'réplicas abertas: ' + summary.opens + ' (pico simultâneo ' + summary.peakOpens + ')',
    'leituras de blocos do diário próprio: ' + summary.ownReads,
    'assinaturas verificadas: ' + summary.verifies + ' (mediana ' + summary.verifyMs + ' ms)'
  ]
  if (opts.reads) lines.push('primeiras leituras (medianas): feed.read ' + summary.feedMs + ' ms, profile.read ' + summary.profileMs + ' ms, engagement.read ' + summary.engagementMs + ' ms')
  process.stdout.write(lines.join('\n') + '\n')
}

main().catch((err) => {
  process.stderr.write('erro: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
