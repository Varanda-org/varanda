'use strict'

// lib/invite-card.js: the exact bytes, that every field is bound by the
// signature, domain separation from the signup-invite request, shape checks
// on the text, and that the module stays pure (no fs, no network).
const test = require('brittle')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const {
  PREFIX,
  digestText,
  cardFields,
  cardPayload,
  signInviteCard,
  verifyInviteCard
} = require('../lib/invite-card')
const invite = require('../lib/invite')

const coreRoot = path.join(__dirname, '..')

const MEMBER_KP = crypto.keyPair(b4a.alloc(32, 1))
const MEMBER = b4a.toString(MEMBER_KP.publicKey, 'hex')
const ASSOCIATION = 'cd'.repeat(32)
const CODE = 'A'.repeat(43)

const FIELDS = {
  code: CODE,
  design: 'cordel',
  name: 'Ana Maria',
  message: 'Vem pra Varanda!\nTe espero aqui.',
  expires: 1800000000,
  member: MEMBER,
  association: ASSOCIATION
}

test('isInviteCardExpired: one day of skew past expires, total on bad input', (t) => {
  const { isInviteCardExpired, EXPIRY_SKEW_S } = require('../lib/invite-card')
  t.is(EXPIRY_SKEW_S, 86400)
  const now = 1800000000
  t.is(isInviteCardExpired(now + 10, now), false, 'future')
  t.is(isInviteCardExpired(now - 3600, now), false, 'an hour past')
  t.is(isInviteCardExpired(now - 86400, now), false, 'exactly one day past')
  t.is(isInviteCardExpired(now - 86401, now), true, 'more than a day past')
  for (const bad of [null, '1800000000', 1.5, NaN]) t.is(isInviteCardExpired(bad, now), true, String(bad))
  t.is(isInviteCardExpired(now, undefined), true, 'no clock')
})

test('constants and digest', (t) => {
  t.is(PREFIX, 'varanda-invite-card-v1')
  const text = 'Olá, São João!'
  t.is(digestText(text), b4a.toString(crypto.hash(b4a.from(text, 'utf8')), 'hex'))
  t.ok(/^[0-9a-f]{64}$/.test(digestText(text)))
})

test('payload: exact lines, no trailing LF', (t) => {
  const payload = cardPayload(FIELDS)
  t.is(b4a.toString(payload, 'utf8'), [
    'varanda-invite-card-v1',
    CODE,
    'cordel',
    '1800000000',
    digestText(FIELDS.name),
    digestText(FIELDS.message),
    MEMBER,
    ASSOCIATION
  ].join('\n'))
  t.is(payload[payload.length - 1] === 0x0a, false, 'no trailing LF')
})

test('cardFields computes the digests and ignores passed ones', (t) => {
  const { reason, fields } = cardFields({ ...FIELDS, nameDigest: '00'.repeat(32), messageDigest: '00'.repeat(32) })
  t.is(reason, null)
  t.is(fields.nameDigest, digestText(FIELDS.name))
  t.is(fields.messageDigest, digestText(FIELDS.message))
  t.alike(cardFields(null), { reason: 'fields', fields: null })
})

test('round trip', (t) => {
  const signature = signInviteCard(FIELDS, MEMBER_KP)
  t.ok(/^[0-9a-f]{128}$/.test(signature))
  t.alike(verifyInviteCard(FIELDS, signature), { ok: true })
})

test('every field is bound by the signature', (t) => {
  const signature = signInviteCard(FIELDS, MEMBER_KP)
  const other = b4a.toString(crypto.keyPair(b4a.alloc(32, 2)).publicKey, 'hex')
  const changes = {
    code: { code: 'B'.repeat(43) },
    design: { design: 'chita' },
    name: { name: 'Ana Mario' },
    message: { message: 'Vem pra Varanda!' },
    expires: { expires: 1800000001 },
    member: { member: other },
    association: { association: 'ce'.repeat(32) }
  }
  for (const [name, change] of Object.entries(changes)) {
    t.alike(verifyInviteCard({ ...FIELDS, ...change }, signature), { ok: false, reason: 'bad-signature' }, name)
  }
  const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
  t.alike(verifyInviteCard(FIELDS, flipped), { ok: false, reason: 'bad-signature' }, 'one flipped digit')
})

test('domain separation from the signup-invite request', (t) => {
  const inviteFields = { action: 'issue', nonce: CODE, member: MEMBER, association: ASSOCIATION }
  const inviteSig = invite.signInvite(inviteFields, MEMBER_KP)
  t.alike(verifyInviteCard(FIELDS, inviteSig), { ok: false, reason: 'bad-signature' }, 'invite signature is not a card')
  const cardSig = signInviteCard(FIELDS, MEMBER_KP)
  t.alike(invite.verifyInvite(inviteFields, cardSig), { ok: false, reason: 'bad-signature' }, 'card signature is not an invite')
  // The card's own lines under the invite prefix never verify here.
  const rest = b4a.toString(cardPayload(FIELDS)).split('\n').slice(1).join('\n')
  const forged = b4a.toString(crypto.sign(b4a.from('varanda-invite-v1\n' + rest), MEMBER_KP.secretKey), 'hex')
  t.alike(verifyInviteCard(FIELDS, forged), { ok: false, reason: 'bad-signature' }, 'invite prefix over card lines')
})

