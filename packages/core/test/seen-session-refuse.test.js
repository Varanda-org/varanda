'use strict'

// The seen blob is browser-node only (docs/protocol.md section 13): the node
// session answers seen.sign and seen.merge with USAGE before anything opens.
// Those handlers are called directly, because the refusal is the session's
// and it opens nothing. group.seen still goes through the RPC link and writes
// only group-seen.json.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')

const BOOTSTRAP = ['127.0.0.1:49737']
const NONCE = 'n'.repeat(54)
const BLOB = 'A'.repeat(43744)

const SEEN_NO = { code: 'USAGE', message: 'estado de vistos sincronizado só no navegador' }

// Params the RPC contract accepts (docs/rpc.md 5.88 and 5.89).
const CALLS = [
  ['seen.sign', { nonce: NONCE, action: 'read' }],
  ['seen.merge', { blob: null, avisos: { own: [] }, unchanged: false }]
]

// The member's own files. store/ is the storage engine's directory, whose
// logs rotate on their own and say nothing about what a refusal wrote.
function listTree (dir, top = true) {
  const out = []
  for (const name of fs.readdirSync(dir).sort()) {
    if (top && name === 'store') continue
    const full = path.join(dir, name)
    out.push(name)
    if (fs.statSync(full).isDirectory()) for (const sub of listTree(full, false)) out.push(name + '/' + sub)
  }
  return out
}

function refuse (session, method, params) {
  return failure(session.handlers[method](params))
}

function added (before, after) {
  const had = new Set(before)
  return after.filter((name) => !had.has(name)).sort()
}

test('seen.sign and seen.merge are refused before an identity, data dir untouched', async (t) => {
  const dataDir = tmpDir(t)
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: BOOTSTRAP })
  await connect(t, session)
  const before = listTree(dataDir)
  for (const [method, params] of CALLS) {
    t.alike(await refuse(session, method, params), SEEN_NO, method)
  }
  t.alike(await refuse(session, 'seen.sign', { nonce: NONCE, action: 'write' }), SEEN_NO, 'write')
  t.alike(await refuse(session, 'seen.merge', { blob: BLOB, avisos: { own: ['ab'.repeat(16)] }, unchanged: false }), SEEN_NO, 'merge with a blob')
  t.alike(listTree(dataDir), before, 'no file created')
  t.alike(session.internal, [], 'no internal error')
})

test('seen.sign and seen.merge are refused with an identity, nothing written', async (t) => {
  const dataDir = tmpDir(t)
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  const log = await link.call('log.read')
  const before = listTree(dataDir)
  for (const [method, params] of CALLS) {
    t.alike(await refuse(session, method, params), SEEN_NO, method)
  }
  t.alike(await refuse(session, 'seen.sign', { action: 'delete', nonce: NONCE, prevHash: 'cd'.repeat(32) }), SEEN_NO, 'delete')
  t.alike(listTree(dataDir), before, 'no file created')
  t.alike(await link.call('log.read'), log, 'nothing appended')
  t.alike(session.internal, [], 'no internal error')
})

test('group.seen still updates only the local file', async (t) => {
  const dataDir = tmpDir(t)
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  await link.call('profile.set', { name: 'Ana' })
  const { group } = await link.call('community.create', { name: 'Bairro', join: 'open' })
  await link.call('group.post', { group, text: 'oi da Ana' })
  const log = await link.call('log.read')
  const before = listTree(dataDir)
  t.absent(before.includes('group-seen.json'), 'no mark yet')

  t.alike(await link.call('group.seen', { group }), { ok: true })
  const after = listTree(dataDir)
  t.ok(after.includes('group-seen.json'))
  // Reopening the store may add a file under store/. The seen mark is the
  // only new file outside it, and nothing is written for the synced blob.
  const extra = added(before, after).filter((name) => name !== 'group-seen.json' && !name.startsWith('store'))
  t.alike(extra, [], 'only group-seen.json is new')
  t.absent(after.some((name) => name === 'seen' || name.startsWith('seen/')), 'no synced blob')

  const seenPath = path.join(dataDir, 'group-seen.json')
  const stat = fs.statSync(seenPath)
  t.is(stat.mode & 0o777, 0o600)
  const raw = fs.readFileSync(seenPath, 'utf8')
  t.absent(raw.includes('oi da Ana'), 'the file holds no post text')
  const data = JSON.parse(raw)
  t.is(data.v, 1)
  t.is(data.marks.length, 1)
  const mark = data.marks[0]
  t.alike(Object.keys(mark).sort(), ['at', 'group', 'seq', 'writer'])
  t.is(mark.group, group)
  t.ok(/^[0-9a-f]{64}$/.test(mark.writer))
  t.ok(Number.isSafeInteger(mark.seq) && mark.seq >= 1)
  t.is(new Date(mark.at).toISOString(), mark.at)

  t.alike(await link.call('group.seen', { group }), { ok: true })
  const again = fs.statSync(seenPath)
  t.alike([again.ino, again.mtimeMs], [stat.ino, stat.mtimeMs], 'an unchanged mark is not written again')
  t.is(fs.readFileSync(seenPath, 'utf8'), raw)

  for (const [method, params] of CALLS) {
    t.alike(await refuse(session, method, params), SEEN_NO, method)
  }
  t.is(fs.readFileSync(seenPath, 'utf8'), raw, 'a refusal leaves the mark')
  t.alike(listTree(dataDir), after, 'a refusal creates nothing')
  t.alike(await link.call('log.read'), log, 'the diary is unchanged')
  t.alike(session.internal, [], 'no internal error')
})
