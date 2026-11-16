'use strict'

// Eventos on the browser node (docs/rpc.md): post.create with an event, the
// RSVP of a diary event through choice.set (pick 0 'vou', 1 'talvez'),
// group.post with an event, group.choose and group.voters on it and
// group.events, through lib/session.js and an in-memory client on memory
// storage. The core node refuses every event param and group.events.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket, WebSocketServer, createWebSocketStream } = require('ws')
const { testnet, tmpDir, localSwarmOptions } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createSession } = require('@varanda/core/lib/session')
const { validateRecord, postRecord, POST_EVENT_KEYS } = require('@varanda/core/lib/records')
const { pickCount, EVENT_PICKS } = require('@varanda/core/lib/polls')
const { memoryNodeStorage } = require('../lib/node-storage')
const { createBrowserNode } = require('../lib/node')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { groupKeyPairFromPrf } = require('../lib/passkey')
const ops = require('../lib/member-ops')
const store = require('../lib/node-store')

const KEY = 'ab'.repeat(32)
const AT = '2026-01-01T00:00:00.000Z'
const EVENT = { title: 'Mutirão na horta', start: '2027-03-06T12:00:00.000Z', end: '2027-03-06T15:00:00.000Z', place: 'Praça' }
const OPEN_EVENT = { title: 'Feira', start: '2027-04-01T10:00:00.000Z', end: null, place: '' }
const WEB_ONLY = 'leitura sob demanda só na versão web'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function errorPair (p) {
  const err = await errorOf(p)
  return [err && err.code, err && err.message]
}

async function entries (web) {
  return (await web.request('log.read', {})).entries
}

function typesOf (log) {
  return log.map((e) => e.record.type)
}

// A certified browser node; without seederUrl every peek fails.
async function certified (t, { seederUrl = null, kp = generateAssociationKeyPair(), peekTimeoutMs = 300 } = {}) {
  await testnet(t)
  const internal = []
  const node = createBrowserNode({
    storage: memoryNodeStorage(),
    association: hex(kp.publicKey),
    seederUrl: seederUrl || 'ws://127.0.0.1:' + (await deadPort()) + '/seeder',
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false,
    peekTimeoutMs
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair(), { prf: crypto.randomBytes(32) })
  const web = await connectClient(node, { timeoutMs: 30000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, kp) })
  return { web, key: publicKey, internal }
}

test('pickCount: a poll counts its options, an event post two, anything else none', (t) => {
  t.is(EVENT_PICKS, 2)
  t.is(pickCount(postRecord({ text: 'Qual dia?', poll: ['a', 'b', 'c'], at: AT })), 3)
  t.is(pickCount(postRecord({ text: 'Vem?', event: EVENT, at: AT })), 2)
  t.is(pickCount(postRecord({ text: 'Vem?', event: OPEN_EVENT, at: AT })), 2)
  t.is(pickCount(postRecord({ text: 'oi', at: AT })), null, 'a plain post')
  t.is(pickCount({ type: 'post', text: 'Vem?', at: AT, replyTo: null, event: { ...EVENT, end: EVENT.start } }), null, 'an invalid event')
  t.is(pickCount({ type: 'post', text: 'Vem?', at: AT, replyTo: { author: KEY, seq: 1 }, event: EVENT }), null, 'a reply carries no event')
  for (const bad of [null, undefined, 5, 'post', []]) t.is(pickCount(bad), null, String(bad))
})

test('post.create with an event writes the event key set; the dispatcher refuses an event with a poll, media or a preview', async (t) => {
  const { web, key, internal } = await certified(t)
  t.alike(await web.request('post.create', { text: 'Vem pro mutirão', event: EVENT }), { seq: 1, ref: key + ':1' })
  t.alike(await web.request('post.create', { text: 'Feira', event: OPEN_EVENT }), { seq: 2, ref: key + ':2' })
  const log = await entries(web)
  t.alike(log[1].record.event, EVENT)
  t.alike(Object.keys(log[1].record).sort(), POST_EVENT_KEYS.slice().sort())
  t.alike(log[2].record.event, OPEN_EVENT)
  for (const e of log.slice(1)) t.is(validateRecord(e.record, e.seq), null, 'valid at its seq')
  t.is((await errorPair(web.request('post.create', { text: 'x', event: EVENT, poll: ['a', 'b'] })))[0], 'USAGE')
  t.is((await errorPair(web.request('post.create', { text: 'x', event: { ...EVENT, end: EVENT.start } })))[0], 'USAGE')
  t.is((await errorPair(web.request('post.create', { text: 'x', event: { ...EVENT, extra: 1 } })))[0], 'USAGE')
  t.alike(typesOf(await entries(web)), ['member-cert', 'post', 'post'], 'nothing more written')
  t.alike(internal, [])
})

