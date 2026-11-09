'use strict'

// The direct message inner plaintext, its sealed envelope and the drop
// frame (lib/dm.js). No network.
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const hcrypto = require('hypercore-crypto')
const dm = require('../lib/dm')
const { generateAssociationKeyPair, createCert, createIssuerCert, createIssuedCert } = require('../lib/cert')
const { MAX_TEXT, dmTextBudget } = require('@varanda/rpc')

const {
  DM_MAX_TEXT, DM_INNER_BYTES, DM_SEAL_BYTES, DM_SEALED_BYTES, DM_DROP_BYTES, DM_PAGE_MAX, DM_MAX_MESSAGE,
  DM_SIG_PREFIX, DM_SIG_PREFIX_V2, DROP, buildInner, openInner, sealInner, openSealed, encodeDrop, decodeDrop, newDropId,
  textBudget
} = dm

const AT = '2026-11-03T12:00:00.000Z'
const assoc = generateAssociationKeyPair()
const ASSOC = b4a.toString(assoc.publicKey, 'hex')
const O = { association: ASSOC }

function boxPair () {
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(32)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey, hex: b4a.toString(publicKey, 'hex') }
}

function signPair () {
  const kp = hcrypto.keyPair()
  return { ...kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

const ana = signPair()
const bia = signPair()
const caio = signPair()
for (const p of [ana, bia, caio]) p.cert = createCert({ member: p.hex, date: AT }, assoc)

// A signed inner of any body (for shapes buildInner refuses).
function forge (body, signer, prefix = DM_SIG_PREFIX) {
  const json = b4a.from(JSON.stringify(body))
  const sig = hcrypto.sign(b4a.concat([b4a.from(prefix), json]), signer.secretKey)
  const out = b4a.alloc(DM_INNER_BYTES)
  out[0] = json.byteLength >> 8
  out[1] = json.byteLength & 0xff
  out.set(json, 2)
  out.set(sig, 2 + json.byteLength)
  return out
}

function msg (over = {}, from = ana) {
  return buildInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT, cert: from.cert, ...over }, from)
}

test('constants', (t) => {
  t.ok(Object.isFrozen(dm))
  t.is(dm.DM_PROTOCOL, 'varanda/dm/1')
  t.is(dm.DM_STAMP_PROTOCOL, 'varanda/dm-stamp/1')
  t.is(DM_MAX_TEXT, 1000)
  t.is(DM_MAX_TEXT, MAX_TEXT, 'same limit as posts')
  t.is(DM_INNER_BYTES, 5120)
  t.is(DM_SEAL_BYTES, 48)
  t.is(DM_SEAL_BYTES, sodium.crypto_box_SEALBYTES)
  t.is(DM_SEALED_BYTES, DM_INNER_BYTES + DM_SEAL_BYTES)
  t.is(DM_SEALED_BYTES, 5168)
  t.is(DM_DROP_BYTES, DROP.SEALED_OFFSET + DM_SEALED_BYTES)
  t.is(DM_DROP_BYTES, 5501)
  t.is(dm.DM_MAGIC, 'VDM1')
  t.is(dm.DM_VERSION, 1)
  t.is(dm.DM_RETENTION_MS, 7 * 86400000)
  t.is(dm.DM_POOL_MAX, 20000)
  t.is(DM_PAGE_MAX, 8)
  t.is(dm.DM_PULL_BUDGET_BYTES, 8388608)
  t.is(DM_MAX_MESSAGE, 65536)
  t.is(dm.DM_STAMPS_PER_DAY, 200)
  t.is(dm.DM_STAMP_WALLET, 20)
  t.is(dm.DM_STAMP_WALLET_LOW, 10)
  t.is(dm.DM_REQUESTS_MAX, 100)
  t.is(dm.DM_MESSAGES_PER_PEER, 500)
  t.is(DM_SIG_PREFIX, 'varanda-dm-v1\n')
  t.is(dm.DM_KEY_HKDF_SALT, 'varanda/member-dm-box/hkdf/v1')
  t.is(dm.DM_KEY_HKDF_INFO, 'varanda/member-dm-box/x25519/v1')
  t.is(dm.DM_LOCAL_HKDF_SALT, 'varanda/member-dm-local/hkdf/v1')
  t.is(dm.DM_LOCAL_HKDF_INFO, 'varanda/member-dm-local/secretbox/v1')
  t.is(dm.DM_STAMP_FDH_DOMAIN, 'varanda/dm-stamp-fdh/v1')
})

test('drop offsets sum to the frame size', (t) => {
  const parts = [
    [DROP.MAGIC_OFFSET, DROP.MAGIC_BYTES],
    [DROP.VERSION_OFFSET, DROP.VERSION_BYTES],
    [DROP.ID_OFFSET, DROP.ID_BYTES],
    [DROP.KID_OFFSET, DROP.KID_BYTES],
    [DROP.SIG_OFFSET, DROP.SIG_BYTES],
    [DROP.TOKEN_OFFSET, DROP.TOKEN_BYTES],
    [DROP.SEALED_OFFSET, DROP.SEALED_BYTES]
  ]
  let at = 0
  for (const [offset, len] of parts) {
    t.is(offset, at)
    at += len
  }
  t.is(at, DM_DROP_BYTES)
  t.alike(parts.map(p => p[0]), [0, 4, 5, 37, 45, 301, 333])
})

test('a full page of drops fits one channel message', (t) => {
  const drop = b4a.toString(b4a.alloc(DM_DROP_BYTES, 0xff), 'base64')
  const items = { type: 'items', items: new Array(DM_PAGE_MAX).fill(0).map(() => ({ seq: Number.MAX_SAFE_INTEGER, drop })), next: Number.MAX_SAFE_INTEGER, oldest: Number.MAX_SAFE_INTEGER }
  t.ok(b4a.byteLength(JSON.stringify(items)) < DM_MAX_MESSAGE, DM_PAGE_MAX + ' base64 drops stay under DM_MAX_MESSAGE')
})

test('inner: round trip, recipient and self copy', (t) => {
  const inner = msg({ replyTo: 'c'.repeat(32) })
  t.is(inner.byteLength, DM_INNER_BYTES)
  const copy = b4a.from(inner)
  const body = openInner(inner, bia.hex, O)
  t.is(body.kind, 'msg')
  t.is(body.from, ana.hex)
  t.is(body.to, bia.hex)
  t.is(body.text, 'oi')
  t.is(body.replyTo, 'c'.repeat(32))
  t.is(body.op, null)
  t.is(body.peer, null)
  t.is(body.at, AT)
  t.ok(/^[0-9a-f]{32}$/.test(body.id))
  t.is(body.mine, false)
  t.ok(inner.every(x => x === 0), 'plaintext zeroed after reading')

  const self = openInner(b4a.from(copy), ana.hex, O)
  t.is(self.mine, true, 'self copy opens for the sender identity')
  t.is(self.id, body.id)
  t.is(openInner(b4a.from(copy), caio.hex, O), null, 'third party')
})

test('inner: layout and signature over the exact JSON', (t) => {
  const inner = msg()
  const len = (inner[0] << 8) | inner[1]
  const json = inner.subarray(2, 2 + len)
  const parsed = JSON.parse(b4a.toString(json))
  t.alike(Object.keys(parsed), ['v', 'kind', 'id', 'from', 'to', 'replyTo', 'text', 'op', 'peer', 'at', 'cert'])
  t.alike(parsed.cert, ana.cert)
  const sig = inner.subarray(2 + len, 2 + len + 64)
  t.ok(hcrypto.verify(b4a.concat([b4a.from(DM_SIG_PREFIX), json]), sig, ana.publicKey))
  t.ok(inner.subarray(2 + len + 64).every(x => x === 0), 'zero padding')

  const flipped = b4a.from(inner)
  flipped[2 + len + 3] ^= 1
  t.is(openInner(flipped, bia.hex, O), null, 'bad signature')
  const tail = b4a.from(inner)
  tail[DM_INNER_BYTES - 1] = 1
  t.is(openInner(tail, bia.hex, O), null, 'non-zero padding')

  // Same fields, reordered and re-signed: the exact bytes rule refuses it.
  const reordered = { ...parsed }
  delete reordered.v
  reordered.v = 1
  const rj = b4a.from(JSON.stringify(reordered))
  const rs = hcrypto.sign(b4a.concat([b4a.from(DM_SIG_PREFIX), rj]), ana.secretKey)
  const forged = b4a.alloc(DM_INNER_BYTES)
  forged[0] = rj.byteLength >> 8
  forged[1] = rj.byteLength & 0xff
  forged.set(rj, 2)
  forged.set(rs, 2 + rj.byteLength)
  t.is(openInner(forged, bia.hex, O), null)
})

