'use strict'

// Offers in a private conversation (src/feiraOffer.js): cards, texts,
// parsing and the state folded from the thread. ES module through import().
const test = require('brittle')
const { validateParams, MAX_CARD_URL, MAX_CARD_TITLE, MAX_CARD_DESC, cardTextLength, displayText, feira } = require('@varanda/rpc')

const load = () => import('../src/feiraOffer.js')
const SELLER = 'ab'.repeat(32)
const BUYER = 'cd'.repeat(32)
const STRANGER = 'ef'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const LISTING = { author: SELLER, seq: 7, title: 'Bicicleta aro 26' }
const URL7 = ORIGIN + '/f/' + SELLER + '/7'
const CONSENT = '9'.repeat(128)
const id = (n) => String(n).padStart(32, '0')

const sendOk = (card, text = card.url) => validateParams('dm.send', { to: BUYER, text, card }).ok

test('offerCard: exact card shape within the caps, valid for dm.send', async (t) => {
  const o = await load()
  const card = o.offerCard({ origin: ORIGIN, listing: LISTING, cents: 1250 })
  t.alike(Object.keys(card).sort(), ['desc', 'host', 'image', 'title', 'url'])
  t.is(card.url, URL7 + '#oferta=1250')
  t.is(card.host, 'bora.varanda.app')
  t.is(card.title, 'Oferta: R$ 12,50')
  t.is(card.desc, 'Bicicleta aro 26')
  t.is(card.image, null)
  t.ok(sendOk(card), 'proposta passes the real dm.send validator')
  const accept = o.acceptCard({ origin: ORIGIN, listing: LISTING, cents: 1250, consent: CONSENT })
  t.is(accept.url, URL7 + '#oferta=1250&aceite=' + CONSENT)
  t.is(accept.image, null)
  t.ok(sendOk(accept, 'ok ' + accept.url, 'aceite passes dm.send'))
  const decline = o.declineCard({ origin: ORIGIN, listing: LISTING, cents: 1250 })
  t.is(decline.url, URL7 + '#oferta=1250&resposta=recusada')
  t.ok(sendOk(decline))
  const long = o.offerCard({ origin: ORIGIN, listing: { ...LISTING, title: 'x'.repeat(400) }, cents: 1 })
  t.ok(cardTextLength(long.title) <= MAX_CARD_TITLE)
  t.ok(cardTextLength(long.desc) <= MAX_CARD_DESC)
  t.ok(sendOk(long))
})

test('offer cards: an oversize url, a bad consent or bad cents are refused', async (t) => {
  const o = await load()
  const longOrigin = 'https://' + 'a'.repeat(50) + '.example.com'
  t.ok(o.offerCard({ origin: longOrigin, listing: LISTING, cents: 1 }) !== null, 'the proposta still fits')
  const big = o.acceptCard({ origin: longOrigin, listing: { ...LISTING, seq: 1234567890123456 }, cents: feira.MAX_PRICE_CENTS, consent: CONSENT })
  t.is(big, null, 'an aceite url past MAX_CARD_URL is refused')
  t.ok(longOrigin.length + 300 > MAX_CARD_URL)
  t.is(o.acceptCard({ origin: ORIGIN, listing: LISTING, cents: 100, consent: 'zz' }), null)
  t.is(o.acceptCard({ origin: ORIGIN, listing: LISTING, cents: 100, consent: 'A'.repeat(128) }), null)
  for (const cents of [0, -1, 1.5, '100', NaN, feira.MAX_PRICE_CENTS + 1, null]) {
    t.is(o.offerCard({ origin: ORIGIN, listing: LISTING, cents }), null, 'cents ' + String(cents))
  }
  t.ok(o.offerCard({ origin: ORIGIN, listing: LISTING, cents: feira.MAX_PRICE_CENTS }) !== null)
  t.is(o.offerCard({ origin: 'http://bora.varanda.app', listing: LISTING, cents: 1 }), null)
  t.is(o.offerCard({ origin: ORIGIN, listing: { author: 'AB'.repeat(32), seq: 7 }, cents: 1 }), null)
  t.is(o.offerCard({ origin: ORIGIN, listing: { author: SELLER, seq: 0 }, cents: 1 }), null)
})

