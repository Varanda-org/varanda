const test = require('brittle')
const net = require('node:net')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { WebSocket } = require('ws')
const fs = require('node:fs')
const path = require('node:path')
const { testnet, tmpDir, until, localSwarmOptions } = require('./helpers/net')
const { connectClient, errorOf } = require('./helpers/session')
const { createCert, createSeederCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { Seeder } = require('@varanda/core/lib/seeder')
const { startSeedWs } = require('../../../apps/cli/lib/seed-ws')
const { profileRecord, postRecord } = require('@varanda/core/lib/records')
const { memoryNodeStorage } = require('../lib/node-storage')
const store = require('../lib/node-store')
const member = require('../lib/member-ops')
const { editsOf } = require('@varanda/core/lib/post-edit')
const { createBrowserNode } = require('../lib/node')

const LOCKED = 'identidade bloqueada: entre com a passkey'
const BAD_REF = 'referência inválida'
const NOT_POST = 'o registro não é uma publicação'
const NOT_EDITABLE = 'enquetes e eventos não podem ser editados'
const BAD_TEXT = 'texto inválido'

function hex (buf) {
  return b4a.toString(buf, 'hex')
}

function association () {
  const kp = generateAssociationKeyPair()
  return { kp, hex: hex(kp.publicKey) }
}

async function deadPort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function setup (t, { storage = memoryNodeStorage(), assoc = association(), keyPair = crypto.keyPair(), mediaKeyPair = crypto.keyPair(), ...options } = {}) {
  const port = await deadPort()
  const internal = []
  const node = createBrowserNode({
    storage,
    association: assoc.hex,
    seederUrl: 'ws://127.0.0.1:' + port + '/seeder',
    createSocket: (url) => {
      const ws = new WebSocket(url)
      ws.on('error', () => {})
      return ws
    },
    onInternalError: (err) => internal.push(err),
    writeGate: false,
    ...options
  })
  t.teardown(() => node.close(), { force: true })
  if (keyPair !== null) await node.setKeyPair(keyPair, mediaKeyPair === null ? {} : { media: mediaKeyPair })
  const web = await connectClient(node)
  return { node, web, assoc, storage, keyPair, mediaKeyPair, internal }
}

async function certified (t, options) {
  const s = await setup(t, options)
  const { publicKey } = await s.web.request('identity.create')
  await s.web.request('cert.add', { cert: createCert({ member: publicKey }, s.assoc.kp) })
  return { ...s, key: publicKey }
}

// A certified diary with a few records appended before any node opens it.
async function prepared (make) {
  const assoc = association()
  const keyPair = crypto.keyPair()
  const storage = memoryNodeStorage()
  const ctx = { storage, association: assoc.hex, keyPair }
  const { publicKey } = await member.idCreate(ctx)
  await member.certAdd(ctx, createCert({ member: publicKey }, assoc.kp))
  const records = make(publicKey)
  if (records.length > 0) await member.withIdentity(ctx, ({ diary }) => store.appendRecords(diary, records))
  return { assoc, keyPair, storage, key: publicKey }
}

async function errorPair (p) {
  const err = await errorOf(p)
  return [err && err.code, err && err.message]
}

async function logOf (web) {
  const log = await web.request('log.read', {})
  return log
}

test('post.edit: edits a post, an edit of the edit tombstones the older one, the same text writes nothing', async (t) => {
  await testnet(t)
  const { web, key, internal } = await certified(t)
  const post = await web.request('post.create', { text: 'primeira' })
  const ref = key + ':' + post.seq

  const e1 = await web.request('post.edit', { to: ref, text: 'corrigida' })
  t.alike(e1, { seq: post.seq + 1, ref, changed: true })
  let log = await logOf(web)
  const at1 = log.entries.find((e) => e.seq === post.seq)
  t.alike([at1.record.text, at1.edited], ['corrigida', true], 'log.read shows the current text and marks it')
  const block = log.entries.find((e) => e.seq === e1.seq)
  t.alike([block.record.type, block.record.seq, block.record.text], ['post-edit', post.seq, 'corrigida'], 'the post-edit block stays an entry')
  t.absent('edited' in block, 'only the post is marked')
  t.alike((await web.request('feed.read', {})).items.map((i) => [i.seq, i.text, i.edited]), [[post.seq, 'corrigida', true]], 'feed.read shows it')

  t.alike(await web.request('post.edit', { to: ref, text: 'corrigida' }), { seq: e1.seq, ref, changed: false }, 'same text: the live edit, nothing written')
  t.is((await logOf(web)).entries.length, log.entries.length, 'no new block')

  const e2 = await web.request('post.edit', { to: ref, text: 'de novo' })
  t.alike(e2, { seq: e1.seq + 1, ref, changed: true }, 'the new edit, then the tombstone of the old one, in one append')
  log = await logOf(web)
  t.alike(log.invalid, [{ seq: e1.seq, reason: 'deleted' }], 'the older edit is tombstoned and cleared')
  t.alike(log.entries.map((e) => e.record.type).slice(-2), ['post-edit', 'delete'])
  t.is(log.entries[log.entries.length - 1].record.seq, e1.seq, 'the tombstone names the old edit')
  t.is(log.entries.find((e) => e.seq === post.seq).record.text, 'de novo')
  t.is(editsOf(log.entries.map((e) => ({ seq: e.seq, record: e.record }))).get(post.seq).seq, e2.seq, 'one live edit')

  // Back to the original text is a new edit (the current text is the edit's).
  const e3 = await web.request('post.edit', { to: ref, text: 'primeira' })
  t.is(e3.changed, true)
  t.alike(internal, [], 'no internal error')
})

test('post.edit refusals write nothing', async (t) => {
  await testnet(t)
  const other = 'ab'.repeat(32)
  const p = await prepared(() => [
    profileRecord({ name: 'Bia', bio: '' }),
    postRecord({ text: 'enquete', poll: ['a', 'b'] }),
    postRecord({ text: 'normal' })
  ])
  const { web } = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: p.keyPair })
  const key = p.key
  t.is((await web.request('post.create', { text: 'apagada' })).seq, 4)
  await web.request('post.delete', { to: key + ':4' })
  const before = await logOf(web)
  const count = before.entries.length + before.invalid.length

  t.alike(await errorPair(web.request('post.edit', { to: other + ':3', text: 'x' })), ['USAGE', BAD_REF], 'another author')
  t.alike(await errorPair(web.request('post.edit', { to: key + ':' + count, text: 'x' })), ['USAGE', BAD_REF], 'at the length')
  t.alike(await errorPair(web.request('post.edit', { to: key + ':999', text: 'x' })), ['USAGE', BAD_REF], 'past the length')
  t.alike(await errorPair(web.request('post.edit', { to: key + ':4', text: 'x' })), ['USAGE', BAD_REF], 'a deleted post')
  t.alike(await errorPair(web.request('post.edit', { to: key + ':1', text: 'x' })), ['USAGE', NOT_POST], 'a profile')
  t.alike(await errorPair(web.request('post.edit', { to: key + ':2', text: 'x' })), ['USAGE', NOT_EDITABLE], 'a poll')
  t.alike(await errorPair(web.request('post.edit', { to: key + ':3', text: '' })), ['USAGE', BAD_TEXT], 'empty text on a text post')
  t.alike(await errorPair(web.request('post.edit', { to: key + ':3', text: 'a\u0000b' })), ['USAGE', BAD_TEXT], 'a control character')
  const zero = await errorOf(web.request('post.edit', { to: key + ':0', text: 'x' }))
  t.is(zero && zero.code, 'USAGE', 'block 0')
  const after = await logOf(web)
  t.is(after.entries.length + after.invalid.length, count, 'nothing appended')
})