test('inner: text rules', (t) => {
  t.ok(msg({ text: 'a\nb' }), 'LF allowed')
  t.exception.all(() => msg({ text: '' }), /mensagem inválida/)
  t.exception.all(() => msg({ text: 'a\tb' }), /mensagem inválida/)
  t.exception.all(() => msg({ text: 'a\u0000' }), /mensagem inválida/)
  t.exception.all(() => msg({ text: '\ud800' }), /mensagem inválida/, 'lone surrogate')
  t.exception.all(() => msg({ text: 'x'.repeat(DM_MAX_TEXT + 1) }), /mensagem inválida/)
  t.exception.all(() => msg({ to: ana.hex }), /mensagem inválida/, 'from === to')
  t.exception.all(() => msg({ op: 'accepted' }), /mensagem inválida/)
  t.exception.all(() => msg({ replyTo: 'x' }), /mensagem inválida/)
  t.exception.all(() => msg({ at: 'nope' }), /mensagem inválida/)
  t.exception.all(() => msg({ from: bia.hex }), /mensagem inválida/)

  const wide = '\u{1F600}'.repeat(DM_MAX_TEXT)
  const inner = msg({ text: wide })
  t.is(openInner(inner, bia.hex, O).text, wide, '1000 four-byte characters fit')
  const lf = msg({ text: '\n'.repeat(DM_MAX_TEXT) })
  t.is(openInner(lf, bia.hex, O).text.length, DM_MAX_TEXT)
})

test('inner: the largest accepted text fits', (t) => {
  // The largest certificates: a v1 with 32-character ageBand and method,
  // and a v2 (issuer, issuer date and two signatures).
  const v1 = signPair()
  v1.cert = createCert({ member: v1.hex, ageBand: 'a'.repeat(32), method: 'b'.repeat(32), date: AT }, assoc)
  const issuer = hcrypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: b4a.toString(issuer.publicKey, 'hex'), date: AT }, assoc)
  const v2 = signPair()
  v2.cert = createIssuedCert({ member: v2.hex, date: AT }, issuer, issuerCert)
  for (const who of [v1, v2]) {
    const worst = buildInner({ kind: 'msg', to: bia.hex, text: '\u{1F600}'.repeat(DM_MAX_TEXT), at: AT, replyTo: 'a'.repeat(32), cert: who.cert }, who)
    const len = (worst[0] << 8) | worst[1]
    t.ok(len + 66 <= DM_INNER_BYTES, 'v' + who.cert.v + ' worst case fits (' + (len + 66) + ' bytes)')
    t.is(openInner(worst, bia.hex, O).text, '\u{1F600}'.repeat(DM_MAX_TEXT))
  }
  const escaped = buildInner({ kind: 'msg', to: bia.hex, text: '\\"'.repeat(DM_MAX_TEXT / 2), at: AT, cert: ana.cert }, ana)
  t.is(openInner(escaped, bia.hex, O).text, '\\"'.repeat(DM_MAX_TEXT / 2), 'escaped characters fit')
  t.exception.all(() => buildInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT }, { publicKey: ana.publicKey, secretKey: b4a.alloc(10) }), /chave de assinatura inválida/)
})

test('inner: ctl envelopes', (t) => {
  const ctl = buildInner({ kind: 'ctl', op: 'blocked', peer: bia.hex, at: AT }, ana)
  const body = openInner(b4a.from(ctl), ana.hex, O)
  t.is(body.kind, 'ctl')
  t.is(body.op, 'blocked')
  t.is(body.peer, bia.hex)
  t.is(body.to, ana.hex)
  t.is(body.text, '')
  t.is(body.mine, true)
  t.is(openInner(b4a.from(ctl), bia.hex, O), null, 'a ctl never opens for the peer')
  for (const op of dm.DM_OPS) t.ok(buildInner({ kind: 'ctl', op, peer: bia.hex, at: AT }, ana))
  t.exception.all(() => buildInner({ kind: 'ctl', op: 'blocked', peer: bia.hex, to: bia.hex, at: AT }, ana), /mensagem inválida/, 'ctl with from !== to')
  t.exception.all(() => buildInner({ kind: 'ctl', op: 'read', peer: bia.hex, at: AT }, ana), /mensagem inválida/)
  t.exception.all(() => buildInner({ kind: 'ctl', op: 'blocked', peer: null, at: AT }, ana), /mensagem inválida/)
  t.exception.all(() => buildInner({ kind: 'ctl', op: 'blocked', peer: bia.hex, text: 'x', at: AT }, ana), /mensagem inválida/)

  t.is(openInner(buildInner({ kind: 'ctl', op: 'blocked', peer: bia.hex, at: AT }, ana), ana.hex).op, 'blocked', 'a ctl needs no association')
  t.is(openInner(buildInner({ kind: 'ctl', op: 'blocked', peer: bia.hex, at: AT, cert: ana.cert }, ana), ana.hex, O).op, 'blocked', 'a ctl may carry the cert')

  // A ctl body with from !== to, signed by the sender, is refused on open.
  const forged = forge({ v: 1, kind: 'ctl', id: 'a'.repeat(32), from: ana.hex, to: bia.hex, replyTo: null, text: '', op: 'accepted', peer: caio.hex, at: AT, cert: null }, ana)
  t.is(openInner(b4a.from(forged), bia.hex, O), null)
  t.is(openInner(b4a.from(forged), ana.hex, O), null)
})

test('inner: a msg needs a certificate of the association for its sender', (t) => {
  const other = generateAssociationKeyPair()
  const throwaway = signPair()
  t.ok(openInner(msg(), bia.hex, O), 'certified sender')
  t.is(openInner(msg(), bia.hex), null, 'no association given')
  t.is(openInner(msg(), bia.hex, { association: 'nope' }), null, 'bad association')
  t.is(openInner(msg(), bia.hex, { association: b4a.toString(other.publicKey, 'hex') }), null, 'another association')
  t.is(openInner(msg({ cert: undefined }, throwaway), bia.hex, O), null, 'a throwaway key without cert')
  t.is(openInner(msg({}, throwaway), bia.hex, O), null, 'still none')
  throwaway.cert = createCert({ member: throwaway.hex, date: AT }, other)
  t.is(openInner(msg({}, throwaway), bia.hex, O), null, 'a cert of another association')
  t.exception.all(() => msg({ cert: caio.cert }), /mensagem inválida/, 'buildInner refuses a cert of another member')

  // Hand-signed bodies: a cert of another member, a broken cert, no cert.
  const base = { v: 1, kind: 'msg', id: 'a'.repeat(32), from: ana.hex, to: bia.hex, replyTo: null, text: 'oi', op: null, peer: null, at: AT }
  t.ok(openInner(forge({ ...base, cert: ana.cert }, ana), bia.hex, O), 'the forge helper builds a valid one')
  t.is(openInner(forge({ ...base, cert: caio.cert }, ana), bia.hex, O), null, 'member !== from')
  t.is(openInner(forge({ ...base, cert: { ...ana.cert, signature: 'f'.repeat(128) } }, ana), bia.hex, O), null, 'bad cert signature')
  t.is(openInner(forge({ ...base, cert: null }, ana), bia.hex, O), null, 'cert null')
  t.is(openInner(forge(base, ana), bia.hex, O), null, 'cert key missing')
  const revoked = new Set(['f'.repeat(64)])
  t.ok(openInner(msg(), bia.hex, { association: ASSOC, revokedIssuers: revoked }), 'a v1 cert ignores revoked issuers')
})

