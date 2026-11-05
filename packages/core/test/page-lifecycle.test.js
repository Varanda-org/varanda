'use strict'

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const certLib = require('../lib/cert')
const page = require('../lib/page')
const lc = require('../lib/page-lifecycle')
const { validateRecord, deleteRecord } = require('../lib/records')

const {
  signClose, signMoved, issuerCountersign, issuerSignLink,
  verifyClose, verifyMoved, verifyLink, pageLifecycle, cutEntries, originOf, latestDelegate
} = lc

const AT = '2026-01-01T00:00:00.000Z'
const hex = (kp) => b4a.toString(kp.publicKey, 'hex')
const nonce = (c) => c.repeat(43)
const at = (seq, record) => ({ seq, record })

function setup () {
  const assocKp = crypto.keyPair()
  const issuerKp = crypto.keyPair()
  const issuerCert = certLib.createIssuerCert({ issuer: hex(issuerKp), date: AT }, assocKp)
  const ownerKp = crypto.keyPair()
  return {
    assocKp,
    assoc: issuerCert.association,
    issuerKp,
    issuerCert,
    ownerKp,
    owner: hex(ownerKp),
    P: hex(crypto.keyPair())
  }
}

function close (s, { kp = s.ownerKp, pageKey = s.P, n = 'c', gen = 2 } = {}) {
  const fields = { type: 'page-close', page: pageKey, gen, at: AT, nonce: nonce(n), actor: hex(kp), association: s.assoc }
  return issuerCountersign({ ...fields, signature: signClose(fields, kp) }, s.issuerKp, s.issuerCert)
}

function moved (s, { to = 'd'.repeat(64), n = 'm' } = {}) {
  const fields = { type: 'page-moved', page: s.P, to, gen: 2, at: AT, nonce: nonce(n), actor: s.owner, association: s.assoc }
  return issuerCountersign({ ...fields, signature: signMoved(fields, s.ownerKp) }, s.issuerKp, s.issuerCert)
}

function link (s, { pageKey = s.P, diary = 'e'.repeat(64), actor = 'c'.repeat(64) } = {}) {
  return issuerSignLink({ page: pageKey, diary, actor, at: AT, nonce: nonce('l') }, s.issuerKp, s.issuerCert)
}

function origin (s, pageKey, { from = 'd'.repeat(64) } = {}) {
  const fields = { type: 'page-origin', page: pageKey, from, fromSeq: 9, gen: 2, owner: s.owner, admins: [], at: AT, nonce: nonce('g'), actor: s.owner, association: s.assoc }
  return issuerCountersign({ ...fields, signature: page.signOrigin(fields, s.ownerKp) }, s.issuerKp, s.issuerCert)
}

const post = (text) => ({ type: 'post', text, at: AT })

test('page-lifecycle: constants and golden payload bytes', (t) => {
  t.is(lc.CLOSE_PREFIX, 'varanda-page-close-v1')
  t.is(lc.CLOSE_ISSUER_PREFIX, 'varanda-page-close-issuer-v1')
  t.is(lc.MOVED_PREFIX, 'varanda-page-moved-v1')
  t.is(lc.MOVED_ISSUER_PREFIX, 'varanda-page-moved-issuer-v1')
  t.is(lc.LINK_PREFIX, 'varanda-page-link-v1')

  const s = setup()
  const str = (buf) => b4a.toString(buf, 'utf8')
  const c = close(s)
  t.is(str(page.ownerPayload(c)), ['varanda-page-close-v1', s.P, '2', AT, nonce('c'), s.owner, s.assoc].join('\n'))
  t.is(str(page.issuerPayload(c)), ['varanda-page-close-issuer-v1', s.P, '2', AT, nonce('c'), s.owner, s.assoc, c.signature].join('\n'))
  t.ok(crypto.verify(page.ownerPayload(c), b4a.from(c.signature, 'hex'), s.ownerKp.publicKey), 'close signed by the owner')
  t.ok(crypto.verify(page.issuerPayload(c), b4a.from(c.countersignature, 'hex'), s.issuerKp.publicKey), 'close countersigned by the issuer')

  const m = moved(s)
  const D = 'd'.repeat(64)
  t.is(str(page.ownerPayload(m)), ['varanda-page-moved-v1', s.P, D, '2', AT, nonce('m'), s.owner, s.assoc].join('\n'))
  t.is(str(page.issuerPayload(m)), ['varanda-page-moved-issuer-v1', s.P, D, '2', AT, nonce('m'), s.owner, s.assoc, m.signature].join('\n'))

  const l = link(s)
  t.is(str(page.ownerPayload(l)), ['varanda-page-link-v1', s.P, 'e'.repeat(64), 'c'.repeat(64), AT, nonce('l'), s.assoc].join('\n'))
  t.ok(crypto.verify(page.ownerPayload(l), b4a.from(l.signature, 'hex'), s.issuerKp.publicKey), 'link signed by the issuer')
  t.is(l.issuer, s.issuerCert.issuer)
  t.is(l.issuerDate, s.issuerCert.date)
  t.is(l.issuerSignature, s.issuerCert.signature)
  for (const r of [c, m, l]) t.is(validateRecord(r, 5), null, r.type + ' passes the record shape')
})