test('offer texts: the url last, a seller title holding a link left out', async (t) => {
  const o = await load()
  const url = URL7 + '#oferta=8000'
  t.is(o.offerText(LISTING, 8000, url), 'Ofereço R$ 80,00 pelo seu anúncio "Bicicleta aro 26" na Feira: ' + url)
  const evil = { ...LISTING, title: 'Veja https://evil.example/x agora' }
  const text = o.offerText(evil, 8000, url)
  t.absent(text.includes('evil'), 'no seller-chosen link in the text')
  const card = o.offerCard({ origin: ORIGIN, listing: evil, cents: 8000 })
  t.absent(card.desc.includes('evil'), 'nor in the card')
  t.is(o.acceptText(8000, url), 'Aceitei sua oferta de R$ 80,00. Agora você pode avaliar o anúncio: ' + url)
  t.is(o.declineText(8000, url), 'Recusei sua oferta de R$ 80,00: ' + url)
  t.is(o.offerText(LISTING, 8000), '')
  t.absent(text.includes('\u2014'))
})

test('parseOffer: own origin only, from a card or the text', async (t) => {
  const o = await load()
  t.alike(o.parseOffer({ url: URL7 + '#oferta=5' }, ORIGIN), { author: SELLER, seq: 7, cents: 5, aceite: null, recusada: false })
  t.alike(o.parseOffer('Aceito: ' + URL7 + '#oferta=5&aceite=' + CONSENT + '.', ORIGIN), { author: SELLER, seq: 7, cents: 5, aceite: CONSENT, recusada: false })
  t.is(o.parseOffer('x ' + URL7 + '#oferta=5&resposta=recusada', ORIGIN).recusada, true)
  t.is(o.parseOffer({ url: 'https://evil.example/f/' + SELLER + '/7#oferta=5' }, ORIGIN), null, 'foreign origin ignored')
  t.is(o.parseOffer('https://evil.example/f/' + SELLER + '/7#oferta=5', ORIGIN), null)
  t.is(o.parseOffer(ORIGIN + '.evil/f/' + SELLER + '/7#oferta=5', ORIGIN), null, 'longer host ignored')
  t.is(o.parseOffer('a:' + URL7 + '#oferta=5', ORIGIN), null, 'glued link ignored')
  t.is(o.parseOffer(URL7, ORIGIN), null, 'no fragment, no offer')
  t.is(o.parseOffer(URL7 + '#oferta=1.5', ORIGIN), null)
  t.is(o.parseOffer(URL7 + '#oferta=' + (feira.MAX_PRICE_CENTS + 1), ORIGIN), null)
  t.is(o.parseOffer({ url: URL7 + '#oferta=5' }, 'nope'), null)
  t.is(o.parseOffer(null, ORIGIN), null)
  t.is(o.parseOffer('x'.repeat(5000) + ' ' + URL7 + '#oferta=5', ORIGIN), null)
})

// A proposta without a card is the bare offer link (as a page sends it).
const offerMsg = (n, from, cents, extra = {}) => ({ id: id(n), from, text: URL7 + '#oferta=' + cents, at: '2026-11-01T12:00:0' + n + '.000Z', ...extra })
const replyMsg = (n, from, to, cents, suffix, extra = {}) => ({ id: id(n), from, replyTo: id(to), text: 'resp ' + URL7 + '#oferta=' + cents + suffix, at: '2026-11-01T12:00:0' + n + '.000Z', ...extra })

test('offerState: pairing by replyTo, latest offer wins', async (t) => {
  const o = await load()
  const msgs = [offerMsg(1, BUYER, 100), replyMsg(2, SELLER, 1, 100, '&resposta=recusada'), offerMsg(3, BUYER, 200)]
  let s = o.offerState(msgs, SELLER, LISTING, ORIGIN)
  t.is(s.id, id(3))
  t.is(s.cents, 200)
  t.is(s.from, BUYER)
  t.is(s.answered, null)
  msgs.push(replyMsg(4, SELLER, 3, 200, '&aceite=' + CONSENT))
  s = o.offerState(msgs, BUYER, LISTING, ORIGIN)
  t.is(s.answered, 'aceita')
  t.is(s.consent, CONSENT)
  const first = o.offerState(msgs.slice(0, 2), SELLER, LISTING, ORIGIN)
  t.is(first.answered, 'recusada')
  t.is(first.consent, null)
  // Out-of-order input is ordered by time.
  t.is(o.offerState(msgs.slice().reverse(), BUYER, LISTING, ORIGIN).id, id(3))
  // An own message has no from: `me` is its sender.
  const mine = o.offerState([{ ...offerMsg(1, undefined, 100), mine: true }], BUYER, LISTING, ORIGIN)
  t.is(mine.from, BUYER)
})

