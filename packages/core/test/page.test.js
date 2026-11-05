'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const certLib = require('../lib/cert')
const page = require('../lib/page')
const { validateRecord, MAX_PAGE_ADMINS } = require('../lib/records')

const {
  ownerPayload, issuerPayload, signRoster, signAccept, signOffer, signOrigin, signClose, signMoved,
  issuerCountersign, verifyCountersigned, verifyIssuerOnly, verifyRoster, verifyAccept, verifyOffer,
  verifyOrigin, pageState, pendingOffer
} = page

const AT = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'
const hex = (kp) => b4a.toString(kp.publicKey, 'hex')
const nonce = (c) => c.repeat(43)

function setup () {
  const assocKp = crypto.keyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = certLib.createIssuerCert({ issuer: hex(issuerKp), date: AT }, assocKp)
  const people = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair(), crypto.keyPair()]
    .map((kp) => ({ kp, hex: hex(kp) }))
    .sort((a, b) => (a.hex < b.hex ? -1 : 1))
  return {
    assocKp,
    assoc: issuerCert.association,
    issuerKp,
    issuerCert,
    P: hex(crypto.keyPair()),
    people
  }
}

function roster (s, ownerKp, { gen = 1, admins = [], prev = null, at = AT, n = 'r', page: pageKey = s.P } = {}) {
  const fields = { type: 'page-roster', page: pageKey, gen, owner: hex(ownerKp), admins: [...admins].sort(), prev, at, nonce: nonce(n), association: s.assoc }
  const signature = signRoster(fields, ownerKp)
  return issuerCountersign({ ...fields, signature }, s.issuerKp, s.issuerCert)
}

function accept (s, kp, rosterRec, { gen = rosterRec.gen } = {}) {
  const fields = { type: 'page-accept', page: s.P, gen, rosterSignature: rosterRec.signature, at: AT, nonce: nonce('a'), actor: hex(kp) }
  return { ...fields, signature: signAccept(fields, kp) }
}

function offer (s, kp, { to, exp = LATER, gen }) {
  const fields = { type: 'page-offer', page: s.P, to, exp: to === null ? null : exp, gen, at: AT, nonce: nonce('o'), actor: hex(kp) }
  return { ...fields, signature: signOffer(fields, kp) }
}

function origin (s, kp, { admins = [], gen = 3, from = 'd'.repeat(64) } = {}) {
  const fields = { type: 'page-origin', page: s.P, from, fromSeq: 9, gen, owner: hex(kp), admins: [...admins].sort(), at: AT, nonce: nonce('g'), actor: hex(kp), association: s.assoc }
  return issuerCountersign({ ...fields, signature: signOrigin(fields, kp) }, s.issuerKp, s.issuerCert)
}

function link (s, { page: pageKey = s.P, diary = 'e'.repeat(64), actor = 'c'.repeat(64) } = {}) {
  const r = {
    type: 'page-link',
    page: pageKey,
    diary,
    actor,
    at: AT,
    nonce: nonce('l'),
    association: s.assoc,
    issuer: s.issuerCert.issuer,
    issuerDate: s.issuerCert.date,
    issuerSignature: s.issuerCert.signature,
    signature: ''
  }
  r.signature = b4a.toString(crypto.sign(ownerPayload(r), s.issuerKp.secretKey), 'hex')
  return r
}

const at = (seq, record) => ({ seq, record })

test('page: constants', (t) => {
  t.is(page.MAX_PAGE_ADMINS, 16)
  t.is(page.MAX_PAGE_ADMINS, MAX_PAGE_ADMINS)
  t.is(page.PAGE_ROSTER_REFRESH_BLOCKS, 256)
  t.is(page.MAX_PAGE_FOLLOWS, 4095)
  t.is(page.ROSTER_PREFIX, 'varanda-page-roster-v1')
  t.is(page.ROSTER_ISSUER_PREFIX, 'varanda-page-roster-issuer-v1')
  t.is(page.ACCEPT_PREFIX, 'varanda-page-accept-v1')
  t.is(page.OFFER_PREFIX, 'varanda-page-offer-v1')
  t.is(page.ORIGIN_PREFIX, 'varanda-page-origin-v1')
  t.is(page.ORIGIN_ISSUER_PREFIX, 'varanda-page-origin-issuer-v1')
})

