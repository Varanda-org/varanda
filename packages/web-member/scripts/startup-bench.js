'use strict'

// Startup bench of the browser sync (lib/sync.js): how long a returning
// visit waits from runSync until the run publishes its reader (the moment
// borrowed member reads can start), with the counts that explain it. Not a
// test (CI never runs it); numbers from Node do not match a browser, the
// counts are what compare.
//
//   node scripts/startup-bench.js [--follows N] [--blocks M] [--own K]
//                                 [--idb | --file] [--issued] [--js-verify]
//                                 [--reads] [--reads-twice] [--log] [--lease-gap]
//                                 [--steps] [--early-reads] [--dm-rows N]
//                                 [--groups G --group-blocks B]
//                                 [--runs R] [--json]
//
// N followed diaries of M blocks each are stored as replicas, the own diary
// has K blocks (its certificate, N follow records, posts). Storage is in
// memory, fake-indexeddb with --idb, or a fresh temporary directory per run
// with --file (the native worklet's storage). The run dials a closed loopback
// port, so only the startup is measured. --issued: v2 certificates from an
// issuer and a username record in every diary, as the account service
// makes them. --js-verify: signatures are checked with sodium-javascript,
// as the web bundle does (Node's native binding is about 60x faster).
// --reads: once the reader is published, the app's first reads run on the
// lent cores (feed.read limit 20, profile.read of every author,
// engagement.read), timed one after the other as the node's chain runs
// them. Every run starts with an empty signature memo, as a page load does.
// --reads-twice repeats the trio on the same cores; --log reads pages 1 and
// 8 of the own diary. --lease-gap reads the feed exclusively after shutdown.
// --steps: the time of each startup step of runSync (the onStep hook of
// lib/sync.js) as startup.steps {name: ms}, plus readerPublishedMs (the first
// reader publication) and startupSettledMs (the connection step begins: every
// step before it is done); the 'conexão' step itself reads 0, it is the end
// marker. --early-reads: log.read (own), profile.read [own] and feed.read are
// issued at sync.start, one after the other as the node's chain runs them, each
// waiting for the reader to be published to borrow the run's cores; each
// answer's time from sync.start is earlyOwnReadMs, earlyProfileReadMs and
// earlyFeedReadMs. --dm-rows N: N rows over 40 peers are filed in the local
// direct message store; per run dmUnlockMs (engine.unlock), dmListMs and
// dmList2Ms (dm.list, first and again), dmThreadMs (dm.thread of one peer).
// --groups G --group-blocks B: G public groups of B blocks over 3 writers
// (the own diary and two helper members, their cores copied in as a sync
// would); per run groupListMs, groupList2Ms and communityListMs, the first
// call after a cleared signature memo and a second one on the warm memo. The
// DM and group reads run before the startup is measured.