test('inner: hostile input never throws', (t) => {
  t.is(openInner(null, bia.hex, O), null)
  t.is(openInner(b4a.alloc(10), bia.hex, O), null)
  t.is(openInner(b4a.alloc(DM_INNER_BYTES), bia.hex, O), null)
  t.is(openInner(b4a.alloc(DM_INNER_BYTES, 0xff), bia.hex, O), null)
  t.is(openInner(msg(), 'nope'), null)
})

test('seal: fixed size, recipient only', (t) => {
  const box = boxPair()
  const small = sealInner(msg({ text: 'a' }), box.hex)
  const big = sealInner(msg({ text: 'x'.repeat(900) }), box.hex)
  t.is(small.byteLength, DM_SEALED_BYTES)
  t.is(big.byteLength, DM_SEALED_BYTES)
  const inner = openSealed(big, box)
  t.is(openInner(inner, bia.hex, O).text, 'x'.repeat(900))

  const other = boxPair()
  let opened = 0
  for (let i = 0; i < 1000; i++) {
    const s = sealInner(msg({ text: 'n' + i }), box.hex)
    if (openSealed(s, other) !== null) opened++
  }
  t.is(opened, 0, 'no envelope opens for a non-recipient')

  t.exception.all(() => sealInner(msg(), '0'.repeat(64)), /chave de caixa inválida/)
  t.exception.all(() => sealInner(msg(), 'A'.repeat(64)), /chave de caixa inválida/)
  t.exception.all(() => sealInner(b4a.alloc(10), box.hex), TypeError)
  t.is(openSealed(b4a.alloc(10), box), null)
  t.is(openSealed(big, null), null)
  t.is(openSealed(big, { publicKey: b4a.alloc(32), secretKey: box.secretKey }), null, 'weak own key')
  const flip = b4a.from(big)
  flip[100] ^= 1
  t.is(openSealed(flip, box), null)
})

test('drop: encode and decode', (t) => {
  const box = boxPair()
  const fields = {
    dropId: newDropId(),
    kid: b4a.alloc(8, 1),
    rsaSig: b4a.alloc(256, 2),
    token: b4a.alloc(32, 3),
    sealed: sealInner(msg(), box.hex)
  }
  const frame = encodeDrop(fields)
  t.is(frame.byteLength, DM_DROP_BYTES)
  t.is(b4a.toString(frame.subarray(0, 4), 'ascii'), 'VDM1')
  t.is(frame[4], 1)
  const back = decodeDrop(frame)
  t.alike(back, fields)
  frame[0] = 0
  t.is(back.sealed.byteLength, DM_SEALED_BYTES, 'decode copies')
  t.is(decodeDrop(frame), null, 'bad magic')
  const v2 = encodeDrop(fields)
  v2[4] = 2
  t.is(decodeDrop(v2), null, 'unknown version')
  t.is(decodeDrop(b4a.alloc(DM_DROP_BYTES - 1)), null)
  t.is(decodeDrop('x'), null)
  t.exception.all(() => encodeDrop({ ...fields, kid: b4a.alloc(7) }), TypeError)
  t.unlike(newDropId(), newDropId())
})

// Frozen before v2 existed: the exact JSON and signature a v1 writer sends.
// Keys from fixed seeds (association 1, sender 2, recipient 3).
const GOLDEN_V1 = {
  json: '{"v":1,"kind":"msg","id":"0123456789abcdef0123456789abcdef","from":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","to":"ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1","replyTo":null,"text":"oi, tudo bem? \u{1F600}","op":null,"peer":null,"at":"2026-11-03T12:00:00.000Z","cert":{"v":1,"member":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","ageBand":"18+","method":"stub","date":"2026-11-03T12:00:00.000Z","association":"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c","signature":"be6af89dcbfed1d742ceb852998ce7fc39cf057a4d5e1b5ed9b96d2318a2b798c4eb31891adac9d1d9f90a510ec9e6eb9084bcbc890593035def2205f9ac6208"}}',
  sig: '562a1fe83e8d17e1ae3470838ec1749595c830547562d12afd1303b381a89cc85464c6bf9abcfc771c9bc012c5b3f2ca33af93b87787d4dd32a0e492a471480b',
  association: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
  to: 'ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1'
}

function goldenInner () {
  const json = b4a.from(GOLDEN_V1.json)
  const out = b4a.alloc(DM_INNER_BYTES)
  out[0] = json.byteLength >> 8
  out[1] = json.byteLength & 0xff
  out.set(json, 2)
  out.set(b4a.from(GOLDEN_V1.sig, 'hex'), 2 + json.byteLength)
  return out
}

function blobItem (n, over = {}) {
  return {
    id: n.toString(16).padStart(64, '0'),
    key: 'f'.repeat(64),
    nonce: 'e'.repeat(48),
    chunks: 2,
    bytes: 32768 + 100,
    sha256: 'd'.repeat(64),
    mime: 'image/jpeg',
    w: 640,
    h: 480,
    ms: 0,
    ...over
  }
}

// The largest item: 257 chunks of 32768 bytes, a ten-character mime and
// the widest sides.
function bigItem (n) {
  return blobItem(n, { chunks: 257, bytes: 257 * 32768, mime: 'image/webp', w: 16384, h: 16384 })
}

function largestV2Sender () {
  const issuer = hcrypto.keyPair()
  const issuerCert = createIssuerCert({ issuer: b4a.toString(issuer.publicKey, 'hex'), date: AT }, assoc)
  const who = signPair()
  who.cert = createIssuedCert({ member: who.hex, date: AT }, issuer, issuerCert)
  return who
}

// A text of exactly n JSON bytes with at most 1000 code points.
function textOfBytes (n) {
  return '\u{1F600}'.repeat(Math.floor(n / 4)) + 'x'.repeat(n % 4)
}

function v2Body (over = {}) {
  return { v: 2, kind: 'msg', id: 'a'.repeat(32), from: ana.hex, to: bia.hex, replyTo: null, text: 'foto', media: [blobItem(1)], card: null, fwd: 0, op: null, peer: null, at: AT, cert: ana.cert, ...over }
}

test('inner: a v1 golden vector still opens and is still built byte for byte', (t) => {
  const body = openInner(goldenInner(), GOLDEN_V1.to, { association: GOLDEN_V1.association })
  t.ok(body, 'opens')
  t.is(body.v, 1)
  t.is(body.text, 'oi, tudo bem? \u{1F600}')
  t.alike(Object.keys(body), [...dm.INNER_KEYS, 'mine'], 'no v2 keys on a v1 body')

  const seed = (c) => b4a.alloc(32, c)
  const sender = hcrypto.keyPair(seed(2))
  const cert = JSON.parse(GOLDEN_V1.json).cert
  const rebuilt = buildInner({ kind: 'msg', to: GOLDEN_V1.to, text: 'oi, tudo bem? \u{1F600}', id: '0123456789abcdef0123456789abcdef', at: AT, cert }, sender)
  t.alike(rebuilt, goldenInner(), 'a text-only message is still the v1 bytes')
  const withNulls = buildInner({ kind: 'msg', to: GOLDEN_V1.to, text: 'oi, tudo bem? \u{1F600}', id: '0123456789abcdef0123456789abcdef', at: AT, cert, media: null, card: null, fwd: 0 }, sender)
  t.alike(withNulls, goldenInner(), 'unused v2 fields keep v1')
})

