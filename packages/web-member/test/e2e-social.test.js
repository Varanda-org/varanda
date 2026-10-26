// End to end, loopback only: threads, likes, reposts, quotes and profiles
// across Hypercore 10 members (A, B, C, D: memory storage, linked to the
// seeder over its WebSocket entry, records appended as built), a viewer V
// (the browser node session: memory storage, the RPC client wired in
// memory, a running continuous sync), a REAL in-process Seeder (Hypercore
// 11) with startSeedWs serving the WebSocket entry and the /index routes,
// and a CLI member (the varanda binary) on the local DHT.
// 1. Thread completeness: more than 60 replies to A's post P from B, C and
//    D, a quote by B, a repost by C, likes by B and C (C undoes and likes
//    again). /index/post is paged with its cursor (each reply exactly once,
//    in (at, author, seq) order; counts equal a reducer over the diaries);
//    V peeks A, B, D (not followed) and C (followed, read locally) per
//    planPeeks and assembleThread (apps/app/src/thread.js) rebuilds the
//    thread with names and verified usernames; no replica for A, B or D.
// 2. Feed: C's repost item in V's feed; V's like (engagement.read, an
//    idempotent like.set) reaches the seeder's counts.
// 3. Profile: /index/member of B, peeked into B's profile page.
// 6. Old readers: diaries with like/repost/quote records pass the seeder's
//    gate and the CLI's `log --json` lists them.
// 5. CLI: the quote and repost lines in `feed`, `kind`/`quote` in --json.
// 4. Moderation: a blocklist that blocks B (offered by a moderator's
//    browser node) removes B from /index and from V's peeks.
const test = require('brittle')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until, localSwarmOptions, bootstrapFlags } = require('./helpers/net')
const { connectClient, stoppedOf, errorOf } = require('./helpers/session')
const { Seeder } = require('@varanda/core/lib/seeder')
const { createCert, createSeederCert, createIssuerCert, createUsernameRecord, createModeratorCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { profileRecord, postRecord, likeRecord, repostRecord } = require('@varanda/core/lib/records')
const { createSnapshot } = require('@varanda/core/lib/blocklist')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')
const { createMember } = require('../lib/member')
const { memoryStorage } = require('../lib/storage')
const { connectSeeder } = require('../lib/seeder-link')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')

const BIN = path.join(__dirname, '../../../apps/cli/bin/varanda.js')
const APP_SRC = path.join(__dirname, '../../../apps/app/src')
const loadThread = () => import(path.join(APP_SRC, 'thread.js'))
const loadIndexClient = () => import(path.join(APP_SRC, 'indexClient.js'))
const DIARY_UNAVAILABLE = 'diário indisponível'

const REPLIES = 66 // 22 each from B, C and D: two /index/post pages
const BASE_MS = Date.parse('2026-03-01T12:00:00.000Z')
const at = (i) => new Date(BASE_MS + i * 1000).toISOString()

const env = {}
for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('VARANDA_')) env[k] = v

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function jsonLines (stdout) {
  return stdout.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter((v) => v !== null)
}

// The CLI as a child process (the seeder runs in this process and must keep
// serving), with the loopback testnet flags.
function varanda (t, bootstrap, args) {
  const child = spawn(process.execPath, [BIN, ...args, ...bootstrapFlags(bootstrap)], { env })
  const proc = { stdout: '', stderr: '', code: null }
  child.stdout.on('data', (d) => { proc.stdout += d })
  child.stderr.on('data', (d) => { proc.stderr += d })
  const exited = new Promise((resolve) => child.on('close', (code) => { proc.code = code; resolve(proc) }))
  t.teardown(async () => {
    if (proc.code === null) {
      child.kill('SIGKILL')
      await exited
    }
  }, { force: true })
  return exited
}

async function run (t, bootstrap, args) {
  const proc = await varanda(t, bootstrap, args)
  t.is(proc.code, 0, args.slice(0, 2).join(' ') + ' ' + proc.stderr)
  const lines = jsonLines(proc.stdout)
  return { proc, lines, last: lines[lines.length - 1] }
}

function makeAssociation () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

// The seeder in this process with its WebSocket entry and /index routes on
// a system port (startSeedWs, as `seed --ws-port` runs it).
async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-es-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-es-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const events = []
  const seeder = new Seeder({
    dataDir,
    ...localSwarmOptions(bootstrap),
    log: (e) => {
      events.push(e)
      if (process.env.VARANDA_TEST_LOG) console.error('# seeder', JSON.stringify(e))
    }
  })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  return { seeder, events, publicKey, port: ws.port, url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
}

