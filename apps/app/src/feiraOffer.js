// A Feira offer inside a private conversation (docs/protocol.md section 15,
// "Ratings and consent"). Pure ES module: no React, no globals, no Node
// built-ins.
//
// An offer is the listing's public link with `#oferta=<cents>`; the listing
// author answers it by replying (replyTo = the offer's message id) with the
// same link plus `&aceite=<consent>` or `&resposta=recusada`. A personal
// account sends it as a link card and in the text; a Página sends text only,
// so every message carries the URL in its text and both are read here.
//
// Nothing about offers is stored apart from the conversation: the state,
// including the consent the proposer needs to rate, is folded from the
// thread's messages each time. Every message is untrusted peer data; an
// answer counts only when it comes from the listing author.

import rpc from '@varanda/rpc'
import { sellerTitle } from './feiraChat.js'
import { shareUrlOf, validOrigin } from './feiraLink.js'

const { MAX_CARD_URL, MAX_CARD_TITLE, MAX_CARD_DESC, MAX_TEXT, cardText, cardUrlHost, feira } = rpc

const MAX_SCAN = 4000
const TRAILING = new Set(['.', ',', ';', '!', '?', ')', ']', '"', "'"])
const SPACE = /\s/
const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const NO_TITLE = 'anúncio na Feira'

export const ACCEPTED = 'aceita'
export const DECLINED = 'recusada'
export const CONSENT_NOTE = 'Ao aceitar, você assina um consentimento que deixa esta pessoa publicar uma avaliação do seu anúncio. Você não escolhe as estrelas, e isso não é um pagamento.'

// A valid offer value: whole centavos, at least 1, at most the listing cap.
export function validCents (cents) {
  return Number.isSafeInteger(cents) && cents >= 1 && cents <= feira.MAX_PRICE_CENTS
}

// 'R$ 1.234,56' (the listing price format), or '' for an invalid value.
export function centsLabel (cents) {
  return validCents(cents) ? feira.priceLabel(cents, null, 'produto') : ''
}

function validListing (listing) {
  return !!listing && typeof listing === 'object' && typeof listing.author === 'string' &&
    HEX64.test(listing.author) && Number.isSafeInteger(listing.seq) && listing.seq >= 1
}

function offerUrl (origin, listing, cents, suffix = '') {
  if (!validCents(cents) || !validListing(listing)) return null
  const base = shareUrlOf(origin, listing.author, listing.seq)
  if (base === null) return null
  const url = base + '#oferta=' + cents + suffix
  return url.length <= MAX_CARD_URL && cardUrlHost(url) !== null ? url : null
}

function card (url, title, listing) {
  const desc = sellerTitle(listing, MAX_CARD_DESC)
  return Object.freeze({
    url,
    host: cardUrlHost(url),
    title: cardText(title, MAX_CARD_TITLE),
    desc: desc !== '' ? desc : NO_TITLE,
    image: null
  })
}

// The proposta card { url, host, title, desc, image: null }, or null.
export function offerCard ({ origin, listing, cents } = {}) {
  const url = offerUrl(origin, listing, cents)
  return url === null ? null : card(url, 'Oferta: ' + centsLabel(cents), listing)
}

// The aceite card, carrying the listing author's consent, or null (a bad
// consent, or a URL longer than a card allows).
export function acceptCard ({ origin, listing, cents, consent } = {}) {
  if (typeof consent !== 'string' || !HEX128.test(consent)) return null
  const url = offerUrl(origin, listing, cents, '&aceite=' + consent)
  return url === null ? null : card(url, 'Oferta aceita: ' + centsLabel(cents), listing)
}

export function declineCard ({ origin, listing, cents } = {}) {
  const url = offerUrl(origin, listing, cents, '&resposta=recusada')
  return url === null ? null : card(url, 'Oferta recusada: ' + centsLabel(cents), listing)
}

function withUrl (text, url) {
  if (typeof url !== 'string' || url === '') return ''
  const full = text + ': ' + url
  return Array.from(full).length <= MAX_TEXT ? full : url
}

// The message text of each step; it always ends with the URL, which is what
// a Página reads and sends (text only).
export function offerText (listing, cents, url) {
  const title = sellerTitle(listing, feira.MAX_LISTING_TITLE)
  const named = title === '' ? '' : ' "' + title + '"'
  return withUrl('Ofereço ' + centsLabel(cents) + ' pelo seu anúncio' + named + ' na Feira', url)
}

// The proposta's message text. A page sends text only, and the seller's
// node (listing.consent, the page action listing-consent) reads an offer
// only from a card URL or a text that IS the offer URL (feira.parseOfferRef),
// so a page's proposta is the bare URL; a member's carries the sentence and
// the card.
export function proposalText (listing, cents, url, { asPage = false } = {}) {
  if (asPage === true) return typeof url === 'string' && feira.parseOfferRef(url) !== null ? url : ''
  return offerText(listing, cents, url)
}

export function acceptText (cents, url) {
  return withUrl('Aceitei sua oferta de ' + centsLabel(cents) + '. Agora você pode avaliar o anúncio', url)
}

export function declineText (cents, url) {
  return withUrl('Recusei sua oferta de ' + centsLabel(cents), url)
}

function ownOffer (url, origin) {
  if (typeof url !== 'string' || !url.startsWith(origin + '/')) return null
  const ref = feira.parseOfferRef(url)
  if (ref === null) return null
  return { author: ref.author, seq: ref.seq, cents: ref.cents, aceite: ref.aceite, recusada: ref.recusada === true }
}

