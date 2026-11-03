'use strict'

// The direct message inner plaintext, its sealed envelope and the drop
// frame (lib/dm.js). No network.
const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const hcrypto = require('hypercore-crypto')
const dm = require('../lib/dm')
const { generateAssociationKeyPair, createCert, createIssuerCert, createIssuedCert } = require('../lib/cert')
const { MAX_TEXT } = require('@varanda/rpc')

const {
  DM_MAX_TEXT, DM_INNER_BYTES, DM_SEAL_BYTES, DM_SEALED_BYTES, DM_DROP_BYTES, DM_PAGE_MAX, DM_MAX_MESSAGE,
  DM_SIG_PREFIX, DROP, buildInner, openInner, sealInner, openSealed, encodeDrop, decodeDrop, newDropId
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
function forge (body, signer) {
  const json = b4a.from(JSON.stringify(body))
  const sig = hcrypto.sign(b4a.concat([b4a.from(DM_SIG_PREFIX), json]), signer.secretKey)
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