test('post.edit: a locked session is refused', async (t) => {
  await testnet(t)
  const p = await prepared(() => [postRecord({ text: 'oi' })])
  const locked = await setup(t, { storage: p.storage, assoc: p.assoc, keyPair: null })
  t.alike(await errorPair(locked.web.request('post.edit', { to: p.key + ':1', text: 'x' })), ['USAGE', LOCKED])
  t.is((await locked.web.request('log.read', {})).entries.length, 2)
})

test('post.delete after an edit tombstones the edit in the same append', async (t) => {
  await testnet(t)
  const { web, key, internal } = await certified(t)
  const post = await web.request('post.create', { text: 'primeira' })
  const ref = key + ':' + post.seq
  const edit = await web.request('post.edit', { to: ref, text: 'corrigida' })
  const d = await web.request('post.delete', { to: ref })
  t.alike([d.changed, d.deleted], [true, [post.seq]])
  t.is(d.seq, edit.seq + 2, 'the post tombstone and the edit tombstone are one append')
  const log = await logOf(web)
  t.alike(log.invalid.map((i) => i.seq).sort((a, b) => a - b), [post.seq, edit.seq], 'both blocks cleared')
  t.alike(log.entries.slice(-2).map((e) => [e.record.type, e.record.seq]).sort((a, b) => a[1] - b[1]), [['delete', post.seq], ['delete', edit.seq]])
  t.alike((await web.request('feed.read', {})).items, [])
  t.alike(await web.request('post.delete', { to: ref }), { seq: d.seq - 1, ref: key + ':' + (d.seq - 1), changed: false, deleted: [post.seq] }, 'the repeat names the post tombstone and writes nothing')
  t.alike(internal, [], 'no internal error')
})