// A Hypercore 10 member with its certificate and `records(key)` appended as
// they are, announced to the seeder and served whole; the link is closed
// afterwards, so the seeder alone serves the diary.
async function servedMember (t, { assoc, seederUrl, seederKey, keyPair, records }) {
  const m = await createMember({ storage: memoryStorage(), keyPair, association: assoc.hex })
  t.teardown(() => m.close(), { force: true })
  await m.setCert(createCert({ member: m.key }, assoc.kp))
  m.entries = []
  for (const record of records(m.key)) {
    m.entries.push({ seq: m.core.length, record })
    await m.core.append(record)
  }
  const link = connectSeeder({
    member: m,
    socket: new WebSocket(seederUrl),
    association: assoc.hex,
    seederPublicKey: seederKey,
    timeoutMs: 30000
  })
  t.teardown(() => link.close(), { force: true })
  await link.admitted
  await link.waitServed(m.core.length)
  link.close()
  return m
}

async function browserNode (t, { assoc, seederUrl, storage = memoryNodeStorage(), internal }) {
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl,
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    syncOptions: { retryMinMs: 100, retryMaxMs: 300, blocklistMinIntervalMs: 0 },
    writeGate: false
  })
  t.teardown(() => node.close(), { force: true })
  await node.setKeyPair(crypto.keyPair())
  const web = await connectClient(node, { timeoutMs: 60000 })
  const { publicKey } = await web.request('identity.create')
  await web.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  return { node, web, storage, key: publicKey }
}

