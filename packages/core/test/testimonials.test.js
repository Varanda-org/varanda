'use strict'

const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const records = require('../lib/records')
const {
  MAX_TESTIMONIAL, MAX_TESTIMONIAL_BOX, MAX_TESTIMONIAL_SEALED,
  sealOffer, openOffer, verifyShow, shownRows, commitment
} = require('../lib/testimonials')

const WRITER = 'a'.repeat(64)
const OWNER = 'b'.repeat(64)
const OTHER = 'e'.repeat(64)
const AT = '2026-01-01T00:00:00.000Z'

function boxPair () {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function written (text, kp = boxPair(), from = WRITER) {
  const boxPk = b4a.toString(kp.publicKey, 'hex')
  const sealed = sealOffer({ from, text, boxPk })
  const record = records.testimonialRecord({ to: OWNER, gen: 1, hash: sealed.hash, box: sealed.box, at: AT })
  return { kp, sealed, record }
}

test('constants match the records caps', (t) => {
  t.is(MAX_TESTIMONIAL, 400)
  t.is(MAX_TESTIMONIAL, records.MAX_TESTIMONIAL)
  t.is(MAX_TESTIMONIAL_BOX, records.MAX_TESTIMONIAL_BOX)
  t.is(MAX_TESTIMONIAL_SEALED, records.MAX_TESTIMONIAL_SEALED)
})

test('seal and open round trip', (t) => {
  const { kp, sealed, record } = written('Amiga de todas as horas.\nObrigada!')
  t.ok(records.isHex64(sealed.nonce))
  t.ok(records.isHex64(sealed.hash))
  t.is(sealed.hash, commitment(WRITER, sealed.nonce, 'Amiga de todas as horas.\nObrigada!'))
  t.not(sealed.hash, commitment(OTHER, sealed.nonce, 'Amiga de todas as horas.\nObrigada!'), 'bound to the writer')
  t.is(records.validateRecord(record, 1), null)
  t.alike(openOffer(sealed.box, kp), { text: 'Amiga de todas as horas.\nObrigada!', nonce: sealed.nonce })
  // Bytes or hex for the public key.
  const again = sealOffer({ from: WRITER, text: 'oi', boxPk: kp.publicKey })
  t.alike(openOffer(again.box, kp), { text: 'oi', nonce: again.nonce })
  t.not(again.nonce, sealOffer({ from: WRITER, text: 'oi', boxPk: kp.publicKey }).nonce, 'fresh nonce each time')
  // Another key opens nothing.
  t.is(openOffer(sealed.box, boxPair()), null)
})

test('the worst-case text fits the box cap', (t) => {
  const kp = boxPair()
  const text = '\u{1F600}'.repeat(MAX_TESTIMONIAL)
  const sealed = sealOffer({ from: WRITER, text, boxPk: kp.publicKey })
  t.is(b4a.from(sealed.box, 'base64').byteLength, MAX_TESTIMONIAL_SEALED, 'exactly the cap')
  t.is(sealed.box.length, MAX_TESTIMONIAL_BOX)
  t.is(records.validateRecord(records.testimonialRecord({ to: OWNER, gen: 1, hash: sealed.hash, box: sealed.box, at: AT }), 1), null)
  t.alike(openOffer(sealed.box, kp), { text, nonce: sealed.nonce })
  // Escapes never beat a 4-byte character.
  for (const ch of ['"', '\\', '\n', 'é', '中']) {
    const s = sealOffer({ from: WRITER, text: ch.repeat(MAX_TESTIMONIAL), boxPk: kp.publicKey })
    t.ok(b4a.from(s.box, 'base64').byteLength <= MAX_TESTIMONIAL_SEALED, 'fits: ' + ch.codePointAt(0))
  }
  // One byte more (sealed by hand) is refused by the record and by openOffer.
  const plain = b4a.from('{"text":' + JSON.stringify(text + 'x') + ',"nonce":"' + 'd'.repeat(64) + '"}', 'utf8')
  const big = b4a.alloc(plain.byteLength + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(big, plain, kp.publicKey)
  t.is(big.byteLength, MAX_TESTIMONIAL_SEALED + 1)
  const bigBox = b4a.toString(big, 'base64')
  t.is(records.validateRecord({ type: 'testimonial', to: OWNER, gen: 1, hash: 'c'.repeat(64), box: bigBox, at: AT }, 1), 'malformed')
  t.is(openOffer(bigBox, kp), null)
})

test('sealOffer refuses bad input without echoing it', async (t) => {
  const kp = boxPair()
  for (const text of ['', 'x'.repeat(MAX_TESTIMONIAL + 1), 'a\u0000b', 'a\ud800', 7, null]) {
    await t.exception.all(async () => sealOffer({ from: WRITER, text, boxPk: kp.publicKey }), /^TypeError: depoimento inválido$/)
  }
  for (const boxPk of ['z'.repeat(64), '0'.repeat(64), b4a.alloc(31), null]) {
    await t.exception.all(async () => sealOffer({ from: WRITER, text: 'oi', boxPk }), /^TypeError: chave de caixa inválida$/)
  }
  for (const from of [undefined, 'A'.repeat(64), 'a'.repeat(63), 7]) {
    await t.exception.all(async () => sealOffer({ from, text: 'oi', boxPk: kp.publicKey }), /^TypeError: autor inválido$/)
  }
})

test('openOffer never throws and refuses forged plaintext', (t) => {
  const kp = boxPair()
  const seal = (str) => {
    const plain = b4a.from(str, 'utf8')
    const out = b4a.alloc(plain.byteLength + sodium.crypto_box_SEALBYTES)
    sodium.crypto_box_seal(out, plain, kp.publicKey)
    return b4a.toString(out, 'base64')
  }
  const N = 'd'.repeat(64)
  t.ok(openOffer(seal('{"text":"oi","nonce":"' + N + '"}'), kp), 'canonical opens')
  t.is(openOffer(seal('{"nonce":"' + N + '","text":"oi"}'), kp), null, 'reordered keys')
  t.is(openOffer(seal('{"text":"oi","nonce":"' + N + '","x":1}'), kp), null, 'extra key')
  t.is(openOffer(seal('{"text":"\\u006fi","nonce":"' + N + '"}'), kp), null, 're-escaped')
  t.is(openOffer(seal('{"text":"oi","nonce":"' + 'D'.repeat(64) + '"}'), kp), null, 'upper nonce')
  t.is(openOffer(seal('{"text":"a\\r","nonce":"' + N + '"}'), kp), null, 'control char')
  t.is(openOffer(seal('{"text":"' + 'x'.repeat(401) + '","nonce":"' + N + '"}'), kp), null, 'too long')
  t.is(openOffer(seal('not json at all, but long enough to pass the minimum sealed length of the box, yes'), kp), null)
  for (const bad of [null, 7, '', '!!!!', 'AAAA', b4a.toString(b4a.alloc(200), 'base64')]) t.is(openOffer(bad, kp), null)
  const good = seal('{"text":"oi","nonce":"' + N + '"}')
  for (const pair of [null, {}, { publicKey: kp.publicKey }, { publicKey: b4a.alloc(32), secretKey: kp.secretKey }]) t.is(openOffer(good, pair), null)
  const hostile = {}
  Object.defineProperty(hostile, 'publicKey', { enumerable: true, get () { throw new Error('boom') } })
  t.is(openOffer(good, hostile), null)
})

test('verifyShow accepts only the committed text for the owner', (t) => {
  const { sealed, record } = written('Generosa e leal.')
  const show = records.testimonialShowRecord({ from: WRITER, seq: 4, text: 'Generosa e leal.', nonce: sealed.nonce, at: AT })
  t.ok(verifyShow(show, record, OWNER))
  t.absent(verifyShow({ ...show, text: 'Generosa e desleal.' }, record, OWNER), 'edited text')
  t.absent(verifyShow({ ...show, nonce: 'f'.repeat(64) }, record, OWNER), 'wrong nonce')
  t.absent(verifyShow(show, { ...record, hash: 'c'.repeat(64) }, OWNER), 'wrong hash')
  t.absent(verifyShow(show, { ...record, to: OTHER }, OWNER), 'written to someone else')
  t.absent(verifyShow(show, record, OTHER), 'shown by someone else')
  t.absent(verifyShow(show, null, OWNER), 'missing writer block')
  t.absent(verifyShow(show, { type: 'post', text: 'oi', at: AT, replyTo: null }, OWNER), 'writer block is not a testimonial')
  t.absent(verifyShow(show, { ...record, extra: 1 }, OWNER), 'malformed writer block')
  t.absent(verifyShow({ ...show, from: OWNER }, { ...record, to: OWNER }, OWNER), 'self testimonial')
  t.absent(verifyShow({ ...show, type: 'testimonial' }, record, OWNER))
  t.absent(verifyShow(show, record, 'x'))
  // OTHER copies the writer's block verbatim into OTHER's diary: a show
  // naming OTHER with the same text and nonce does not verify.
  t.absent(verifyShow({ ...show, from: OTHER }, record, OWNER), 'copied block under another writer')
  const hostile = { ...show }
  Object.defineProperty(hostile, 'text', { enumerable: true, get () { throw new Error('boom') } })
  t.absent(verifyShow(hostile, record, OWNER))
})

test('shownRows: one per writer, newest show decides, tombstones hide', (t) => {
  const show = (from, seq, text) => records.testimonialShowRecord({ from, seq, text, nonce: 'd'.repeat(64), at: AT })
  const entries = [
    { seq: 1, record: show(WRITER, 2, 'antigo') },
    { seq: 2, record: { type: 'post', text: 'oi', at: AT, replyTo: null } },
    { seq: 3, record: show(OTHER, 7, 'outro') },
    { seq: 4, record: show(WRITER, 9, 'novo') },
    { seq: 5, record: { type: 'testimonial-show', from: WRITER, seq: 10, text: '', nonce: 'd'.repeat(64), at: AT } }
  ]
  t.alike(shownRows(entries).map((r) => [r.from, r.seq, r.showSeq, r.text]), [
    [WRITER, 9, 4, 'novo'],
    [OTHER, 7, 3, 'outro']
  ])
  t.alike(Object.keys(shownRows(entries)[0]), ['from', 'seq', 'showSeq', 'text', 'nonce', 'at'])
  // The owner tombstones the newest show of WRITER: that writer is hidden.
  const removed = [...entries, { seq: 6, record: records.deleteRecord({ seq: 4, at: AT }) }]
  t.alike(shownRows(removed).map((r) => r.from), [OTHER])
  // A newer show brings it back.
  const back = [...removed, { seq: 7, record: show(WRITER, 11, 'de volta') }]
  t.alike(shownRows(back).map((r) => [r.from, r.text]), [[WRITER, 'de volta'], [OTHER, 'outro']])
  t.alike(shownRows(null), [])
  t.alike(shownRows([null, 7, { seq: 'x' }, { seq: 0, record: show(WRITER, 1, 'x') }]), [])
})
