'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const certLib = require('../lib/cert')
const { MAX_HELD_USERNAMES, heldUsernames, latestUsername } = require('../lib/username')

const K1 = 'a'.repeat(64)
const K2 = 'b'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'

function issuerSetup (assocKp = crypto.keyPair()) {
  const issuerKp = crypto.keyPair()
  const issuerCert = certLib.createIssuerCert({ issuer: b4a.toString(issuerKp.publicKey, 'hex'), date: AT }, assocKp)
  return { assocKp, assocHex: issuerCert.association, issuerKp, issuerCert, issuer: issuerCert.issuer }
}

function named (username, setup, member = K1) {
  return certLib.createUsernameRecord({ member, username, date: AT }, setup.issuerKp, setup.issuerCert)
}

function genesis (setup) {
  const v2 = certLib.createIssuedCert({ member: K1, date: AT }, setup.issuerKp, setup.issuerCert)
  return { seq: 0, record: { type: 'member-cert', cert: v2 } }
}

// Counts the verifications heldUsernames makes; username.js calls them
// through the cert module object.
function spyVerify (t) {
  const original = certLib.verifyUsernameRecord
  const spy = { calls: 0 }
  certLib.verifyUsernameRecord = (...args) => {
    spy.calls++
    return original(...args)
  }
  t.teardown(() => { certLib.verifyUsernameRecord = original })
  return spy
}

test('heldUsernames: every verified own name maps to its issuer', async (t) => {
  const setup = issuerSetup()
  const second = issuerSetup(setup.assocKp)
  const entries = [
    genesis(setup),
    { seq: 1, record: named('ana', setup) },
    { seq: 2, record: { type: 'post', text: 'oi', at: AT, replyTo: null } },
    { seq: 3, record: named('bia', second) }
  ]
  const held = heldUsernames(entries, K1, setup.assocHex)
  t.alike([...held.entries()].sort(), [['ana', setup.issuer], ['bia', second.issuer]])
  t.alike(heldUsernames(entries.slice().reverse(), K1, setup.assocHex), held, 'the seq orders, not the input')
  t.is(latestUsername(entries, K1, setup.assocHex), 'bia', 'latestUsername still gives only the newest')

  // a name held twice maps to the issuer of its newest record
  const again = entries.concat([{ seq: 4, record: named('ana', second) }])
  t.is(heldUsernames(again, K1, setup.assocHex).get('ana'), second.issuer)
})

test('heldUsernames: copied records, revoked issuers and failed signatures are absent', async (t) => {
  const setup = issuerSetup()
  const second = issuerSetup(setup.assocKp)
  const other = issuerSetup()
  const ana = named('ana', setup)
  const entries = [
    genesis(setup),
    { seq: 1, record: ana },
    { seq: 2, record: named('caio', setup, K2) },
    { seq: 3, record: named('bia', second) }
  ]
  t.alike([...heldUsernames(entries, K1, setup.assocHex).keys()].sort(), ['ana', 'bia'], 'a copied record is ignored')
  t.alike([...heldUsernames(entries, K2, setup.assocHex).keys()], ['caio'], 'it belongs to its own member')

  const revoked = heldUsernames(entries, K1, setup.assocHex, { revokedIssuers: new Set([setup.issuer]) })
  t.alike([...revoked.entries()], [['bia', second.issuer]], 'a revoked issuer drops only its record')

  // a bad newest record does not hide an earlier good one
  for (const [label, record] of [
    ['a tampered name', { ...ana, username: 'fabi' }],
    ['another association', named('dani', other)],
    ['a swapped issuerSignature', { ...named('edu', setup), issuerSignature: other.issuerCert.signature }]
  ]) {
    const held = heldUsernames(entries.concat([{ seq: 4, record }]), K1, setup.assocHex)
    t.alike([...held.keys()].sort(), ['ana', 'bia'], label + ' on the newest record')
    t.is(latestUsername(entries.concat([{ seq: 4, record }]), K1, setup.assocHex), null, label + ': latestUsername has no fallback')
  }
})

test('heldUsernames: only the newest MAX_HELD_USERNAMES records are candidates', async (t) => {
  t.is(MAX_HELD_USERNAMES, 64)
  const setup = issuerSetup()
  const entries = [genesis(setup)]
  for (let i = 1; i <= MAX_HELD_USERNAMES + 1; i++) entries.push({ seq: i, record: named('u_' + i, setup) })

  const spy = spyVerify(t)
  const held = heldUsernames(entries, K1, setup.assocHex)
  t.is(held.size, MAX_HELD_USERNAMES)
  t.absent(held.has('u_1'), 'the 65th-oldest name is outside the window')
  t.ok(held.has('u_2') && held.has('u_65'))
  t.is(spy.calls, MAX_HELD_USERNAMES, 'at most MAX_HELD_USERNAMES verifications')

  // 64 newer shape-valid junk records push a good name out of the window
  const junk = [genesis(setup), { seq: 1, record: named('ana', setup) }]
  const forged = { ...named('bia', setup), username: 'zeca' }
  for (let i = 2; i <= MAX_HELD_USERNAMES + 1; i++) junk.push({ seq: i, record: forged })
  spy.calls = 0
  t.is(heldUsernames(junk, K1, setup.assocHex).size, 0)
  t.is(spy.calls, MAX_HELD_USERNAMES)
  t.is(heldUsernames(junk.slice(0, -1), K1, setup.assocHex).get('ana'), setup.issuer, 'inside the window it is found')
  t.is(latestUsername(entries, K1, setup.assocHex), 'u_65')
})

test('heldUsernames: garbage gives an empty Map and never throws', async (t) => {
  const setup = issuerSetup()
  const entries = [genesis(setup), { seq: 1, record: named('ana', setup) }]
  const bad = [null, undefined, 5, 'x', [null], [{ seq: 1, get record () { throw new Error('boom') } }], [{ seq: 0, record: named('ana', setup) }]]
  for (const input of bad) {
    const held = heldUsernames(input, K1, setup.assocHex)
    t.ok(held instanceof Map)
    t.is(held.size, 0)
  }
  t.is(heldUsernames(entries, null, setup.assocHex).size, 0)
  t.is(heldUsernames(entries, K1, 'zz').size, 0)
  t.is(heldUsernames(entries, K1, null).size, 0)
})