test('shape: malformed text and fields, payload throws, verify never throws', (t) => {
  const signature = signInviteCard(FIELDS, MEMBER_KP)
  const bad = {
    'name with spaces around': { name: ' Ana ' },
    'name not NFC': { name: 'José' },
    'message not trimmed': { message: 'oi\n' },
    'control char in name': { name: 'Ana\u0007' },
    'LF in name': { name: 'Ana\nMaria' },
    'control char in message': { message: 'oi\u0000' },
    'lone surrogate in name': { name: 'Ana\ud800' },
    'lone surrogate in message': { message: 'oi\udc00' },
    '41 code point name': { name: 'a'.repeat(41) },
    'empty name': { name: '' },
    'empty message': { message: '' },
    'message over the byte cap': { message: 'é'.repeat(101) },
    'expires 2**32': { expires: 2 ** 32 },
    'expires 0': { expires: 0 },
    'expires string': { expires: '1800000000' },
    'unknown design': { design: 'nope' },
    'short code': { code: 'A'.repeat(42) },
    'upper hex member': { member: MEMBER.toUpperCase() },
    'short association': { association: 'cd'.repeat(31) },
    'name not a string': { name: 42 },
    'null name': { name: null },
    'null message': { message: null }
  }
  for (const [label, change] of Object.entries(bad)) {
    const input = { ...FIELDS, ...change }
    t.alike(verifyInviteCard(input, signature), { ok: false, reason: 'malformed' }, label)
    t.exception.all(() => cardPayload(input), TypeError, label + ' payload throws')
  }
  // JSON null would otherwise pass the canonical-equality check and throw
  // later while hashing: cardFields answers a reason instead.
  t.alike(cardFields({ ...FIELDS, name: null }), { reason: 'name', fields: null })
  t.alike(cardFields({ ...FIELDS, message: null }), { reason: 'message', fields: null })
  t.alike(cardFields({ ...FIELDS, message: null, expires: 0 }), { reason: 'message', fields: null })
  t.ok(cardFields({ ...FIELDS, name: 'a'.repeat(40) }).reason === null, '40 code points is fine')
  t.ok(cardFields({ ...FIELDS, expires: 2 ** 32 - 1 }).reason === null, '2**32 - 1 is fine')
  for (const input of [null, undefined, [], 'x', 42, new Map()]) {
    t.alike(verifyInviteCard(input, signature), { ok: false, reason: 'malformed' })
  }
  for (const sig of [null, '', signature.toUpperCase(), signature.slice(1), signature + '0']) {
    t.alike(verifyInviteCard(FIELDS, sig), { ok: false, reason: 'malformed' })
  }
  // A getter that names one member for the payload and another for the key
  // never verifies: the fields are read once.
  const attacker = crypto.keyPair(b4a.alloc(32, 9))
  const attackerHex = b4a.toString(attacker.publicKey, 'hex')
  const forgedSig = b4a.toString(crypto.sign(cardPayload(FIELDS), attacker.secretKey), 'hex')
  let reads = 0
  const shifty = { ...FIELDS }
  Object.defineProperty(shifty, 'member', { enumerable: true, get () { return ++reads <= 2 ? MEMBER : attackerHex } })
  t.alike(verifyInviteCard(shifty, forgedSig), { ok: false, reason: 'bad-signature' }, 'one read of member')
  const hostile = { ...FIELDS }
  Object.defineProperty(hostile, 'member', { enumerable: true, get () { throw new Error('boom') } })
  t.alike(verifyInviteCard(hostile, signature), { ok: false, reason: 'malformed' })
  t.exception.all(() => signInviteCard(FIELDS, null), TypeError)
  t.exception.all(() => signInviteCard(FIELDS, { secretKey: b4a.alloc(32) }), TypeError)
})

test('the module is pure: no fs, no network', (t) => {
  const code = [
    "const Module = require('node:module')",
    'const asked = []',
    'const load = Module._load',
    'Module._load = function (request, parent, ...rest) { asked.push([request, parent ? parent.filename : null]); return load.call(this, request, parent, ...rest) }',
    "require('./lib/invite-card.js')",
    'process.stdout.write(JSON.stringify({ asked, cached: Object.keys(require.cache) }))'
  ].join('\n')
  const r = spawnSync(process.execPath, ['-e', code], { cwd: coreRoot, encoding: 'utf8' })
  t.is(r.status, 0, r.stderr)
  const { asked, cached } = JSON.parse(r.stdout)
  const own = asked.filter(([, parent]) => parent === path.join(coreRoot, 'lib', 'invite-card.js')).map(([id]) => id)
  t.alike(own.sort(), ['@varanda/rpc', 'b4a', 'hypercore-crypto'], 'own requires')
  const all = asked.map(([id]) => id)
  for (const id of ['net', 'node:net', 'http', 'node:http', 'https', 'node:https', 'tls', 'node:tls', 'dgram', 'node:dgram', '#fs', '#path']) {
    t.absent(all.includes(id), 'not required: ' + id)
  }
  for (const frag of ['/lib/cert.js', '/lib/node/fs.js', '/hyperswarm/', '/hyperdht/', '/node_modules/hypercore/']) {
    t.absent(cached.some((p) => p.includes(frag)), 'not loaded: ' + frag)
  }
})