test('page-lifecycle: verify reasons', (t) => {
  const s = setup()
  const c = close(s)
  t.alike(verifyClose(c, s.P, s.assoc), { ok: true })
  t.alike(verifyClose(c, s.P, s.assoc, { owner: s.owner }), { ok: true })
  t.alike(verifyClose(c, 'a'.repeat(64), s.assoc), { ok: false, reason: 'page-mismatch' })
  t.alike(verifyClose(c, s.P, 'a'.repeat(64)), { ok: false, reason: 'untrusted-association' })
  t.alike(verifyClose(c, s.P, s.assoc, { owner: 'a'.repeat(64) }), { ok: false, reason: 'not-owner' })
  t.alike(verifyClose({ ...c, countersignature: 'a'.repeat(128) }, s.P, s.assoc), { ok: false, reason: 'bad-issuer-signature' })
  t.alike(verifyClose({ ...c, issuerSignature: 'a'.repeat(128) }, s.P, s.assoc), { ok: false, reason: 'bad-issuer-signature' })
  const noAssoc = { ...c }
  delete noAssoc.association
  t.alike(verifyClose(noAssoc, s.P, s.assoc), { ok: false, reason: 'malformed' }, 'no association')
  const noCounter = { ...c }
  delete noCounter.countersignature
  t.alike(verifyClose(noCounter, s.P, s.assoc), { ok: false, reason: 'malformed' }, 'no countersign')
  t.alike(verifyClose(moved(s), s.P, s.assoc), { ok: false, reason: 'malformed' }, 'a move is not a close')
  t.alike(verifyClose(c, s.P, s.assoc, { revokedIssuers: new Set([s.issuerCert.issuer]) }), { ok: false, reason: 'revoked-issuer' })

  // The actor is covered by both signatures: swapping it breaks the countersign first.
  const other = crypto.keyPair()
  const forged = { ...c, actor: hex(other) }
  t.alike(verifyClose(forged, s.P, s.assoc), { ok: false, reason: 'bad-issuer-signature' })

  const m = moved(s)
  t.alike(verifyMoved(m, s.P, s.assoc), { ok: true })
  t.alike(verifyMoved(m, 'a'.repeat(64), s.assoc), { ok: false, reason: 'page-mismatch' })
  t.alike(verifyMoved(c, s.P, s.assoc), { ok: false, reason: 'malformed' })

  const l = link(s)
  t.alike(verifyLink(l, s.P, s.assoc), { ok: true })
  t.alike(verifyLink(l, 'a'.repeat(64), s.assoc), { ok: false, reason: 'page-mismatch' })
  t.alike(verifyLink(l, s.P, 'a'.repeat(64)), { ok: false, reason: 'untrusted-association' })
  t.alike(verifyLink({ ...l, signature: 'a'.repeat(128) }, s.P, s.assoc), { ok: false, reason: 'bad-signature' })
  t.alike(verifyLink(l, s.P, s.assoc, { revokedIssuers: new Set([s.issuerCert.issuer]) }), { ok: false, reason: 'revoked-issuer' })
})

test('page-lifecycle: sign refuses bad input', (t) => {
  const s = setup()
  const fields = { type: 'page-close', page: s.P, gen: 1, at: AT, nonce: nonce('c'), actor: s.owner, association: s.assoc }
  t.exception.all(() => signClose(fields, s.ownerKp), TypeError, 'gen 1 close')
  t.exception.all(() => signClose({ ...fields, gen: 2 }, crypto.keyPair()), TypeError, 'not the actor')
  t.exception.all(() => signMoved({ ...fields, type: 'page-moved', to: s.P, gen: 2 }, s.ownerKp), TypeError, 'moved to itself')
  t.exception.all(() => issuerSignLink({ page: s.P, diary: s.P, actor: 'c'.repeat(64), at: AT, nonce: nonce('l') }, s.issuerKp, s.issuerCert), TypeError, 'diary is the page')
  t.exception.all(() => issuerSignLink({ page: s.P, diary: 'e'.repeat(64), actor: 'c'.repeat(64), at: AT, nonce: nonce('l') }, crypto.keyPair(), s.issuerCert), TypeError, 'another issuer key')
  t.exception.all(() => issuerSignLink({ page: s.P, diary: 'e'.repeat(64), actor: 'c'.repeat(64), at: AT, nonce: nonce('l'), association: 'a'.repeat(64) }, s.issuerKp, s.issuerCert), TypeError, 'another association')
  t.exception.all(() => issuerSignLink(null, s.issuerKp, s.issuerCert), TypeError)
})

