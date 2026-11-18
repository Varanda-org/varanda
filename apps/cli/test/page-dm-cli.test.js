'use strict'

// `page dm-list`, `page dm-read` and `page dm-reply` end to end on loopback
// only: a local DHT, a real seeder with the dm and blob options, a browser
// node as the page owner and as the member who writes, and the CLI as a
// child process on a core data dir whose delegate holds the page's
// Conversas. The account origin is a loopback front: it forwards /seeder and
// /blob to the seeder and stands in for the account service's 'dm-sign'
// (start, then the page's signature over the digest, docs/rpc.md 5.84).
// Every engine, in the test and in each CLI child (helpers/dm-limits-preload.js),
// runs with 1 s peek and close-drain limits: the page diary is never on the
// seeder, so its dm-key peek would hold each close for the 20 s default.

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const { testnet, tmpDir, until } = require('./helpers/net')
const { createCert, createIssuerCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { signRoster, issuerCountersign } = require('@varanda/core/lib/page')
const coreStore = require('@varanda/core/lib/store')
const member = require('@varanda/core/lib/member')
const { createSession } = require('@varanda/core/lib/session')
const { createCoreDm } = require('@varanda/web-member/lib/core-dm')
const { createMember } = require('@varanda/web-member/lib/member')
const { memoryStorage } = require('@varanda/web-member/lib/storage')
const { fileNodeStorage } = require('@varanda/web-member/lib/file-storage')
const { dmBoxKeyPairFromPrf } = require('@varanda/web-member/lib/passkey')
const { seederHost, memberNode, push, png } = require('../../../packages/web-member/test/helpers/dm-e2e')
const { signed } = require('../../../packages/web-member/test/helpers/page-dm')

const BIN = path.join(__dirname, '../bin/varanda.js')
const PRELOAD = path.join(__dirname, 'helpers/dm-limits-preload.js')
const { TEST_LIMITS } = require('./helpers/dm-limits-preload')
const AT = '2026-11-03T12:00:00.000Z'
const RNONCE = 'r'.repeat(43)
const NONCE = 'n'.repeat(43)
const DM_OFF = 'Conversas ainda não ativadas neste aparelho'
const DM_BUSY = 'Conversas abertas em outro processo deste aparelho'

function noop () {}

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function socketTo (url) {
  const ws = new WebSocket(url)
  ws.on('error', noop)
  return ws
}

function cli (args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-r', PRELOAD, BIN, ...args], { env: { PATH: process.env.PATH, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

function lastJson (stdout) {
  const lines = stdout.trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

// The loopback account origin: the page routes answered here, the rest
// (blob GETs and the /seeder upgrade) passed to the seeder host.
async function accountFront (t, host, pageKp, asked) {
  const seederPort = Number(new URL(host.url).port)
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/account/pages/')) {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => {
        const action = req.url.slice('/account/pages/'.length)
        const data = JSON.parse(body)
        asked.push({ action, data })
        let answer = null
        if (action === 'start') answer = { nonce: NONCE }
        else if (action === 'dm-sign' && data.nonce === NONCE) answer = signed(data.op.digest, pageKp)
        res.writeHead(answer === null ? 400 : 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer === null ? { error: 'pedido-invalido' } : answer))
      })
      return
    }
    const up = http.request({ host: '127.0.0.1', port: seederPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers)
      r.pipe(res)
    })
    up.on('error', () => res.destroy())
    req.pipe(up)
  })
  const sockets = new Set()
  server.on('upgrade', (req, socket, head) => {
    const up = net.connect(seederPort, '127.0.0.1', () => {
      let lines = req.method + ' ' + req.url + ' HTTP/1.1\r\n'
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n'
      up.write(lines + '\r\n')
      if (head.length) up.write(head)
      socket.pipe(up).pipe(socket)
    })
    sockets.add(up).add(socket)
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.teardown(async () => {
    for (const s of sockets) s.destroy()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(() => resolve()))
  }, { force: true })
  return 'http://127.0.0.1:' + server.address().port
}

