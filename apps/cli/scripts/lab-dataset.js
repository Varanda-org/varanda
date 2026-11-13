'use strict'

// The hosted lab's dataset (hosted-lab.js --dataset): runs a plan from
// ../lib/lab-dataset-plan.js against the lab's seeder. Every member is a
// browser node session (packages/web-member, memory storage, as
// packages/web-member/test/e2e-media.test.js drives it) with a fresh key
// pair, a v2 certificate and a username record from the lab issuer, so the
// seeder's gate admits the diary. Photos are real media cores pushed by the
// member's own sync, since the seeder's /media is read only.
// The signed-in reader's key lives in the browser (passkey PRF), so nothing
// here writes the reader's diary: <root>/reader-setup.js is pasted into the
// dev page's console and follows the dataset through __varandaDev.
// Secret keys stay in memory; only public keys reach disk or the log.

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const zlib = require('node:zlib')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { createClient, parseMessage, EVENTS, MAX_MESSAGE } = require('@varanda/rpc')
const { createIssuedCert, createUsernameRecord } = require('@varanda/core/lib/cert')
const { createBrowserNode } = require('@varanda/web-member/lib/node')
const { memoryNodeStorage } = require('@varanda/web-member/lib/node-storage')
const { makeRandom } = require('../lib/lab-dataset-plan')

const CONCURRENCY = 4
const SYNC_TIMEOUT_MS = 60000
const HELD_TIMEOUT_MS = 120000
const RAJADA_MEMBERS = 5
const PUSH_ATTEMPTS = 8

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The in-memory client side of a node, wired as apps/app wires the browser
// one (JSON text both ways on a microtask), with the events recorded.
async function connect (node) {
  const events = []
  let port = null
  const client = createClient({
    send: (message, text) => queueMicrotask(() => { if (port !== null) port.receive(text) }),
    timeoutMs: SYNC_TIMEOUT_MS
  })
  port = node.connect((text) => queueMicrotask(() => {
    const parsed = parseMessage(text, MAX_MESSAGE)
    if (parsed.ok) client.receive(parsed.value)
  }), { onClose: () => client.close() })
  for (const name of EVENTS) client.on(name, (data) => events.push({ name, data }))
  await client.request('session.open', {})
  return { events, request: (method, params = {}) => client.request(method, params) }
}