test('inner v2: constants and layout', (t) => {
  t.is(DM_SIG_PREFIX_V2, 'varanda-dm-v2\n')
  t.alike(dm.INNER_KEYS, ['v', 'kind', 'id', 'from', 'to', 'replyTo', 'text', 'op', 'peer', 'at', 'cert'])
  t.alike(dm.INNER_KEYS_V2, ['v', 'kind', 'id', 'from', 'to', 'replyTo', 'text', 'media', 'card', 'fwd', 'op', 'peer', 'at', 'cert'])
  t.alike(dm.DM_MEDIA_KEYS, ['id', 'key', 'nonce', 'chunks', 'bytes', 'sha256', 'mime', 'w', 'h', 'ms'])
  t.is(dm.DM_MEDIA_MAX, 4)
  t.alike(dm.DM_MEDIA_MIMES, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

  // Items built in any key order are written in the canonical one.
  const shuffled = Object.fromEntries(Object.entries(blobItem(1)).reverse())
  const inner = msg({ media: [shuffled], replyTo: 'c'.repeat(32) })
  const len = (inner[0] << 8) | inner[1]
  const json = inner.subarray(2, 2 + len)
  const parsed = JSON.parse(b4a.toString(json))
  t.alike(Object.keys(parsed), dm.INNER_KEYS_V2)
  t.alike(Object.keys(parsed.media[0]), dm.DM_MEDIA_KEYS)
  t.is(parsed.v, 2)
  t.is(parsed.card, null)
  t.is(parsed.fwd, 0)
  const sig = inner.subarray(2 + len, 2 + len + 64)
  t.ok(hcrypto.verify(b4a.concat([b4a.from(DM_SIG_PREFIX_V2), json]), sig, ana.publicKey), 'signed under the v2 prefix')
  t.absent(hcrypto.verify(b4a.concat([b4a.from(DM_SIG_PREFIX), json]), sig, ana.publicKey), 'not under the v1 prefix')

  const body = openInner(inner, bia.hex, O)
  t.is(body.v, 2)
  t.alike(body.media, [blobItem(1)])
  t.is(body.card, null)
  t.is(body.fwd, 0)
  t.is(body.replyTo, 'c'.repeat(32))
  t.is(body.mine, false)
})

test('inner v2: text rules with media', (t) => {
  t.exception.all(() => msg({ text: '' }), /mensagem inválida/, 'empty text without media')
  t.exception.all(() => msg({ text: '', media: null }), /mensagem inválida/, 'empty text with media null')
  t.is(openInner(msg({ text: '', media: [blobItem(1)] }), bia.hex, O).text, '', 'empty text with media')
  t.exception.all(() => msg({ text: 'a\tb', media: [blobItem(1)] }), /mensagem inválida/)
  t.exception.all(() => msg({ text: 'x'.repeat(DM_MAX_TEXT + 1), media: [blobItem(1)] }), /mensagem inválida/)
  t.exception.all(() => msg({ text: '\ud800', media: [blobItem(1)] }), /mensagem inválida/)
  t.exception.all(() => msg({ text: '', media: [blobItem(1)], op: 'accepted' }), /mensagem inválida/)
  t.exception.all(() => buildInner({ kind: 'ctl', op: 'blocked', peer: bia.hex, at: AT, media: [blobItem(1)] }, ana), /mensagem inválida/, 'ops stay v1')
})

test('inner v2: sizes', (t) => {
  const v1Cert = signPair()
  v1Cert.cert = createCert({ member: v1Cert.hex, ageBand: 'a'.repeat(32), method: 'b'.repeat(32), date: AT }, assoc)
  const v2Cert = largestV2Sender()
  const wide = '\u{1F600}'.repeat(DM_MAX_TEXT)
  const R = 'a'.repeat(32)

  for (const who of [v1Cert, v2Cert]) {
    const worst = buildInner({ kind: 'msg', to: bia.hex, text: wide, at: AT, replyTo: R, cert: who.cert }, who)
    const len = (worst[0] << 8) | worst[1]
    t.ok(len + 66 <= DM_INNER_BYTES, 'v1 worst case with a v' + who.cert.v + ' cert fits (' + (len + 66) + ' bytes)')
    t.is(textBudget({ replyTo: R, cert: who.cert }) - 4 * DM_MAX_TEXT, DM_INNER_BYTES - len - 66, 'the budget measures the same bytes')

    const four = [bigItem(1), bigItem(2), bigItem(3), bigItem(4)]
    const media = buildInner({ kind: 'msg', to: bia.hex, text: '', at: AT, replyTo: R, cert: who.cert, media: four }, who)
    const mlen = (media[0] << 8) | media[1]
    t.ok(mlen + 66 <= DM_INNER_BYTES, 'four descriptors and a v' + who.cert.v + ' cert fit with empty text (' + (mlen + 66) + ' bytes)')
    t.alike(openInner(media, bia.hex, O).media, four)
  }

  t.exception.all(() => buildInner({ kind: 'msg', to: bia.hex, text: wide, at: AT, cert: v2Cert.cert, media: [bigItem(1)] }, v2Cert), /mensagem longa demais/, '1000 four-byte characters and one descriptor')

  for (const n of [1, 2, 3, 4]) {
    const items = [bigItem(1), bigItem(2), bigItem(3), bigItem(4)].slice(0, n)
    const fields = { kind: 'msg', to: bia.hex, at: AT, replyTo: R, cert: v2Cert.cert, media: items }
    const budget = textBudget(fields)
    t.ok(budget > 0 && budget < 4 * DM_MAX_TEXT, n + ' descriptors leave ' + budget + ' bytes of text')
    const fits = buildInner({ ...fields, text: textOfBytes(budget) }, v2Cert)
    t.is(openInner(fits, bia.hex, O).text, textOfBytes(budget), 'text at the budget fits')
    t.exception.all(() => buildInner({ ...fields, text: textOfBytes(budget) + 'x' }, v2Cert), /mensagem longa demais/, 'one byte more throws')
  }

  // Escapes count as the bytes written.
  const fields = { kind: 'msg', to: bia.hex, at: AT, cert: v2Cert.cert, media: [bigItem(1), bigItem(2), bigItem(3), bigItem(4)] }
  const budget = textBudget(fields)
  const escaped = '"'.repeat(300) + textOfBytes(budget - 600)
  t.ok(Array.from(escaped).length <= DM_MAX_TEXT)
  t.is(openInner(buildInner({ ...fields, text: escaped }, v2Cert), bia.hex, O).text, escaped, 'quotes at two bytes each fit at the budget')
  t.exception.all(() => buildInner({ ...fields, text: escaped + '"' }, v2Cert), /mensagem longa demais/)
})

test('inner v2: descriptors are validated strictly', (t) => {
  const bad = {
    'extra key': blobItem(1, { alt: 'x' }),
    'missing ms': (() => { const d = blobItem(1); delete d.ms; return d })(),
    'missing nonce': (() => { const d = blobItem(1); delete d.nonce; return d })(),
    'svg mime': blobItem(1, { mime: 'image/svg+xml' }),
    'video mime': blobItem(1, { mime: 'video/mp4' }),
    'upper mime': blobItem(1, { mime: 'IMAGE/JPEG' }),
    'w 0': blobItem(1, { w: 0 }),
    'h too large': blobItem(1, { h: 16385 }),
    'w fraction': blobItem(1, { w: 1.5 }),
    'w string': blobItem(1, { w: '640' }),
    'ms 1': blobItem(1, { ms: 1 }),
    'chunks 258': blobItem(1, { chunks: 258, bytes: 258 * 32768 }),
    'chunks 0': blobItem(1, { chunks: 0, bytes: 100 }),
    'chunks not matching bytes': blobItem(1, { chunks: 3 }),
    'bytes only the MAC': blobItem(1, { chunks: 1, bytes: 16 }),
    'short nonce': blobItem(1, { nonce: 'e'.repeat(46) }),
    'upper sha256': blobItem(1, { sha256: 'D'.repeat(64) }),
    'short key': blobItem(1, { key: 'f'.repeat(62) }),
    'null item': null
  }
  for (const [name, item] of Object.entries(bad)) {
    t.exception.all(() => msg({ media: [item] }), /mensagem inválida/, name + ' refused on build')
    t.is(openInner(forge(v2Body({ media: [item] }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, name + ' refused on open')
  }
  const lists = {
    'empty list': [],
    'five items': [1, 2, 3, 4, 5].map(n => blobItem(n)),
    'duplicate ids': [blobItem(1), blobItem(1)],
    'an object': blobItem(1),
    'a string': 'x'
  }
  for (const [name, media] of Object.entries(lists)) {
    t.exception.all(() => msg({ media }), /mensagem inválida/, name + ' refused on build')
    t.is(openInner(forge(v2Body({ media }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, name + ' refused on open')
  }
  t.ok(msg({ media: [1, 2, 3, 4].map(n => blobItem(n, { mime: dm.DM_MEDIA_MIMES[n - 1] })) }), 'every mime, four items')
  t.ok(msg({ media: [blobItem(1, { chunks: 1, bytes: 17 })] }), 'the smallest blob')
})

test('inner v2: one exact key set, one prefix, one encoding', (t) => {
  t.ok(openInner(forge(v2Body(), ana, DM_SIG_PREFIX_V2), bia.hex, O), 'the forge helper builds a valid v2')
  t.is(openInner(forge(v2Body(), ana), bia.hex, O), null, 'v2 under the v1 prefix')
  const v1Body = { v: 1, kind: 'msg', id: 'a'.repeat(32), from: ana.hex, to: bia.hex, replyTo: null, text: 'oi', op: null, peer: null, at: AT, cert: ana.cert }
  t.ok(openInner(forge(v1Body, ana), bia.hex, O))
  t.is(openInner(forge(v1Body, ana, DM_SIG_PREFIX_V2), bia.hex, O), null, 'v1 under the v2 prefix')

  const refused = {
    'card set': v2Body({ card: { url: 'x' } }),
    'fwd 2': v2Body({ fwd: 2 }),
    'fwd true': v2Body({ fwd: true }),
    "fwd '1'": v2Body({ fwd: '1' }),
    'fwd false': v2Body({ fwd: false }),
    'media null and fwd 0': v2Body({ media: null }),
    'media null with empty text': v2Body({ media: null, text: '' }),
    'v1 number with v2 keys': v2Body({ v: 1 }),
    'v 3': v2Body({ v: 3 }),
    'v string': v2Body({ v: '2' }),
    'a ctl body': v2Body({ kind: 'ctl', to: ana.hex, text: '', op: 'blocked', peer: bia.hex }),
    'a v2 key missing': (() => { const b = v2Body(); delete b.card; return b })(),
    'an extra key': v2Body({ extra: 1 })
  }
  for (const [name, body] of Object.entries(refused)) {
    t.is(openInner(forge(body, ana, DM_SIG_PREFIX_V2), bia.hex, O), null, name)
  }
  t.is(openInner(forge({ ...v1Body, v: 2 }, ana, DM_SIG_PREFIX_V2), bia.hex, O), null, 'v2 number with v1 keys')
  t.is(openInner(forge({ ...v1Body, media: [blobItem(1)] }, ana), bia.hex, O), null, 'v1 plus media')

  // Reordered keys inside an item, re-signed: the exact bytes rule refuses it.
  const shuffled = Object.fromEntries(Object.entries(blobItem(1)).reverse())
  t.is(openInner(forge(v2Body({ media: [shuffled] }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, 'item key order')
  const reordered = v2Body()
  delete reordered.media
  reordered.media = [blobItem(1)]
  t.is(openInner(forge(reordered, ana, DM_SIG_PREFIX_V2), bia.hex, O), null, 'body key order')
  const json = JSON.stringify(v2Body()).replace('"ms":0', '"ms":0.0')
  const raw = b4a.from(json)
  const sig = hcrypto.sign(b4a.concat([b4a.from(DM_SIG_PREFIX_V2), raw]), ana.secretKey)
  const out = b4a.alloc(DM_INNER_BYTES)
  out[0] = raw.byteLength >> 8
  out[1] = raw.byteLength & 0xff
  out.set(raw, 2)
  out.set(sig, 2 + raw.byteLength)
  t.is(openInner(out, bia.hex, O), null, 'a number spelled another way')

  // A v2 msg still needs the sender's certificate.
  t.is(openInner(forge(v2Body({ cert: null }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, 'no cert')
  t.is(openInner(msg({ media: [blobItem(1)] }), bia.hex), null, 'no association')
})

test('inner v2: fwd is 0 or 1, and a forward may be text only', (t) => {
  const withMedia = openInner(msg({ text: 'foto', media: [blobItem(1)], fwd: 1 }), bia.hex, O)
  t.is(withMedia.fwd, 1)
  t.alike(withMedia.media, [blobItem(1)])
  t.is(withMedia.card, null)

  const textOnly = openInner(msg({ text: 'encaminhada', fwd: 1 }), bia.hex, O)
  t.is(textOnly.v, 2)
  t.is(textOnly.fwd, 1)
  t.is(textOnly.media, null)
  t.is(textOnly.card, null)
  t.is(textOnly.text, 'encaminhada')
  t.alike(Object.keys(textOnly), [...dm.INNER_KEYS_V2, 'mine'])

  // A forward with no photo is still a message: empty text stays the caption case.
  t.exception.all(() => msg({ text: '', fwd: 1 }), /mensagem inválida/, 'text forward still needs text')
  t.is(openInner(forge(v2Body({ media: null, text: '', fwd: 1 }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, 'open refuses an empty text forward')

  for (const fwd of [2, true, '1', false]) {
    t.exception.all(() => msg({ fwd, media: [blobItem(1)] }), /mensagem inválida/, 'build refuses fwd ' + JSON.stringify(fwd))
    t.is(openInner(forge(v2Body({ fwd }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, 'open refuses fwd ' + JSON.stringify(fwd))
  }
  t.is(openInner(forge(v2Body({ media: null, fwd: 0 }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, 'v2 with media null and fwd 0')
  t.exception.all(() => buildInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT, cert: ana.cert, media: null, fwd: 2 }, ana), /mensagem inválida/)

  const v1 = openInner(msg({ text: 'oi' }), bia.hex, O)
  t.is(v1.v, 1)
  t.is(v1.text, 'oi')
  t.alike(Object.keys(v1), [...dm.INNER_KEYS, 'mine'], 'a plain text message stays v1')
})

test('inner v2: a sparse media list is refused before signing', (t) => {
  const sparse = new Array(2)
  sparse[1] = blobItem(1)
  t.exception.all(() => msg({ media: sparse }), /mensagem inválida/, 'a hole is not an item')
  const holed = [blobItem(1), blobItem(2), blobItem(3)]
  delete holed[1]
  t.exception.all(() => msg({ media: holed }), /mensagem inválida/, 'a deleted slot is not an item')
})

function voiceItem (n, over = {}) {
  return blobItem(n, { chunks: 2, bytes: 40000, mime: 'audio/mp4', w: 0, h: 0, ms: 4200, ...over })
}

// The largest voice note: a 1572864-byte file sealed, at two minutes.
function bigVoice (n) {
  return voiceItem(n, { chunks: 49, bytes: dm.DM_AUDIO_MAX_BYTES, ms: dm.DM_AUDIO_MAX_MS })
}

test('inner v2: a voice note', (t) => {
  t.is(dm.DM_AUDIO_MIME, 'audio/mp4')
  t.is(dm.DM_AUDIO_MAX_MS, 120000)
  t.is(dm.DM_AUDIO_MAX_BYTES, 1572864 + 16, 'the plaintext cap plus the blob MAC')
  t.absent(dm.DM_MEDIA_MIMES.includes('audio/mp4'), 'the image mimes stay images')
  t.alike(openInner(msg({ text: '', media: [voiceItem(1)] }), bia.hex, O).media, [voiceItem(1)])
  t.alike(openInner(msg({ media: [bigVoice(1)] }), bia.hex, O).media, [bigVoice(1)], 'the largest')
  t.ok(msg({ media: [voiceItem(1, { ms: 1 })] }), 'the shortest')

  const bad = {
    'video mime': voiceItem(1, { mime: 'video/mp4' }),
    'mpeg audio': voiceItem(1, { mime: 'audio/mpeg' }),
    'ogg audio': voiceItem(1, { mime: 'audio/ogg' }),
    'webm audio': voiceItem(1, { mime: 'audio/webm' }),
    'upper mime': voiceItem(1, { mime: 'AUDIO/MP4' }),
    'w 1': voiceItem(1, { w: 1 }),
    'h 1': voiceItem(1, { h: 1 }),
    'ms 0': voiceItem(1, { ms: 0 }),
    'ms too long': voiceItem(1, { ms: 120001 }),
    'ms float': voiceItem(1, { ms: 1.5 }),
    'ms string': voiceItem(1, { ms: '4200' }),
    'one byte too many': voiceItem(1, { chunks: 49, bytes: dm.DM_AUDIO_MAX_BYTES + 1 }),
    'image with a duration': blobItem(1, { ms: 4200 })
  }
  for (const [name, item] of Object.entries(bad)) {
    t.exception.all(() => msg({ media: [item] }), /mensagem inválida/, name + ' refused on build')
    t.is(openInner(forge(v2Body({ media: [item] }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, name + ' refused on open')
  }
  const lists = {
    'two voice notes': [voiceItem(1), voiceItem(2)],
    'voice then image': [voiceItem(1), blobItem(2)],
    'image then voice': [blobItem(1), voiceItem(2)],
    'voice among four': [blobItem(1), blobItem(2), blobItem(3), voiceItem(4)]
  }
  for (const [name, media] of Object.entries(lists)) {
    t.exception.all(() => msg({ media }), /mensagem inválida/, name + ' refused on build')
    t.is(openInner(forge(v2Body({ media }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, name + ' refused on open')
  }
})

test('inner v2: a voice note keeps the text budget', (t) => {
  const who = largestV2Sender()
  const R = 'a'.repeat(32)
  const wide = '\u{1F600}'.repeat(DM_MAX_TEXT)
  const fields = { kind: 'msg', to: bia.hex, at: AT, replyTo: R, cert: who.cert, media: [bigVoice(1)] }
  t.exception.all(() => buildInner({ ...fields, text: wide }, who), /mensagem longa demais/, 'a voice note and 1000 four-byte characters')
  const empty = buildInner({ ...fields, text: '' }, who)
  const len = (empty[0] << 8) | empty[1]
  t.ok(len + 66 <= DM_INNER_BYTES, 'a voice note with empty text fits (' + (len + 66) + ' bytes)')
  t.alike(openInner(empty, bia.hex, O).media, [bigVoice(1)])
  const budget = textBudget(fields)
  t.is(budget, DM_INNER_BYTES - len - 66, 'the budget measures the same bytes')
  t.is(openInner(buildInner({ ...fields, text: textOfBytes(budget) }, who), bia.hex, O).text, textOfBytes(budget), 'text at the budget fits')
  t.exception.all(() => buildInner({ ...fields, text: textOfBytes(budget) + 'x' }, who), /mensagem longa demais/, 'one byte more throws')
  t.is(sealInner(empty, boxPair().hex).byteLength, DM_SEALED_BYTES, 'the sealed frame keeps its size')
})

test('text forward budgets include the v2 keys without media', (t) => {
  const fields = { kind: 'msg', to: bia.hex, from: ana.hex, at: AT, cert: ana.cert, media: null }
  const forward = { ...fields, fwd: 1 }
  const budget = textBudget(forward)
  t.is(budget, dmTextBudget(forward))
  t.is(textBudget(fields) - budget, 33, 'media, card and fwd consume the extra JSON bytes')
  const inner = buildInner({ ...forward, text: 'oi' }, ana)
  const len = (inner[0] << 8) | inner[1]
  t.is(budget - 2, DM_INNER_BYTES - len - 66, 'the budget matches the signed inner')
})

function dmThumb (over = {}) {
  return blobItem(9, { chunks: 1, bytes: 32768, w: 400, h: 210, ...over })
}

function dmCard (over = {}) {
  return { url: 'https://example.com/a', host: 'example.com', title: 'Título', desc: 'Descrição', image: dmThumb(), ...over }
}

test('inner v2: a link card', (t) => {
  const inner = msg({ text: 'olha https://example.com/a', card: dmCard() })
  const body = openInner(inner, bia.hex, O)
  t.is(body.v, 2, 'a card with no media and fwd 0 is v2')
  t.alike(body.card, dmCard())
  t.is(body.media, null)
  t.is(body.fwd, 0)
  t.alike(openInner(msg({ text: 'oi', card: dmCard({ image: null }) }), bia.hex, O).card, dmCard({ image: null }), 'no thumbnail')
  t.is(openInner(msg({ text: 'oi', card: dmCard(), fwd: 1 }), bia.hex, O).fwd, 1, 'a forwarded card')
  t.is(openInner(msg({ text: 'oi', card: null }), bia.hex, O).v, 1, 'plain text stays v1')

  // Built in any key order, written in the canonical one; a reordered card refused on open.
  const shuffled = Object.fromEntries(Object.entries(dmCard({ image: Object.fromEntries(Object.entries(dmThumb()).reverse()) })).reverse())
  const len = (x) => (x[0] << 8) | x[1]
  const canon = msg({ text: 'oi', card: shuffled })
  const parsed = JSON.parse(b4a.toString(canon.subarray(2, 2 + len(canon))))
  t.alike(Object.keys(parsed.card), ['url', 'host', 'title', 'desc', 'image'])
  t.alike(Object.keys(parsed.card.image), dm.DM_MEDIA_KEYS)
  t.is(openInner(forge(v2Body({ media: null, card: shuffled }), ana, DM_SIG_PREFIX_V2), bia.hex, O), null, 'card key order')

  const bad = {
    'with media': v2Body({ card: dmCard() }),
    'empty text': v2Body({ media: null, text: '', card: dmCard() }),
    http: v2Body({ media: null, card: dmCard({ url: 'http://example.com/a' }) }),
    javascript: v2Body({ media: null, card: dmCard({ url: 'javascript:alert(1)' }) }),
    data: v2Body({ media: null, card: dmCard({ url: 'data:text/html,x' }) }),
    ftp: v2Body({ media: null, card: dmCard({ url: 'ftp://example.com/a' }) }),
    credentials: v2Body({ media: null, card: dmCard({ url: 'https://u:p@example.com/a' }) }),
    'host mismatch': v2Body({ media: null, card: dmCard({ host: 'evil.com' }) }),
    'long title': v2Body({ media: null, card: dmCard({ title: 'x'.repeat(81) }) }),
    'long desc': v2Body({ media: null, card: dmCard({ desc: 'x'.repeat(161) }) }),
    'control in title': v2Body({ media: null, card: dmCard({ title: 'a\u001b[2J' }) }),
    'bidi in desc': v2Body({ media: null, card: dmCard({ desc: 'a⁦' }) }),
    'image over 32768': v2Body({ media: null, card: dmCard({ image: dmThumb({ chunks: 2, bytes: 32769 }) }) }),
    'image not jpeg': v2Body({ media: null, card: dmCard({ image: dmThumb({ mime: 'image/png' }) }) }),
    'image a voice note': v2Body({ media: null, card: dmCard({ image: voiceItem(1, { chunks: 1, bytes: 1000 }) }) }),
    'image a public descriptor': v2Body({ media: null, card: dmCard({ image: { core: 'a'.repeat(64), mime: 'image/jpeg', start: 1, blocks: 1, bytes: 100, sha256: 'd'.repeat(64), width: 1, height: 1 } }) }),
    'image a url': v2Body({ media: null, card: dmCard({ image: 'https://example.com/x.jpg' }) }),
    'card extra key': v2Body({ media: null, card: { ...dmCard(), extra: 1 } })
  }
  for (const [name, body] of Object.entries(bad)) {
    t.is(openInner(forge(body, ana, DM_SIG_PREFIX_V2), bia.hex, O), null, name + ' refused on open')
    t.exception.all(() => msg({ text: body.text, media: body.media, card: body.card }), /mensagem inválida/, name + ' refused on build')
  }
  t.ok(dm.validDmCard(dmCard()))
  t.absent(dm.validDmCard(dmCard({ image: dmThumb({ bytes: 32769, chunks: 2 }) })))
})

test('inner v2: legacy v1 bodies still open next to cards', (t) => {
  const v1Body = { v: 1, kind: 'msg', id: 'b'.repeat(32), from: ana.hex, to: bia.hex, replyTo: null, text: 'oi', op: null, peer: null, at: AT, cert: ana.cert }
  const body = openInner(forge(v1Body, ana), bia.hex, O)
  t.is(body.v, 1)
  t.alike(Object.keys(body), [...dm.INNER_KEYS, 'mine'])
  t.is(openInner(forge({ ...v1Body, card: dmCard() }, ana), bia.hex, O), null, 'v1 plus a card')
})

test('inner v2: the worst card fits the DM frame with the largest certificate', (t) => {
  const who = largestV2Sender()
  const worst = dmCard({
    url: 'https://example.com/' + '%'.repeat(280),
    title: '\u{1F600}'.repeat(80),
    desc: '\u{1F600}'.repeat(160),
    image: dmThumb({ id: 'f'.repeat(64), w: 16384, h: 16384 })
  })
  t.is(worst.url.length, 300)
  const fields = { kind: 'msg', to: bia.hex, at: AT, replyTo: 'a'.repeat(32), cert: who.cert, card: worst, fwd: 1 }
  const budget = textBudget(fields)
  t.is(budget, dmTextBudget(fields), 'rpc and core agree')
  t.ok(budget >= 4 * 100, 'room for at least 100 four-byte characters next to the worst card (' + budget + ' text bytes)')
  const inner = buildInner({ ...fields, text: textOfBytes(budget) }, who)
  t.alike(openInner(inner, bia.hex, O).card, worst, 'the worst card at the full budget opens')
  t.exception.all(() => buildInner({ ...fields, text: textOfBytes(budget) + 'x' }, who), /mensagem longa demais/, 'one byte more throws')
  const one = buildInner({ ...fields, text: 'x' }, who)
  const used = ((one[0] << 8) | one[1]) + 66 - 1
  t.comment('worst DM card inner without text: ' + used + ' of ' + DM_INNER_BYTES + ' bytes; text budget ' + budget)
  t.is(used + budget, DM_INNER_BYTES, 'the budget is exactly what is left')
  t.is(sealInner(one, boxPair().hex).byteLength, DM_SEALED_BYTES, 'the sealed frame keeps its size')
})

// A Página's inner (v3): built on a device, its digest signed by the key holder.
const page = signPair()
page.cert = createCert({ member: page.hex, date: AT }, assoc)

const EXP = Date.parse(AT) + dm.DM_V3_TTL_MS

function u64 (n) {
  const out = b4a.alloc(8)
  out.writeUInt32BE(Math.floor(n / 0x100000000), 0)
  out.writeUInt32BE(n % 0x100000000, 4)
  return out
}

function pageInner (fields, signer = page, expiresAt = EXP) {
  const { json, digest, body } = dm.innerDigest({ from: page.hex, ...fields })
  return { inner: dm.assembleInner(json, dm.signDigest(digest, signer.secretKey, expiresAt), expiresAt), json, digest, body }
}

test('inner v3: constants and the digest signature', (t) => {
  t.is(dm.DM_V3_PREFIX, 'varanda-dm-v3\n')
  t.alike(dm.INNER_KEYS_V3, dm.INNER_KEYS_V2)
  const { inner, json, digest, body } = pageInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT, cert: page.cert })
  t.is(inner.byteLength, DM_INNER_BYTES)
  t.is(body.v, 3)
  t.alike(Object.keys(body), dm.INNER_KEYS_V2)
  t.is(json.byteLength, (inner[0] << 8) | inner[1])
  t.alike(b4a.from(inner.subarray(2, 2 + json.byteLength)), json)
  const d = b4a.alloc(32)
  sodium.crypto_hash_sha256(d, json)
  t.is(digest, b4a.toString(d, 'hex'))
  const sig = inner.subarray(2 + json.byteLength, 2 + json.byteLength + 64)
  t.ok(hcrypto.verify(b4a.concat([b4a.from('varanda-dm-v3\n'), d, u64(EXP)]), sig, page.publicKey), 'prefix || sha256(json) || uint64be(expiresAt)')
  t.absent(hcrypto.verify(b4a.concat([b4a.from('varanda-dm-v3\n'), d]), sig, page.publicKey), 'the expiry is signed')
  t.absent(hcrypto.verify(b4a.concat([b4a.from(DM_SIG_PREFIX_V2), json]), sig, page.publicKey))
  const off = 2 + json.byteLength + 64
  t.alike(b4a.from(inner.subarray(off, off + 8)), u64(EXP), 'expiresAt follows the signature')
  for (let i = off + 8; i < DM_INNER_BYTES; i++) {
    if (inner[i] !== 0) { t.fail('padding'); break }
  }
})

test('inner v3: a text-only msg round trip, recipient and self copy', (t) => {
  const { inner } = pageInner({ kind: 'msg', to: bia.hex, text: 'olá da página', at: AT, cert: page.cert })
  const theirs = openInner(b4a.from(inner), bia.hex, O)
  t.is(theirs.v, 3)
  t.is(theirs.expiresAt, EXP)
  t.is(theirs.text, 'olá da página')
  t.is(theirs.media, null)
  t.is(theirs.card, null)
  t.is(theirs.fwd, 0)
  t.is(theirs.mine, false)
  t.is(openInner(b4a.from(inner), page.hex, O).mine, true)
  t.is(openInner(b4a.from(inner), caio.hex, O), null, 'not for a third member')
  t.is(openInner(b4a.from(inner), bia.hex), null, 'a msg still needs the association')
  const noCert = pageInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT }).inner
  t.is(openInner(noCert, bia.hex, O), null, 'a msg still needs a certificate')
  t.exception.all(() => dm.innerDigest({ from: page.hex, kind: 'msg', to: bia.hex, text: '', at: AT }), /mensagem inválida/, 'empty text without media')
  t.exception.all(() => dm.innerDigest({ from: page.hex, kind: 'msg', to: bia.hex, text: 'x'.repeat(DM_MAX_TEXT + 1), at: AT }), /mensagem inválida/)
})

test('inner v3: every v2 combination', (t) => {
  const withMedia = pageInner({ kind: 'msg', to: bia.hex, text: '', media: [blobItem(1)], at: AT, cert: page.cert }).inner
  t.alike(openInner(withMedia, bia.hex, O).media, [blobItem(1)], 'media with no caption')
  const withCard = pageInner({ kind: 'msg', to: bia.hex, text: 'olha', card: dmCard(), at: AT, cert: page.cert }).inner
  t.alike(openInner(withCard, bia.hex, O).card, dmCard())
  const forwarded = pageInner({ kind: 'msg', to: bia.hex, text: 'oi', fwd: 1, at: AT, cert: page.cert }).inner
  t.is(openInner(forwarded, bia.hex, O).fwd, 1)
  t.exception.all(() => dm.innerDigest({ from: page.hex, kind: 'msg', to: bia.hex, text: 'oi', fwd: true, at: AT }), /mensagem inválida/)
  t.exception.all(() => dm.innerDigest({ from: page.hex, kind: 'msg', to: bia.hex, text: 'oi', media: [blobItem(1)], card: dmCard(), at: AT }), /mensagem inválida/)
})

test('inner v3: ctl round trip', (t) => {
  const { inner, body } = pageInner({ kind: 'ctl', op: 'blocked', peer: bia.hex, at: AT })
  t.is(body.to, page.hex)
  t.is(body.media, null)
  t.is(body.card, null)
  t.is(body.fwd, 0)
  const opened = openInner(b4a.from(inner), page.hex)
  t.is(opened.v, 3)
  t.is(opened.op, 'blocked')
  t.is(opened.mine, true)
  t.is(openInner(b4a.from(inner), bia.hex, O), null, 'a ctl never opens for the peer')
  t.exception.all(() => dm.innerDigest({ from: page.hex, kind: 'ctl', op: 'blocked', peer: bia.hex, to: bia.hex, at: AT }), /mensagem inválida/)
  t.exception.all(() => dm.innerDigest({ from: page.hex, kind: 'ctl', op: 'blocked', peer: bia.hex, fwd: 1, at: AT }), /mensagem inválida/)
  t.exception.all(() => dm.innerDigest({ from: page.hex, kind: 'ctl', op: 'blocked', peer: bia.hex, media: [blobItem(1)], at: AT }), /mensagem inválida/)
  t.exception.all(() => dm.innerDigest({ from: page.hex, kind: 'ctl', op: 'blocked', peer: bia.hex, text: 'x', at: AT }), /mensagem inválida/)
})

test('inner v3: tampering, wrong signer and old prefixes are refused', (t) => {
  const fields = { kind: 'msg', to: bia.hex, text: 'oi', at: AT, cert: page.cert }
  const { inner, json, digest } = pageInner(fields)
  const tampered = b4a.from(inner)
  // "oi" becomes "oj": still canonical JSON, so only the signature can refuse it.
  tampered[2 + b4a.toString(json).indexOf('"oi"') + 2] = 'j'.charCodeAt(0)
  t.is(openInner(tampered, bia.hex, O), null, 'tampered json')
  t.is(openInner(pageInner(fields, caio).inner, bia.hex, O), null, 'wrong signer')
  const v1sig = hcrypto.sign(b4a.concat([b4a.from(DM_SIG_PREFIX), json]), page.secretKey)
  const v2sig = hcrypto.sign(b4a.concat([b4a.from(DM_SIG_PREFIX_V2), json]), page.secretKey)
  const rawDigest = hcrypto.sign(b4a.from(digest, 'hex'), page.secretKey)
  const noExpiry = hcrypto.sign(b4a.concat([b4a.from('varanda-dm-v3\n'), b4a.from(digest, 'hex')]), page.secretKey)
  for (const sig of [v1sig, v2sig, rawDigest, noExpiry]) {
    t.is(openInner(dm.assembleInner(json, b4a.toString(sig, 'hex'), EXP), bia.hex, O), null)
  }
  const ctl = pageInner({ kind: 'ctl', op: 'accepted', peer: bia.hex, at: AT }, caio).inner
  t.is(openInner(ctl, page.hex), null, 'a ctl signed by another key')
})

test('inner v3: the API refuses bad input and long bodies', (t) => {
  t.exception.all(() => dm.innerDigest({ kind: 'msg', to: bia.hex, text: 'oi', at: AT }), /mensagem inválida/, 'from required')
  t.exception.all(() => dm.innerDigest(null), /mensagem inválida/)
  t.exception.all(() => dm.signDigest('ab', page.secretKey), /resumo inválido/)
  t.exception.all(() => dm.signDigest('A'.repeat(64), page.secretKey), /resumo inválido/)
  t.exception.all(() => dm.signDigest('a'.repeat(64), b4a.alloc(32), EXP), /chave de assinatura inválida/)
  for (const bad of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', NaN]) {
    t.exception.all(() => dm.signDigest('a'.repeat(64), page.secretKey, bad), /validade inválida/, 'signDigest expiresAt ' + String(bad))
    t.exception.all(() => dm.assembleInner(b4a.from('{}'), 'a'.repeat(128), bad), /validade inválida/, 'assembleInner expiresAt ' + String(bad))
  }
  t.exception.all(() => dm.assembleInner(b4a.from('{}'), 'zz', EXP), /assinatura inválida/)
  t.exception.all(() => dm.assembleInner(b4a.alloc(DM_INNER_BYTES - 73), 'a'.repeat(128), EXP), /mensagem inválida/, 'no room for the expiry')
  t.ok(dm.assembleInner(b4a.alloc(DM_INNER_BYTES - 74), 'a'.repeat(128), EXP), 'exactly fits')
  const media = [blobItem(1), blobItem(2), blobItem(3), blobItem(4)]
  t.exception.all(() => dm.innerDigest({ from: page.hex, kind: 'msg', to: bia.hex, text: '\u{1F600}'.repeat(DM_MAX_TEXT), media, replyTo: 'c'.repeat(32), at: AT, cert: page.cert }), /mensagem longa demais/)
})

test('inner v3: the frame expiry must match the signed one', (t) => {
  const { inner, json } = pageInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT, cert: page.cert })
  const off = 2 + json.byteLength + 64
  const other = b4a.from(inner)
  other.set(u64(EXP + 1), off)
  t.is(openInner(other, bia.hex, O), null, 'a different expiresAt than the signed one')
  const padded = b4a.from(inner)
  padded[off + 8] = 1
  t.is(openInner(padded, bia.hex, O), null, 'non-zero padding after the expiry')
  padded[off + 8] = 0
  padded[DM_INNER_BYTES - 1] = 1
  t.is(openInner(padded, bia.hex, O), null, 'non-zero last byte')
  for (const bad of [0, Number.MAX_SAFE_INTEGER + 1]) {
    const f = b4a.from(inner)
    f.set(u64(bad), off)
    t.is(openInner(f, bia.hex, O), null, 'frame expiresAt ' + bad)
  }
  const huge = b4a.from(inner)
  huge.fill(0xff, off, off + 8)
  t.is(openInner(huge, bia.hex, O), null, 'frame expiresAt above 2^53')
  const big = Number.MAX_SAFE_INTEGER
  t.is(openInner(pageInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT, cert: page.cert }, page, big).inner, bia.hex, O).expiresAt, big, 'the largest safe expiry')
  t.is(openInner(pageInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT, cert: page.cert }, page, 1).inner, bia.hex, O).expiresAt, 1)
})

test('inner v3: pageInnerStale boundaries', (t) => {
  t.is(dm.DM_V3_TTL_MS, 600000)
  t.is(dm.DM_V3_STALE_MS, dm.DM_RETENTION_MS + 86400000)
  const body = { v: 3, expiresAt: EXP }
  t.is(dm.pageInnerStale(body, EXP), false)
  t.is(dm.pageInnerStale(body, EXP + dm.DM_V3_STALE_MS), false, 'exactly at the limit is still filed')
  t.is(dm.pageInnerStale(body, EXP + dm.DM_V3_STALE_MS + 1), true, 'one ms later is stale')
  t.is(dm.pageInnerStale(body, 0), false, 'a receiver clock behind is not stale')
  t.is(dm.pageInnerStale({ v: 1 }, EXP + 10 * dm.DM_V3_STALE_MS), false, 'v1 never stale')
  t.is(dm.pageInnerStale({ v: 2 }, EXP + 10 * dm.DM_V3_STALE_MS), false, 'v2 never stale')
  t.is(dm.pageInnerStale({ v: 3 }, EXP), true, 'a v3 without expiresAt is refused')
  t.is(dm.pageInnerStale({ v: 3, expiresAt: 0 }, EXP), true)
  t.is(dm.pageInnerStale(body, NaN), true)
  t.is(dm.pageInnerStale(null, EXP), false)
  const opened = openInner(pageInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT, cert: page.cert }).inner, bia.hex, O)
  t.is(dm.pageInnerStale(opened, EXP + dm.DM_V3_STALE_MS + 1), true, 'works on an opened body')
  t.absent('expiresAt' in openInner(msg(), bia.hex, O), 'v1 has no expiresAt')
  t.absent('expiresAt' in openInner(msg({ fwd: 1 }), bia.hex, O), 'v2 has no expiresAt')
})

test('inner v3: buildInner never writes v3, and v1/v2 vectors are unchanged', (t) => {
  t.is(openInner(msg(), bia.hex, O).v, 1)
  t.is(openInner(msg({ fwd: 1 }), bia.hex, O).v, 2)
  t.is(openInner(buildInner({ kind: 'ctl', op: 'blocked', peer: bia.hex, at: AT }, ana), ana.hex).v, 1)
  t.is(openInner(buildInner({ kind: 'msg', to: bia.hex, text: 'oi', at: AT, cert: ana.cert, v: 3 }, ana), bia.hex, O).v, 1, 'a v field is ignored')
})
