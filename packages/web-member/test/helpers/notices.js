'use strict'

// Shared fixtures of the notices tests: copies of the helpers of
// ../notices.test.js (which exports nothing), the seeder stand-in extended
// with the 'varanda/notices/2' channel. Loopback only.
const b4a = require('b4a')
const Hypercore = require('hypercore')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket } = require('ws')
const { connectClient } = require('./session')
const { createCert, createSeederCert, createModeratorCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { memberCertRecord } = require('@varanda/core/lib/records')
const { attachAdmission } = require('@varanda/core/lib/admission')
const { attachNotices, attachNoticesV2, NOTICES_V2_PROTOCOL } = require('@varanda/core/lib/notices-net')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { createBrowserNode } = require('../../lib/node')
const { memoryNodeStorage } = require('../../lib/node-storage')
const { memoryStorage } = require('../../lib/storage')
const { wsStream } = require('../../lib/ws-stream')

const HOUR = 3600000
const HEX32 = /^[0-9a-f]{32}$/

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function noop () {}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

function moderator (assocKp) {
  const keyPair = crypto.keyPair()
  return { keyPair, cert: createModeratorCert({ moderator: hex(keyPair.publicKey) }, assocKp) }
}

function snapshot (mod, { seq = 1, blocked = [], revokedIssuers = [] }) {
  return createSnapshot({ seq, blocked, revokedIssuers }, mod.keyPair, mod.cert)
}

function issuer (assoc) {
  const keyPair = crypto.keyPair()
  return { keyPair, hex: hex(keyPair.publicKey), cert: createIssuerCert({ issuer: hex(keyPair.publicKey) }, assoc.kp) }
}

function iso (ms) {
  return new Date(ms).toISOString()
}

// A Hypercore 10 diary with the given records (block 0 first); each maker
// receives the diary key. Every block it uploads is counted in `uploads`.
async function diary (t, records) {
  const core = new Hypercore(memoryStorage(), { valueEncoding: 'json' })
  await core.ready()
  t.teardown(() => core.close(), { force: true })
  for (const make of records) await core.append(make(hex(core.key)))
  core.uploads = 0
  core.on('upload', () => { core.uploads++ })
  return core
}

function certOf (assoc) {
  return (key) => memberCertRecord(createCert({ member: key }, assoc.kp))
}

// The seeder stand-in: role 'seeder' certified by `signer`, replicating
// state.cores and an empty inventory. Unless notices is false it answers
// 'varanda/notices/1' with state.page(target, after, limit, noise); when
// state.pageV2 is a function it also answers 'varanda/notices/2' with it
// (pages recorded in seeder.pagesV2). hang(connectionIndex) -> true leaves
// that connection's pages unanswered. v2Silent: the seeder pairs
// 'varanda/notices/2' but never opens it back (the member's `supported`
// never settles).
async function noticesSeeder (t, { signer, state, notices = true, hang = () => false, v2Silent = false }) {
  const keyPair = crypto.keyPair()
  const cert = createSeederCert({ seeder: hex(keyPair.publicKey) }, signer)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  const seeder = {
    url: 'ws://127.0.0.1:' + wss.address().port + '/seeder',
    connections: 0,
    pages: [],
    pagesV2: [],
    async close () {
      for (const s of wss.clients) s.terminate()
      await new Promise((resolve) => wss.close(() => resolve()))
    }
  }
  t.teardown(() => seeder.close(), { force: true })
  wss.on('connection', (ws) => {
    const noise = new NoiseSecretStream(false, wsStream(ws), { keyPair })
    noise.on('error', noop)
    noise.once('connect', () => {
      const index = seeder.connections++
      Hypercore.createProtocolStream(noise)
      for (const core of state.cores) core.replicate(noise)
      if (notices) {
        attachNotices(noise, {
          role: 'seeder',
          page: ({ target, after, limit }) => {
            seeder.pages.push({ target, after, limit })
            if (hang(index)) return new Promise(noop)
            return state.page(target, after, limit, noise)
          }
        })
      }
      // A pairing that never settles keeps the member's open pending
      // (protomux rejects it once the notify resolves without a channel).
      if (v2Silent) noise.noiseStream.userData.pair({ protocol: NOTICES_V2_PROTOCOL }, () => new Promise(noop))
      if (typeof state.pageV2 === 'function') {
        attachNoticesV2(noise, {
          role: 'seeder',
          page: ({ target, after, limit }) => {
            seeder.pagesV2.push({ target, after, limit })
            if (hang(index)) return new Promise(noop)
            return state.pageV2(target, after, limit, noise)
          }
        })
      }
      attachAdmission(noise, { role: 'seeder', cert, have: [] })
    })
  })
  return seeder
}

// A storage that records every core opened and every kv key written while
// `recording` is set.
function spyStorage () {
  const base = memoryNodeStorage()
  const spy = { recording: false, cores: [], writes: [] }
  const storage = new Proxy(base, {
    get (target, prop) {
      if (prop === 'core') {
        return (name, opts) => {
          if (spy.recording) spy.cores.push(name)
          return target.core(name, opts)
        }
      }
      if (prop === 'writeJson') {
        return (key, value) => {
          if (spy.recording) spy.writes.push(key)
          return target.writeJson(key, value)
        }
      }
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    }
  })
  return { storage, spy }
}

// The web node with its client in memory, identity created (and certified
// when `certify`), the write gate off. `sockets` records every WebSocket.
async function webNode (t, assoc, url, { storage = memoryNodeStorage(), keyPair = crypto.keyPair(), certify = false, notices = {} } = {}) {
  const sockets = []
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', noop)
      sockets.push(ws)
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 200, notices },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair)
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  if (certify) await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, storage, key: publicKey, sockets, internal }
}

function keysOf (r) {
  return r.notices.map((n) => n.key)
}

// The page with every row's `seen` token checked (32 lowercase hex) and
// removed, so the rest of the shape compares exactly.
function withoutSeen (t, r) {
  return {
    ...r,
    notices: r.notices.map(({ seen, ...row }) => {
      t.ok(HEX32.test(seen), 'seen is 32 lowercase hex')
      return row
    })
  }
}

// The token lib/session.js computes: BLAKE2b over a domain tag, the identity
// seed and own + key + seq, first 32 hex.
function seenOf (seed, own, key, seq) {
  const digest = crypto.hash([b4a.from('varanda-notices-seen-v1\n'), seed, b4a.from(own + '\n' + key + ':' + seq)])
  return hex(digest).slice(0, 32)
}

module.exports = {
  HOUR,
  HEX32,
  hex,
  noop,
  association,
  moderator,
  snapshot,
  issuer,
  iso,
  diary,
  certOf,
  noticesSeeder,
  spyStorage,
  webNode,
  keysOf,
  withoutSeen,
  seenOf
}
