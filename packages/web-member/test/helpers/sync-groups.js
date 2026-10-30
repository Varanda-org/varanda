'use strict'

// Shared by sync-groups.test.js and sync-groups-2.test.js (one file ran
// past the runner's per-file limit on slow machines).
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws')
const { tmpDir, localSwarmOptions } = require('./net')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createModeratorCert } = require('@varanda/core/lib/cert')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { runSync } = require('../../lib/sync')
const { memoryNodeStorage } = require('../../lib/node-storage')
const { groupKeyPairFromPrf } = require('../../lib/passkey')
const store = require('../../lib/node-store')
const ops = require('../../lib/member-ops')

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function randomKey () {
  return hex(crypto.keyPair().publicKey)
}

// A browser member with block 0 and a profile; group key pairs derive from
// a random PRF (lib/passkey.js).
async function member (assocKp, name, makeCert = null) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = new Uint8Array(32)
  globalThis.crypto.getRandomValues(prf)
  const ctx = {
    storage,
    association: hex(assocKp.publicKey),
    keyPair,
    groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce)
  }
  await ops.idCreate(ctx)
  const ownHex = hex(keyPair.publicKey)
  await ops.certAdd(ctx, makeCert ? makeCert(ownHex) : createCert({ member: ownHex }, assocKp))
  await ops.profileSet(ctx, { name, bio: '' })
  return { storage, ownHex, ctx }
}

// An in-process seeder with a WebSocket entry handing streams to acceptStream.
async function seederOverWs (t, assocKp, bootstrap, SeederClass = Seeder) {
  const dataDir = tmpDir(t, 'varanda-sg-seed-')
  const association = hex(assocKp.publicKey)
  Seeder.ensureConfig(dataDir, association)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-sg-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assocKp), null, 2) + '\n')
  Seeder.addCert(dataDir, certFile, association)
  const seeder = new SeederClass({ dataDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => wss.once('listening', resolve))
  t.teardown(() => {
    for (const client of wss.clients) client.terminate()
    return new Promise((resolve) => wss.close(() => resolve()))
  }, { force: true })
  wss.on('connection', (ws) => {
    const raw = createWebSocketStream(ws)
    raw.on('error', () => {})
    seeder.acceptStream(raw)
  })
  return { seeder, dataDir, wss, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

function admittedGroups (dataDir) {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'admitted.json'), 'utf8'))
    return file.groups || {}
  } catch {
    return {}
  }
}

// The seeder's writer pages list `key` for `group` (admitted.json is
// written before the core opens; the index follows).
function indexed (seeder, group, key) {
  return seeder.groupWriters({ group, after: null, limit: 64 }).items.some((it) => it.key === key)
}

function sync (m, url, events, opts = {}) {
  return runSync({
    storage: m.storage,
    seederUrl: url,
    createSocket: (u) => new WebSocket(u),
    retryMinMs: 100,
    retryMaxMs: 200,
    mediaPollMs: 50,
    groupsChangedMs: 20,
    onEvent: (ev) => events.push(ev),
    ...opts
  })
}

function once (m, url, events, opts = {}) {
  return sync(m, url, events, { once: true, timeoutMs: 30000, ...opts })
}

function named (events, name) {
  return events.filter((e) => e.event === name)
}

// -> { length, contiguous } of a stored group core, or null.
async function held (m, key) {
  const core = await store.openGroupCoreReadOnly(m.storage, key)
  if (core === null) return null
  try {
    return { length: core.length, contiguous: core.contiguousLength }
  } finally {
    await core.close()
  }
}

async function joinSeq (m, group, writer) {
  const { entries } = await ops.logRead(m.ctx)
  const found = entries.filter((e) => e.record.type === 'group-join' && e.record.group === group && e.record.writer === writer)
  return found[found.length - 1].seq
}

// Every writer page of `group` served from `extra` items merged into the
// seeder's own (sorted by key, GROUPS_LIMIT_MAX per page).
function injectWriters (seeder, group, extra) {
  const real = seeder.groupWriters.bind(seeder)
  const calls = []
  seeder.groupWriters = (q) => {
    if (q.group !== group) return real(q)
    calls.push(q.after)
    const base = real({ group, after: null, limit: 64 })
    const all = [...base.items, ...extra].sort((a, b) => (a.key < b.key ? -1 : 1))
    const rest = all.filter((it) => q.after === null || it.key > q.after)
    const items = rest.slice(0, q.limit)
    const next = rest.length > q.limit ? items[items.length - 1].key : null
    return { items, next, incomplete: false }
  }
  return calls
}

function moderatorSnapshot (assocKp, { seq = 1, blocked = [], revokedIssuers = [] }) {
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assocKp)
  return createSnapshot({ seq, blocked, revokedIssuers }, modKp, modCert)
}

module.exports = { hex, randomKey, member, seederOverWs, admittedGroups, indexed, sync, once, named, held, joinSeq, injectWriters, moderatorSnapshot }
