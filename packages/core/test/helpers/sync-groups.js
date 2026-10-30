'use strict'

// Shared fixtures of the member group sync tests (sync-groups.test.js and
// sync-groups-2.test.js): members, seeders, a fake seeder serving writer
// pages, and the stores they share in process.
const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const { until, localSwarmOptions } = require('./net')
const { tmpDir } = require('./tmp')
const { runSync } = require('../../lib/sync')
const { Seeder } = require('../../lib/seeder')
const { createCert, createSeederCert, createModeratorCert } = require('../../lib/cert')
const { createSnapshot } = require('../../lib/blocklist')
const { attachGroups } = require('../../lib/groups-net')
const { attachBlocklist } = require('../../lib/blocklist-net')
const { createSwarm, joinAndFlush, topicFor, attachAdmission, generateNoiseKeyPair } = require('../../lib/net')
const { writerHeader, groupHeader, groupPost } = require('../../lib/group')
const { memberCertRecord, groupJoinRecord } = require('../../lib/records')
const store = require('../../lib/store')
const member = require('../../lib/member')

const hex = (key) => b4a.toString(key, 'hex')

async function person (t, kp, name) {
  const ctx = { dataDir: tmpDir(t, 'varanda-gsync-'), association: hex(kp.publicKey) }
  const { publicKey } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: publicKey }, kp))
  await member.profileSet(ctx, { name })
  return { ...ctx, key: publicKey }
}

// Copies every core of `from` into `to` in process (no sockets, no DHT).
async function exchange (from, to) {
  const a = await store.openStore(from.dataDir)
  const b = await store.openStore(to.dataDir)
  let left
  let right
  try {
    const copies = []
    for await (const dk of a.list()) {
      const source = a.get({ discoveryKey: dk, writable: false })
      await source.ready()
      const target = b.get({ key: source.key, writable: false })
      await target.ready()
      copies.push({ source, target })
    }
    left = a.replicate(true)
    right = b.replicate(false)
    left.pipe(right).pipe(left)
    for (const { source, target } of copies) {
      for (let seq = 0; seq < source.contiguousLength; seq++) {
        await target.get(seq, { raw: true, timeout: 10000 })
      }
    }
  } finally {
    if (left) left.destroy()
    if (right) right.destroy()
    await b.close()
    await a.close()
  }
}

async function startSeeder (t, bootstrap, kp) {
  const dataDir = tmpDir(t, 'varanda-gseed-')
  Seeder.ensureConfig(dataDir, hex(kp.publicKey))
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-gsc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, kp)))
  Seeder.addCert(dataDir, certFile, hex(kp.publicKey))
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), associationKey: hex(kp.publicKey), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  return seeder
}

async function syncOnce (bootstrap, ctx, opts = {}) {
  const events = []
  const result = await runSync({
    dataDir: ctx.dataDir,
    ...localSwarmOptions(bootstrap),
    once: true,
    timeoutMs: 40000,
    onEvent: (ev) => events.push(ev),
    ...opts
  })
  return { result, events }
}

async function stored (ctx, key) {
  const s = await store.openStore(ctx.dataDir)
  try {
    return await store.replicaStored(s, key)
  } finally {
    await s.close()
  }
}

function ownWriter (ctx, group) {
  return store.readGroups(ctx.dataDir).find((g) => g.group === group).writer
}

const texts = async (ctx, group) => (await member.groupRead(ctx, { group })).items.map((p) => p.text).sort()

// A fake seeder (lib/seeder.js is not used): a verified hello that admits
// nothing and a writer page over `items` (sorted by key), recording each
// request. Its store serves on demand whatever the test puts in it.
// `snapshot()` is the blocklist snapshot it offers; announce() pushes a new
// one to every connected peer.
// `answer(query, n)` replaces the page for the n-th request (0-based).
async function fakeSeeder (t, bootstrap, kp, items, { snapshot = () => null, answer = null } = {}) {
  const noise = generateNoiseKeyPair()
  const cert = createSeederCert({ seeder: hex(noise.publicKey) }, kp)
  const cs = new Corestore(tmpDir(t, 'varanda-gfake-'))
  await cs.ready()
  const swarm = createSwarm({ ...localSwarmOptions(bootstrap), keyPair: noise })
  t.teardown(() => swarm.destroy(), { force: true })
  t.teardown(() => cs.close(), { force: true })
  const requests = []
  const handles = new Set()
  const page = ({ group, after, limit }) => {
    requests.push({ group, after, limit })
    if (answer) return answer({ group, after, limit }, requests.length - 1)
    const rest = items.filter((it) => after === null || it.key > after)
    const out = rest.slice(0, limit)
    return { items: out, next: rest.length > limit ? out[out.length - 1].key : null, incomplete: false }
  }
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    cs.replicate(socket)
    const h = attachBlocklist(socket, {
      current: snapshot,
      offer: async () => ({ adopted: false, reason: 'same', added: new Set(), removed: new Set(), revokedAdded: new Set(), revokedRemoved: new Set() })
    })
    handles.add(h)
    socket.once('close', () => handles.delete(h))
    attachGroups(socket, { role: 'seeder', page })
    attachAdmission(socket, { role: 'seeder', cert, have: [], onmessage: () => {} })
  })
  await joinAndFlush(swarm, [topicFor(hex(kp.publicKey))])
  return { store: cs, swarm, requests, announce: () => { for (const h of handles) h.announce() } }
}