// The offer a card ({ url }) or a message text points to on this
// installation's origin: { author, seq, cents, aceite, recusada } or null. In
// a text the last own-origin offer link wins. Never throws.
export function parseOffer (input, origin) {
  try {
    if (!validOrigin(origin)) return null
    if (input && typeof input === 'object') return ownOffer(input.url, origin)
    if (typeof input !== 'string' || input.length > MAX_SCAN) return null
    let from = 0
    let found = null
    while (from <= input.length) {
      const at = input.indexOf(origin, from)
      if (at === -1) return found
      from = at + 1
      if (at > 0 && !SPACE.test(input[at - 1])) continue
      let end = at + origin.length
      while (end < input.length && !SPACE.test(input[end])) end++
      while (end > at && TRAILING.has(input[end - 1])) end--
      const hit = ownOffer(input.slice(at, end), origin)
      if (hit !== null) found = hit
    }
    return found
  } catch {
    return null
  }
}

// The offer of one message (its card first, then its text), or null.
export function offerOfMessage (message, origin) {
  if (!message || typeof message !== 'object' || message.deleted === true) return null
  return parseOffer(message.card, origin) || parseOffer(message.text, origin)
}

// A proposta as the seller's node reads it (listing.consent, the page
// action listing-consent): the card URL, or a text that IS the offer URL.
// An offer link inside a sentence is shown as a link but cannot be accepted,
// so it is not offered as a proposta here either.
export function proposalOfMessage (message, origin) {
  if (!message || typeof message !== 'object' || message.deleted === true || !validOrigin(origin)) return null
  const fromCard = message.card && typeof message.card === 'object' ? ownOffer(message.card.url, origin) : null
  const ref = fromCard || (typeof message.text === 'string' ? ownOffer(message.text, origin) : null)
  return ref !== null && ref.aceite === null && !ref.recusada ? ref : null
}

function timeOf (value) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(t) ? t : null
}

// The latest offer on `listing` ({ author, seq }) in a thread's messages
// ({ id, from, mine, text, card, replyTo, at }), as `me` sees it:
// { id, cents, from, at, answered: null | 'aceita' | 'recusada', consent }
// or null. An answer counts only when it replies to that offer, names the
// same listing and value, and its sender is the listing author; the first
// such answer wins. An offer from the listing author is no offer.
export function offerState (messages, me, listing, origin) {
  if (!Array.isArray(messages) || !validListing(listing) || !validOrigin(origin)) return null
  const senderOf = (m) => (m.mine === true ? me : m.from)
  const list = []
  messages.forEach((m, i) => {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !HEX32.test(m.id)) return
    const from = senderOf(m)
    if (typeof from !== 'string' || !HEX64.test(from)) return
    const ref = offerOfMessage(m, origin)
    if (ref === null || ref.author !== listing.author || ref.seq !== listing.seq) return
    list.push({ m, i, from, ref, t: timeOf(m.at) })
  })
  list.sort((a, b) => {
    if (a.t !== null && b.t !== null && a.t !== b.t) return a.t - b.t
    return a.i - b.i
  })
  let offer = null
  for (const e of list) {
    if (e.ref.aceite !== null || e.ref.recusada) continue
    if (e.from === listing.author) continue
    if (proposalOfMessage(e.m, origin) === null) continue
    offer = e
  }
  if (offer === null) return null
  let answered = null
  let consent = null
  for (const e of list) {
    if (e.from !== listing.author || e.m.replyTo !== offer.m.id || e.ref.cents !== offer.ref.cents) continue
    if (e.ref.aceite !== null) {
      answered = ACCEPTED
      consent = e.ref.aceite
    } else if (e.ref.recusada) {
      answered = DECLINED
    } else {
      continue
    }
    break
  }
  return Object.freeze({
    id: offer.m.id,
    cents: offer.ref.cents,
    from: offer.from,
    at: typeof offer.m.at === 'string' ? offer.m.at : null,
    answered,
    consent
  })
}

// Which actions an offer bubble shows to `me`: answer (Aceitar / Recusar)
// only for the listing author on an unanswered offer of someone else; rate
// (Avaliar) only for the proposer after an aceite that carries a consent.
export function buttonState (offer, me, listing) {
  const none = { answer: false, rate: false }
  if (!offer || typeof me !== 'string' || !HEX64.test(me) || !validListing(listing)) return none
  return {
    answer: me === listing.author && offer.from !== me && offer.answered === null,
    rate: offer.from === me && me !== listing.author && offer.answered === ACCEPTED &&
      typeof offer.consent === 'string' && HEX128.test(offer.consent)
  }
}

// The listing a "Fazer oferta" targets: the newest own-origin listing link
// in the thread whose author is `seller`, with the title of a card that
// points at it (no fragment), or null.
export function offerTarget (messages, seller, origin, linkOf) {
  if (!Array.isArray(messages) || typeof seller !== 'string' || !HEX64.test(seller) || typeof linkOf !== 'function') return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || typeof m !== 'object' || m.deleted === true) continue
    const link = linkOf(m)
    if (!link || link.author !== seller) continue
    let title = ''
    const url = shareUrlOf(origin, link.author, link.seq)
    for (let j = messages.length - 1; j >= 0 && title === ''; j--) {
      const c = messages[j] && messages[j].card
      if (c && typeof c === 'object' && c.url === url && typeof c.title === 'string') title = c.title
    }
    return { author: link.author, seq: link.seq, title }
  }
  return null
}

// The params of listing.consent for an offer on an own listing.
export function consentParams (listing, offer) {
  if (!validListing(listing) || !offer || typeof offer.id !== 'string' || !HEX32.test(offer.id)) return null
  if (typeof offer.from !== 'string' || !HEX64.test(offer.from)) return null
  return { to: listing.author + ':' + listing.seq, rater: offer.from, offer: offer.id }
}