test('page: golden payload bytes', (t) => {
  const [p, o, a1, a2, as, is, d, f] = ['1', '2', '3', '4', '5', '6', '7', '8'].map((c) => c.repeat(64))
  const sig = 's'.repeat(3)
  const N = nonce('N')
  const trio = { association: as, issuer: is, issuerDate: AT, issuerSignature: '9'.repeat(128) }
  const str = (buf) => b4a.toString(buf, 'utf8')

  const r = { type: 'page-roster', page: p, gen: 2, owner: o, admins: [a1, a2], prev: 7, at: AT, nonce: N, ...trio, signature: sig }
  t.is(str(ownerPayload(r)), ['varanda-page-roster-v1', p, '2', o, a1 + ',' + a2, '7', AT, N, as].join('\n'))
  t.is(str(issuerPayload(r)), ['varanda-page-roster-issuer-v1', p, '2', o, a1 + ',' + a2, '7', AT, N, as, sig].join('\n'))
  const g = { ...r, admins: [], prev: null, gen: 1 }
  t.is(str(ownerPayload(g)), ['varanda-page-roster-v1', p, '1', o, '', 'null', AT, N, as].join('\n'), 'genesis: empty admins, null prev')

  const og = { type: 'page-origin', page: p, from: f, fromSeq: 12, gen: 3, owner: o, admins: [a1], at: AT, nonce: N, actor: o, ...trio, signature: sig }
  t.is(str(ownerPayload(og)), ['varanda-page-origin-v1', p, f, '12', '3', o, a1, AT, N, o, as].join('\n'))
  t.is(str(issuerPayload(og)), ['varanda-page-origin-issuer-v1', p, f, '12', '3', o, a1, AT, N, o, as, sig].join('\n'))

  const cl = { type: 'page-close', page: p, gen: 4, at: AT, nonce: N, actor: o, ...trio, signature: sig }
  t.is(str(ownerPayload(cl)), ['varanda-page-close-v1', p, '4', AT, N, o, as].join('\n'))
  t.is(str(issuerPayload(cl)), ['varanda-page-close-issuer-v1', p, '4', AT, N, o, as, sig].join('\n'))

  const mv = { type: 'page-moved', page: p, to: d, gen: 4, at: AT, nonce: N, actor: o, ...trio, signature: sig }
  t.is(str(ownerPayload(mv)), ['varanda-page-moved-v1', p, d, '4', AT, N, o, as].join('\n'))
  t.is(str(issuerPayload(mv)), ['varanda-page-moved-issuer-v1', p, d, '4', AT, N, o, as, sig].join('\n'))

  const ac = { type: 'page-accept', page: p, gen: 2, rosterSignature: 'r'.repeat(4), at: AT, nonce: N, actor: a1, signature: sig }
  t.is(str(ownerPayload(ac)), ['varanda-page-accept-v1', p, '2', 'rrrr', AT, N, a1].join('\n'))

  const of = { type: 'page-offer', page: p, to: a1, exp: LATER, gen: 2, at: AT, nonce: N, actor: o, signature: sig }
  t.is(str(ownerPayload(of)), ['varanda-page-offer-v1', p, a1, LATER, '2', AT, N, o].join('\n'))
  t.is(str(ownerPayload({ ...of, to: null, exp: null })), ['varanda-page-offer-v1', p, 'null', 'null', '2', AT, N, o].join('\n'), 'cancel')

  const ln = { type: 'page-link', page: p, diary: d, actor: a1, at: AT, nonce: N, ...trio, signature: sig }
  t.is(str(ownerPayload(ln)), ['varanda-page-link-v1', p, d, a1, AT, N, as].join('\n'))

  t.exception.all(() => issuerPayload(ac), /unsupported/, 'no issuer payload for an accept')
  t.exception.all(() => issuerPayload(ln), /unsupported/, 'no issuer payload for a link')
  t.exception.all(() => ownerPayload({ type: 'page-delegate', actor: a1, at: AT }), /unsupported/)
  t.exception.all(() => ownerPayload({ type: 'post' }), /unsupported/)
  t.exception.all(() => ownerPayload(null), /unsupported/)
})

