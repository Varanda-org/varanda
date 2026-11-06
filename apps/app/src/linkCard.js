// The composer's link card (docs/protocol.md, "Link cards"): pure rules, no
// React, no platform module, no I/O of its own. The composer waits
// LINK_DRAFT_DELAY_MS after a link appears in the draft (preview.js
// previewTarget), builds the card once per distinct URL through the
// platform's buildPreview (./previewBuild), shows it as a dismissable draft,
// and at send freezes what was shown into the pending send, so an explicit
// retry reuses the same card and never builds or uploads again. A photo
// drops the card (a card goes with text only). Any failure sends plain text.

import rpc from '@varanda/rpc'
import { previewTarget } from './preview.js'

const { MAX_CARD_TITLE, MAX_CARD_DESC, MAX_CARD_IMAGE_BYTES, cardTextLength, cardUrlHost } = rpc

export const LINK_DRAFT_DELAY_MS = 600
// The thumbnail's plaintext cap: a sealed blob (a DM item, a private group
// item) adds a 16-byte MAC and every validator bounds the stored bytes by
// MAX_CARD_IMAGE_BYTES, so the plaintext keeps room for it everywhere.
export const CARD_THUMB_MAX_BYTES = MAX_CARD_IMAGE_BYTES - 16
export const CARD_THUMB_SIDE = 320
export const CARD_THUMB_MIME = 'image/jpeg'
// Built results kept per draft, so moving the caret around a link or
// editing the text next to it never builds the same URL twice.
const SEEN_MAX = 8

export const PHASES = Object.freeze(['idle', 'building', 'ready', 'dismissed', 'failed'])

export function linkDraftIdle () {
  return { phase: 'idle', url: null, data: null, dismissed: [], seen: [] }
}

function seenOf (state, url) {
  const hit = state.seen.find((e) => e.url === url)
  return hit === undefined ? undefined : hit.data
}

function remember (state, url, data) {
  const seen = state.seen.filter((e) => e.url !== url)
  seen.push({ url, data })
  return seen.length > SEEN_MAX ? seen.slice(seen.length - SEEN_MAX) : seen
}

// The draft state machine. Events:
//   { type: 'target', url } the link the draft now holds (null: none);
//   { type: 'built', url, data } / { type: 'failed', url } a build ended;
//   { type: 'dismiss' } the person removed the card;
//   { type: 'photo' } a photo was attached: the card is dropped for its URL;
//   { type: 'reset' } a sent or emptied draft, or previews turned off.
// A result for a URL that is no longer the target is kept for later but
// never shown. Never throws; an unknown event leaves the state as it was.
export function linkDraftStep (state, event) {
  const s = state && Array.isArray(state.seen) && Array.isArray(state.dismissed) ? state : linkDraftIdle()
  if (!event || typeof event !== 'object') return s
  switch (event.type) {
    case 'reset':
      return linkDraftIdle()
    case 'target': {
      const url = typeof event.url === 'string' && event.url !== '' ? event.url : null
      if (url === null) return { ...s, phase: 'idle', url: null, data: null }
      if (url === s.url && s.phase !== 'idle') return s
      if (s.dismissed.includes(url)) return { ...s, phase: 'dismissed', url, data: null }
      const seen = seenOf(s, url)
      if (seen === null) return { ...s, phase: 'failed', url, data: null }
      if (seen !== undefined) return { ...s, phase: 'ready', url, data: seen }
      return { ...s, phase: 'building', url, data: null }
    }
    case 'built':
    case 'failed': {
      if (typeof event.url !== 'string') return s
      const data = event.type === 'built' ? draftData(event.data) : null
      const next = { ...s, seen: remember(s, event.url, data) }
      if (s.url !== event.url || s.phase !== 'building') return next
      return { ...next, phase: data === null ? 'failed' : 'ready', data }
    }
    case 'dismiss':
    case 'photo': {
      if (s.url === null) return s
      const dismissed = s.dismissed.includes(s.url) ? s.dismissed : [...s.dismissed, s.url]
      return { ...s, phase: 'dismissed', data: null, dismissed }
    }
    default:
      return s
  }
}

// Whether the composer must start a build for this state (one per URL).
export function needsBuild (state) {
  return !!state && state.phase === 'building' && typeof state.url === 'string'
}

// The photo rule: a staged photo drops the card.
export function photoDropsCard (state, photos) {
  return photos ? linkDraftStep(state, { type: 'photo' }) : state
}

// What the draft card shows: { url, host, title, desc }.
export function draftView (state) {
  if (!state || state.phase !== 'ready' || !state.data) return null
  const { url, host, title, desc } = state.data
  return { url, host, title, desc }
}

// The send's snapshot: the ready card for the link the sent text still holds,
// frozen (an edit or a later build never changes a pending send), or null.
export function freezeSnapshot (state, text) {
  if (!state || state.phase !== 'ready' || !state.data) return null
  if (previewTarget(typeof text === 'string' ? text : '') !== state.url) return null
  const { url, host, title, desc, thumb } = state.data
  return Object.freeze({ url, host, title, desc, thumb: thumb ? Object.freeze({ ...thumb }) : null })
}

