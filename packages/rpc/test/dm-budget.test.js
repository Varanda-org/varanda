'use strict'

// The DM text budget (lib/dm-budget.js) against core's real buildInner,
// which signs and refuses what does not fit.
const test = require('brittle')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const dm = require('@varanda/core/lib/dm')
const { generateAssociationKeyPair, createCert, createIssuerCert, createIssuedCert } = require('@varanda/core/lib/cert')
const rpc = require('@varanda/rpc')
const budget = require('../lib/dm-budget')

const AT = '2026-11-03T12:00:00.000Z'
const assoc = generateAssociationKeyPair()

function signPair () {
  const kp = hcrypto.keyPair()
  return { ...kp, hex: b4a.toString(kp.publicKey, 'hex') }
}

const bia = signPair()
const plain = signPair()
plain.cert = createCert({ member: plain.hex, date: AT }, assoc)
const wide = signPair()
wide.cert = createCert({ member: wide.hex, ageBand: 'a'.repeat(32), method: 'b'.repeat(32), date: AT }, assoc)
const issuer = hcrypto.keyPair()
const issuerCert = createIssuerCert({ issuer: b4a.toString(issuer.publicKey, 'hex'), date: AT }, assoc)
const issued = signPair()
issued.cert = createIssuedCert({ member: issued.hex, date: AT }, issuer, issuerCert)

function item (n, over = {}) {
  return { id: n.toString(16).padStart(64, '0'), key: 'f'.repeat(64), nonce: 'e'.repeat(48), chunks: 257, bytes: 257 * 32768, sha256: 'd'.repeat(64), mime: 'image/webp', w: 16384, h: 16384, ms: 0, ...over }
}

// Exactly n JSON bytes in at most 1000 code points (when n < 4004).
function textOfBytes (n) {
  return '\u{1F600}'.repeat(Math.floor(n / 4)) + 'x'.repeat(n % 4)
}

function innerLength (inner) {
  return (inner[0] << 8) | inner[1]
}

test('dm-budget: same constants and key lists as core', (t) => {
  t.is(budget.DM_INNER_BYTES, dm.DM_INNER_BYTES)
  t.is(budget.DM_INNER_FRAMING_BYTES, 66)
  t.is(rpc.DM_INNER_KEYS, dm.INNER_KEYS)
  t.is(rpc.DM_INNER_KEYS_V2, dm.INNER_KEYS_V2)
  t.is(rpc.DM_MEDIA_KEYS, dm.DM_MEDIA_KEYS)
  t.is(rpc.dmTextBudget, budget.dmTextBudget)
  t.is(rpc.dmTextBytes, budget.dmTextBytes)
  t.ok(Object.isFrozen(rpc.DM_INNER_KEYS) && Object.isFrozen(rpc.DM_INNER_KEYS_V2) && Object.isFrozen(rpc.DM_MEDIA_KEYS))
})

test('dm-budget: text bytes count JSON escapes', (t) => {
  t.is(rpc.dmTextBytes(''), 0)
  t.is(rpc.dmTextBytes('oi'), 2)
  t.is(rpc.dmTextBytes('"'), 2)
  t.is(rpc.dmTextBytes('\\'), 2)
  t.is(rpc.dmTextBytes('\n'), 2)
  t.is(rpc.dmTextBytes('ã'), 2)
  t.is(rpc.dmTextBytes('\u{1F600}'), 4)
  t.is(rpc.dmTextBytes(null), 0)
})

test('dm-budget: version follows what the body needs', (t) => {
  t.is(rpc.dmInnerVersion({ media: null, card: null, fwd: 0 }), 1)
  t.is(rpc.dmInnerVersion({ media: [item(1)], card: null, fwd: 0 }), 2)
  t.is(rpc.dmInnerVersion({ media: null, card: {}, fwd: 0 }), 2)
  t.is(rpc.dmInnerVersion({ media: null, card: null, fwd: 1 }), 2)
})

test('dm-budget: matches core buildInner byte for byte', (t) => {
  const senders = [{ who: plain, cert: undefined }, { who: plain, cert: plain.cert }, { who: wide, cert: wide.cert }, { who: issued, cert: issued.cert }]
  let boundaries = 0
  for (const { who, cert } of senders) {
    for (const replyTo of [undefined, 'c'.repeat(32)]) {
      for (let n = 0; n <= 4; n++) {
        const media = n === 0 ? undefined : [1, 2, 3, 4].slice(0, n).map(i => item(i))
        const fields = { kind: 'msg', to: bia.hex, at: AT, cert, replyTo, media }
        const free = rpc.dmTextBudget(fields)
        const label = (cert ? 'v' + cert.v + ' cert' : 'no cert') + (replyTo ? ', reply' : '') + ', ' + n + ' items'
        // The measured size with a short text equals the budget's arithmetic.
        const inner = dm.buildInner({ ...fields, text: 'x' }, who)
        t.is(dm.DM_INNER_BYTES - 66 - innerLength(inner), free - 1, label + ': same size as the signed inner')
        if (free >= 4 * dm.DM_MAX_TEXT) continue
        boundaries++
        t.ok(dm.buildInner({ ...fields, text: textOfBytes(free) }, who), label + ': text at the budget fits')
        t.exception.all(() => dm.buildInner({ ...fields, text: textOfBytes(free + 1) }, who), /mensagem longa demais/, label + ': one byte more throws')
      }
    }
  }
  t.ok(boundaries >= 16, 'every case with media is checked at the boundary')
})

test('dm-budget: stand-ins have the length of the real values', (t) => {
  const fields = { media: [item(1)], cert: issued.cert }
  const known = { ...fields, id: 'a'.repeat(32), from: issued.hex, to: bia.hex, at: AT }
  t.is(rpc.dmTextBudget(fields), rpc.dmTextBudget(known))
  t.is(rpc.dmTextBudget(fields), dm.textBudget(fields), 'core exposes the same function')
  t.is(rpc.dmTextBudget({ media: [Object.fromEntries(Object.entries(item(1)).reverse())], cert: issued.cert }), rpc.dmTextBudget(fields), 'item key order does not matter')
  t.ok(rpc.dmTextBudget() > 4 * dm.DM_MAX_TEXT, 'a text-only message always fits')
  t.ok(rpc.dmTextBudget(null) > 4 * dm.DM_MAX_TEXT)
})