// A diary D (block 0 `cert(key)`, then a join) and its writer W for `group`
// with `posts` posts, in `cs`.
async function diaryAndWriter (cs, group, cert, posts = 0) {
  const d = cs.get({ name: 'diary' })
  await d.ready()
  const dkey = hex(d.key)
  const w = cs.get({ name: 'writer' })
  await w.ready()
  const wkey = hex(w.key)
  await d.append(b4a.from(JSON.stringify(memberCertRecord(cert(dkey)))))
  await d.append(b4a.from(JSON.stringify(groupJoinRecord({ group, writer: wkey, on: true }))))
  await w.append(b4a.from(JSON.stringify(writerHeader({ group, diary: dkey }))))
  for (let i = 0; i < posts; i++) await w.append(b4a.from(JSON.stringify(groupPost({ text: 'p' + i }))))
  return { d, dkey, w, wkey }
}

// Copies the given cores of a bare Corestore into a member's main store.
async function copyInto (cs, ctx, cores) {
  const s = await store.openStore(ctx.dataDir)
  const left = cs.replicate(true)
  const right = s.replicate(false)
  left.pipe(right).pipe(left)
  try {
    for (const source of cores) {
      const target = s.get({ key: source.key, writable: false })
      await target.ready()
      for (let seq = 0; seq < source.length; seq++) await target.get(seq, { raw: true, timeout: 10000 })
      await target.close()
    }
  } finally {
    left.destroy()
    right.destroy()
    await s.close()
  }
}

// A long-running sync stopped once `stopWhen()` holds.
async function runUntil (ctx, bootstrap, stopWhen, opts = {}) {
  const events = []
  const ac = new AbortController()
  const p = runSync({ dataDir: ctx.dataDir, ...localSwarmOptions(bootstrap), signal: ac.signal, onEvent: (ev) => events.push(ev), ...opts })
  await until(() => stopWhen(events), { timeoutMs: 40000, name: 'run condition' })
  ac.abort()
  return { result: await p, events }
}

const hasBlocklist = (ctx) => fs.existsSync(path.join(ctx.dataDir, 'blocklist.json'))

// A member without a certificate (no G2) whose groups.json lists `group`
// with a fresh, empty own writer.
// `group` null makes the writer a root of its own (group = writer); each
// own writer gets `blocks` blocks.
async function groupMember (t, kp, group, { extra = [], blocks = 0 } = {}) {
  const dir = tmpDir(t, 'varanda-gsync-')
  store.writeConfig(dir, { v: 1, role: 'member', association: hex(kp.publicKey) })
  const s = await store.openStore(dir)
  const groups = []
  try {
    await store.openDiary(s)
    for (const g of [group, ...extra]) {
      const nonce = b4a.toString(crypto.randomBytes(16), 'hex')
      const writer = await store.openGroupWriter(s, nonce)
      for (let i = 0; i < blocks; i++) await writer.append({ type: 'x', i })
      groups.push({ group: g === null ? hex(writer.key) : g, writer: hex(writer.key), nonce })
    }
    store.writeGroups(dir, groups)
  } finally {
    await s.close()
  }
  return { dataDir: dir, groups }
}

async function ownLengths (ctx) {
  const s = await store.openStore(ctx.dataDir)
  try {
    const out = []
    for (const g of ctx.groups) out.push((await store.openGroupWriter(s, g.nonce)).length)
    return out
  } finally {
    await s.close()
  }
}

const never = () => new Promise(() => {})

function inBackground (fn) {
  fn().catch(() => {})
}

// A joined root naming `named`, stored without that diary's replica.
async function joinedRoot (t, kp, named) {
  const cs = new Corestore(tmpDir(t, 'varanda-groot-'))
  await cs.ready()
  t.teardown(() => cs.close(), { force: true })
  const root = cs.get({ name: 'root' })
  await root.ready()
  const rkey = hex(root.key)
  await root.append(b4a.from(JSON.stringify(groupHeader({ diary: named, name: 'Comunidade', join: 'open' }))))
  const m = await groupMember(t, kp, rkey)
  await copyInto(cs, m, [root])
  return { m, rkey }
}

function blockDiary (m, kp, key) {
  const mod = crypto.keyPair()
  store.writeBlocklist(m.dataDir, createSnapshot({ seq: 1, blocked: [key] }, mod, createModeratorCert({ moderator: hex(mod.publicKey) }, kp)))
}

const readCerts = (ctx) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'group-certs.json'), 'utf8'))
  } catch {
    return null
  }
}

function revokeIssuer (m, kp, issuerHex) {
  const mod = crypto.keyPair()
  store.writeBlocklist(m.dataDir, createSnapshot({ seq: 1, revokedIssuers: [issuerHex] }, mod, createModeratorCert({ moderator: hex(mod.publicKey) }, kp)))
}

module.exports = {
  hex,
  person,
  exchange,
  startSeeder,
  syncOnce,
  stored,
  ownWriter,
  texts,
  fakeSeeder,
  diaryAndWriter,
  copyInto,
  runUntil,
  hasBlocklist,
  groupMember,
  ownLengths,
  never,
  inBackground,
  joinedRoot,
  blockDiary,
  readCerts,
  revokeIssuer
}