test('page-lifecycle: the first close or move is terminal', (t) => {
  const s = setup()
  const c1 = close(s, { n: 'x' })
  const c2 = close(s, { n: 'y' })
  const m1 = moved(s, { to: 'd'.repeat(64), n: 'p' })
  const m2 = moved(s, { to: 'b'.repeat(64), n: 'q' })
  const l = link(s)
  const L = { actor: 'c'.repeat(64), diary: 'e'.repeat(64) }

  const entries = [at(1, post('a')), at(4, l), at(5, m1), at(6, c1), at(7, m2), at(8, c2), at(9, l)]
  const lf = pageLifecycle(entries, s.P, s.assoc)
  t.alike(lf, { closed: null, movedTo: { to: 'd'.repeat(64), seq: 5 }, links: [{ ...L, seq: 4 }] }, 'move then close: moved only, later link ignored')
  t.alike(pageLifecycle([...entries].reverse(), s.P, s.assoc), lf, 'whatever the entry order')
  t.alike(pageLifecycle([at(5, m1), at(7, m2)], s.P, s.assoc).movedTo, { to: 'd'.repeat(64), seq: 5 }, 'a second page-moved does not replace the first')

  const closeFirst = [at(1, post('a')), at(4, l), at(5, c1), at(6, m1), at(7, c2), at(8, l)]
  t.alike(pageLifecycle(closeFirst, s.P, s.assoc), { closed: { seq: 5, at: AT }, movedTo: null, links: [{ ...L, seq: 4 }] }, 'close then move: closed only')

  for (const e of [entries, closeFirst]) {
    t.alike(pageLifecycle(cutEntries(e, pageLifecycle(e, s.P, s.assoc)), s.P, s.assoc), pageLifecycle(e, s.P, s.assoc), 'fold agrees with the cut')
  }

  t.alike(pageLifecycle([at(3, close(s, { pageKey: 'a'.repeat(64) }))], s.P, s.assoc).closed, null, 'close for another page')
  const noCounter = { ...c1 }
  delete noCounter.countersignature
  t.alike(pageLifecycle([at(3, noCounter)], s.P, s.assoc).closed, null, 'close without countersign ignored')
  t.alike(pageLifecycle([at(3, { ...c1, countersignature: 'a'.repeat(128) }), at(4, c2)], s.P, s.assoc).closed, { seq: 4, at: AT }, 'bad countersign is not terminal')
  t.alike(pageLifecycle(entries, s.P, s.assoc, { revokedIssuers: new Set([s.issuerCert.issuer]) }), { closed: null, movedTo: null, links: [] }, 'revoked issuer: no close, no move, no link')
  t.alike(pageLifecycle(closeFirst, s.P, s.assoc, { owner: 'a'.repeat(64) }).closed, null, 'actor is not the owner')
  t.alike(pageLifecycle(closeFirst, s.P, s.assoc, { owner: s.owner }).closed, { seq: 5, at: AT })
  t.alike(pageLifecycle([at(3, c1), at(3, post('x'))], s.P, s.assoc).closed, { seq: 3, at: AT }, 'first entry wins a duplicated seq')
})

test('page-lifecycle: a delete of a close or a move has no effect', (t) => {
  const s = setup()
  const c = close(s)
  const raw = [at(1, post('a')), at(2, c), at(3, deleteRecord({ seq: 2, at: AT }))]
  t.alike(pageLifecycle(raw, s.P, s.assoc).closed, { seq: 2, at: AT }, 'still closed')
  const m = moved(s)
  const rawM = [at(1, post('a')), at(2, m), at(3, deleteRecord({ seq: 2, at: AT }))]
  t.alike(pageLifecycle(rawM, s.P, s.assoc).movedTo, { to: 'd'.repeat(64), seq: 2 }, 'still moved')
})

test('page-lifecycle: cutEntries', (t) => {
  const s = setup()
  const entries = [at(1, post('a')), at(2, post('b')), at(3, close(s)), at(4, post('c')), at(5, post('d'))]
  const lf = pageLifecycle(entries, s.P, s.assoc)
  t.alike(cutEntries(entries, lf).map((e) => e.seq), [1, 2, 3], 'blocks after the close dropped')
  t.alike(cutEntries(entries, { closed: { seq: 4 }, movedTo: { seq: 2 } }).map((e) => e.seq), [1, 2], 'the lower of the two')
  t.is(cutEntries(entries, { closed: null, movedTo: null, links: [] }), entries, 'unchanged when neither')
  t.alike(cutEntries(null, lf), [])
  t.alike(cutEntries([null, 7, at(1, post('a')), { seq: 'x' }], lf).map((e) => e.seq), [1])
})