async function syncOnce (web) {
  const { runId } = await web.request('sync.start', { once: true, timeoutMs: SYNC_TIMEOUT_MS })
  const deadline = Date.now() + SYNC_TIMEOUT_MS + 10000
  while (Date.now() < deadline) {
    const ev = web.events.find((e) => e.name === 'sync.stopped' && e.data.runId === runId)
    if (ev) return ev.data
    await sleep(50)
  }
  throw new Error('tempo esgotado na sincronização')
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

// A real RGB PNG: a gradient with noise from `seed`, so it decodes in the
// app and weighs about what a small phone thumbnail does (tens of KiB).
function photoPng ({ seed, width, height }) {
  const rnd = makeRandom(seed)
  const base = [rnd.int(256), rnd.int(256), rnd.int(256)]
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let o = 0
  for (let y = 0; y < height; y++) {
    raw[o++] = 0
    for (let x = 0; x < width; x++) {
      for (let ch = 0; ch < 3; ch++) raw[o++] = (base[ch] + ((x + y) * (ch + 1)) / 2 + rnd.int(48)) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// HEAD of a /media range through the lab origin (the same route the app
// reads photos from) -> the status code.
function mediaStatus (origin, diary, d) {
  const url = new URL(origin)
  return new Promise((resolve) => {
    const req = http.request({
      // The lab binds the host it was given; with localhost that can be ::1.
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 80),
      method: 'HEAD',
      path: '/media/' + diary + '/' + d.core + '/' + d.start + '/' + d.blocks,
      headers: { host: url.host },
      agent: false
    }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', () => resolve(0))
    req.end()
  })
}

function openNode ({ association, seederWsUrl, internal }) {
  return createBrowserNode({
    storage: memoryNodeStorage(),
    association,
    seederUrl: seederWsUrl,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false
  })
}

// Syncs until a run ends well and the seeder holds the first `length`
// blocks of the diary contiguously (heldLength, when the lab passes it:
// a core's length grows before its blocks arrive), then until every photo
// is served over /media. Throws after PUSH_ATTEMPTS failed runs: the
// memory node is the only copy, so a partial push must never pass.
async function pushUntilHeld ({ web, key, length, photos, origin, heldLength }) {
  const deadline = Date.now() + HELD_TIMEOUT_MS
  for (let attempt = 1; ; attempt++) {
    const stopped = await syncOnce(web)
    const ok = stopped.reason === 'done' && stopped.result && stopped.result.ok === true && stopped.result.seederConfirmed === true
    const held = heldLength === null ? (ok ? length : 0) : heldLength(key)
    if (ok && held >= length) break
    if (attempt >= PUSH_ATTEMPTS || Date.now() > deadline) {
      throw new Error('o semeador não recebeu o diário inteiro (' + held + ' de ' + length + ' blocos, ' + attempt + ' tentativas)')
    }
    await sleep(250)
  }
  // The seeder answers /media under a token bucket (seed-ws.js MEDIA_RATE),
  // so each photo is asked until it answers once and never again.
  const pendingPhotos = new Set(photos)
  const served = async () => {
    for (const d of [...pendingPhotos]) {
      if (await mediaStatus(origin, key, d) === 200) pendingPhotos.delete(d)
    }
    return pendingPhotos.size === 0
  }
  if (await served()) return
  // A once run ends as soon as the diary is confirmed, before the seeder
  // has pulled the media core; a continuous run stays connected while it does.
  await web.request('sync.start', {})
  // Its own budget: the seeder pulls every photo core after the diary, and
  // a diary with dozens of photos needs more than the push deadline left.
  const mediaDeadline = Date.now() + 60000 + 3000 * photos.length
  try {
    while (Date.now() < mediaDeadline) {
      if (await served()) return
      await sleep(1000)
    }
  } finally {
    await web.request('sync.stop').catch(() => {})
  }
  throw new Error('o semeador não recebeu as fotos a tempo')
}

async function ownLength (web) {
  const { entries } = await web.request('log.read', { limit: 1 })
  return entries.length === 0 ? 0 : Math.max(...entries.map((e) => e.seq)) + 1
}

// runDataset({ seederWsUrl, origin, association, issuer, plan, root, log,
// heldLength, concurrency, keep }) -> { members, communities, followsFile,
// setupFile, ms, startRajada, close }. issuer is { keyPair, cert } (the
// lab's loadIssuer); heldLength(key), optional, is how many leading blocks
// of a diary the seeder holds. The first `keep` member sessions stay open for
// startRajada; close() ends them. exposeClients: true also returns them as
// `clients` ([{ index, key, node, web }], in member order), for a harness
// that drives them itself; they stay owned by close().
async function runDataset ({ seederWsUrl, origin, association, issuer, plan, root, log = () => {}, heldLength = null, concurrency = CONCURRENCY, keep = RAJADA_MEMBERS, exposeClients = false }) {
  if (!issuer || !issuer.keyPair || !issuer.cert) throw new TypeError('issuer must be { keyPair, cert }')
  const started = Date.now()
  fs.mkdirSync(root, { recursive: true })
  // Every key pair up front: an action names its target by `<key>:<seq>`
  // even when the target's author has not written it yet.
  // prf stands in for the passkey PRF output that derives group keys.
  const pairs = plan.members.map(() => ({ id: crypto.keyPair(), media: crypto.keyPair(), prf: crypto.randomBytes(32) }))
  const keys = pairs.map((p) => hex(p.id.publicKey))
  const kept = new Map()
  const internal = []
  const done = []
  const lengths = plan.members.map((m) => m.blocks)
  const communities = []

  async function runMember (m) {
    const member = plan.members[m]
    const key = keys[m]
    const node = openNode({ association, seederWsUrl, internal })
    let keepOpen = false
    try {
      await node.setKeyPair(pairs[m].id, { media: pairs[m].media, prf: pairs[m].prf })
      const web = await connect(node)
      const created = await web.request('identity.create')
      if (created.publicKey !== key) throw new Error('chave inesperada do diário')
      const date = new Date().toISOString()
      await web.request('cert.add', { cert: createIssuedCert({ member: key, date }, issuer.keyPair, issuer.cert) })
      await web.request('username.add', { record: createUsernameRecord({ member: key, username: member.username, date }, issuer.keyPair, issuer.cert) })
      await web.request('profile.set', { name: member.name, bio: member.bio })
      const photos = []
      for (const a of member.actions) {
        const to = a.target ? keys[a.target.member] + ':' + a.target.seq : null
        let r
        if (a.kind === 'post') r = await web.request('post.create', { text: a.text })
        else if (a.kind === 'photo') {
          const descriptor = await node.mediaUpload({ bytes: photoPng(a.photo), mime: 'image/png', width: a.photo.width, height: a.photo.height })
          photos.push(descriptor)
          r = await web.request('post.create', { text: a.text, media: [descriptor] })
        } else if (a.kind === 'reply') r = await web.request('post.reply', { to, text: a.text })
        else if (a.kind === 'quote') r = await web.request('post.quote', { to, text: a.text })
        else if (a.kind === 'repost') r = await web.request('repost.set', { to, on: true })
        else r = await web.request('like.set', { to, on: true })
        if (r.seq !== a.seq) throw new Error(member.username + ': seq ' + r.seq + ' no lugar de ' + a.seq + ' (' + a.kind + ')')
      }
      // One creator may make several communities (a one-member dataset).
      for (const planned of plan.communities.filter((c) => c.creator === m)) {
        try {
          const c = await web.request('community.create', { name: planned.name, join: 'open' })
          communities.push({ index: planned.index, name: planned.name, community: c.community, general: c.group, joined: [] })
          // Only this device holds the creator's writer core, so its posts go here.
          for (const p of planned.posts.filter((x) => x.member === m)) await web.request('group.post', { group: c.group, text: p.text })
        } catch (err) {
          log('comunidade "' + planned.name + '" não criada: ' + err.message)
        }
      }
      const length = await ownLength(web)
      lengths[m] = length
      await pushUntilHeld({ web, key, length, photos, origin, heldLength })
      done.push(m)
      log('diário ' + done.length + '/' + plan.members.length + ' pronto: @' + member.username + ', ' + length + ' blocos, ' + member.actions.filter((a) => a.kind === 'photo').length + ' fotos')
      if (kept.size < keep && m < keep) {
        kept.set(m, { node, web })
        keepOpen = true
      }
    } finally {
      if (!keepOpen) await node.close().catch(() => {})
    }
  }

  async function pool (items, fn) {
    let next = 0
    const workers = []
    let failure = null
    for (let w = 0; w < Math.min(concurrency, items.length); w++) {
      workers.push((async () => {
        while (failure === null && next < items.length) {
          const item = items[next++]
          try {
            await fn(item)
          } catch (err) {
            failure = failure || err
          }
        }
      })())
    }
    await Promise.all(workers)
    if (failure !== null) throw failure
  }

  try {
    await pool(plan.members.map((m) => m.index), runMember)
    if (communities.length > 0) await joinCommunities()
  } catch (err) {
    await closeKept()
    throw err
  }

  // A member already done on another device: a fresh session recovers its
  // diary from the seeder before joining, as a second device would. All of
  // one member's joins run in one task, so two sessions never write the same
  // diary at once, and nothing is written before the recovered diary has the
  // length the seeder holds (a shorter one would fork it).
  async function joinCommunities () {
    const byMember = new Map()
    for (const c of communities) {
      const planned = plan.communities[c.index]
      for (const m of planned.members) {
        if (!byMember.has(m)) byMember.set(m, [])
        byMember.get(m).push({ c, planned })
      }
    }
    await pool([...byMember.entries()], async ([m, joins]) => {
      const username = plan.members[m].username
      const reuse = kept.get(m)
      const node = reuse ? reuse.node : openNode({ association, seederWsUrl, internal })
      try {
        let web = reuse ? reuse.web : null
        if (web === null) {
          await node.setKeyPair(pairs[m].id, { media: crypto.keyPair(), prf: pairs[m].prf })
          web = await connect(node)
          await web.request('identity.create')
          for (let attempt = 1; await ownLength(web) < lengths[m]; attempt++) {
            if (attempt > PUSH_ATTEMPTS) throw new Error('diário não recuperado do semeador')
            await syncOnce(web)
          }
        }
        for (const { c, planned } of joins) {
          let r = await web.request('community.join', { community: c.community })
          if (r.state === 'pending') {
            await syncOnce(web)
            r = await web.request('community.join', { community: c.community })
          }
          if (r.state !== 'member') {
            log('@' + username + ' não entrou em "' + c.name + '" (' + r.state + ')')
            continue
          }
          c.joined.push(m)
          for (const p of planned.posts.filter((x) => x.member === m)) await web.request('group.post', { group: c.general, text: p.text })
        }
        lengths[m] = await ownLength(web)
        await pushUntilHeld({ web, key: keys[m], length: lengths[m], photos: [], origin, heldLength })
      } catch (err) {
        log('@' + username + ' nas comunidades: ' + err.message)
      } finally {
        if (!reuse) await node.close().catch(() => {})
      }
    })
    for (const c of communities) log('comunidade "' + c.name + '": ' + (c.joined.length + 1) + ' membros')
  }

  if (internal.length > 0) log(internal.length + ' erros internos dos nós (primeiro: ' + internal[0].message + ')')

  const followsFile = path.join(root, 'reader-follows.json')
  const setupFile = path.join(root, 'reader-setup.js')
  fs.writeFileSync(followsFile, JSON.stringify(keys, null, 2) + '\n')
  fs.writeFileSync(setupFile, readerSetup({ seed: plan.seed, keys, communities: communities.map((c) => c.community) }))

  async function closeKept () {
    for (const { node } of kept.values()) await node.close().catch(() => {})
    kept.clear()
  }

  // One post per intervalMs on the kept sessions, in turn, each on a
  // continuous sync run, until the returned stop() is called.
  async function startRajada ({ intervalMs = 1000, onPost = () => {} } = {}) {
    const sessions = [...kept.entries()].map(([m, s]) => ({ m, ...s }))
    if (sessions.length === 0) throw new Error('nenhuma sessão aberta para a rajada')
    for (const s of sessions) await s.web.request('sync.start', {})
    const rnd = makeRandom(plan.seed + ':rajada')
    let n = 0
    let stopped = false
    let pending = Promise.resolve()
    const timer = setInterval(() => {
      if (stopped) return
      const s = sessions[n % sessions.length]
      const i = ++n
      pending = pending.then(async () => {
        if (stopped) return
        const r = await s.web.request('post.create', { text: 'Rajada ' + i + ': ' + rnd.pick(['agora', 'olha', 'de novo', 'mais um']) })
        onPost({ n: i, username: plan.members[s.m].username, key: keys[s.m], seq: r.seq })
      }).catch((err) => log('rajada: ' + err.message))
    }, intervalMs)
    return async function stop () {
      stopped = true
      clearInterval(timer)
      await pending
      for (const s of sessions) await s.web.request('sync.stop').catch(() => {})
      return n
    }
  }

  const result = {
    members: plan.members.map((m) => ({ index: m.index, key: keys[m.index], username: m.username, blocks: m.blocks })),
    communities: communities.map((c) => ({ name: c.name, community: c.community, general: c.general, members: c.joined.length + 1 })),
    followsFile,
    setupFile,
    ms: Date.now() - started,
    startRajada,
    close: closeKept
  }
  if (exposeClients === true) {
    result.clients = [...kept.entries()].sort((a, b) => a[0] - b[0]).map(([m, s]) => ({ index: m, key: keys[m], node: s.node, web: s.web }))
  }
  return result
}

// The console snippet for the signed-in dev page (EXPO_PUBLIC_VARANDA_PERF=1
// exposes __varandaDev). Public keys only.
function readerSetup ({ seed, keys, communities }) {
  return [
    '// Conjunto de dados do laboratório (semente ' + JSON.stringify(seed) + ').',
    '// Cole no console da página do app já com a conta aberta (build de desenvolvimento',
    '// com EXPO_PUBLIC_VARANDA_PERF=1). Segue os diários do conjunto, entra nas comunidades',
    '// e, se OWN_POSTS for maior que zero, publica essa quantidade de posts seus.',
    '(async () => {',
    '  const OWN_POSTS = 0',
    '  const KEYS = ' + JSON.stringify(keys),
    '  const COMMUNITIES = ' + JSON.stringify(communities),
    '  const dev = globalThis.__varandaDev',
    '  if (!dev || typeof dev.request !== \'function\') {',
    '    console.error(\'__varandaDev ausente: use o build de desenvolvimento com EXPO_PUBLIC_VARANDA_PERF=1\')',
    '    return',
    '  }',
    '  const t0 = performance.now()',
    '  let followed = 0',
    '  for (const key of KEYS) {',
    '    const r = await dev.request(\'follow.add\', { key })',
    '    if (r && r.changed) followed++',
    '  }',
    '  for (const community of COMMUNITIES) {',
    '    try { await dev.request(\'community.join\', { community }) } catch (err) { console.warn(\'comunidade\', community.slice(0, 8), err.message) }',
    '  }',
    '  for (let i = 1; i <= OWN_POSTS; i++) await dev.request(\'post.create\', { text: \'Post do leitor \' + i })',
    '  console.log(\'seguindo \' + followed + \' novos diários de \' + KEYS.length + \' em \' + Math.round(performance.now() - t0) + \' ms\')',
    '})()',
    ''
  ].join('\n')
}

module.exports = { runDataset, readerSetup, photoPng }
