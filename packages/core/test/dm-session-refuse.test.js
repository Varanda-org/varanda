'use strict'

// Conversas are browser-node only (docs/rpc.md 5.71 to 5.79): the node
// session answers every dm.* with USAGE before anything opens.
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation, issueCertificate } = require('../lib/assoc')

const BOOTSTRAP = ['127.0.0.1:49737']
const KEY = 'ab'.repeat(32)
const ID = 'cd'.repeat(16)

const DM_NO = { code: 'USAGE', message: 'mensagens diretas disponíveis só no navegador' }
const SIGN_NO = { code: 'USAGE', message: 'assinatura disponível só no navegador' }

const CALLS = [
  ['dm.enable', {}, DM_NO],
  ['dm.lookup', { member: KEY }, DM_NO],
  ['dm.send', { to: KEY, text: 'oi', replyTo: ID }, DM_NO],
  ['dm.pull', {}, DM_NO],
  ['dm.list', {}, DM_NO],
  ['dm.thread', { peer: KEY, before: ID, limit: 10 }, DM_NO],
  ['dm.set', { peer: KEY, state: 'blocked' }, DM_NO],
  ['dm.seen', { peer: KEY }, DM_NO],
  ['dm.reportSign', { nonce: 'n'.repeat(43), target: KEY, reason: 'assedio', quote: 'mensagem' }, SIGN_NO]
]

function listTree (dir) {
  const out = []
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    out.push(name)
    if (fs.statSync(full).isDirectory()) for (const sub of listTree(full)) out.push(name + '/' + sub)
  }
  return out
}

test('every dm.* is refused by the node session before an identity, data dir untouched', async (t) => {
  const dataDir = tmpDir(t)
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const before = listTree(dataDir)
  for (const [method, params, expected] of CALLS) {
    t.alike(await failure(link.call(method, params)), expected, method)
  }
  t.alike(listTree(dataDir), before, 'no file created')
  t.alike(session.internal, [], 'no internal error')
})

test('every dm.* is refused by the node session with an identity, nothing written', async (t) => {
  const dataDir = tmpDir(t)
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: BOOTSTRAP })
  const link = await connect(t, session)
  const { publicKey } = await link.call('identity.create')
  await link.call('cert.add', { cert: issueCertificate(assocDir, { member: publicKey }) })
  const log = await link.call('log.read')
  const before = listTree(dataDir)
  for (const [method, params, expected] of CALLS) {
    t.alike(await failure(link.call(method, params)), expected, method)
  }
  t.alike(await failure(link.call('dm.lookup', { member: publicKey })), DM_NO, 'own key')
  t.alike(listTree(dataDir), before, 'no file created')
  t.alike(await link.call('log.read'), log, 'nothing appended')
  t.alike(session.internal, [], 'no internal error')
})