test('page: signed records pass the record shapes and verify', (t) => {
  const s = setup()
  const [o] = s.people
  const r = roster(s, o.kp)
  t.is(validateRecord(r, 2), null)
  t.alike(verifyRoster(r, s.P, s.assoc), { ok: true })
  t.alike(verifyCountersigned(r, s.P, s.assoc), { ok: true })
  const og = origin(s, o.kp)
  t.is(validateRecord(og, 3), null)
  t.alike(verifyOrigin(og, s.P, s.assoc), { ok: true })
  t.is(verifyRoster(og, s.P, s.assoc).reason, 'malformed', 'an origin is not a roster')

  const closeFields = { type: 'page-close', page: s.P, gen: 2, at: AT, nonce: nonce('c'), actor: o.hex, association: s.assoc }
  const close = issuerCountersign({ ...closeFields, signature: signClose(closeFields, o.kp) }, s.issuerKp, s.issuerCert)
  t.is(validateRecord(close, 4), null)
  t.alike(verifyCountersigned(close, s.P, s.assoc), { ok: true })
  const movedFields = { type: 'page-moved', page: s.P, to: 'd'.repeat(64), gen: 2, at: AT, nonce: nonce('m'), actor: o.hex, association: s.assoc }
  const moved = issuerCountersign({ ...movedFields, signature: signMoved(movedFields, o.kp) }, s.issuerKp, s.issuerCert)
  t.is(validateRecord(moved, 4), null)
  t.alike(verifyCountersigned(moved, s.P, s.assoc), { ok: true })

  const ac = accept(s, s.people[1].kp, roster(s, o.kp, { gen: 2, prev: 2, admins: [s.people[1].hex] }))
  t.is(validateRecord(ac, 3), null)
  t.alike(verifyAccept(ac, s.P, s.assoc), { ok: true })
  t.is(verifyAccept({ ...ac, actor: o.hex }, s.P, s.assoc).reason, 'bad-signature')
  t.is(verifyAccept(ac, 'd'.repeat(64), s.assoc).reason, 'page-mismatch')
  const of = offer(s, o.kp, { to: s.people[1].hex, gen: 1 })
  t.is(validateRecord(of, 3), null)
  t.alike(verifyOffer(of, s.P, s.assoc), { ok: true })
  const cancel = offer(s, o.kp, { to: null, gen: 1 })
  t.alike(verifyOffer(cancel, s.P, s.assoc), { ok: true })

  const ln = link(s)
  t.is(validateRecord(ln, 3), null)
  t.alike(verifyIssuerOnly(ln, s.assoc), { ok: true })
  t.is(verifyIssuerOnly({ ...ln, actor: 'b'.repeat(64) }, s.assoc).reason, 'bad-signature')
  t.is(verifyIssuerOnly(ln, 'd'.repeat(64)).reason, 'untrusted-association')
  t.is(verifyIssuerOnly(ln, s.assoc, { revokedIssuers: new Set([s.issuerCert.issuer]) }).reason, 'revoked-issuer')
  t.is(verifyIssuerOnly(r, s.assoc).reason, 'malformed', 'a roster is not a link')
})

test('page: verify reasons for countersigned records', (t) => {
  const s = setup()
  const [o, other] = s.people
  const r = roster(s, o.kp)
  t.is(verifyRoster(r, 'd'.repeat(64), s.assoc).reason, 'page-mismatch', 'a roster copied from another page')
  t.is(verifyRoster(r, s.P, 'd'.repeat(64)).reason, 'untrusted-association')
  t.is(verifyRoster({ ...r, issuerSignature: 'a'.repeat(128) }, s.P, s.assoc).reason, 'bad-issuer-signature', 'forged delegation')
  t.is(verifyRoster({ ...r, countersignature: r.signature }, s.P, s.assoc).reason, 'bad-issuer-signature', 'not countersigned')
  t.is(verifyRoster({ ...r, nonce: nonce('x') }, s.P, s.assoc).reason, 'bad-issuer-signature', 'field changed after the countersign')

  // Signed by a non-owner, countersigned by a (fooled) issuer.
  const fields = { type: 'page-roster', page: s.P, gen: 1, owner: o.hex, admins: [], prev: null, at: AT, nonce: nonce('r'), association: s.assoc }
  const forged = { ...fields, issuer: s.issuerCert.issuer, issuerDate: s.issuerCert.date, issuerSignature: s.issuerCert.signature, signature: signRoster({ ...fields, owner: other.hex }, other.kp), countersignature: '' }
  forged.countersignature = b4a.toString(crypto.sign(issuerPayload(forged), s.issuerKp.secretKey), 'hex')
  t.is(verifyRoster(forged, s.P, s.assoc).reason, 'bad-signature', 'signed by a non-owner')
  t.is(pageState([at(2, forged)], s.P, s.assoc).page, false, 'a non-owner roster is ignored')

  t.is(verifyRoster(r, s.P, s.assoc, { revokedIssuers: new Set([s.issuerCert.issuer]) }).reason, 'revoked-issuer')
  t.is(verifyRoster({ ...r, signature: 'a'.repeat(128) }, s.P, s.assoc, { revokedIssuers: new Set([s.issuerCert.issuer]) }).reason, 'bad-issuer-signature', 'revocation is checked last')
  t.is(verifyRoster({ ...r, extra: 1 }, s.P, s.assoc).reason, 'malformed')
  t.is(verifyRoster(r, 'nope', s.assoc).reason, 'malformed')
  t.is(verifyRoster(r, s.P, 'nope').reason, 'malformed')
})

