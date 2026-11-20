'use strict'

// page.sign 'invite' (docs/rpc.md 5.84): the owner's statement signs an
// optional share { sealed, sig }; any other key in the op, or a malformed
// share, is refused.
const test = require('brittle')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { pageSignResult } = require('../lib/session')
const { opHash, verifyPage } = require('@varanda/core/lib/page-proof')
const { generateAssociationKeyPair } = require('@varanda/core/lib/cert')

const NONCE = 'A-_9'.repeat(11)
const AT = '2026-11-03T12:00:00.000Z'
const hex = (b) => b4a.toString(b, 'hex')

function setup () {
  const owner = crypto.keyPair()
  const assoc = hex(generateAssociationKeyPair().publicKey)
  const ownHex = hex(owner.publicKey)
  const page = hex(crypto.keyPair().publicKey)
  const member = hex(crypto.keyPair().publicKey)
  const roster = { owner: ownHex, admins: [member], prev: null, at: AT, nonce: NONCE }
  const op = { member, gen: 2, rosterSignature: 'x', roster }
  const sign = (o) => pageSignResult({ action: 'invite', nonce: NONCE, page, op: o }, ownHex, owner, assoc)
  return { sign, op, ownHex, page, assoc, owner }
}

test('invite without a share signs the statement', (t) => {
  const { sign, op } = setup()
  const r = sign(op)
  t.is(r.record.type, 'page-roster')
  t.is(typeof r.signature, 'string')
})

test('invite with a share: the share is covered by the statement hash', (t) => {
  const { sign, op, ownHex, page, assoc } = setup()
  const share = { sealed: 'abc', sig: 'ab'.repeat(64) }
  const r = sign({ ...op, share })
  t.is(r.record.type, 'page-roster')
  const withoutShare = sign(op)
  t.not(r.signature, withoutShare.signature, 'share changes the statement')
  const signed = { ...op, share, rosterSignature: r.record.signature }
  t.ok(verifyPage({ action: 'invite', nonce: NONCE, member: ownHex, page, association: assoc, opHash: opHash(signed) }, r.signature, ownHex), 'verifies over the op with the share')
})

const refused = (t, fn) => {
  try {
    fn()
    t.fail('accepted')
  } catch (err) {
    t.is(err.message, 'invalid page op')
  }
}

test('invite refuses an unknown key and a malformed share', (t) => {
  const { sign, op } = setup()
  const good = { sealed: 'abc', sig: 'ab'.repeat(64) }
  refused(t, () => sign({ ...op, extra: 1 }))
  refused(t, () => sign({ ...op, share: { ...good, extra: 1 } }))
  refused(t, () => sign({ ...op, share: { sealed: 'abc' } }))
  refused(t, () => sign({ ...op, share: { sealed: 1, sig: good.sig } }))
  refused(t, () => sign({ ...op, share: { sealed: 'abc', sig: 'zz' } }))
  refused(t, () => sign({ ...op, share: null }))
})
