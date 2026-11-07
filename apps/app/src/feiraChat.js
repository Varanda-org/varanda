// A listing in Conversas: the link card a "Mensagem" sends, the draft text
// it starts from and the strict recognition of a listing link of this
// installation in a received message (for the listing pill). Pure ES module:
// no React, no globals, no Node built-ins.
//
// The card is the composer's snapshot shape (linkCard.js), so it goes out
// through the same cardForSend upload as any link card and every DM card is
// exactly { url, host, title, desc, image }. A received message is untrusted
// peer text: recognizing a link only offers to open the listing.

import rpc from '@varanda/rpc'
import { CARD_THUMB_MAX_BYTES, CARD_THUMB_SIDE, cardFields, thumbOf } from './linkCard.js'
import { findLinks } from './links.js'
import { kindLabel } from './feira.js'
import { parseListingPath, shareUrlOf, validOrigin } from './feiraLink.js'

const { MAX_CARD_TITLE, MAX_CARD_DESC, MAX_TEXT, cardText, feira } = rpc

const MAX_SCAN = 4000
const TRAILING = new Set(['.', ',', ';', '!', '?', ')', ']', '"', "'"])
const SPACE = /\s/
const SEP = ' · '

const isBytes = (v) => v instanceof Uint8Array && v.byteLength > 0

function titleOf (listing) {
  const title = cardText(listing.title, MAX_CARD_TITLE)
  return title !== '' ? title : kindLabel(listing.kind)
}

function descOf (listing) {
  const parts = [kindLabel(listing.kind)]
  if (typeof listing.priceLabel === 'string' && listing.priceLabel !== '') parts.push(listing.priceLabel)
  const place = listing.place && typeof listing.place.label === 'string' ? listing.place.label : ''
  if (place !== '') parts.push(place)
  return cardText(parts.filter((p) => p !== '').join(SEP), MAX_CARD_DESC)
}

// The card fields of a listing view (feira.js listingView) on this
// installation's public link, or null. Synchronous: no thumbnail.
export function listingCardFields ({ origin, listing } = {}) {
  try {
    if (!listing || typeof listing !== 'object') return null
    const url = shareUrlOf(origin, listing.author, listing.seq)
    if (url === null) return null
    return cardFields({ url, host: rpc.cardUrlHost(url), title: titleOf(listing), desc: descOf(listing) })
  } catch {
    return null
  }
}

// The snapshot { url, host, title, desc, thumb } a Mensagem sends through
// linkCard.cardForSend. `photo` is the first listing photo, already read and
// verified ({ bytes, mime }); it is re-encoded by encodeThumbnail, and a
// failure drops only the thumbnail. -> a frozen snapshot or null; never
// rejects.
export async function listingCard ({ origin, listing, photo = null, encodeThumbnail } = {}) {
  const fields = listingCardFields({ origin, listing })
  if (fields === null) return null
  let thumb = null
  if (photo && isBytes(photo.bytes) && typeof encodeThumbnail === 'function') {
    try {
      thumb = thumbOf(await encodeThumbnail(photo.bytes, photo.mime, { side: CARD_THUMB_SIDE, maxBytes: CARD_THUMB_MAX_BYTES }))
    } catch {
      thumb = null
    }
  }
  return Object.freeze({ ...fields, thumb: thumb ? Object.freeze(thumb) : null })
}

// The seller's title on one line, at most `max` characters, or '' when it
// holds a link: text this app writes from listing fields (a draft, an offer)
// never carries, nor previews, an address the seller chose.
export function sellerTitle (listing, max) {
  const raw = cardText(listing && listing.title, max)
  return findLinks(raw).length > 0 ? '' : raw
}

// The message a Mensagem starts with; the person can edit it before sending.
// The URL is never cut, the title is (one line, at most MAX_LISTING_TITLE).
// The title is the seller's text: one holding a link is left out, so the
// draft's only link is the listing's and the composer never previews (and
// fetches from this device) an address the seller chose.
export function draftText (listing, url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return ''
  const kind = listing && listing.kind
  const title = sellerTitle(listing, feira.MAX_LISTING_TITLE)
  const named = title === '' ? '' : ' "' + title + '"'
  let text
  if (kind === 'procura') text = 'Olá! Vi sua procura' + (named === '' ? '' : ' por' + named) + ' na Feira e posso ajudar: ' + url
  else if (kind === 'servico') text = 'Olá! Tenho interesse no seu serviço' + named + ' na Feira: ' + url
  else text = 'Olá! Tenho interesse no seu anúncio' + named + ' na Feira: ' + url
  return Array.from(text).length <= MAX_TEXT ? text : url
}

function ownPath (url, origin) {
  if (typeof url !== 'string' || !url.startsWith(origin)) return null
  const rest = url.slice(origin.length)
  if (rest[0] !== '/') return null
  return parseListingPath(rest)
}

// The listing a received message points to on this installation's origin, or
// null. `input` is the message text (the last own-origin listing link wins,
// as in inviteMessage.js inviteLinkOf) or a card ({ url }). Any fragment,
// such as #oferta=..., is ignored. Never throws: the input comes from a peer.
export function listingLinkOf (input, origin) {
  try {
    if (!validOrigin(origin)) return null
    if (input && typeof input === 'object') return ownPath(input.url, origin)
    if (typeof input !== 'string' || input.length > MAX_SCAN) return null
    let from = 0
    let found = null
    while (from <= input.length) {
      const at = input.indexOf(origin, from)
      if (at === -1) return found
      from = at + 1
      // A link glued to another token (https://evil.example/a:https://...)
      // is part of that token.
      if (at > 0 && !SPACE.test(input[at - 1])) continue
      const start = at + origin.length
      // The next character must open the path, or the origin was only the
      // prefix of a longer host (https://bora.varanda.app.evil).
      if (input[start] !== '/') continue
      let end = start
      while (end < input.length && !SPACE.test(input[end])) end++
      while (end > start && TRAILING.has(input[end - 1])) end--
      const hit = parseListingPath(input.slice(start, end))
      if (hit !== null) found = hit
    }
    return found
  } catch {
    return null
  }
}