test('page: sign and countersign refuse bad input', (t) => {
  const s = setup()
  const [o, other] = s.people
  const fields = { type: 'page-roster', page: s.P, gen: 1, owner: o.hex, admins: [], prev: null, at: AT, nonce: nonce('r'), association: s.assoc }
  t.exception.all(() => signRoster({ ...fields, gen: 0 }, o.kp), TypeError)
  t.exception.all(() => signRoster({ ...fields, admins: [o.hex] }, o.kp), TypeError, 'owner among admins')
  t.exception.all(() => signRoster({ ...fields, nonce: 'short' }, o.kp), TypeError)
  t.exception.all(() => signRoster(fields, other.kp), TypeError, 'not the owner')
  t.exception.all(() => signRoster(fields, {}), TypeError)
  t.exception.all(() => signRoster(null, o.kp), TypeError)
  t.exception.all(() => signAccept({ type: 'page-accept', page: s.P, gen: 1, rosterSignature: 'a'.repeat(128), at: AT, nonce: nonce('a'), actor: o.hex }, o.kp), TypeError, 'accept gen 1')
  t.exception.all(() => signOffer({ type: 'page-offer', page: s.P, to: null, exp: LATER, gen: 1, at: AT, nonce: nonce('o'), actor: o.hex }, o.kp), TypeError, 'cancel with exp')
  t.exception.all(() => signOrigin({ type: 'page-origin', page: s.P, from: s.P, fromSeq: 1, gen: 1, owner: o.hex, admins: [], at: AT, nonce: nonce('g'), actor: o.hex, association: s.assoc }, o.kp), TypeError, 'origin from itself')

  const signed = { ...fields, signature: signRoster(fields, o.kp) }
  t.exception.all(() => issuerCountersign(signed, other.kp, s.issuerCert), TypeError, 'issuer cert for another key')
  t.exception.all(() => issuerCountersign({ ...signed, association: 'd'.repeat(64) }, s.issuerKp, s.issuerCert), TypeError, 'another association')
  t.exception.all(() => issuerCountersign({ ...signed, nonce: nonce('z') }, s.issuerKp, s.issuerCert), TypeError, 'owner signature does not verify')
  t.exception.all(() => issuerCountersign({ type: 'page-accept' }, s.issuerKp, s.issuerCert), TypeError)
  const done = issuerCountersign(signed, s.issuerKp, s.issuerCert)
  t.alike(Object.keys(done), ['type', 'page', 'gen', 'owner', 'admins', 'prev', 'at', 'nonce', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature', 'countersignature'])
  t.is(done.issuer, s.issuerCert.issuer)
  t.is(done.issuerSignature, s.issuerCert.signature)
})

test('page: pageState bounded mode', (t) => {
  const s = setup()
  const [o, a] = s.people
  const g1 = roster(s, o.kp)
  const g2 = roster(s, o.kp, { gen: 2, prev: 2, admins: [a.hex], n: 's' })
  const st = pageState([at(2, g2), at(5, g1)], s.P, s.assoc)
  t.is(st.page, true)
  t.is(st.gen, 2, 'highest gen, not highest seq')
  t.is(st.seq, 2)
  t.is(st.owner, o.hex)
  t.alike(st.admins, [a.hex])
  t.is(pageState([at(2, g1), at(9, g1)], s.P, s.assoc).seq, 9, 'ties: highest seq')

  t.is(pageState([at(2, g1)], 'd'.repeat(64), s.assoc).page, false, 'a roster copied from another page')
  t.is(pageState([at(2, { ...g1, countersignature: g1.signature })], s.P, s.assoc).page, false, 'a roster not countersigned')
  const bad = { ...g2, countersignature: g2.signature }
  t.is(pageState([at(2, g1), at(3, bad)], s.P, s.assoc).gen, 1, 'an unverified higher gen is skipped')
  const none = pageState([at(2, g1)], s.P, s.assoc, { revokedIssuers: new Set([s.issuerCert.issuer]) })
  t.is(none.page, false, 'revoked issuer nulls the page')
  t.is(none.owner, null)
  t.alike(none.admins, [])

  // Bounded mode trusts a countersigned genesis with admins.
  t.is(pageState([at(2, roster(s, o.kp, { admins: [a.hex] }))], s.P, s.assoc).page, true)
})

test('page: pageState follows', (t) => {
  const s = setup()
  const [o] = s.people
  const k1 = 'c'.repeat(64)
  const k2 = 'd'.repeat(64)
  const st = pageState([
    at(2, roster(s, o.kp)),
    at(3, { type: 'follow', key: k1, on: true, at: AT }),
    at(4, { type: 'follow', key: k2, on: true, at: AT }),
    at(5, { type: 'follow', key: k1, on: false, at: AT }),
    at(6, { type: 'follow', key: s.P, on: true, at: AT })
  ], s.P, s.assoc)
  t.alike(st.follows, [k2])
  t.alike(pageState([at(3, { type: 'follow', key: k1, on: true, at: AT })], s.P, s.assoc).follows, [k1], 'follows without a roster')
  t.alike(pageState([at(6, { type: 'follow', key: s.P, on: true, at: AT })], s.P.toUpperCase(), s.assoc).follows, [], 'an uppercase page key never follows itself')
})

test('page: pageState full mode, removal and add', (t) => {
  const s = setup()
  const [o, a, b] = s.people
  const g1 = roster(s, o.kp, { admins: [] })
  const g2 = roster(s, o.kp, { gen: 2, prev: 2, admins: [a.hex], n: 's' })
  const acc = accept(s, a.kp, g2)
  const full = { full: true }

  let st = pageState([at(2, g1), at(3, acc), at(4, g2)], s.P, s.assoc, full)
  t.is(st.gen, 2, 'add right after the accept')
  t.alike(st.admins, [a.hex])

  t.is(pageState([at(2, g1), at(3, acc), at(4, { type: 'post', text: 'oi', at: AT, replyTo: null }), at(5, g2)], s.P, s.assoc, full).gen, 1, 'add without the adjacent accept')
  t.is(pageState([at(2, g1), at(3, accept(s, a.kp, g2, { gen: 3 })), at(4, g2)], s.P, s.assoc, full).gen, 1, 'accept for another gen')
  t.is(pageState([at(2, g1), at(3, accept(s, a.kp, g1, { gen: 2 })), at(4, g2)], s.P, s.assoc, full).gen, 1, 'accept for another roster')
  t.is(pageState([at(2, g1), at(3, accept(s, b.kp, g2)), at(4, g2)], s.P, s.assoc, full).gen, 1, 'accept by another member')
  t.is(pageState([at(2, g1), at(3, acc), at(4, g2)], s.P, s.assoc).gen, 2, 'bounded mode agrees')

  const badPrev = roster(s, o.kp, { gen: 2, prev: 1, admins: [a.hex], n: 's' })
  t.is(pageState([at(2, g1), at(3, accept(s, a.kp, badPrev)), at(4, badPrev)], s.P, s.assoc, full).gen, 1, 'bad prev')
  const skip = roster(s, o.kp, { gen: 3, prev: 2, admins: [], n: 't' })
  t.is(pageState([at(2, g1), at(4, skip)], s.P, s.assoc, full).gen, 1, 'gen must be previous + 1')
  t.is(pageState([at(2, g1), at(4, skip)], s.P, s.assoc).gen, 3, 'bounded mode does not walk')

  // Removal: a subset by the same owner; prev may name a refresh copy.
  const g3 = roster(s, o.kp, { gen: 3, prev: 6, admins: [], n: 'u' })
  st = pageState([at(2, g1), at(3, acc), at(4, g2), at(6, g2), at(7, g3)], s.P, s.assoc, full)
  t.is(st.gen, 3, 'removal chains from the refresh copy')
  t.alike(st.admins, [])
  st = pageState([at(2, g1), at(3, acc), at(4, g2), at(6, g2)], s.P, s.assoc, full)
  t.is(st.seq, 6, 'the newest copy of the current roster')
  const twoAdded = roster(s, o.kp, { gen: 2, prev: 2, admins: [a.hex, b.hex], n: 's' })
  t.is(pageState([at(2, g1), at(3, accept(s, a.kp, twoAdded)), at(4, twoAdded)], s.P, s.assoc, full).gen, 1, 'two added at once')
  const noGenesis = roster(s, o.kp, { gen: 1, prev: 4, n: 'v' })
  t.is(pageState([at(2, noGenesis)], s.P, s.assoc, full).page, false, 'gen 1 with a prev is no genesis')
})

test('page: pageState full mode, transfer', (t) => {
  const s = setup()
  const [o, a, b] = s.people
  const full = { full: true }
  const g1 = roster(s, o.kp, { admins: [] })
  const g2 = roster(s, o.kp, { gen: 2, prev: 2, admins: [a.hex], n: 's' })
  const base = [at(2, g1), at(3, accept(s, a.kp, g2)), at(4, g2)]
  const off = offer(s, o.kp, { to: a.hex, gen: 2 })
  const t3 = roster(s, a.kp, { gen: 3, prev: 4, admins: [o.hex], n: 't' })

  const st = pageState([...base, at(5, off), at(6, t3)], s.P, s.assoc, full)
  t.is(st.gen, 3)
  t.is(st.owner, a.hex, 'the new owner')
  t.alike(st.admins, [o.hex], 'the previous owner is an admin')

  t.is(pageState([...base, at(6, t3)], s.P, s.assoc, full).owner, o.hex, 'transfer without an offer')
  t.is(pageState([...base, at(6, t3)], s.P, s.assoc).owner, a.hex, 'bounded mode trusts the countersign')
  const drop = roster(s, a.kp, { gen: 3, prev: 4, admins: [], n: 't' })
  t.is(pageState([...base, at(5, off), at(6, drop)], s.P, s.assoc, full).owner, o.hex, 'transfer that drops the previous owner')
  const cancel = offer(s, o.kp, { to: null, gen: 2 })
  t.is(pageState([...base, at(5, off), at(6, cancel), at(7, t3)], s.P, s.assoc, full).owner, o.hex, 'offer cancelled')
  t.is(pageState([...base, at(5, offer(s, o.kp, { to: b.hex, gen: 2 })), at(6, t3)], s.P, s.assoc, full).owner, o.hex, 'offer to someone else')
  t.is(pageState([...base, at(5, offer(s, o.kp, { to: a.hex, gen: 1 })), at(6, t3)], s.P, s.assoc, full).owner, o.hex, 'offer for an older gen')
  t.is(pageState([...base, at(5, offer(s, o.kp, { to: a.hex, gen: 2, exp: '2025-12-31T00:00:00.000Z' })), at(6, t3)], s.P, s.assoc, full).owner, o.hex, 'expired offer')
  t.is(pageState([...base, at(5, offer(s, a.kp, { to: a.hex, gen: 2 })), at(6, t3)], s.P, s.assoc, full).owner, o.hex, 'offer not by the owner')
  t.is(pageState([at(2, g1), at(3, offer(s, o.kp, { to: a.hex, gen: 2 })), at(4, accept(s, a.kp, g2)), at(5, g2), at(6, roster(s, a.kp, { gen: 3, prev: 5, admins: [o.hex], n: 't' }))], s.P, s.assoc, full).owner, o.hex, 'offer before prev')

  // The offer sits between the first copy of gen 2 and the refresh copy that `prev` names.
  const viaRefresh = roster(s, a.kp, { gen: 3, prev: 6, admins: [o.hex], n: 't' })
  t.is(pageState([...base, at(5, off), at(6, g2), at(7, viaRefresh)], s.P, s.assoc, full).owner, a.hex, 'offer before the refresh copy that prev names')

  t.alike(pendingOffer([...base, at(5, off)], pageState(base, s.P, s.assoc, full)), { to: a.hex, exp: LATER, gen: 2, at: AT, seq: 5 })
  const now = Date.parse(LATER)
  t.is(pendingOffer([...base, at(5, off)], pageState(base, s.P, s.assoc, full), now).seq, 5, 'not expired at exp')
  t.is(pendingOffer([...base, at(5, off)], pageState(base, s.P, s.assoc, full), now + 1), null, 'expired before now')
  t.is(pendingOffer([...base, at(5, off), at(6, cancel)], pageState(base, s.P, s.assoc, full)), null, 'cancelled')
  t.is(pendingOffer([...base, at(5, offer(s, o.kp, { to: a.hex, gen: 1 }))], pageState(base, s.P, s.assoc, full)), null, 'another gen')
  t.is(pendingOffer(base, pageState([], s.P, s.assoc)), null, 'no page')
  t.is(pendingOffer(base, null), null)
})

test('page: genesis with admins needs a page-origin at seq 3 in full mode', (t) => {
  const s = setup()
  const [o, a] = s.people
  const full = { full: true }
  const g = roster(s, o.kp, { admins: [a.hex] })
  t.is(pageState([at(2, g)], s.P, s.assoc, full).page, false, 'no origin')
  const st = pageState([at(2, g), at(3, origin(s, o.kp, { admins: [a.hex] }))], s.P, s.assoc, full)
  t.is(st.page, true, 'with the origin')
  t.alike(st.admins, [a.hex])
  t.is(pageState([at(2, g), at(4, origin(s, o.kp, { admins: [a.hex] }))], s.P, s.assoc, full).page, false, 'origin not at seq 3')
  t.is(pageState([at(2, g), at(3, origin(s, o.kp, { admins: [] }))], s.P, s.assoc, full).page, false, 'origin with other admins')
  t.is(pageState([at(2, g), at(3, origin(s, a.kp, { admins: [] }))], s.P, s.assoc, full).page, false, 'origin by another owner')
  const forged = { ...origin(s, o.kp, { admins: [a.hex] }), countersignature: 'a'.repeat(128) }
  t.is(pageState([at(2, g), at(3, forged)], s.P, s.assoc, full).page, false, 'origin not countersigned')
})

test('page: hostile input never throws', (t) => {
  const s = setup()
  const [o] = s.people
  const g1 = roster(s, o.kp)
  const throwing = { seq: 2 }
  Object.defineProperty(throwing, 'record', { enumerable: true, get () { throw new Error('boom') } })
  const hostileRecord = { ...g1 }
  Object.defineProperty(hostileRecord, 'admins', { enumerable: true, get () { throw new Error('boom') } })
  const cyclic = { ...g1 }
  cyclic.self = cyclic
  const arrayTrap = new Proxy([at(2, g1)], { get () { throw new Error('boom') } })
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const hostileSet = { has () { throw new Error('boom') } }

  const inputs = [null, undefined, 5, 'x', {}, [null, 1, 'x', {}], [throwing], [at(2, hostileRecord)], [at(2, cyclic)], arrayTrap, [at(2, revoked.proxy)], [at(-1, g1), at(1.5, g1)]]
  for (const entries of inputs) {
    for (const full of [false, true]) {
      const st = pageState(entries, s.P, s.assoc, { full })
      t.is(st.page, false)
    }
  }
  t.is(pageState([throwing, at(2, g1)], s.P, s.assoc).page, true, 'a throwing entry is skipped')
  t.is(pageState([at(2, g1)], s.P, s.assoc, { revokedIssuers: hostileSet }).page, false, 'a throwing revoked set')
  t.is(pageState([at(2, g1)], null, s.assoc).page, false)
  t.is(pageState([at(2, g1)], s.P, null).page, false)
  t.is(pageState([at(2, g1)], s.P).page, false)
  const throwingOptions = {}
  Object.defineProperty(throwingOptions, 'full', { enumerable: true, get () { throw new Error('boom') } })
  for (const options of [null, 5, 'x', true, throwingOptions, revoked.proxy]) {
    t.is(pageState([at(2, g1)], s.P, s.assoc, options).page, false, 'bad options')
  }
  t.is(pendingOffer(arrayTrap, { page: true, owner: o.hex, gen: 1, key: s.P }), null)

  for (const v of [null, undefined, 5, hostileRecord, cyclic, revoked.proxy, { type: 'page-roster' }]) {
    for (const fn of [verifyRoster, verifyOrigin, verifyAccept, verifyOffer, verifyCountersigned]) {
      t.is(fn(v, s.P, s.assoc).ok, false)
    }
    t.is(verifyIssuerOnly(v, s.assoc).ok, false)
  }
})