async function seederStack (t, bootstrap, assoc) {
  const dataDir = tmpDir(t, 'varanda-pe-seed-')
  Seeder.ensureConfig(dataDir, assoc.hex)
  const { publicKey } = Seeder.createKey(dataDir)
  const certFile = path.join(tmpDir(t, 'varanda-pe-sc-'), 'seeder-cert.json')
  fs.writeFileSync(certFile, JSON.stringify(createSeederCert({ seeder: publicKey }, assoc.kp)))
  Seeder.addCert(dataDir, certFile, assoc.hex)
  const seeder = new Seeder({ dataDir, ...localSwarmOptions(bootstrap), log: () => {} })
  t.teardown(() => seeder.close(), { force: true })
  await seeder.start()
  const ws = await startSeedWs({ port: 0, seeder })
  t.teardown(() => ws.close(), { force: true })
  return { url: 'ws://127.0.0.1:' + ws.port + '/seeder' }
}

test('a second reader converges to the edited text through the seeder (local testnet)', async (t) => {
  t.timeout(240000)
  const { bootstrap } = await testnet(t)
  const kp = generateAssociationKeyPair()
  const assoc = { kp, hex: hex(kp.publicKey) }
  const { url } = await seederStack(t, bootstrap, assoc)
  const node = (extra) => createBrowserNode({
    storage: memoryNodeStorage(),
    association: assoc.hex,
    seederUrl: url,
    createSocket: (u) => {
      const ws = new WebSocket(u)
      ws.on('error', () => {})
      return ws
    },
    syncOptions: { retryMinMs: 100, retryMaxMs: 200 },
    writeGate: false,
    ...extra
  })
  const a = node()
  const b = node()
  t.teardown(() => a.close(), { force: true })
  t.teardown(() => b.close(), { force: true })
  await a.setKeyPair(crypto.keyPair(), {})
  await b.setKeyPair(crypto.keyPair(), {})
  const wa = await connectClient(a, { timeoutMs: 60000 })
  const wb = await connectClient(b, { timeoutMs: 60000 })
  const { publicKey } = await wa.request('identity.create')
  await wa.request('cert.add', { cert: createCert({ member: publicKey }, assoc.kp) })
  const post = await wa.request('post.create', { text: 'antes' })
  await wa.request('post.edit', { to: publicKey + ':' + post.seq, text: 'depois' })
  await wa.request('sync.start', {})

  const idB = await wb.request('identity.create')
  await wb.request('cert.add', { cert: createCert({ member: idB.publicKey }, assoc.kp) })
  await wb.request('follow.add', { key: publicKey })
  const item = await until(async () => {
    await wb.request('sync.start', {}).catch(() => {})
    const items = (await wb.request('feed.read', {})).items.filter((i) => i.author === publicKey)
    return items.length > 0 && items[0].edited === true ? items[0] : null
  }, { timeoutMs: 120000, name: 'the second reader shows the edit' })
  t.is(item.text, 'depois')
})