const net = require('node:net')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const b4a = require('b4a')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createCert, createIssuerCert, createIssuedCert, createUsernameRecord, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord, followRecord, postRecord } = require('@varanda/core/lib/records')
const { clearMemo } = require('@varanda/core/lib/verified')
const { createDmStore } = require('../lib/dm-store')
const { createDmEngine } = require('../lib/dm')
const { dmLocalKeyFromPrf } = require('../lib/passkey')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const { memoryNodeStorage } = require('../lib/node-storage')
const { memoryStorage } = require('../lib/storage')
const store = require('../lib/node-store')
const ops = require('../lib/member-ops')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function parseArgs (argv) {
  const opts = { follows: 50, blocks: 20, own: 200, idb: false, file: false, issued: false, jsVerify: false, reads: false, readsTwice: false, log: false, leaseGap: false, steps: false, earlyReads: false, dmRows: 0, groups: 0, groupBlocks: 0, runs: 3, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--idb') opts.idb = true
    else if (a === '--file') opts.file = true
    else if (a === '--json') opts.json = true
    else if (a === '--issued') opts.issued = true
    else if (a === '--js-verify') opts.jsVerify = true
    else if (a === '--reads') opts.reads = true
    else if (a === '--reads-twice') opts.readsTwice = true
    else if (a === '--log') opts.log = true
    else if (a === '--lease-gap') opts.leaseGap = true
    else if (a === '--steps') opts.steps = true
    else if (a === '--early-reads') opts.earlyReads = true
    else if (a === '--follows' || a === '--blocks' || a === '--own' || a === '--runs' || a === '--dm-rows' || a === '--groups' || a === '--group-blocks') {
      const n = Number(argv[++i])
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('valor inválido para ' + a)
      opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = n
    } else {
      throw new Error('opção desconhecida: ' + a)
    }
  }
  if (opts.runs < 1) opts.runs = 1
  if (opts.idb && opts.file) throw new Error('escolha --idb ou --file')
  if (opts.groups > 0 && opts.groupBlocks < 1) throw new Error('--groups pede --group-blocks')
  if (opts.readsTwice) opts.reads = true
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

async function fixture ({ follows, blocks, own, idb, issued }, storage = null) {
  if (storage === null) {
    if (idb) {
      require('fake-indexeddb/auto')
      const { idbNodeStorage } = require('../lib/node-storage')
      storage = await idbNodeStorage('varanda-startup-bench-' + process.pid)
    } else {
      const { memoryNodeStorage } = require('../lib/node-storage')
      storage = memoryNodeStorage()
    }
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
  return { storage, association: ctx.association, ownHex, keys, assocKp, issuer, keyPair }
}

const DM_PEERS = 40

function rand (n) {
  return crypto.randomBytes(n)
}

// N rows over 40 peers in the local direct message store, sealed under the
// key of `prf` as the passkey session does. Returns the prf and one peer.
async function fillDm (f, rows) {
  const prf = rand(32)
  const peers = []
  for (let i = 0; i < DM_PEERS; i++) peers.push(hex(rand(32)))
  const local = createDmStore({ storage: f.storage })
  const key = await dmLocalKeyFromPrf(prf)
  await local.unlock(key)
  key.fill(0)
  try {
    const t0 = Date.UTC(2026, 0, 1)
    let batch = []
    for (let i = 0; i < rows; i++) {
      const peer = peers[i % DM_PEERS]
      const mine = Math.floor(i / DM_PEERS) % 2 === 0
      batch.push({ t: 'msg', id: hex(rand(16)), peer, from: mine ? f.ownHex : peer, text: 'mensagem ' + i, replyTo: null, media: null, at: new Date(t0 + i * 1000).toISOString(), mine, filedAt: t0 + i * 1000 })
      if (batch.length === 500 || i === rows - 1) {
        await local.append(batch)
        batch = []
      }
    }
  } finally {
    await local.close()
  }
  return { prf, peer: peers[0] }
}

// Unlock, list twice and one thread of the filed rows, timed.
async function dmReads (f, dm, url) {
  const engine = createDmEngine({ storage: f.storage, association: f.association, seederUrl: url, createSocket: () => { throw new Error('sem rede na bancada') } })
  const timed = async (fn) => {
    const start = process.hrtime.bigint()
    await fn()
    return Number(process.hrtime.bigint() - start) / 1e6
  }
  try {
    const out = {}
    out.dmUnlockMs = await timed(() => engine.unlock(dm.prf))
    out.dmListMs = await timed(() => engine.list(f.ownHex, {}))
    out.dmList2Ms = await timed(() => engine.list(f.ownHex, {}))
    out.dmThreadMs = await timed(() => engine.thread(f.ownHex, { peer: dm.peer }))
    return out
  } finally {
    engine.lock()
    await engine.idle()
  }
}

async function copyGroupCore (from, to, key) {
  const source = await store.openGroupCoreReadOnly(from, key)
  if (source === null) return
  const target = await store.openGroupReplica(to, key)
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    if (source.length > 0) await target.download({ start: 0, end: source.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
  await store.addGroupReplica(to, key)
}

async function copyDiary (from, to, ownHex) {
  const source = await store.openDiary(from)
  const target = await store.openReplica(to, ownHex)
  const a = source.replicate(true, { keepAlive: false })
  const b = target.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await target.download({ start: 0, end: source.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await source.close()
    await target.close()
  }
}

// The community cores `from` writes or holds, to `to`.
async function copyCommunityCores (from, to) {
  for (const e of await store.readGroupWriters(from)) {
    if (e.kind !== 'community') continue
    await copyGroupCore(from, to, e.key)
    if (e.key !== e.group) await copyGroupCore(from, to, e.group)
  }
}

// G public groups of `blocks` posts over three writers: the own diary and two
// helper members (own storages), whose group and community writers and diaries
// are copied into the own storage as a sync would bring them.
async function fillGroups (f, groups, blocks) {
  const prf = rand(32)
  const own = { storage: f.storage, association: f.association, keyPair: f.keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const helperOf = async () => {
    const storage = memoryNodeStorage()
    const keyPair = crypto.keyPair()
    const hprf = rand(32)
    const ctx = { storage, association: f.association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(hprf, nonce) }
    await ops.idCreate(ctx)
    const ownHex = hex(keyPair.publicKey)
    await ops.certAdd(ctx, memberCert(ownHex, f.assocKp, f.issuer))
    return { storage, ctx, ownHex }
  }
  const helpers = [await helperOf(), await helperOf()]
  // B posts per group over 3 writers: the own diary takes the remainder,
  // so the summary's 'G x B blocos' is what was built.
  const per = Math.floor(blocks / 3)
  const ownPer = Math.max(1, blocks - 2 * per)
  let community = null
  let inCommunity = 0
  const joined = new Set()
  for (let g = 0; g < groups; g++) {
    if (community === null || inCommunity >= 30) {
      community = (await ops.communityCreate(own, { name: 'Bairro ' + g, join: 'open' })).community
      inCommunity = 0
      joined.clear()
    }
    inCommunity++
    const { group } = await ops.groupCreate(own, { name: 'Grupo ' + g, join: 'open', community })
    for (let i = 0; i < ownPer; i++) await ops.groupPost(own, { group, text: 'poste ' + i })
    for (const h of helpers) {
      await copyGroupCore(f.storage, h.storage, group)
      await copyCommunityCores(f.storage, h.storage)
      await copyDiary(f.storage, h.storage, f.ownHex)
      if (!joined.has(h)) await ops.communityJoin(h.ctx, { community })
      await ops.groupJoin(h.ctx, { group, community })
      for (let i = 0; i < per; i++) await ops.groupPost(h.ctx, { group, text: 'poste ' + i })
      for (const e of await store.readGroupWriters(h.storage)) await copyGroupCore(h.storage, f.storage, e.key)
      await copyDiary(h.storage, f.storage, h.ownHex)
    }
    joined.add(helpers[0])
    joined.add(helpers[1])
  }
}

async function groupReads (f, groups) {
  // The session's group fold memo (a Map per key pair), as group.list gets it.
  const ctx = { storage: f.storage, association: f.association, keyPair: f.keyPair, memo: new Map() }
  const timed = async (fn) => {
    const start = process.hrtime.bigint()
    const r = await fn()
    return [Number(process.hrtime.bigint() - start) / 1e6, r]
  }
  clearMemo()
  const out = {}
  const [first, list] = await timed(() => ops.groupList(ctx, { offset: 0, limit: Infinity }))
  out.groupListMs = first
  if (list.total < groups) throw new Error('grupos listados: ' + list.total + ' de ' + groups)
  out.groupList2Ms = (await timed(() => ops.groupList(ctx, { offset: 0, limit: Infinity })))[0]
  out.communityListMs = (await timed(() => ops.communityList(ctx)))[0]
  return out
}

async function prepare (opts, storage = null) {
  const f = await fixture(opts, storage)
  f.dm = opts.dmRows > 0 ? await fillDm(f, opts.dmRows) : null
  if (opts.groups > 0) await fillGroups(f, opts.groups, opts.groupBlocks)
  return f
}

// The DM and group reads, run before the startup is measured.
async function extraReads (f, url, opts) {
  const out = {}
  if (f.dm !== null) Object.assign(out, await dmReads(f, f.dm, url))
  if (opts.groups > 0) Object.assign(out, await groupReads(f, opts.groups))
  return out
}

function counts (c) {
  return { ownReads: c.ownReads, existence: c.existence, opens: c.opens, storageGets: c.storageGets, storageHas: c.storageHas, storageReads: c.storageReads, storageStats: c.storageStats }
}

// Separate core get/has from adapter reads/probes so cache hits do not look
// like I/O. Adapter counts are calls, not OS syscalls or IDB transactions.
function instrumentStorage (storage, c) {
  const seen = new WeakSet()
  function wrap (target) {
    if (seen.has(target)) return target
    seen.add(target)
    for (const [counter, methods] of [
      ['storageReads', ['get', 'read', 'readJson']],
      ['storageStats', ['has', 'hasCore', 'stat', 'exists']]
    ]) {
      for (const name of methods) {
        const original = target[name]
        if (typeof original !== 'function') continue
        target[name] = function (...args) {
          if (c.measuring) c[counter]++
          return original.apply(this, args)
        }
      }
    }
    return target
  }
  const core = storage.core
  storage.core = function (...args) {
    const factory = core.apply(this, args)
    return (...args) => wrap(factory(...args))
  }
  return wrap(storage)
}

function instrument ({ jsVerify }) {
  const original = { replicaExists: store.replicaExists, openReplica: store.openReplica, openDiary: store.openDiary }
  const c = { existence: 0, opens: 0, inflight: 0, peak: 0, ownReads: 0, storageGets: 0, storageHas: 0, storageReads: 0, storageStats: 0, verifies: 0, verifyMs: 0, measuring: false }
  function wrapCore (core, own = false) {
    for (const name of ['get', 'has']) {
      const original = core[name]
      core[name] = function (...args) {
        if (c.measuring) {
          c[name === 'get' ? 'storageGets' : 'storageHas']++
          if (own && name === 'get' && args[0] >= 1) c.ownReads++
        }
        return original.apply(this, args)
      }
    }
    return core
  }
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
      return wrapCore(await original.openReplica.apply(this, args))
    } finally {
      c.inflight--
    }
  }
  store.openDiary = async function (...args) {
    const core = await original.openDiary.apply(this, args)
    if (!c.measuring) return core
    return wrapCore(core, true)
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
async function firstReads (api, { storage, association, ownHex, keys }, opts, c, phases) {
  const ctx = { storage, association, cores: { diary: api.diary, replica: api.replica, group: api.group, opened: api.opened, settled: api.settled } }
  const timed = async (phase, read) => {
    if (!api.hold()) throw new Error('a sincronização não emprestou os núcleos')
    const before = counts(c)
    const start = process.hrtime.bigint()
    try {
      await read()
    } finally {
      api.release()
      const after = counts(c)
      phases[phase] = Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]))
    }
    return Number(process.hrtime.bigint() - start) / 1e6
  }
  // The run keeps working after it publishes the reader (connect, the
  // follow fold); without this wait that tail lands in the first phase's
  // counts. It is reported apart as phases.startupTail.
  const tailBefore = counts(c)
  let last = JSON.stringify(tailBefore)
  for (let waited = 0; waited < 5000; waited += 300) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const now = JSON.stringify(counts(c))
    if (now === last) break
    last = now
  }
  const tailAfter = counts(c)
  phases.startupTail = Object.fromEntries(Object.keys(tailBefore).map((key) => [key, tailAfter[key] - tailBefore[key]]))
  const timings = {}
  if (opts.reads) {
    for (const suffix of opts.readsTwice ? ['', '2'] : ['']) {
      timings['feed' + suffix + 'Ms'] = await timed('feed' + suffix, () => ops.feedRead(ctx, { limit: 20 }))
      timings['profile' + suffix + 'Ms'] = await timed('profile' + suffix, () => ops.profileRead(ctx, { authors: [ownHex, ...keys] }))
      timings['engagement' + suffix + 'Ms'] = await timed('engagement' + suffix, () => ops.engagementRead(ctx, { refs: keys.slice(0, 20).map((k) => k + ':2') }))
    }
  }
  if (opts.log) {
    const logPage = async (before) => {
      const { entries } = await ops.logRead(ctx)
      let end = entries.length
      if (before !== undefined) {
        while (end > 0 && entries[end - 1].seq >= before) end--
      }
      return entries.slice(Math.max(0, end - 32), end)
    }
    timings.logPage1Ms = await timed('log1', () => logPage())
    timings.logPage8Ms = await timed('log8', () => logPage(api.diary.length - 7 * 32))
  }
  return timings
}

// The first reads of the app, issued at sync.start: each waits for the reader
// to be published (the run's cores are lent from then on) and answers from the
// lent cores; times are from sync.start, the chain running them in turn.
async function earlyReads (api, { storage, association, ownHex }, start, out) {
  const ctx = { storage, association, cores: { diary: api.diary, replica: api.replica, group: api.group, opened: api.opened, settled: api.settled } }
  const since = () => Number(process.hrtime.bigint() - start) / 1e6
  const read = async (name, fn) => {
    if (!api.hold()) throw new Error('a sincronização não emprestou os núcleos')
    try {
      await fn()
    } finally {
      api.release()
    }
    out[name] = since()
  }
  await read('earlyOwnReadMs', () => ops.logRead(ctx))
  await read('earlyProfileReadMs', () => ops.profileRead(ctx, { authors: [ownHex] }))
  await read('earlyFeedReadMs', () => ops.feedRead(ctx, { limit: 20 }))
}

// [[name, msSinceStart]] -> { startup steps durations, startupSettledMs }: a
// step lasts until the next one begins; the 'conexão' step ends the startup.
function stepTimes (steps) {
  const durations = {}
  let settled = null
  for (let i = 0; i < steps.length; i++) {
    const [name, at] = steps[i]
    if (name === 'conexão' && settled === null) settled = at
    const next = i + 1 < steps.length ? steps[i + 1][1] : at
    durations[name] = (durations[name] || 0) + (next - at)
  }
  return { stepMs: durations, startupSettledMs: settled }
}

async function measure (f, url, c, opts) {
  const { runSync } = require('../lib/sync')
  const storage = f.storage
  clearMemo()
  Object.assign(c, { existence: 0, opens: 0, inflight: 0, peak: 0, ownReads: 0, storageGets: 0, storageHas: 0, storageReads: 0, storageStats: 0, verifies: 0, verifyMs: 0, measuring: true })
  const ac = new AbortController()
  let published = null
  let timings = null
  let startup = null
  const phases = {}
  let readError = null
  const steps = []
  const early = {}
  const start = process.hrtime.bigint()
  const run = runSync({
    onStep: opts.steps ? (name, ms) => { steps.push([name, ms]) } : undefined,
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
        startup = counts(c)
        if (!opts.reads && !opts.log && !opts.earlyReads) return ac.abort()
        const next = opts.earlyReads ? earlyReads(api, f, start, early) : Promise.resolve()
        next.then(() => (opts.reads || opts.log) ? firstReads(api, f, opts, c, phases) : {}).then((t) => { timings = t }, (err) => { readError = err }).finally(() => ac.abort())
      },
      clear () {}
    }
  })
  const result = await run
  c.measuring = false
  if (published === null) throw new Error('a sincronização terminou sem publicar o leitor: ' + JSON.stringify(result.errors))
  if (readError !== null) throw readError
  const out = { ms: published, existence: c.existence, opens: c.opens, peakOpens: c.peak, ownReads: c.ownReads, verifies: c.verifies, verifyMs: c.verifyMs, storageGets: c.storageGets, storageHas: c.storageHas, storageReads: c.storageReads, storageStats: c.storageStats, startup, phases }
  if (timings !== null) Object.assign(out, timings)
  Object.assign(out, early)
  if (opts.steps) {
    out.readerPublishedMs = published
    Object.assign(out, stepTimes(steps))
  }
  if (opts.leaseGap) {
    // Keep the historical totals scoped to the live run, including teardown.
    c.measuring = true
    const start = process.hrtime.bigint()
    try {
      await ops.feedRead({ storage, association: f.association }, { limit: 20 })
      out.leaseGapReadMs = Number(process.hrtime.bigint() - start) / 1e6
    } finally {
      c.measuring = false
    }
  }
  return out
}

