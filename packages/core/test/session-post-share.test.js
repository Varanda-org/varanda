'use strict'

// Public post sharing belongs to the browser node (docs/rpc.md 5.121 to
// 5.123 and 5.169).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { tmpDir } = require('./helpers/tmp')
const { newSession, connect, failure } = require('./helpers/net')
const { initAssociation } = require('../lib/assoc')

const key = (i) => i.toString(16).padStart(64, '0')
const A = key(1)

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

test('the core node refuses public post sharing before opening the diary', async (t) => {
  const NO = { code: 'USAGE', message: 'A página pública de uma publicação só pode ser ligada pelo app ou pelo navegador.' }
  const dataDir = tmpDir(t)
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const session = newSession(t, { dataDir, association: assoc, dhtHost: '127.0.0.1', bootstrap: ['127.0.0.1:49737'] })
  const { call } = await connect(t, session)
  const before = listTree(dataDir)
  const to = A + ':1'
  t.alike(await failure(call('post.uncovered', {})), NO)
  t.alike(await failure(session.handlers['post.shared']({ to })), NO)
  t.alike(await failure(session.handlers['post.share']({ to })), NO)
  t.alike(await failure(session.handlers['post.unshare']({ to })), NO)
  const image = { core: A, mime: 'image/jpeg', start: 1, blocks: 1, bytes: 1, sha256: A, width: 1, height: 1 }
  t.alike(await failure(call('post.cover', { to, image })), NO)
  t.absent(fs.existsSync(path.join(dataDir, 'store')), 'store was never opened')
  t.alike(listTree(dataDir), before, 'no file created')
})
