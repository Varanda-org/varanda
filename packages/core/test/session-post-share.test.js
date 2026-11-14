'use strict'

// post.shared, post.share and post.unshare are browser-node only (docs/rpc.md
// 5.121 to 5.123): the core session answers them with USAGE before anything
// opens.
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

test('the core node refuses post.shared, post.share and post.unshare before anything opens', async (t) => {
  const NO = { code: 'USAGE', message: 'A página pública de uma publicação só pode ser ligada pelo app ou pelo navegador.' }
  const dataDir = tmpDir(t)
  const assocDir = path.join(tmpDir(t, 'varanda-assoc-'), 'assoc')
  const { publicKey: assoc } = initAssociation(assocDir)
  const session = newSession(t, { dataDir, association: assoc, bootstrap: ['127.0.0.1:49737'] })
  await connect(t, session)
  const before = listTree(dataDir)
  const to = A + ':1'
  t.alike(await failure(session.handlers['post.shared']({ to })), NO)
  t.alike(await failure(session.handlers['post.share']({ to })), NO)
  t.alike(await failure(session.handlers['post.unshare']({ to })), NO)
  t.alike(listTree(dataDir), before, 'no file created')
})
