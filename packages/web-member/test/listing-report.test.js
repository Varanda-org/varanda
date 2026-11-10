'use strict'

// report.sign with kind 'listing' on the browser node: the listing report
// statement (core lib/report.js signListingReport), never a post report.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { createCert, generateAssociationKeyPair } = require('@varanda/core/lib/cert')
const { verifyReport, verifyListingReport } = require('@varanda/core/lib/report')
const { createBrowserNode } = require('../lib/node')
const { memoryNodeStorage } = require('../lib/node-storage')
const ops = require('../lib/member-ops')
const { connectClient, errorOf } = require('./helpers/session')

const hex = (buf) => b4a.toString(buf, 'hex')
const KEY = 'ab'.repeat(32)

async function setup (t) {
  const assoc = generateAssociationKeyPair()
  const association = hex(assoc.publicKey)
  const storage = memoryNodeStorage()
  const keyPair = crypto.keyPair()
  const key = hex(keyPair.publicKey)
  const ctx = { storage, association, keyPair }
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
  await node.setKeyPair(keyPair)
  const web = await connectClient(node)
  return { web, key, association, internal }
}

test('report.sign kind listing signs the listing statement, not a post report', async (t) => {
  const s = await setup(t)
  const params = { nonce: 'A'.repeat(43), target: KEY, seq: 7, reason: 'spam', text: 'golpe', quote: 'Bicicleta', kind: 'listing' }
  const { signature } = await s.web.request('report.sign', params)
  const fields = { nonce: params.nonce, member: s.key, association: s.association, target: KEY, seq: 7, reason: 'spam', text: 'golpe', quote: 'Bicicleta' }
  t.alike(verifyListingReport(fields, signature), { ok: true }, 'the listing statement verifies')
  t.absent(verifyReport(fields, signature).ok, 'never valid as a post report')
  t.absent(verifyListingReport({ ...fields, seq: 8 }, signature).ok, 'bound to the listing seq')

  const post = await s.web.request('report.sign', { nonce: params.nonce, target: KEY, seq: 7, reason: 'spam', text: 'golpe', quote: 'Bicicleta' })
  t.ok(verifyReport(fields, post.signature).ok, 'without kind a post report as before')
  t.absent(verifyListingReport(fields, post.signature).ok, 'and no listing report')

  const self = await errorOf(s.web.request('report.sign', { ...params, target: s.key }))
  t.is(self.code, 'USAGE', 'the own key is refused')
  const noSeq = await errorOf(s.web.request('report.sign', { nonce: params.nonce, target: KEY, reason: 'spam', kind: 'listing' }))
  t.is(noSeq.code, 'USAGE', 'kind listing needs seq')
  t.alike(s.internal, [])
})