// A page diary: block 0 its certificate, a roster naming `owner`, its
// gen 1 dm-key `box`.
async function pageDiary (t, { assoc, issuer, pageKp, ownerKp, box }) {
  const m = await createMember({ storage: memoryStorage(), association: assoc.hex, keyPair: pageKp })
  t.teardown(() => m.close(), { force: true })
  const page = hex(pageKp.publicKey)
  await m.setCert(createCert({ member: page }, assoc.kp))
  const fields = { page, gen: 1, owner: hex(ownerKp.publicKey), admins: [], prev: null, at: AT, nonce: RNONCE, association: assoc.hex }
  await m.core.append(issuerCountersign({ type: 'page-roster', ...fields, signature: signRoster(fields, ownerKp) }, issuer.kp, issuer.cert))
  await m.core.append({ type: 'dm-key', box, gen: 1, at: AT })
  return m
}

async function holdWeb (m, storage) {
  const store = require('@varanda/web-member/lib/node-store')
  const dst = await store.openReplica(storage, m.key)
  const a = m.core.replicate(true, { keepAlive: false })
  const b = dst.replicate(false, { keepAlive: false })
  a.pipe(b).pipe(a)
  try {
    await dst.update({ wait: true })
    await dst.download({ start: 0, end: m.core.length }).done()
  } finally {
    a.destroy()
    b.destroy()
    await dst.close()
  }
}

async function holdCore (m, dataDir) {
  const dst = await coreStore.openStore(dataDir)
  try {
    const a = m.core.replicate(true, { keepAlive: false })
    const b = dst.replicate(false)
    a.pipe(b).pipe(a)
    const replica = dst.get({ key: m.core.key, valueEncoding: 'json' })
    await replica.ready()
    await replica.download({ start: 0, end: m.core.length }).done()
    a.destroy()
    b.destroy()
  } finally {
    await dst.close()
  }
}

async function walletOf (dataDir) {
  const s = fileNodeStorage(dataDir + '/private/dm')
  try {
    const w = await s.readJson('dmStamps')
    return w && Array.isArray(w.items) ? w.items.length : 0
  } finally {
    await s.close()
  }
}

function coreSession (dataDir, assoc, bootstrap, accountOrigin) {
  const session = createSession({
    dataDir,
    association: assoc.hex,
    bootstrap,
    dhtHost: '127.0.0.1',
    dm: (hooks) => createCoreDm({ ...hooks, accountOrigin, createSocket: socketTo, limits: TEST_LIMITS })
  })
  const events = []
  session.attach((event, data) => events.push({ event, data }))
  const call = (method, params = {}) => session.handlers[method](params)
  return { session, events, call }
}