test('post.create in member-ops refuses an event beside a poll or a preview, nothing written', async (t) => {
  const storage = memoryNodeStorage()
  const assoc = generateAssociationKeyPair()
  const keyPair = crypto.keyPair()
  const ctx = { storage, association: hex(assoc.publicKey), keyPair }
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: hex(keyPair.publicKey) }, assoc))
  await t.exception(() => ops.postCreate(ctx, { text: 'x', event: EVENT, poll: ['a', 'b'] }), /parâmetro inválido: event/)
  await t.exception(() => ops.postCreate(ctx, { text: 'x', event: EVENT, preview: { url: 'https://example.com/', title: 'a', description: '', image: null } }), /parâmetro inválido: event/)
  const diary = await store.openDiary(storage)
  try { t.is(diary.length, 1, 'only the certificate') } finally { await diary.close() }
})

// The seeder in this process with a WebSocket entry (as polls.test.js).
async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-events-seed-')
  const assocHex = hex(assoc.publicKey)
  Seeder.ensureConfig(dataDir, assocHex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-events-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc)))
  Seeder.addCert(dataDir, certFile, assocHex)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: () => {} })
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
  return { publicKey, url: 'ws://127.0.0.1:' + wss.address().port + '/seeder' }
}

async function served (t, { assoc, seederUrl, seederKey, records }) {
  const m = await createMember({ storage: memoryStorage(), association: hex(assoc.publicKey) })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc))
  for (const record of records) await m.core.append(record)
  const link = connectSeeder({ member: m, socket: new WebSocket(seederUrl), association: hex(assoc.publicKey), seederPublicKey: seederKey, timeoutMs: 30000 })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await link.waitServed(m.core.length)
  link.close()
  return m
}

test('choice.set on a diary event post: an RSVP of 0 or 1 goes through, pick 2 is refused', async (t) => {
  t.timeout(180000)
  const { bootstrap } = await testnet(t)
  const assoc = generateAssociationKeyPair()
  const { url, publicKey: seederKey } = await seederStack(t, bootstrap, assoc)
  const author = await served(t, {
    assoc,
    seederUrl: url,
    seederKey,
    records: [postRecord({ text: 'Vem pro mutirão', event: EVENT }), postRecord({ text: 'oi' })]
  })
  const { web, internal } = await certified(t, { seederUrl: url, kp: assoc, peekTimeoutMs: 8000 })
  await web.request('sync.start', {})

  t.alike(await errorPair(web.request('choice.set', { to: author.key + ':1', pick: 2 })), ['USAGE', 'opção inválida'], 'an event takes picks 0 and 1 only')
  t.alike(await errorPair(web.request('choice.set', { to: author.key + ':2', pick: 0 })), ['USAGE', 'a publicação não é uma enquete'])
  t.alike(typesOf(await entries(web)), ['member-cert'], 'nothing written for a refusal')

  t.alike(await web.request('choice.set', { to: author.key + ':1', pick: 1 }), { seq: 1 })
  t.alike(await web.request('choice.mine', { to: author.key + ':1' }), { pick: 1, seq: 1 })
  t.alike(await web.request('choice.set', { to: author.key + ':1', pick: 0 }), { seq: 2 })
  t.alike(await web.request('choice.mine', { to: author.key + ':1' }), { pick: 0, seq: 2 }, 'the last RSVP wins')
  t.alike(await web.request('choice.set', { to: author.key + ':1', pick: null }), { seq: 3 })
  t.alike(await web.request('choice.mine', { to: author.key + ':1' }), { pick: null, seq: null }, 'withdrawn')
  t.alike(internal, [])
})

// ---- group events (as session-groups.test.js) ----

