'use strict'

// Feira ratings (src/feiraReview.js). ES module through import().
const test = require('brittle')
const { validateParams } = require('@varanda/rpc')

const load = () => import('../src/feiraReview.js')
const loadOffer = () => import('../src/feiraOffer.js')
const SELLER = 'ab'.repeat(32)
const BUYER = 'cd'.repeat(32)
const OTHER = 'ef'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const LISTING = { author: SELLER, seq: 7 }
const URL7 = ORIGIN + '/f/' + SELLER + '/7'
const CONSENT = '9'.repeat(128)
const id = (n) => String(n).padStart(32, '0')

async function accepted () {
  const o = await loadOffer()
  return o.offerState([
    { id: id(1), from: BUYER, text: URL7 + '#oferta=100', at: '2026-11-01T12:00:01.000Z' },
    { id: id(2), from: SELLER, replyTo: id(1), text: URL7 + '#oferta=100&aceite=' + CONSENT, at: '2026-11-01T12:00:02.000Z' }
  ], BUYER, LISTING, ORIGIN)
}

test('canRate requires the consent folded from the thread', async (t) => {
  const r = await load()
  const o = await loadOffer()
  const offer = await accepted()
  t.ok(r.canRate({ offer, listing: LISTING, me: BUYER }))
  t.absent(r.canRate({ offer, listing: LISTING, me: SELLER }), 'the author never rates')
  t.absent(r.canRate({ offer, listing: LISTING, me: OTHER }), 'only the proposer')
  t.absent(r.canRate({ offer: { ...offer, consent: null }, listing: LISTING, me: BUYER }), 'no consent, no rating')
  t.absent(r.canRate({ offer: { ...offer, answered: 'recusada' }, listing: LISTING, me: BUYER }))
  t.absent(r.canRate({ offer: null, listing: LISTING, me: BUYER }))
  const open = o.offerState([{ id: id(1), from: BUYER, text: URL7 + '#oferta=100' }], BUYER, LISTING, ORIGIN)
  t.absent(r.canRate({ offer: open, listing: LISTING, me: BUYER }), 'an unanswered offer')
  t.absent(r.canRate({}))
})

test('rateParams passes the listing.rate validator', async (t) => {
  const r = await load()
  const offer = await accepted()
  const params = r.rateParams({ offer, listing: LISTING, me: BUYER, stars: 5, text: '  Tudo certo  ' })
  t.alike(params, { to: SELLER + ':7', offer: id(1), consent: CONSENT, stars: 5, text: 'Tudo certo' })
  t.ok(validateParams('listing.rate', params).ok)
  t.is(r.rateParams({ offer, listing: LISTING, me: BUYER, stars: 6 }), null)
  t.is(r.rateParams({ offer, listing: LISTING, me: BUYER, stars: 4, text: 'x'.repeat(281) }), null)
  t.is(r.rateParams({ offer, listing: LISTING, me: SELLER, stars: 4 }), null)
})

test('summarize: dedupe by rater and listing, newest wins', async (t) => {
  const r = await load()
  t.alike(r.summarize([]), { count: 0, average: null })
  t.alike(r.summarize(null), { count: 0, average: null })
  const rows = [
    { rater: BUYER, seq: 3, listingSeq: 7, stars: 2, text: '', at: '2026-11-01T00:00:00.000Z' },
    { rater: BUYER, seq: 9, listingSeq: 7, stars: 5, text: '', at: '2026-11-02T00:00:00.000Z' },
    { rater: OTHER, seq: 4, listingSeq: 7, stars: 4, text: '', at: '2026-11-01T00:00:00.000Z' },
    { rater: OTHER, seq: 5, listingSeq: 8, stars: 3, text: '', at: '2026-11-01T00:00:00.000Z' },
    { rater: 'bad', seq: 1, listingSeq: 7, stars: 5 },
    { rater: OTHER, seq: 6, listingSeq: 7, stars: 0 }
  ]
  t.alike(r.summarize(rows, SELLER), { count: 3, average: 4 })
  t.is(r.dedupe(rows, SELLER)[0].stars, 5, 'newest first, the newer block of a rater wins')
  // Across pages of two authors the same rater counts once per listing.
  const two = [{ ...rows[0], listingAuthor: SELLER }, { ...rows[0], listingAuthor: OTHER }]
  t.is(r.summarize(two).count, 2)
  t.alike(r.summarize([rows[0], rows[2], { ...rows[3], listingSeq: 9 }]), { count: 3, average: 3 })
  // A clock that went back: the higher diary block wins, not the later date.
  const rollback = [
    { rater: BUYER, seq: 12, listingSeq: 7, stars: 1, text: '', at: '2026-10-01T00:00:00.000Z' },
    { rater: BUYER, seq: 9, listingSeq: 7, stars: 5, text: '', at: '2026-11-02T00:00:00.000Z' }
  ]
  t.is(r.dedupe(rollback, SELLER).length, 1)
  t.is(r.dedupe(rollback, SELLER)[0].stars, 1, 'seq 12 replaces seq 9 whatever the dates say')
})

