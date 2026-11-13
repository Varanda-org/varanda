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

// A bound reply's replyTo: the quoted message's sender, id and digest.
const BOUND = { from: bia.hex, id: 'c'.repeat(32), digest: 'd'.repeat(64) }

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
  t.is(rpc.dmInnerVersion({ media: null, card: null, fwd: 0, replyTo: BOUND }), 2, 'a bound reply needs v2')
  t.is(rpc.dmInnerVersion({ media: null, card: null, fwd: 0, replyTo: 'c'.repeat(32) }), 1, 'a bare id stays v1')
  t.is(rpc.dmInnerVersion({ media: null, card: null, fwd: 0, replyTo: null }), 1)
})

test('dm-budget: matches core buildInner byte for byte', (t) => {
  const senders = [{ who: plain, cert: undefined }, { who: plain, cert: plain.cert }, { who: wide, cert: wide.cert }, { who: issued, cert: issued.cert }]
  let boundaries = 0
  for (const { who, cert } of senders) {
    for (const replyTo of [undefined, 'c'.repeat(32), BOUND]) {
      for (let n = 0; n <= 4; n++) {
        const media = n === 0 ? undefined : [1, 2, 3, 4].slice(0, n).map(i => item(i))
        const fields = { kind: 'msg', to: bia.hex, at: AT, cert, replyTo, media }
        const free = rpc.dmTextBudget(fields)
        const label = (cert ? 'v' + cert.v + ' cert' : 'no cert') + (replyTo ? (typeof replyTo === 'string' ? ', reply' : ', bound reply') : '') + ', ' + n + ' items'
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
  t.ok(boundaries >= 24, 'every case with media is checked at the boundary')
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

test('dm-budget: a link card counts, in its canonical order', (t) => {
  const { CARD_KEYS } = require('@varanda/core/lib/link-card')
  t.alike(budget.DM_CARD_KEYS, CARD_KEYS)
  t.ok(Object.isFrozen(budget.DM_CARD_KEYS))
  const card = { url: 'https://example.com/' + '%'.repeat(280), host: 'example.com', title: '\u{1F600}'.repeat(80), desc: '\u{1F600}'.repeat(160), image: item(9, { chunks: 1, bytes: 32768, mime: 'image/jpeg' }) }
  const shuffled = Object.fromEntries(Object.entries({ ...card, image: Object.fromEntries(Object.entries(card.image).reverse()) }).reverse())
  const fields = { kind: 'msg', to: bia.hex, at: AT, cert: issued.cert, replyTo: 'c'.repeat(32), card, fwd: 1 }
  const free = rpc.dmTextBudget(fields)
  t.is(rpc.dmTextBudget({ ...fields, card: shuffled }), free, 'card key order does not matter')
  t.ok(free < rpc.dmTextBudget({ ...fields, card: null }), 'the card takes room')
  const inner = dm.buildInner({ ...fields, text: 'x' }, issued)
  t.is(dm.DM_INNER_BYTES - 66 - innerLength(inner), free - 1, 'same size as the signed inner')
  t.ok(dm.buildInner({ ...fields, text: textOfBytes(free) }, issued), 'text at the budget fits')
  t.exception.all(() => dm.buildInner({ ...fields, text: textOfBytes(free + 1) }, issued), /mensagem longa demais/, 'one byte more throws')
})

test('dm-budget: v3 writes the v2 keys and matches core innerDigest', (t) => {
  t.is(budget.DM_INNER_KEYS_V3, budget.DM_INNER_KEYS_V2)
  const body = { v: 3, kind: 'msg', id: 'a'.repeat(32), from: bia.hex, to: plain.hex, replyTo: null, text: 'oi', media: null, card: null, fwd: 0, op: null, peer: null, at: AT, cert: null }
  const json = budget.canonicalInnerJson(Object.fromEntries(Object.entries(body).reverse()))
  t.alike(Object.keys(JSON.parse(json)), budget.DM_INNER_KEYS_V2)
  t.is(json, b4a.toString(dm.innerDigest(body).json))
  t.is(rpc.dmInnerVersion({ media: null, card: null, fwd: 0 }), 1, 'innerVersion never answers 3')

  for (const media of [undefined, [item(1)]]) {
    const fields = { kind: 'msg', from: issued.hex, to: bia.hex, at: AT, cert: issued.cert, media }
    const free = rpc.dmTextBudget({ ...fields, v: 3 })
    const { json } = dm.innerDigest({ ...fields, text: 'x' })
    t.is(budget.DM_INNER_V3_EXPIRY_BYTES, 8)
    t.is(dm.DM_INNER_BYTES - 66 - 8 - json.byteLength, free - 1, 'same size as the v3 inner, expiry included')
    t.ok(free <= rpc.dmTextBudget(fields), 'v3 never has more room than v1 or v2')
  }
  const full = { kind: 'msg', from: issued.hex, to: bia.hex, at: AT, cert: issued.cert, replyTo: 'c'.repeat(32), media: [item(1), item(2), item(3), item(4)] }
  const free = rpc.dmTextBudget({ ...full, v: 3 })
  t.ok(free < 4000, 'the budget is below the code point limit here')
  t.ok(dm.innerDigest({ ...full, text: textOfBytes(free) }), 'text at the v3 budget fits')
  t.exception.all(() => dm.innerDigest({ ...full, text: textOfBytes(free + 1) }), /mensagem longa demais/, 'one byte more throws')
})

test('dm-budget: a bound reply is written in its canonical order and counted', (t) => {
  const body = { v: 2, kind: 'msg', id: 'a'.repeat(32), from: plain.hex, to: bia.hex, replyTo: { digest: BOUND.digest, id: BOUND.id, from: BOUND.from }, text: 'oi', media: null, card: null, fwd: 0, op: null, peer: null, at: AT, cert: null }
  const parsed = JSON.parse(budget.canonicalInnerJson(Object.fromEntries(Object.entries(body).reverse())))
  t.alike(Object.keys(parsed), budget.DM_INNER_KEYS_V2)
  t.alike(Object.keys(parsed.replyTo), ['from', 'id', 'digest'], 'replyTo in DM_TARGET_KEYS order')
  t.is(JSON.parse(budget.canonicalInnerJson({ ...body, replyTo: 'c'.repeat(32) })).replyTo, 'c'.repeat(32), 'a bare id as given')
  const fields = { kind: 'msg', to: bia.hex, at: AT, cert: issued.cert }
  const bare = rpc.dmTextBudget({ ...fields, replyTo: 'c'.repeat(32) })
  const bound = rpc.dmTextBudget({ ...fields, replyTo: BOUND })
  t.is(bare - bound, 190, 'the object and the v2 keys')
  t.is(bound, 3895, 'a text-only bound reply with the largest certificate')
  t.is(Math.floor(bound / 4), 973)
  t.ok(bare >= 4 * dm.DM_MAX_TEXT, 'a bare-id text reply still fits 1000 four-byte characters')
  const v3 = { ...fields, from: issued.hex }
  const free = rpc.dmTextBudget({ ...v3, v: 3, replyTo: BOUND })
  t.is(free, 3887, 'a page reply, bound')
  t.is(rpc.dmTextBudget({ ...v3, v: 3, replyTo: 'c'.repeat(32) }), 4044)
  const { json } = dm.innerDigest({ ...v3, replyTo: BOUND, text: 'x' })
  t.is(dm.DM_INNER_BYTES - 66 - 8 - json.byteLength, free - 1, 'same size as the v3 inner')
  t.ok(dm.innerDigest({ ...v3, replyTo: BOUND, text: textOfBytes(free) }), 'text at the v3 budget fits')
  t.exception.all(() => dm.innerDigest({ ...v3, replyTo: BOUND, text: textOfBytes(free + 1) }), /mensagem longa demais/, 'one byte more throws')
})

// The longest reaction isReaction accepts in UTF-8: eight code points, three
// pictographs with skin tones joined by two ZWJ (4+4+3+4+4+3+4+4 bytes).
const LONGEST_EMOJI = '\u{1F468}\u{1F3FB}‍\u{1F468}\u{1F3FB}‍\u{1F468}\u{1F3FB}'

test('dm-budget: v4 is a reaction with its own exact key set', (t) => {
  t.alike(rpc.DM_INNER_KEYS_V4, ['v', 'kind', 'id', 'from', 'to', 'target', 'emoji', 'rev', 'at', 'cert'])
  t.is(rpc.DM_INNER_KEYS_V4, budget.DM_INNER_KEYS_V4)
  t.is(rpc.DM_INNER_KEYS_V4, dm.INNER_KEYS_V4)
  t.alike(rpc.DM_TARGET_KEYS, ['from', 'id', 'digest'], 'the target names the message by sender, id and digest')
  t.is(rpc.DM_TARGET_KEYS, dm.DM_TARGET_KEYS)
  t.ok(Object.isFrozen(rpc.DM_INNER_KEYS_V4) && Object.isFrozen(rpc.DM_TARGET_KEYS))
  const body = { v: 4, kind: 'react', id: 'a'.repeat(32), from: bia.hex, to: plain.hex, target: { digest: 'c'.repeat(64), id: 'b'.repeat(32), from: plain.hex, extra: 1 }, emoji: '❤️', rev: 1, at: AT, cert: null }
  const json = budget.canonicalInnerJson(Object.fromEntries(Object.entries(body).reverse()))
  const parsed = JSON.parse(json)
  t.alike(Object.keys(parsed), rpc.DM_INNER_KEYS_V4, 'wire order whatever the caller built')
  t.alike(Object.keys(parsed.target), ['from', 'id', 'digest'], 'target in its canonical order, nothing else')
})

test('dm-budget: the largest v4 inner fits the fixed frame', (t) => {
  t.ok(rpc.isReaction(LONGEST_EMOJI))
  t.is(b4a.byteLength(LONGEST_EMOJI), 30)
  t.ok(rpc.REACTION_MAX_BYTES >= 30)
  const body = {
    v: 4,
    kind: 'react',
    id: 'f'.repeat(32),
    from: 'f'.repeat(64),
    to: 'e'.repeat(64),
    target: { from: 'e'.repeat(64), id: 'd'.repeat(32), digest: 'c'.repeat(64) },
    emoji: LONGEST_EMOJI,
    rev: 1000000,
    at: AT,
    cert: budget.MEMBER_CERT_STANDIN
  }
  const bytes = b4a.byteLength(budget.canonicalInnerJson(body))
  t.ok(bytes + budget.DM_INNER_FRAMING_BYTES <= budget.DM_INNER_BYTES, 'v4 frame ' + (bytes + 66) + ' of ' + budget.DM_INNER_BYTES)
  // Even an emoji at the byte cap, all of it escaped as \uXXXX (6 bytes per
  // 1 to 3 bytes), leaves room.
  const bound = bytes - 30 + rpc.REACTION_MAX_BYTES * 6
  t.ok(bound + budget.DM_INNER_FRAMING_BYTES <= budget.DM_INNER_BYTES)

  const real = dm.buildInner({ kind: 'react', to: bia.hex, target: { from: bia.hex, id: 'd'.repeat(32), digest: 'c'.repeat(64) }, emoji: LONGEST_EMOJI, rev: 1000000, at: AT, cert: issued.cert }, issued)
  const realJson = b4a.toString(real.subarray(2, 2 + innerLength(real)))
  t.alike(Object.keys(JSON.parse(realJson)), rpc.DM_INNER_KEYS_V4)
  t.is(realJson, budget.canonicalInnerJson(JSON.parse(realJson)), 'core signs the canonical bytes')
})
