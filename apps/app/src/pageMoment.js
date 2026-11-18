// A momento published as whoever is acting, the pure part: the composer's
// gate, which uploaded item a send may carry, what a failed send does, and
// which delete a ring's item takes. No I/O here.
//
// A Page publishes its momento through the page action 'moment' (pages.js
// pagesMoment) and deletes it through 'delete'; the person keeps
// moment.create and moment.delete. The media blob is the same anonymous one
// moment.putMedia answers for both.

import { expiresIn } from './moments.js'

const HEX64 = /^[0-9a-f]{64}$/

// A faulty answer never renders more than this many rows, or a longer text.
export const PAGE_MOMENTS_MAX = 20
export const PAGE_MOMENT_TEXT_MAX = 200

export const MOMENT_PAGE_UNCERTAIN = 'Não sabemos se o momento saiu. Toque em Tentar de novo para reenviar o mesmo, ou descarte.'

// The node's refusal of a Página's upload with too few stamps (putMoment
// `ahead`): a fill started, nothing went up, and the person presses again.
export const MOMENT_PREPARING = 'envio em preparo'
export const MOMENT_PREPARING_NOTICE = 'Preparando o envio. Tente de novo em instantes.'

// The putMoment arguments for `file` (a video when `clip`). A Página's upload
// never buys stamps right before it (`ahead`): the purchase time would point
// at the blob the Página's record names.
export function momentPutArgs (file, { clip = false, publisher = null } = {}) {
  const args = clip
    ? { bytes: file.bytes.slice(), mime: file.mime, width: file.width, height: file.height, ms: file.ms, kind: 'video' }
    : { bytes: file.bytes.slice(), mime: file.mime, width: file.width, height: file.height }
  if (momentPublisher(publisher) !== null) args.ahead = true
  return args
}

export const isMomentPreparing = (err) => !!err && typeof err.message === 'string' && err.message.includes(MOMENT_PREPARING)

// A send that landed after the identity changed: the draft goes, and this
// says for whom it was published.
export const momentPublishedAs = (label) => 'Momento publicado como ' + label + '.'

// The momento composer is offered on a hosted node that can put the media,
// for a plain post (no reply or quote), as the person or as a Page.
export function momentComposerOn ({ canPublish, reply, quote }) {
  return canPublish === true && !reply && !quote
}

// Who publishes: the page key when acting as a page, else null (the person).
export function momentPublisher (asPage) {
  return typeof asPage === 'string' && HEX64.test(asPage) ? asPage : null
}

// 'person' | 'page'
export const momentRoute = (publisher) => (publisher === null ? 'person' : 'page')

const same = (a, b) => (a === null && b === null) || (typeof a === 'string' && a === b)

// The one item this composer session put (moment.putMedia), and for whom.
// A send carries only the item `take` gives back: the one the node answered
// here, for the publisher now acting. A different publisher, a clear (a
// publish, a drop of the draft) or an item nobody recorded gives null, and
// the next explicit press puts the media again.
export function createMomentItems () {
  let kept = null
  return {
    put (item, publisher) {
      kept = item !== null && typeof item === 'object' ? { item, publisher: momentPublisher(publisher) } : null
      return kept === null ? null : kept.item
    },
    take (publisher) {
      return kept !== null && same(kept.publisher, momentPublisher(publisher)) ? kept.item : null
    },
    // The identity changed: an item put for another publisher is dropped.
    follow (publisher) {
      if (kept !== null && !same(kept.publisher, momentPublisher(publisher))) kept = null
    },
    clear () { kept = null },
    get held () { return kept !== null }
  }
}

// What a failed send does. `retry` is what a page request attaches to an
// uncertain failure; a person's uncertain moment.create has none and holds
// the draft instead (never resent).
// -> 'retry' | 'hold' | null (a plain error: the draft stays free)
export function momentFailure ({ uncertain, publisher, retry, itemKept }) {
  if (uncertain !== true) return null
  if (momentPublisher(publisher) !== null && typeof retry === 'function') return 'retry'
  return itemKept === true ? 'hold' : null
}

// The page whose own momento `ref` ('author:seq') is, when acting as that
// page; null for anyone else's, or when not acting as a page.
export function momentDeleteAs (ref, actingPage) {
  const page = momentPublisher(actingPage)
  return page !== null && typeof ref === 'string' && ref.startsWith(page + ':') ? page : null
}

// The Page's own momentos from its signed 'status' answer (`moments`, newest
// first): { live, past }, live by the same 24-hour rule the rings use. An
// entry with a bad seq or `at` is dropped; text is data for the screen's
// displayText.
export function pageMomentsOf (status, pageKey, now = Date.now()) {
  const out = { live: [], past: [] }
  const page = momentPublisher(pageKey)
  const raw = status && typeof status === 'object' && !Array.isArray(status) ? status.moments : null
  if (page === null || !Array.isArray(raw)) return out
  const items = []
  for (const m of raw) {
    if (!m || typeof m !== 'object' || !Number.isSafeInteger(m.seq) || m.seq < 1) continue
    if (typeof m.at !== 'string' || Number.isNaN(new Date(m.at).getTime())) continue
    if (typeof m.text === 'string' && Array.from(m.text).length > PAGE_MOMENT_TEXT_MAX) continue
    items.push({ ref: page + ':' + m.seq, seq: m.seq, at: m.at, text: typeof m.text === 'string' ? m.text : '' })
  }
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || b.seq - a.seq)
  for (const it of items.slice(0, PAGE_MOMENTS_MAX)) (expiresIn(it.at, now) > 0 ? out.live : out.past).push(it)
  return out
}