test('reviewModel: hostile text through displayText, malformed rows dropped', async (t) => {
  const r = await load()
  const m = r.reviewModel({ rater: BUYER, seq: 3, listingSeq: 7, stars: 4, text: '\u202eoi\u0000\u001b[2J', at: '2026-11-01T00:00:00.000Z' })
  t.is(m.stars, 4)
  t.absent(Array.from(m.text).some((ch) => (ch.codePointAt(0) < 0x20 && ch !== '\n') || ch === '\u202e'))
  t.is(r.reviewModel({ rater: BUYER, stars: 9 }), null)
  t.is(r.reviewModel(null), null)
  t.is(r.RATINGS_NOTE, 'avaliações confirmadas pelo anunciante')
  t.is(r.NOT_PAYMENT, 'não é prova de pagamento')
})

test('collectRatings: pages hints, verifies per listing, dedupes across pages', async (t) => {
  const r = await load()
  const row = (rater, seq, listingSeq, stars, at) => ({ rater, seq, listingSeq, stars, text: 'ok', at })
  const pages = [
    { ok: true, refs: [{ rater: BUYER, seq: 3 }, { rater: SELLER, seq: 9 }], next: 'c1' },
    { ok: true, refs: [{ rater: BUYER, seq: 5 }, { rater: OTHER, seq: 2 }, { rater: BUYER, seq: 3 }], next: null }
  ]
  const asked = []
  const cursors = []
  const out = await r.collectRatings({ author: SELLER, seqs: [7, 7, 8] }, {
    refsPage: async (cursor) => { cursors.push(cursor); return pages[cursors.length - 1] },
    verify: async (q) => {
      asked.push(q)
      if (q.seq === 7) return { items: [row(BUYER, 3, 7, 2, '2026-11-01T00:00:00.000Z'), row(OTHER, 2, 7, 5, '2026-11-02T00:00:00.000Z')], dropped: 0, incomplete: false }
      return { items: [row(BUYER, 5, 8, 4, '2026-11-03T00:00:00.000Z')], dropped: 0, incomplete: false }
    }
  })
  t.alike(cursors, [null, 'c1'])
  t.is(asked.length, 2, 'one call per listing, duplicate seqs once')
  t.alike(asked[0].refs, [{ rater: BUYER, seq: 3 }, { rater: BUYER, seq: 5 }, { rater: OTHER, seq: 2 }], 'self and repeated hints left out')
  t.is(out.rows.length, 3)
  t.alike(out.summary, { count: 3, average: 3.7 })
  t.is(r.summaryLabel(out.summary), '3 avaliações, média 3,7')
  t.absent(out.incomplete)

  const dup = await r.collectRatings({ author: SELLER, seqs: [7] }, {
    refsPage: async () => ({ ok: true, refs: [{ rater: BUYER, seq: 3 }, { rater: BUYER, seq: 6 }], next: null }),
    verify: async () => ({ items: [row(BUYER, 3, 7, 1, '2026-11-01T00:00:00.000Z'), row(BUYER, 6, 7, 5, '2026-10-01T00:00:00.000Z')] })
  })
  t.is(dup.summary.count, 1, 'one per rater and listing')
  t.is(dup.rows[0].stars, 5, 'the newer block wins even with an older clock')

  t.is(await r.collectRatings({ author: SELLER, seqs: [7] }, { refsPage: async () => ({ off: true }), verify: async () => ({}) }), null)
  const failed = await r.collectRatings({ author: SELLER, seqs: [7, 8] }, {
    refsPage: async () => ({ ok: true, refs: [{ rater: BUYER, seq: 3 }], next: null }),
    verify: async (q) => { if (q.seq === 8) throw new Error('x'); return { items: [row(BUYER, 3, 7, 4, '2026-11-01T00:00:00.000Z')] } }
  })
  t.ok(failed.incomplete)
  t.is(failed.summary.count, 1, 'verified rows before the failure stay')
  t.is(r.summaryLabel({ count: 0, average: null }), '')
  t.is(r.summaryLabel({ count: 1, average: 5 }), '1 avaliação, média 5,0')
  t.is(r.starsLabel(3), '★★★☆☆')
  t.is(r.starsLabel(9), '')
})