async function setup (t, { assoc = generateAssociationKeyPair() } = {}) {
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const prf = crypto.randomBytes(32)
  const association = hex(assoc.publicKey)
  const ctx = { storage, association, keyPair, groupKeyPair: (nonce) => groupKeyPairFromPrf(prf, nonce) }
  const key = hex(keyPair.publicKey)
  await ops.idCreate(ctx)
  await ops.certAdd(ctx, createCert({ member: key }, assoc))
  const internal = []
  const node = createBrowserNode({
    storage,
    association,
    seederUrl: 'ws://127.0.0.1:9/seeder',
    createSocket: () => { throw new Error('unexpected socket') },
    writeGate: false,
    onInternalError: (err) => internal.push(err)
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(keyPair, { prf })
  const web = await connectClient(node)
  return { node, web, ctx, key, assoc, storage, internal }
}

async function share (from, to, group) {
  for (const key of [from.key, group]) {
    const diary = key === from.key
    const source = diary ? await store.openDiary(from.storage) : await store.openGroupCoreReadOnly(from.storage, key)
    const target = diary ? await store.openReplica(to.storage, key) : await store.openGroupReplica(to.storage, key)
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
  await store.addGroupDiary(to.storage, from.key)
  await store.addGroupReplica(to.storage, group)
}

async function groupLength (s, group) {
  const core = await store.openGroupCoreReadOnly(s.storage, group)
  try { return core.length } finally { await core.close() }
}

async function groupRecords (s, group) {
  const core = await store.openGroupCoreReadOnly(s.storage, group)
  try {
    const out = []
    for (let i = 0; i < core.length; i++) out.push(JSON.parse(b4a.toString(await core.get(i))))
    return out
  } finally {
    await core.close()
  }
}

test('group events: a post and its group-event in one append, RSVPs, voters, the events page and a hidden root', async (t) => {
  const a = await setup(t)
  const b = await setup(t, { assoc: a.assoc })
  const { community: C, group: general } = await a.web.request('community.create', { name: 'Bairro', join: 'open' })
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'open', community: C })
  t.alike(await a.web.request('group.post', { group, text: 'Mutirão de sábado', event: EVENT }), { seq: 1 })
  t.is(await groupLength(a, group), 3, 'root, the post and its group-event')
  const records = await groupRecords(a, group)
  t.is(records[2].type, 'group-event')
  t.alike(records[2].target, { writer: group, seq: 1 })
  t.alike([records[2].title, records[2].start, records[2].end, records[2].place], [EVENT.title, EVENT.start, EVENT.end, EVENT.place])
  t.alike(await a.web.request('group.post', { group, text: 'Feira', topic: true, event: OPEN_EVENT }), { seq: 3 })
  t.is(await groupLength(a, group), 6, 'a topic with an event: the post, its group-topic and its group-event')
  t.alike(await a.web.request('group.post', { group, text: 'oi' }), { seq: 6 })
  const root = { writer: group, seq: 1 }

  await share(a, b, C)
  await share(a, b, general)
  await share(a, b, group)
  t.alike(await b.web.request('community.join', { community: C }), { state: 'member', group: general })
  t.alike(await b.web.request('group.join', { group }), { state: 'member' })
  t.alike(await b.web.request('group.choose', { group, target: root, pick: 1 }), { ok: true })
  const bWriter = (await store.readGroupWriters(b.storage)).find((e) => e.group === group).key
  const voted = await groupLength(b, bWriter)
  t.alike(await b.web.request('group.choose', { group, target: root, pick: 1 }), { ok: true }, 'the same RSVP again')
  t.is(await groupLength(b, bWriter), voted, 'writes nothing')
  t.alike((await errorOf(b.web.request('group.choose', { group, target: root, pick: 2 }))).message, 'opção inválida', 'an event takes picks 0 and 1 only')
  t.alike((await errorOf(b.web.request('group.choose', { group, target: { writer: group, seq: 6 }, pick: 0 }))).message, 'enquete não encontrada', 'a plain post takes no RSVP')
  t.alike(await b.web.request('group.voters', { group, target: root }), { voters: [{ pick: 0, count: 0, by: [] }, { pick: 1, count: 1, by: [b.key] }] })

  const page = await b.web.request('group.events', { group })
  t.alike(page.next, null)
  t.is(typeof page.incomplete, 'boolean')
  t.alike(page.items.map((x) => [x.writer, x.seq, x.text, x.event, x.totals, x.mine, x.hidden]), [
    [group, 3, 'Feira', OPEN_EVENT, [0, 0], null, false],
    [group, 1, 'Mutirão de sábado', EVENT, [0, 1], 1, false]
  ])
  t.alike(Object.keys(page.items[0]).sort(), ['at', 'diary', 'event', 'hidden', 'mine', 'name', 'seq', 'text', 'totals', 'username', 'writer'])
  t.is(page.items[0].diary, a.key)
  const older = await b.web.request('group.events', { group, cursor: { at: page.items[0].at, writer: group, seq: 3 } })
  t.alike(older.items.map((x) => x.seq), [1], 'the cursor is exclusive')

  const read = await b.web.request('group.read', { group })
  t.ok(read.items.every((p) => !('event' in p)), 'group.read carries no event')
  const topics = await b.web.request('group.topics', { group })
  t.alike(topics.items.map((x) => x.seq), [3], 'the topic with an event is a topic')
  t.alike(await b.web.request('group.choose', { group, target: { writer: group, seq: 3 }, pick: 0 }), { ok: true })
  const topicRead = await b.web.request('group.read', { group, topic: { writer: group, seq: 3 } })
  t.alike(topicRead.event, { writer: group, seq: 3, title: OPEN_EVENT.title, start: OPEN_EVENT.start, end: OPEN_EVENT.end, place: OPEN_EVENT.place, totals: [1, 0], mine: 0 }, 'a topic read carries the root event without the voter lists')
  t.is(topicRead.poll, null)

  t.alike(await a.web.request('group.hide', { group, target: root, on: true }), { ok: true })
  await share(a, b, group)
  const hidden = (await b.web.request('group.events', { group })).items.find((x) => x.seq === 1)
  t.alike([hidden.text, hidden.event, hidden.totals, hidden.mine, hidden.hidden], ['', null, [0, 0], null, true], 'a hidden root keeps its place, blanked')
  t.alike((await errorOf(b.web.request('group.choose', { group, target: root, pick: 0 }))).message, 'mensagem não encontrada')
  t.alike(a.internal, [])
  t.alike(b.internal, [])
})

test('group events: refused in a private group and beside a reply, nothing written', async (t) => {
  const a = await setup(t)
  const { community: C } = await a.web.request('community.create', { name: 'Bairro', join: 'open' })
  const { group: priv } = await a.web.request('group.create', { name: 'Conselho', join: 'approval', visibility: 'private', community: C })
  const before = await groupLength(a, priv)
  t.alike((await errorOf(a.web.request('group.post', { group: priv, text: 'Reunião', event: EVENT }))).message, 'eventos só em grupo público')
  t.is(await groupLength(a, priv), before, 'nothing written')
  t.alike((await errorOf(a.web.request('group.events', { group: priv }))).message, 'eventos só em grupo público')
  const { group } = await a.web.request('group.create', { name: 'Horta', join: 'open', community: C })
  t.alike(await a.web.request('group.post', { group, text: 'oi' }), { seq: 1 })
  t.is((await errorOf(a.web.request('group.post', { group, text: 'Vem', replyTo: { writer: group, seq: 1 }, event: EVENT }))).code, 'USAGE')
  t.is((await errorOf(a.web.request('group.post', { group, text: 'Vem', topic: true, poll: ['a', 'b'], event: EVENT }))).code, 'USAGE')
  await t.exception(() => ops.groupPost(a.ctx, { group, text: 'Vem', replyTo: { writer: group, seq: 1 }, event: EVENT }), /parâmetro inválido: event/)
  t.is(await groupLength(a, group), 2, 'nothing written')
  t.alike(await a.web.request('group.events', { group }), { items: [], next: null, incomplete: false })
})

test('core node: event params and group.events are browser-node only', async (t) => {
  const core = createSession({ dataDir: tmpDir(t), association: KEY, bootstrap: ['127.0.0.1:1'] })
  t.teardown(() => core.close(), { force: true })
  await t.exception(() => core.handlers['group.events']({ group: KEY }), new RegExp(WEB_ONLY))
  await t.exception(() => core.handlers['post.create']({ text: 'Vem', event: EVENT }), new RegExp(WEB_ONLY))
  await t.exception(() => core.handlers['group.post']({ group: KEY, text: 'Vem', event: EVENT }), new RegExp(WEB_ONLY))
})
