'use strict'

// lib/invite-card.js: the strict member key check in front of the core
// verifier. Every small-order point and a non-canonical encoding are
// malformed whatever the signature; a valid card verifies.
const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { ED25519_TORSION_SUBGROUP } = require('@noble/curves/ed25519.js')
const { signInviteCard } = require('@varanda/core/lib/invite-card')
const { strictVerifyInviteCard } = require('../lib/invite-card')

const KP = crypto.keyPair(b4a.alloc(32, 7))
const FIELDS = {
  code: 'A'.repeat(43),
  design: 'ipe',
  name: 'Ana Maria',
  message: 'Vem pra Varanda!',
  expires: 1800000000,
  member: b4a.toString(KP.publicKey, 'hex'),
  association: 'cd'.repeat(32)
}
// R = the identity point, S = 0: what a lax verifier accepts for any
// message under a small-order key.
const IDENTITY_SIG = '01' + '00'.repeat(63)

test('a valid card verifies', (t) => {
  const signature = signInviteCard(FIELDS, KP)
  t.alike(strictVerifyInviteCard(FIELDS, signature), { ok: true })
  t.alike(strictVerifyInviteCard({ ...FIELDS, message: 'Outra coisa' }, signature), { ok: false, reason: 'bad-signature' })
})

test('the input is read once: the strict check and the signature check see one member', (t) => {
  const signature = signInviteCard(FIELDS, KP)
  let reads = 0
  const input = { ...FIELDS }
  Object.defineProperty(input, 'member', { enumerable: true, get () { reads++; return reads === 1 ? FIELDS.member : ED25519_TORSION_SUBGROUP[0] } })
  t.alike(strictVerifyInviteCard(input, signature), { ok: true })
  t.is(reads, 1, 'member read once')
  const hostile = {}
  Object.defineProperty(hostile, 'member', { enumerable: true, get () { throw new Error('boom') } })
  t.alike(strictVerifyInviteCard(hostile, signature), { ok: false, reason: 'malformed' }, 'a throwing getter never throws out')
})

test('each of the eight small-order points is malformed', (t) => {
  t.is(ED25519_TORSION_SUBGROUP.length, 8)
  const signature = signInviteCard(FIELDS, KP)
  for (const member of ED25519_TORSION_SUBGROUP) {
    t.alike(strictVerifyInviteCard({ ...FIELDS, member }, IDENTITY_SIG), { ok: false, reason: 'malformed' }, member)
    t.alike(strictVerifyInviteCard({ ...FIELDS, member }, signature), { ok: false, reason: 'malformed' }, member + ' with a real signature')
  }
})

test('a non-canonical encoding (y >= p) is malformed', (t) => {
  // y = p + 1 (the identity) and y = p + 3, both under 2^255.
  for (const member of [
    'ee' + 'ff'.repeat(30) + '7f',
    'f0' + 'ff'.repeat(30) + '7f',
    'f0' + 'ff'.repeat(31)
  ]) {
    t.alike(strictVerifyInviteCard({ ...FIELDS, member }, IDENTITY_SIG), { ok: false, reason: 'malformed' }, member)
  }
})

test('a bad shape is malformed and never throws', (t) => {
  const signature = signInviteCard(FIELDS, KP)
  t.alike(strictVerifyInviteCard(null, signature), { ok: false, reason: 'malformed' })
  t.alike(strictVerifyInviteCard({ ...FIELDS, member: 'AB'.repeat(32) }, signature), { ok: false, reason: 'malformed' })
  t.alike(strictVerifyInviteCard({ ...FIELDS, member: undefined }, signature), { ok: false, reason: 'malformed' })
  t.alike(strictVerifyInviteCard(FIELDS, 'zz'), { ok: false, reason: 'malformed' })
})