test('page dm cli: list, read with --save, reply as the page; peer text escaped; no secret printed', async (t) => {
  t.timeout(170000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const issuerKp = crypto.keyPair()
  const issuer = { kp: issuerKp, cert: createIssuerCert({ issuer: hex(issuerKp.publicKey) }, kp) }
  const host = await seederHost(t, bootstrap, assoc, { blob: true })
  const pageKp = crypto.keyPair()
  const P = hex(pageKp.publicKey)
  const asked = []
  const origin = await accountFront(t, host, pageKp, asked)

  // The owner (and the member who writes), a browser node.
  const O = await memberNode(t, assoc, host, { blob: { wallet: 16, walletLow: 8, issuePaceMs: 0 } })
  const boxO = hex((await dmBoxKeyPairFromPrf(O.prf, 1)).publicKey)
  await push(t, O, host)

  // The core data dir, set up in process: delegate, Conversas, the page's keys.
  const D = tmpDir(t, 'varanda-page-dm-cli-')
  const C = coreSession(D, assoc, bootstrap, origin)
  let closed = false
  const closeC = async () => {
    if (closed) return
    closed = true
    await C.session.detach().catch(noop)
    await C.session.close()
  }
  t.teardown(closeC, { force: true })
  const { publicKey: coreKey } = await C.call('identity.create')
  await C.call('cert.add', { cert: createCert({ member: coreKey }, kp) })
  await C.call('page.register')
  const { runId } = await C.call('sync.start', { once: true, timeoutMs: 30000 })
  await until(() => C.events.some((e) => e.event === 'sync.stopped' && e.data.runId === runId), { timeoutMs: 60000, name: 'core push' })
  await until(() => host.current._served.has(coreKey) || host.current._admitted.has(coreKey), { name: 'core served', timeoutMs: 30000 })
  await C.call('dm.enable')
  await until(async () => (await walletOf(D)) > 0, { name: 'core stamps', timeoutMs: 60000 })
  const ab = await C.call('dm.actorBox')
  const made = await O.web.request('dm.pageGenerate', {
    page: P,
    gen: 1,
    recipients: [{ member: O.key, box: boxO }, { member: ab.actor, box: ab.box, proof: { gen: ab.gen, at: ab.at, sig: ab.sig } }]
  })
  const diary = await pageDiary(t, { assoc, issuer, pageKp, ownerKp: O.keyPair, box: made.box })
  await holdWeb(diary, O.storage)
  await holdCore(diary, D)
  const cert = createCert({ member: P }, kp)
  const [own, toCore] = made.shares
  await O.web.request('dm.pageSecrets', { page: P, gen: 1, sealed: own.sealed, by: O.key, sig: own.sig, box: made.box, groupBox: made.groupBox, cert })
  t.alike(await C.call('dm.pageSecrets', { page: P, gen: 1, sealed: toCore.sealed, by: O.key, sig: toCore.sig, box: made.box, groupBox: made.groupBox, cert }), { ok: true }, 'the core delegate adopts')
  await closeC()

  // A member message with a photo and a line feed, the one control
  // character a DM text may carry, which safe shows escaped.
  const photo = png(40000)
  const item = await O.node.dmPutMedia({ bytes: photo, mime: 'image/png', width: 64, height: 48, to: P })
  const text = 'foto\nvermelha fim'
  const sent = await O.web.request('dm.send', { to: P, text, media: [item] })

  const bootArgs = bootstrap.flatMap((b) => ['--bootstrap', b])
  const env = { VARANDA_ASSOCIATION: assoc.hex }
  const outputs = []
  const page = async (args, { data = D, json = true } = {}) => {
    const r = await cli(['page', ...args, '--data', data, '--account-origin', origin, ...bootArgs, ...(json ? ['--json'] : [])], env)
    outputs.push(r.stdout, r.stderr)
    return r
  }

  // dm-list: the conversation, unread, as a request (the page follows nobody).
  const listed = await page(['dm-list', P])
  t.is(listed.status, 0, listed.stderr)
  const list = lastJson(listed.stdout)
  t.is(list.incomplete, false)
  t.alike(list.conversations.map((c) => [c.peer, c.folder, c.unread]), [[O.key, 'request', true]])
  t.is(list.conversations[0].preview, text, 'JSON carries the text, escaped by jsonLine')
  t.is(listed.stdout.trim().split('\n').length, 1, 'one JSON line, the line feed escaped')
  const plainList = await page(['dm-list', P], { json: false })
  t.is(plainList.status, 0, plainList.stderr)
  t.ok(plainList.stdout.includes(O.key + ' pedido ') && plainList.stdout.includes('(não lida)'), plainList.stdout)
  t.ok(plainList.stdout.includes(': foto\\u{a}vermelha fim'), 'the preview through safe')

  // dm-read: text through safe, media by type and size only; nothing written.
  const saveTo = path.join(tmpDir(t, 'varanda-page-dm-save-'), 'midia')
  const read = await page(['dm-read', P, O.key], { json: false })
  t.is(read.status, 0, read.stderr)
  t.ok(read.stdout.includes(O.key + ': foto\\u{a}vermelha fim\n'), read.stdout)
  t.ok(read.stdout.includes('mídia 1: image/png 64x48, ' + photo.byteLength + ' bytes'), 'media listed by type and size')
  t.absent(read.stdout.includes('foto\nvermelha'), 'no raw line feed from the peer')
  t.absent(fs.existsSync(saveTo), 'nothing written without --save')
  for (const k of ['key', 'nonce', 'sha256']) t.absent(read.stdout.includes(item[k]), 'the item ' + k + ' is not printed')

  // --save: the received photo, 0600, in a new 0700 dir; never overwritten.
  const saved = await page(['dm-read', P, O.key, '--save', saveTo])
  t.is(saved.status, 0, saved.stderr)
  const r = lastJson(saved.stdout)
  t.alike(r.messages.map((m) => [m.id, m.text, m.mine]), [[sent.id, text, false]])
  t.is(r.saved.length, 1)
  const file = path.join(saveTo, r.saved[0])
  t.ok(b4a.equals(fs.readFileSync(file), photo), 'the photo bytes')
  t.is(fs.statSync(file).mode & 0o777, 0o600, 'file 0600')
  t.is(fs.statSync(saveTo).mode & 0o777, 0o700, 'dir 0700')
  const again = await page(['dm-read', P, O.key, '--save', saveTo])
  t.is(again.status, 2, 'an existing file is refused')
  t.ok(again.stderr.includes('já existe'), again.stderr)
  t.ok(b4a.equals(fs.readFileSync(file), photo), 'the file is unchanged')
  const link = path.join(tmpDir(t, 'varanda-page-dm-link-'), 'link')
  fs.symlinkSync(tmpDir(t, 'varanda-page-dm-target-'), link)
  const linked = await page(['dm-read', P, O.key, '--save', link])
  t.is(linked.status, 2, 'a symlinked dir is refused')
  t.ok(linked.stderr.includes('link simbólico'), linked.stderr)

  // dm-reply: drafted on the node, signed by the page at the account
  // origin, sent; the member reads it.
  const replied = await page(['dm-reply', P, O.key, 'resposta da página'])
  t.is(replied.status, 0, replied.stderr)
  t.is(lastJson(replied.stdout).sent, true)
  const sign = asked.find((a) => a.action === 'dm-sign')
  t.ok(sign && sign.data.member === ab.actor && sign.data.page === P, 'dm-sign asked by the delegate for the page')
  await until(async () => {
    await O.web.request('dm.pull')
    const th = await O.web.request('dm.thread', { peer: P })
    return th.messages.some((m) => m.text === 'resposta da página')
  }, { name: 'reply delivered', timeoutMs: 30000 })
  t.pass('the member reads the page\'s reply')

  // Another process holding the Conversas of this data dir: refused, clear.
  const busy = coreSession(D, assoc, bootstrap, origin)
  t.teardown(() => busy.session.close(), { force: true })
  await busy.call('dm.list', { page: P, folder: 'inbox', limit: 1 })
  const refused = await page(['dm-list', P])
  t.is(refused.status, 2)
  t.ok(refused.stderr.startsWith('uso: ' + DM_BUSY + ':'), refused.stderr)
  await busy.session.close()

  // A data dir without Conversas says so in pt-BR.
  const fresh = tmpDir(t, 'varanda-page-dm-off-')
  await member.idCreate({ dataDir: fresh, association: assoc.hex })
  const off = await page(['dm-list', P], { data: fresh })
  t.is(off.status, 2)
  t.ok(off.stderr.startsWith('uso: ' + DM_OFF + ': ative'), off.stderr)

  const all = outputs.join('\n')
  t.absent(all.includes(hex(pageKp.secretKey)) || all.includes(sign.data.signature), 'no secret or signature printed')
})