// GET on the index listener with an allowed Host; -> { status, headers, json }.
function indexGet (port, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { Host: '127.0.0.1:' + port }, agent: false }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => {
        const body = b4a.toString(b4a.concat(chunks))
        let json = null
        try { json = JSON.parse(body) } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

// What /index/post must say about `target`, reduced from the diaries'
// records: replies sorted by (at, author, seq); likes / reposts = distinct
// engagers whose last operation (in seq order) is on; quotes counted.
function reduceThread (members, target) {
  const replies = []
  let quotes = 0
  let likes = 0
  let reposts = 0
  const same = (t) => t && t.author === target.author && t.seq === target.seq
  for (const m of members) {
    const last = { like: null, repost: null }
    for (const { seq, record } of m.entries) {
      if (record.type === 'post' && same(record.replyTo)) replies.push({ ms: Date.parse(record.at), author: m.key, seq })
      if (record.type === 'post' && same(record.quote)) quotes++
      if ((record.type === 'like' || record.type === 'repost') && same(record.to)) last[record.type] = record.on
    }
    if (last.like === true) likes++
    if (last.repost === true) reposts++
  }
  replies.sort((a, b) => a.ms - b.ms || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || a.seq - b.seq)
  return { replies: replies.map((r) => r.author + ':' + r.seq), likes, reposts, quotes }
}

// Every /index/post page of `ref`, following `next`.
async function allPages (port, author, seq) {
  const pages = []
  let cursor = null
  for (;;) {
    const res = await indexGet(port, '/index/post/' + author + '/' + seq + (cursor === null ? '' : '/' + cursor))
    if (res.status !== 200) throw new Error('/index/post ' + res.status)
    pages.push(res.json)
    cursor = res.json.next
    if (cursor === null) return pages
  }
}

// The app's merge of diary.peek results into a per-author map
// (apps/app/src/screens/Conversa.js mergePeek), run one peek at a time.
async function peekAll (web, plan) {
  const peeked = new Map()
  for (const params of plan) {
    const peek = await web.request('diary.peek', params)
    const known = peeked.get(peek.key)
    if (!known) {
      peeked.set(peek.key, { key: peek.key, entries: peek.entries.slice(), profile: peek.profile, username: peek.username })
    } else {
      peeked.set(peek.key, {
        key: peek.key,
        entries: known.entries.concat(peek.entries),
        profile: known.profile || peek.profile,
        username: known.username || peek.username
      })
    }
  }
  return peeked
}

// Counts Hypercore#replicate calls per key (hex): a peek of the followed
// key the run already replicates must not add one.
function replicateSpy (t) {
  const original = Hypercore.prototype.replicate
  const counts = new Map()
  Hypercore.prototype.replicate = function (...args) {
    const key = this.key ? hex(this.key) : null
    counts.set(key, (counts.get(key) || 0) + 1)
    return original.apply(this, args)
  }
  t.teardown(() => { Hypercore.prototype.replicate = original })
  return (key) => counts.get(key) || 0
}

test('social: threads, likes, reposts, quotes and profiles across the browser node, the seeder index and the CLI', async (t) => {
  t.timeout(300000)
  const started = Date.now()
  const { bootstrap } = await testnet(t)
  const assoc = makeAssociation()
  const { seeder, events, publicKey: seederKey, port, url } = await seederStack(t, bootstrap, assoc)
  const { planPeeks, assembleThread, assembleMember } = await loadThread()
  const { fetchPost, fetchCounts } = await loadIndexClient()
  const base = 'http://127.0.0.1:' + port
  const deps = { fetch: (u, opts) => fetch(base + u, opts) }
  const issuerKp = crypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: hex(issuerKp.publicKey) }, assoc.kp)
  const username = (key, name) => createUsernameRecord({ member: key, username: name }, issuerKp, issuerCert)

  // ---- the diaries ----
  // A: 1 profile, 2 username, 3 P.
  const A = await servedMember(t, {
    assoc,
    seederUrl: url,
    seederKey,
    records: (key) => [profileRecord({ name: 'Ana', at: at(0) }), username(key, 'ana'), postRecord({ text: 'a pergunta', at: at(1) })]
  })
  const P = { author: A.key, seq: 3 }
  const pRef = A.key + ':3'
  // B, C, D: the replies interleaved by time (pairs share a timestamp, so
  // the author breaks ties), then the engagement.
  const pairs = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair()]
  const replies = (slot) => {
    const out = []
    for (let i = slot; i < REPLIES; i += 3) out.push(postRecord({ text: 'resposta ' + i, at: at(10 + Math.floor(i / 2)), replyTo: P }))
    return out
  }
  const B = await servedMember(t, {
    assoc,
    seederUrl: url,
    seederKey,
    keyPair: pairs[0],
    records: (key) => [
      profileRecord({ name: 'Bruno', at: at(0) }),
      username(key, 'bruno'),
      ...replies(0),
      postRecord({ text: 'olha isto', at: at(100), quote: P }),
      likeRecord({ to: P, on: true, at: at(101) })
    ]
  })
  const bQuote = B.entries.find((e) => e.record.quote).seq
  const bQuoteRef = B.key + ':' + bQuote
  const C = await servedMember(t, {
    assoc,
    seederUrl: url,
    seederKey,
    keyPair: pairs[1],
    records: (key) => [
      profileRecord({ name: 'Carla', at: at(0) }),
      username(key, 'carla'),
      ...replies(1),
      repostRecord({ to: P, on: true, at: at(110) }),
      likeRecord({ to: P, on: true, at: at(111) }),
      likeRecord({ to: P, on: false, at: at(112) }),
      likeRecord({ to: P, on: true, at: at(113) })
    ]
  })
  const cRepost = C.entries.find((e) => e.record.type === 'repost').seq
  const D = await servedMember(t, { assoc, seederUrl: url, seederKey, keyPair: pairs[2], records: () => replies(2) })
  const members = [A, B, C, D]
  const names = { [A.key]: ['Ana', 'ana'], [B.key]: ['Bruno', 'bruno'], [C.key]: ['Carla', 'carla'], [D.key]: [null, null] }
  t.comment('diaries: A ' + A.core.length + ', B ' + B.core.length + ', C ' + C.core.length + ', D ' + D.core.length + ' blocks; ms to serve them: ' + (Date.now() - started))

  // ---- scenario 1: the thread through /index/post ----
  const expected = reduceThread(members, P)
  t.is(expected.replies.length, REPLIES)
  t.alike([expected.likes, expected.reposts, expected.quotes], [2, 1, 1], 'the reducer: likes 2 (C undid and liked again), reposts 1, quotes 1')
  const indexStarted = Date.now()
  await until(async () => {
    const r = await indexGet(port, '/index/post/' + A.key + '/3')
    return r.status === 200 && r.json.repliesTotal === REPLIES && r.json.likes === 2 && r.json.quotesTotal === 1 && r.json.complete && !r.json.indexing
  }, { name: 'P indexado', timeoutMs: 60000 })
  t.comment('ms until the index held the whole thread: ' + (Date.now() - indexStarted))
  const first = await indexGet(port, '/index/post/' + A.key + '/3')
  t.is(first.headers['content-type'], 'application/json; charset=utf-8')
  t.is(first.headers['cache-control'], 'no-store')
  t.is(first.headers['x-content-type-options'], 'nosniff')
  const pagesStarted = Date.now()
  const pages = await allPages(port, A.key, 3)
  const pagesMs = Date.now() - pagesStarted
  t.is(pages.length, 2, 'two pages')
  t.is(pages[0].replies.length, 50, 'a full first page')
  t.ok(pages[0].next !== null && pages[1].next === null, 'next on the first page only')
  const listed = pages.flatMap((p) => p.replies)
  t.is(new Set(listed).size, listed.length, 'each reply exactly once')
  t.alike(listed, expected.replies, 'every reply, in (at, author, seq) order, equal to the reducer')
  for (const p of pages) {
    t.alike([p.ref, p.parent, p.likes, p.reposts, p.repliesTotal, p.quotesTotal], [pRef, null, expected.likes, expected.reposts, REPLIES, expected.quotes])
    t.alike(p.quotes, [bQuoteRef], 'the quote, on every page')
  }
  const authors = Object.assign({}, ...pages.map((p) => p.authors))
  t.alike(Object.keys(authors).sort(), [A.key, B.key, C.key, D.key].sort(), 'hints for every listed author')
  t.alike(authors[B.key], { profileSeq: 1, usernameSeq: 2 })
  t.alike(authors[D.key], { profileSeq: null, usernameSeq: null })
  // The app's own client agrees with the raw route.
  const viaClient = await fetchPost(pRef, null, deps)
  t.ok(viaClient.ok, 'fetchPost ok')
  t.alike(viaClient.value, pages[0], 'fetchPost returns the validated page')
  const second = await fetchPost(pRef, pages[0].next, deps)
  t.alike(second.value.replies, pages[1].replies, 'fetchPost with the cursor')
  const counts = await fetchCounts([pRef, pRef, bQuoteRef], deps)
  t.alike(counts.value.counts, {
    [pRef]: { replies: REPLIES, likes: 2, reposts: 1, quotes: 1 },
    [bQuoteRef]: { replies: 0, likes: 0, reposts: 0, quotes: 0 }
  }, '/index/counts, duplicates collapsed')

  // ---- the viewer V: follows only C ----
  const internal = []
  const replicates = replicateSpy(t)
  const V = await browserNode(t, { assoc, seederUrl: url, internal })
  const web = V.web
  t.alike(await web.request('follow.add', { key: C.key }), { changed: true, followCount: 1 })
  await web.request('sync.start', {})
  await until(() => web.events.some((e) => e.name === 'sync.event' && e.data.line === 'downloaded ' + C.key + ' ' + C.core.length), { name: 'C baixado', timeoutMs: 60000 })
  t.ok(await store.replicaExists(V.storage, C.key), 'C is a local replica')

  const index = { ...pages[0], replies: listed, next: null }
  const plan = planPeeks({ refs: [pRef, ...listed], authors })
  t.alike(plan.map((p) => p.author).sort(), [A.key, B.key, C.key, D.key].sort(), 'one peek per author (each under PEEK_SEQS_MAX)')
  const cBefore = replicates(C.key)
  const peekStarted = Date.now()
  const peeked = await peekAll(web, plan)
  const peekMs = Date.now() - peekStarted
  t.is(replicates(C.key), cBefore, 'the followed diary is read from the local replica (no new channel)')
  const thread = assembleThread({ focal: pRef, index, peeked })
  t.is(thread.post && thread.post.text, 'a pergunta', 'the focal post')
  t.alike([thread.post.name, thread.post.username], ['Ana', 'ana'])
  t.is(thread.parent, null, 'P has no parent')
  t.is(thread.unavailable, 0, 'nothing unavailable')
  t.alike(thread.replies.map((r) => r.author + ':' + r.seq), expected.replies, 'every reply, in index order')
  t.ok(thread.replies.every((r) => r.name === names[r.author][0] && r.username === names[r.author][1]), 'names from the profiles, verified usernames where issued')
  // The parent rule: a reply's own page names P, and P is shown as its parent.
  const dReply = D.entries[0].seq
  const dPage = await indexGet(port, '/index/post/' + D.key + '/' + dReply)
  t.is(dPage.json.parent, pRef, 'a reply names its parent')
  const dPeeked = await peekAll(web, planPeeks({ refs: [D.key + ':' + dReply, pRef], authors: dPage.json.authors }))
  const dThread = assembleThread({ focal: D.key + ':' + dReply, index: dPage.json, peeked: dPeeked })
  t.is(dThread.parent && dThread.parent.text, 'a pergunta', 'the parent from its signed replyTo')
  t.is(dThread.post.username, null, 'D holds no username')
  for (const m of [A, B, D]) t.absent(await store.replicaExists(V.storage, m.key), 'no replica of an unfollowed diary')
  t.comment('thread: ' + REPLIES + ' replies in ' + pages.length + ' pages (' + pagesMs + ' ms), ' + plan.length + ' peeks in ' + peekMs + ' ms')

  // ---- scenario 2: feed and engagement ----
  const feed = await web.request('feed.read', { limit: 30 })
  const repostItem = feed.items.find((i) => i.kind === 'repost')
  t.ok(repostItem, 'C\'s repost in V\'s feed')
  t.alike([repostItem.author, repostItem.seq, repostItem.to, repostItem.text], [C.key, cRepost, P, null])
  t.ok(feed.items.every((i) => i.author === C.key || i.author === V.key), 'only followed (and own) items')
  const liked = await web.request('like.set', { to: pRef, on: true })
  t.is(liked.on, true)
  t.is(liked.changed, true)
  t.ok(Number.isSafeInteger(liked.seq), 'the like record seq')
  t.alike(await web.request('engagement.read', { refs: [pRef, bQuoteRef] }), { liked: [pRef], reposted: [] })
  t.alike(await web.request('like.set', { to: pRef, on: true }), { seq: liked.seq, on: true, changed: false }, 'the same state again: unchanged')
  const likeStarted = Date.now()
  await until(async () => {
    const r = await fetchCounts([pRef], deps)
    return r.ok && r.value.counts[pRef].likes === 3
  }, { name: 'curtida de V no índice', timeoutMs: 60000 })
  t.pass('the index counts 3 likes once V\'s like reached the seeder')
  t.comment('ms from like.set to the seeder\'s count: ' + (Date.now() - likeStarted))

  // ---- scenario 3: B's profile ----
  const bMember = await indexGet(port, '/index/member/' + B.key)
  t.is(bMember.status, 200)
  const bPosts = B.entries.filter((e) => e.record.type === 'post').map((e) => e.seq).reverse()
  t.alike(bMember.json.posts, bPosts, 'B\'s replies and quote, newest first')
  t.is(bMember.json.postsTotal, bPosts.length)
  t.alike([bMember.json.length, bMember.json.profileSeq, bMember.json.usernameSeq], [B.core.length, 1, 2])
  const bPlan = planPeeks({ refs: bMember.json.posts.map((s) => B.key + ':' + s), authors: { [B.key]: { profileSeq: bMember.json.profileSeq, usernameSeq: bMember.json.usernameSeq } } })
  const profile = assembleMember({ author: B.key, index: bMember.json, peeked: await peekAll(web, bPlan) })
  t.alike([profile.profile && profile.profile.name, profile.username], ['Bruno', 'bruno'], 'name and verified @nome from the hints')
  t.is(profile.items.length, bPosts.length)
  t.is(profile.unavailable, 0)
  t.alike(profile.items[0].quote, P, 'the quote leads the profile')
  t.absent(await store.replicaExists(V.storage, B.key), 'still no replica of B')

  // ---- scenario 6: old readers / the gate ----
  for (const m of [B, C]) {
    t.absent(events.some((e) => e.event === 'rejected' && e.key === m.key), 'diary with like/repost/quote records not rejected')
    t.ok(seeder._served.get(m.key).gated, 'it passed the seeder\'s gate')
  }

  // ---- scenario 5: the CLI member ----
  const memberDir = tmpDir(t, 'varanda-es-member-')
  const cliKey = (await run(t, bootstrap, ['id', 'create', '--data', memberDir, '--association', assoc.hex, '--json'])).last.publicKey
  const certFile = path.join(tmpDir(t, 'varanda-es-mc-'), 'member-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createCert({ member: cliKey }, assoc.kp)))
  await run(t, bootstrap, ['cert', 'add', '--data', memberDir, '--cert-file', certFile, '--json'])
  for (const m of [A, B, C]) await run(t, bootstrap, ['follow', '--data', memberDir, '--author', m.key, '--json'])
  const cliStarted = Date.now()
  const cliSync = await varanda(t, bootstrap, ['sync', '--data', memberDir, '--once', '--timeout-ms', '30000', '--json'])
  const cliLines = jsonLines(cliSync.stdout)
  const cliResult = cliLines[cliLines.length - 1]
  if (cliSync.code !== 0) t.comment('cli sync: ' + cliSync.stdout + cliSync.stderr)
  t.is(cliSync.code, 0, 'CLI sync --once exits 0')
  for (const m of [A, B, C]) t.is(cliResult && cliResult.downloaded && cliResult.downloaded[m.key], m.core.length, 'the CLI downloaded ' + m.key.slice(0, 8))
  t.comment('ms for the CLI sync: ' + (Date.now() - cliStarted))
  const text = await varanda(t, bootstrap, ['feed', '--data', memberDir])
  t.is(text.code, 0, 'feed ' + text.stderr)
  const target8 = A.key.slice(0, 8) + '#3'
  t.ok(text.stdout.includes('(' + B.key.slice(0, 8) + ' @bruno) #' + bQuote + ' cita ' + target8), 'the quote line')
  t.ok(text.stdout.includes('(' + C.key.slice(0, 8) + ' @carla) #' + cRepost + ' republicou ' + target8), 'the repost line')
  const json = (await run(t, bootstrap, ['feed', '--data', memberDir, '--json'])).last
  const quoteItem = json.items.find((i) => i.author === B.key && i.seq === bQuote)
  t.alike(quoteItem && [quoteItem.kind, quoteItem.quote, quoteItem.replyTo], ['post', P, null], 'feed --json: the quote')
  const cliRepost = json.items.find((i) => i.author === C.key && i.kind === 'repost')
  t.alike(cliRepost && [cliRepost.seq, cliRepost.to], [cRepost, P], 'feed --json: the repost')
  t.alike(json.skipped, [], 'nothing skipped')
  for (const m of [B, C]) {
    const log = (await run(t, bootstrap, ['log', '--data', memberDir, '--author', m.key, '--json'])).last
    t.is(log.entries.length, m.core.length, 'log --json lists every block of ' + m.key.slice(0, 8))
    const types = log.entries.map((e) => e.record.type + (e.record.quote ? ':quote' : ''))
    for (const want of m === B ? ['like', 'post:quote'] : ['like', 'repost']) t.ok(types.includes(want), 'log --json lists ' + want)
  }

  // ---- scenario 4: moderation ----
  const modKp = crypto.keyPair()
  const modCert = createModeratorCert({ moderator: hex(modKp.publicKey) }, assoc.kp)
  const modStorage = memoryNodeStorage()
  await store.writeBlocklist(modStorage, createSnapshot({ seq: 1, blocked: [B.key] }, modKp, modCert))
  const W = await browserNode(t, { assoc, seederUrl: url, storage: modStorage, internal })
  const modStarted = Date.now()
  const { runId } = await W.web.request('sync.start', { once: true, timeoutMs: 30000 })
  await stoppedOf(W.web.events, runId)
  await until(() => events.some((e) => e.event === 'rejected' && e.key === B.key && e.reason === 'blocked'), { name: 'B bloqueado', timeoutMs: 30000 })
  await until(async () => (await indexGet(port, '/index/member/' + B.key)).status === 404, { name: 'B fora do índice', timeoutMs: 30000 })
  t.comment('ms from the moderator\'s run to B gone from the index: ' + (Date.now() - modStarted))
  const after = await allPages(port, A.key, 3)
  const afterReplies = after.flatMap((p) => p.replies)
  t.alike(afterReplies, expected.replies.filter((r) => !r.startsWith(B.key)), 'B\'s replies are gone, the rest in order')
  t.alike([after[0].likes, after[0].reposts, after[0].quotesTotal, after[0].repliesTotal], [2, 1, 0, REPLIES - REPLIES / 3], 'B\'s like and quote no longer counted')
  t.alike(after[0].quotes, [])
  t.absent(B.key in after[0].authors, 'no hint for B')
  t.alike((await fetchCounts([pRef, bQuoteRef], deps)).value.counts, { [pRef]: { replies: REPLIES - REPLIES / 3, likes: 2, reposts: 1, quotes: 0 } })
  await until(async () => {
    const data = await store.readBlocklist(V.storage)
    return data !== null && data.snapshot.seq === 1
  }, { name: 'V adotou a lista', timeoutMs: 30000 })
  const refused = await errorOf(web.request('diary.peek', { author: B.key, seqs: [bQuote] }))
  t.is(refused && refused.code, 'NOT_FOUND')
  t.is(refused && refused.message, DIARY_UNAVAILABLE, 'a peek of B: diário indisponível')

  await web.request('sync.stop')
  t.alike(internal, [], 'no internal error')
  t.comment('total ms: ' + (Date.now() - started))
})