async function main () {
  const opts = parseArgs(process.argv.slice(2))
  const url = 'ws://127.0.0.1:' + (await deadPort()) + '/seeder'
  const probe = instrument(opts)
  const runs = []
  let f = null
  try {
    if (!opts.file) {
      f = await prepare(opts)
      instrumentStorage(f.storage, probe.counters)
    }
    for (let i = 0; i < opts.runs; i++) {
      if (!opts.file) {
        const extra = await extraReads(f, url, opts)
        runs.push({ ...await measure(f, url, probe.counters, opts), ...extra })
        continue
      }
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varanda-startup-bench-'))
      let storage = null
      try {
        const { fileNodeStorage } = require('../lib/file-storage')
        storage = fileNodeStorage(dir)
        const f = await prepare(opts, storage)
        instrumentStorage(storage, probe.counters)
        const extra = await extraReads(f, url, opts)
        runs.push({ ...await measure(f, url, probe.counters, opts), ...extra })
      } finally {
        probe.counters.measuring = false
        try {
          if (storage !== null) await storage.close()
        } finally {
          await fs.rm(dir, { recursive: true, force: true })
        }
      }
    }
  } finally {
    probe.counters.measuring = false
    probe.restore()
    if (f !== null && typeof f.storage.close === 'function') await f.storage.close()
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
    storage: opts.file ? 'arquivo' : opts.idb ? 'fake-indexeddb' : 'memória',
    runs: runs.length,
    medianMs: Math.round(times[Math.floor(times.length / 2)] * 10) / 10,
    minMs: Math.round(times[0] * 10) / 10,
    existence: runs[runs.length - 1].existence,
    opens: runs[runs.length - 1].opens,
    peakOpens: runs[runs.length - 1].peakOpens,
    ownReads: runs[runs.length - 1].ownReads,
    storageGets: runs[runs.length - 1].storageGets,
    storageHas: runs[runs.length - 1].storageHas,
    storageReads: runs[runs.length - 1].storageReads,
    storageStats: runs[runs.length - 1].storageStats,
    startup: runs[runs.length - 1].startup,
    phases: runs[runs.length - 1].phases,
    certs: opts.issued ? 'v2 + nome de usuário' : 'v1',
    verify: opts.jsVerify ? 'sodium-javascript' : 'nativa',
    verifies: runs[runs.length - 1].verifies,
    verifyMs: median((r) => r.verifyMs)
  }
  if (opts.reads) Object.assign(summary, { feedMs: median((r) => r.feedMs), profileMs: median((r) => r.profileMs), engagementMs: median((r) => r.engagementMs) })
  if (opts.readsTwice) Object.assign(summary, { feed2Ms: median((r) => r.feed2Ms), profile2Ms: median((r) => r.profile2Ms), engagement2Ms: median((r) => r.engagement2Ms) })
  if (opts.log) Object.assign(summary, { logPage1Ms: median((r) => r.logPage1Ms), logPage8Ms: median((r) => r.logPage8Ms) })
  if (opts.leaseGap) summary.leaseGapReadMs = median((r) => r.leaseGapReadMs)
  if (opts.steps) {
    const steps = {}
    for (const name of Object.keys(runs[runs.length - 1].stepMs)) steps[name] = median((r) => r.stepMs[name] || 0)
    summary.startup = { ...summary.startup, steps }
    Object.assign(summary, { readerPublishedMs: median((r) => r.readerPublishedMs), startupSettledMs: median((r) => r.startupSettledMs) })
  }
  if (opts.earlyReads) Object.assign(summary, { earlyOwnReadMs: median((r) => r.earlyOwnReadMs), earlyProfileReadMs: median((r) => r.earlyProfileReadMs), earlyFeedReadMs: median((r) => r.earlyFeedReadMs) })
  if (opts.dmRows > 0) Object.assign(summary, { dmRows: opts.dmRows, dmUnlockMs: median((r) => r.dmUnlockMs), dmListMs: median((r) => r.dmListMs), dmList2Ms: median((r) => r.dmList2Ms), dmThreadMs: median((r) => r.dmThreadMs) })
  if (opts.groups > 0) Object.assign(summary, { groups: opts.groups, groupBlocks: opts.groupBlocks, groupListMs: median((r) => r.groupListMs), groupList2Ms: median((r) => r.groupList2Ms), communityListMs: median((r) => r.communityListMs) })
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
  if (opts.readsTwice) lines.push('segundas leituras (medianas): feed.read ' + summary.feed2Ms + ' ms, profile.read ' + summary.profile2Ms + ' ms, engagement.read ' + summary.engagement2Ms + ' ms')
  if (opts.log) lines.push('diário (medianas): página 1 ' + summary.logPage1Ms + ' ms, página 8 ' + summary.logPage8Ms + ' ms')
  if (opts.leaseGap) lines.push('feed após encerrar a sincronização (mediana): ' + summary.leaseGapReadMs + ' ms')
  if (opts.steps) {
    lines.push('leitor publicado: mediana ' + summary.readerPublishedMs + ' ms; partida concluída (começa a conexão): mediana ' + summary.startupSettledMs + ' ms')
    lines.push('etapas da partida (medianas): ' + Object.entries(summary.startup.steps).map(([k, v]) => k + ' ' + v + ' ms').join(', '))
  }
  if (opts.earlyReads) lines.push('leituras no início da sincronização (medianas, desde o início): log.read ' + summary.earlyOwnReadMs + ' ms, profile.read ' + summary.earlyProfileReadMs + ' ms, feed.read ' + summary.earlyFeedReadMs + ' ms')
  if (opts.dmRows > 0) lines.push('mensagens diretas ' + summary.dmRows + ' linhas (medianas): desbloqueio ' + summary.dmUnlockMs + ' ms, lista ' + summary.dmListMs + ' ms, lista de novo ' + summary.dmList2Ms + ' ms, conversa ' + summary.dmThreadMs + ' ms')
  if (opts.groups > 0) lines.push('grupos ' + summary.groups + ' x ' + summary.groupBlocks + ' blocos (medianas): lista ' + summary.groupListMs + ' ms, lista de novo ' + summary.groupList2Ms + ' ms, comunidades ' + summary.communityListMs + ' ms')
  lines.push('operações de armazenamento: get ' + summary.storageGets + ', has ' + summary.storageHas + ', leituras ' + summary.storageReads + ', consultas ' + summary.storageStats)
  for (const [name, c] of [['partida', summary.startup], ...Object.entries(summary.phases)]) {
    lines.push(name + ': diário ' + c.ownReads + ', existência ' + c.existence + ', aberturas ' + c.opens + ', get ' + c.storageGets + ', has ' + c.storageHas + ', leituras ' + c.storageReads + ', consultas ' + c.storageStats)
  }
  process.stdout.write(lines.join('\n') + '\n')
}

main().catch((err) => {
  process.stderr.write('erro: ' + (err && err.message ? err.message : String(err)) + '\n')
  process.exitCode = 1
})