test('page-lifecycle: originOf', (t) => {
  const s = setup()
  const K2 = hex(crypto.keyPair())
  const o = origin(s, K2)
  t.alike(originOf([at(1, post('a')), at(3, o)], K2, s.assoc), o)
  t.is(originOf([at(4, o)], K2, s.assoc), null, 'only seq 3')
  t.is(originOf([at(3, o)], s.P, s.assoc), null, 'another page')
  t.is(originOf([at(3, o)], K2, s.assoc, { revokedIssuers: new Set([s.issuerCert.issuer]) }), null, 'revoked issuer')
  t.is(originOf([at(3, { ...o, countersignature: 'a'.repeat(128) })], K2, s.assoc), null, 'bad countersign')
})

test('page-lifecycle: latestDelegate picks the newest', (t) => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const d = (actor) => ({ type: 'page-delegate', actor, at: AT })
  t.is(latestDelegate([at(2, d(A)), at(7, d(B)), at(4, d(A))]), B)
  t.is(latestDelegate([at(2, d(A)), at(9, { type: 'page-delegate', actor: B, at: AT, x: 1 })]), A, 'malformed ignored')
  t.is(latestDelegate([at(1, post('a'))]), null)
  t.is(latestDelegate(null), null)

  const del = (seq) => deleteRecord({ seq, at: AT })
  // A delete of a page-* record, page-delegate included, has no effect.
  t.is(latestDelegate([at(2, d(A)), at(7, d(B)), at(8, del(7))]), B, 'a delete of the newest delegate is ignored')
  t.is(latestDelegate([at(7, d(B)), at(8, del(7))]), B, 'a delete of the only delegate is ignored')
})

test('page-lifecycle: a negative or zero seq is never terminal', (t) => {
  const s = setup()
  const c = close(s, { n: 'x' })
  const m = moved(s, { n: 'p' })
  const entries = [at(-1, c), at(0, m), at(1, post('a')), at(5, moved(s, { to: 'b'.repeat(64), n: 'q' }))]
  const lf = pageLifecycle(entries, s.P, s.assoc)
  t.alike(lf.closed, null)
  t.alike(lf.movedTo, { to: 'b'.repeat(64), seq: 5 })
  t.is(cutEntries(entries, lf).some((e) => e.seq === 1), true, 'real blocks before the cut stay')
  t.is(latestDelegate([at(-1, { type: 'page-delegate', actor: 'c'.repeat(64), at: AT })]), null)
})

test('page-lifecycle: issuerSignLink ignores inherited fields', (t) => {
  const s = setup()
  const proto = { page: s.P, diary: 'e'.repeat(64), actor: 'c'.repeat(64), at: AT, nonce: nonce('l') }
  t.exception.all(() => issuerSignLink(Object.create(proto), s.issuerKp, s.issuerCert), /invalid page-link/)
})

test('page-lifecycle: hostile input never throws', (t) => {
  const s = setup()
  const c = close(s)
  const evil = new Proxy({}, { get () { throw new Error('boom') }, ownKeys () { throw new Error('boom') }, getPrototypeOf () { throw new Error('boom') } })
  const getter = { get seq () { throw new Error('boom') }, record: c }
  const hostileOpts = { get revokedIssuers () { throw new Error('boom') } }
  const throwingSet = { has () { throw new Error('boom') } }
  const values = [undefined, null, 0, 'x', [], {}, evil, getter, [evil, getter, null, at(1, evil)]]
  t.execution(() => {
    for (const v of values) {
      verifyClose(v, s.P, s.assoc)
      verifyClose(c, v, v, v)
      verifyMoved(v, s.P, s.assoc, v)
      verifyLink(v, s.P, s.assoc, v)
      verifyLink(link(s), v, v, v)
      pageLifecycle(v, s.P, s.assoc)
      pageLifecycle([at(2, c)], v, v, v)
      cutEntries(v, v)
      cutEntries([at(1, post('a'))], v)
      originOf(v, v, v, v)
      latestDelegate(v)
    }
    verifyClose(c, s.P, s.assoc, hostileOpts)
    pageLifecycle([at(2, c)], s.P, s.assoc, hostileOpts)
  })
  t.alike(verifyClose(c, s.P, s.assoc, { revokedIssuers: throwingSet }), { ok: false, reason: 'malformed' })
  t.alike(pageLifecycle([at(2, c)], s.P, s.assoc, hostileOpts), { closed: null, movedTo: null, links: [] })
})