test('offerState: a stranger or the proposer cannot answer, a wrong reply is ignored', async (t) => {
  const o = await load()
  const base = [offerMsg(1, BUYER, 100)]
  t.is(o.offerState([...base, replyMsg(2, STRANGER, 1, 100, '&aceite=' + CONSENT)], BUYER, LISTING, ORIGIN).answered, null, 'stranger aceite ignored')
  t.is(o.offerState([...base, replyMsg(2, BUYER, 1, 100, '&aceite=' + CONSENT)], BUYER, LISTING, ORIGIN).answered, null, 'self aceite ignored')
  t.is(o.offerState([...base, replyMsg(2, SELLER, 9, 100, '&aceite=' + CONSENT)], BUYER, LISTING, ORIGIN).answered, null, 'reply to another id')
  t.is(o.offerState([...base, replyMsg(2, SELLER, 1, 999, '&aceite=' + CONSENT)], BUYER, LISTING, ORIGIN).answered, null, 'another value')
  t.is(o.offerState([offerMsg(1, SELLER, 100)], BUYER, LISTING, ORIGIN), null, 'the author offers nothing')
  t.is(o.offerState([offerMsg(1, BUYER, 100)], BUYER, { author: SELLER, seq: 8 }, ORIGIN), null, 'another listing')
  // The first answer of the author wins.
  const both = [...base, replyMsg(2, SELLER, 1, 100, '&resposta=recusada'), replyMsg(3, SELLER, 1, 100, '&aceite=' + CONSENT)]
  t.is(o.offerState(both, BUYER, LISTING, ORIGIN).answered, 'recusada')
  // A page answers in text with replyTo; that counts like a card.
  const page = [...base, { id: id(2), from: SELLER, replyTo: id(1), text: 'Aceito ' + URL7 + '#oferta=100&aceite=' + CONSENT, at: '2026-11-01T12:00:02.000Z' }]
  t.is(o.offerState(page, BUYER, LISTING, ORIGIN).consent, CONSENT)
  // A card offer counts too, even when the text has none.
  const card = o.offerCard({ origin: ORIGIN, listing: LISTING, cents: 300 })
  t.is(o.offerState([{ id: id(5), from: BUYER, text: 'oi', card, at: '2026-11-01T12:00:05.000Z' }], SELLER, LISTING, ORIGIN).cents, 300)
  t.is(o.offerState('nope', BUYER, LISTING, ORIGIN), null)
  t.is(o.offerState([null, 1, { id: 'x' }], BUYER, LISTING, ORIGIN), null)
})

test('buttonState: Aceitar for the author on an open offer, Avaliar for the proposer after an aceite', async (t) => {
  const o = await load()
  const open = o.offerState([offerMsg(1, BUYER, 100)], SELLER, LISTING, ORIGIN)
  t.alike(o.buttonState(open, SELLER, LISTING), { answer: true, rate: false })
  t.alike(o.buttonState(open, BUYER, LISTING), { answer: false, rate: false })
  t.alike(o.buttonState(open, STRANGER, LISTING), { answer: false, rate: false })
  const done = o.offerState([offerMsg(1, BUYER, 100), replyMsg(2, SELLER, 1, 100, '&aceite=' + CONSENT)], BUYER, LISTING, ORIGIN)
  t.alike(o.buttonState(done, BUYER, LISTING), { answer: false, rate: true })
  t.alike(o.buttonState(done, SELLER, LISTING), { answer: false, rate: false })
  const no = o.offerState([offerMsg(1, BUYER, 100), replyMsg(2, SELLER, 1, 100, '&resposta=recusada')], BUYER, LISTING, ORIGIN)
  t.alike(o.buttonState(no, BUYER, LISTING), { answer: false, rate: false })
  t.alike(o.buttonState(null, BUYER, LISTING), { answer: false, rate: false })
})