function validText (s, max) {
  const n = cardTextLength(s)
  return n >= 0 && n <= max
}

const isBytes = (v) => v instanceof Uint8Array && v.byteLength > 0
const inRange = (v, max) => Number.isInteger(v) && v >= 1 && v <= max

// A thumbnail the composer may upload: JPEG bytes within CARD_THUMB_MAX_BYTES
// and CARD_THUMB_SIDE, or null.
export function thumbOf (t) {
  if (!t || typeof t !== 'object' || t.mime !== CARD_THUMB_MIME || !isBytes(t.bytes)) return null
  if (t.bytes.byteLength > CARD_THUMB_MAX_BYTES || !inRange(t.width, CARD_THUMB_SIDE) || !inRange(t.height, CARD_THUMB_SIDE)) return null
  return { bytes: t.bytes, mime: t.mime, width: t.width, height: t.height }
}

// Card fields that pass the rpc rules core validates with, or null.
export function cardFields (p) {
  if (!p || typeof p !== 'object') return null
  const host = cardUrlHost(p.url)
  if (host === null || p.host !== host) return null
  if (!validText(p.title, MAX_CARD_TITLE) || !validText(p.desc, MAX_CARD_DESC)) return null
  if (p.title === '' && p.desc === '') return null
  return { url: p.url, host, title: p.title, desc: p.desc }
}

function draftData (d) {
  const fields = cardFields(d)
  if (fields === null) return null
  return { ...fields, thumb: thumbOf(d.thumb) }
}

// The whole build of one draft card: the platform's buildPreview, then the
// thumbnail re-encoded by encodeThumbnail (a failure drops only the image).
// -> { url, host, title, desc, thumb } or null; never rejects. Aborted work
// answers null.
export async function buildDraft (url, { signal, buildPreview, encodeThumbnail, ...ctx } = {}) {
  try {
    if (typeof buildPreview !== 'function' || cardUrlHost(url) === null) return null
    const p = await buildPreview(url, { signal, ...ctx })
    if (signal && signal.aborted) return null
    const fields = cardFields(p)
    if (fields === null) return null
    let thumb = null
    if (isBytes(p.imageBytes) && typeof encodeThumbnail === 'function') {
      try {
        thumb = thumbOf(await encodeThumbnail(p.imageBytes, p.imageMime, { side: CARD_THUMB_SIDE, maxBytes: CARD_THUMB_MAX_BYTES }))
      } catch {
        thumb = null
      }
    }
    if (signal && signal.aborted) return null
    return { ...fields, thumb }
  } catch {
    return null
  }
}

// The card a send carries, from a frozen snapshot: the thumbnail is uploaded
// once through the surface's channel (upload(thumb) -> its descriptor),
// and a failed or missing upload keeps the card without an image. fits(card)
// (optional) is asked first with a stand-in image, so nothing is uploaded
// for a text that cannot carry a card. -> a frozen card or null; never
// rejects.
export async function cardForSend (snapshot, { upload, fits } = {}) {
  try {
    const fields = cardFields(snapshot)
    if (fields === null) return null
    const thumb = thumbOf(snapshot.thumb)
    if (typeof fits === 'function' && !fits({ ...fields, image: thumb ? CARD_IMAGE_STANDIN : null })) {
      if (thumb === null || !fits({ ...fields, image: null })) return null
      return Object.freeze({ ...fields, image: null })
    }
    let image = null
    if (thumb !== null && typeof upload === 'function') {
      try {
        const out = await upload(thumb)
        image = out && typeof out === 'object' && !Array.isArray(out) ? { ...out } : null
      } catch {
        image = null
      }
    }
    return Object.freeze({ ...fields, image })
  } catch {
    return null
  }
}

// The widest DM media item a card's thumbnail can be (one chunk at most),
// for measuring the text budget before the upload.
export const CARD_IMAGE_STANDIN = Object.freeze({
  id: '0'.repeat(64),
  key: '0'.repeat(64),
  nonce: '0'.repeat(48),
  chunks: 1,
  bytes: MAX_CARD_IMAGE_BYTES,
  sha256: '0'.repeat(64),
  mime: CARD_THUMB_MIME,
  w: 16384,
  h: 16384,
  ms: 0
})

// Tries build(card) with the card, then without its image, then with no card
// (plain text): the first request the rpc rules accept. -> { op, card } or
// throws what the plain build threw.
export function withCardFallback (build, card) {
  if (card) {
    try { return { op: build(card), card } } catch {}
    if (card.image !== null) {
      const bare = Object.freeze({ ...card, image: null })
      try { return { op: build(bare), card: bare } } catch {}
    }
  }
  return { op: build(null), card: null }
}
