// Feira ratings (docs/protocol.md section 15): who may rate, the request a
// rating sends and how verified ratings show. Pure ES module: no React, no
// globals, no Node built-ins.
//
// The consent comes from the conversation itself (feiraOffer.js offerState
// over the thread with the seller); nothing else is stored. Only rows that
// listing.ratings verified are shown, and their text is peer text.

import rpc from '@varanda/rpc'
import { ACCEPTED } from './feiraOffer.js'

const { displayText, feira } = rpc

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

export const RATINGS_NOTE = 'avaliações confirmadas pelo anunciante'
export const NOT_PAYMENT = 'não é prova de pagamento'

const isKey = (v) => typeof v === 'string' && HEX64.test(v)

// Whether `me` may rate `listing` ({ author, seq }) with `offer` (the
// offerState of the thread with the seller): only the proposer, never the
// author, and only with an aceite that carries a consent.
export function canRate ({ offer, listing, me } = {}) {
  if (!isKey(me) || !listing || !isKey(listing.author) || listing.author === me) return false
  if (!Number.isSafeInteger(listing.seq) || listing.seq < 1) return false
  if (!offer || typeof offer.id !== 'string' || !HEX32.test(offer.id)) return false
  return offer.from === me && offer.answered === ACCEPTED && typeof offer.consent === 'string' && HEX128.test(offer.consent)
}

// The listing.rate params, or null when the rating cannot go out.
export function rateParams ({ offer, listing, me, stars, text = '' } = {}) {
  if (!canRate({ offer, listing, me }) || !feira.isStars(stars) || typeof text !== 'string') return null
  const clean = text.trim()
  if (Array.from(clean).length > feira.MAX_RATE_TEXT) return null
  return { to: listing.author + ':' + listing.seq, offer: offer.id, consent: offer.consent, stars, text: clean }
}

// One verified row ({ rater, seq, listingSeq, stars, text, at }) for the
// screen: the text through displayText, or null for a malformed row.
export function reviewModel (row) {
  if (!row || typeof row !== 'object' || !isKey(row.rater) || !feira.isStars(row.stars)) return null
  return {
    key: row.rater + ':' + row.seq,
    rater: row.rater,
    stars: row.stars,
    text: displayText(typeof row.text === 'string' ? row.text : '', { multiline: true }),
    at: typeof row.at === 'string' ? row.at : null
  }
}

function timeOf (value) {
  const t = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(t) ? t : -Infinity
}

// Verified rows of one or more pages, one per (rater, listing author,
// listing seq): the highest block of the rater's diary wins, as the node's
// reader decides (a clock can go back; a diary seq cannot).
const seqOf = (row) => (Number.isSafeInteger(row.seq) ? row.seq : -1)

export function dedupe (rows, author) {
  const best = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || !isKey(row.rater) || !feira.isStars(row.stars)) continue
    const listingAuthor = isKey(row.listingAuthor) ? row.listingAuthor : (isKey(author) ? author : '')
    const key = row.rater + ':' + listingAuthor + ':' + row.listingSeq
    const held = best.get(key)
    if (held === undefined || seqOf(row) > seqOf(held)) best.set(key, row)
  }
  return [...best.values()].sort((a, b) => timeOf(b.at) - timeOf(a.at))
}

// { count, average } of verified rows, the average with one decimal, null
// when there is none.
export function summarize (rows, author) {
  const list = dedupe(rows, author)
  if (list.length === 0) return { count: 0, average: null }
  const sum = list.reduce((s, r) => s + r.stars, 0)
  return { count: list.length, average: Math.round((sum / list.length) * 10) / 10 }
}

// Bounds of one ratings read: the seeder's hints are paged and every hint
// costs the node a diary read, so a screen reads at most this much.
export const MAX_RATING_REFS = 64
export const MAX_RATED_LISTINGS = 6
const REFS_PER_CALL = 32
const MAX_REF_PAGES = 4

// The verified ratings of `author`'s listings `seqs`, read once (no retry):
// deps.refsPage(cursor) -> feiraClient.ratingRefs, deps.verify({ author,
// seq, refs }) -> feiraClient.ratings. Rows of every page are deduped
// together (newest block wins). -> { rows, summary, incomplete } or null
// when the Feira is off or the hints cannot be read. A failed verify stops
// the read and marks it incomplete; the rows already verified stay.
export async function collectRatings ({ author, seqs }, deps) {
  if (!isKey(author) || !Array.isArray(seqs)) return null
  const want = [...new Set(seqs.filter((s) => Number.isSafeInteger(s) && s >= 1))].slice(0, MAX_RATED_LISTINGS)
  if (want.length === 0) return { rows: [], summary: { count: 0, average: null }, incomplete: false }
  const refs = []
  const seen = new Set()
  let cursor = null
  let incomplete = false
  for (let i = 0; i < MAX_REF_PAGES && refs.length < MAX_RATING_REFS; i++) {
    let res
    try {
      res = await deps.refsPage(cursor)
    } catch {
      return null
    }
    if (!res || res.ok !== true) return null
    for (const r of res.refs) {
      const k = r.rater + ':' + r.seq
      if (r.rater === author || seen.has(k) || refs.length >= MAX_RATING_REFS) continue
      seen.add(k)
      refs.push(r)
    }
    if (res.next === null || res.next === undefined) break
    cursor = res.next
    if (i === MAX_REF_PAGES - 1 || refs.length >= MAX_RATING_REFS) incomplete = true
  }
  const rows = []
  try {
    for (const seq of want) {
      for (let i = 0; i < refs.length; i += REFS_PER_CALL) {
        const res = await deps.verify({ author, seq, refs: refs.slice(i, i + REFS_PER_CALL) })
        if (res && Array.isArray(res.items)) rows.push(...res.items.map((r) => ({ ...r, listingAuthor: author })))
        if (res && res.incomplete === true) incomplete = true
      }
    }
  } catch {
    incomplete = true
  }
  return { rows: dedupe(rows, author), summary: summarize(rows, author), incomplete }
}

// "3 avaliações, média 4,7" or '' for none.
export function summaryLabel (summary) {
  if (!summary || !Number.isSafeInteger(summary.count) || summary.count < 1 || typeof summary.average !== 'number') return ''
  const avg = summary.average.toFixed(1).replace('.', ',')
  return (summary.count === 1 ? '1 avaliação' : summary.count + ' avaliações') + ', média ' + avg
}

// '★★★☆☆' for 3 stars.
export function starsLabel (stars) {
  return feira.isStars(stars) ? '★'.repeat(stars) + '☆'.repeat(5 - stars) : ''
}