test('offerTarget and consentParams', async (t) => {
  const o = await load()
  const { listingLinkOf } = await import('../src/feiraChat.js')
  const linkOf = (m) => listingLinkOf(m.text, ORIGIN) || listingLinkOf(m.card, ORIGIN)
  const msgs = [{ id: id(1), from: SELLER, text: 'oi', card: { url: URL7, title: 'Bike' } }, { id: id(2), from: BUYER, text: 'quero ' + URL7 }]
  t.alike(o.offerTarget(msgs, SELLER, ORIGIN, linkOf), { author: SELLER, seq: 7, title: 'Bike' })
  t.is(o.offerTarget(msgs, STRANGER, ORIGIN, linkOf), null, 'not the seller of any linked listing')
  const offer = o.offerState([offerMsg(1, BUYER, 100)], SELLER, LISTING, ORIGIN)
  const params = o.consentParams(LISTING, offer)
  t.alike(params, { to: SELLER + ':7', rater: BUYER, offer: id(1) })
  t.ok(validateParams('listing.consent', params).ok, 'passes the listing.consent validator')
  t.is(o.consentParams(LISTING, null), null)
})

test('hostile listing title stays inert through displayText', async (t) => {
  const o = await load()
  const hostile = { ...LISTING, title: '\u202eevil\u0000\u001b[31m\nnext' }
  const card = o.offerCard({ origin: ORIGIN, listing: hostile, cents: 100 })
  t.ok(sendOk(card), 'still a valid card')
  const shown = displayText(card.desc)
  t.absent(Array.from(shown).some((ch) => ch.codePointAt(0) < 0x20 || ch === '\u202e'), 'no control or bidi characters on screen')
  const text = o.offerText(hostile, 100, URL7 + '#oferta=100')
  t.absent(Array.from(text).some((ch) => ch.codePointAt(0) < 0x20), 'the draft title is one clean line')
})

test('a page proposta is the bare offer URL, which the seller node can read', async (t) => {
  const o = await load()
  const card = o.offerCard({ origin: ORIGIN, listing: LISTING, cents: 8000 })
  const asPage = o.proposalText(LISTING, 8000, card.url, { asPage: true })
  t.is(asPage, card.url)
  t.ok(feira.parseOfferRef(asPage), 'parseOfferRef accepts the whole text')
  const member = o.proposalText(LISTING, 8000, card.url)
  t.is(member, o.offerText(LISTING, 8000, card.url), 'a member keeps the sentence beside the card')
  t.is(feira.parseOfferRef(member), null, 'a sentence alone would not be readable: hence the bare URL for pages')
  t.is(o.proposalText(LISTING, 8000, URL7, { asPage: true }), '', 'a URL with no offer is never sent as one')
})

test('a proposta counts only in the shape the seller node can sign', async (t) => {
  const o = await load()
  const card = o.offerCard({ origin: ORIGIN, listing: LISTING, cents: 100 })
  const inSentence = { id: id(1), from: BUYER, mine: false, text: 'Ofereço R$ 1,00: ' + card.url, card: null, replyTo: null, at: '2026-11-07T10:00:00.000Z' }
  t.is(o.proposalOfMessage(inSentence, ORIGIN), null, 'a link inside a sentence without a card')
  t.is(o.offerState([inSentence], SELLER, LISTING, ORIGIN), null, 'so no Aceitar is offered')
  const bare = { ...inSentence, id: id(2), text: card.url }
  t.ok(o.proposalOfMessage(bare, ORIGIN), 'the bare link (a page proposta)')
  t.is(o.offerState([bare], SELLER, LISTING, ORIGIN).id, id(2))
  const carded = { ...inSentence, id: id(3), card }
  t.ok(o.proposalOfMessage(carded, ORIGIN), 'the card carries it')
  t.is(o.offerState([inSentence, carded], SELLER, LISTING, ORIGIN).id, id(3))
})
