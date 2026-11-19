import { ATTEMPT_WINDOW_MS, GATE_MESSAGE, MATCH_SLACK_MS, isQuoteRecord, maxSeq } from './outbox.js'
import { parseRef } from './thread.js'
import { refusalOf } from './wordCheck.js'

function refOf (replyTo) {
  if (!replyTo || typeof replyTo.author !== 'string') return null
  return replyTo.author.toLowerCase() + ':' + String(replyTo.seq)
}

function sameRef (a, b) {
  if (a === null || b === null) return a === b
  return String(a).toLowerCase() === String(b).toLowerCase()
}

function sameMedia (recorded, sent) {
  const list = Array.isArray(recorded) && recorded.length > 0 ? recorded : null
  if (list === null || sent === null) return list === sent
  const id = (d) => d && d.core + ':' + d.start + ':' + d.blocks + ':' + d.sha256
  return list.length === sent.length && list.every((d, i) => id(d) === id(sent[i]))
}

// Expected references are strings, as in post.reply and post.quote params.
export function sentMatcher ({ text, replyTo = null, quote = null, media = null }, { startedAt, slackMs = MATCH_SLACK_MS, seqFloor = null }) {
  return (entry) => {
    const record = entry && entry.record
    const quoteOk = quote
      ? isQuoteRecord(record) && sameRef(refOf(record.quote), quote)
      : !isQuoteRecord(record)
    return record && record.type === 'post' && record.text === text && quoteOk &&
      sameRef(refOf(record.replyTo), replyTo) && sameMedia(record.media, media) &&
      Date.parse(record.at) >= startedAt - slackMs &&
      (seqFloor === null || (Number.isInteger(entry.seq) && entry.seq > seqFloor))
  }
}

export function quickReplyPlan ({ text, nodeReady, actingAsPage, hasLink, refusal }) {
  if (typeof text !== 'string' || text.trim() === '') return { kind: 'empty' }
  if (refusal) return { kind: 'refuse' }
  // A link card is built by Publicar, and a long text needs that editor too.
  if (hasLink || [...text].length > 1000) return { kind: 'expand' }
  // The page diary is the account service, so a quiet local node still sends.
  if (actingAsPage) return { kind: 'send-page' }
  if (!nodeReady) return { kind: 'expand' }
  return { kind: 'send' }
}

// The attempt window guards a floor below the tip, a floor above it can only keep a send uncertain, and neither causes a resend.
export function replyFloor (ownLength, confirmed = null) {
  const synced = Number.isSafeInteger(ownLength) && ownLength >= 1 ? ownLength - 1 : null
  const own = Number.isSafeInteger(confirmed) && confirmed >= 0 ? confirmed : null
  if (synced === null) return own
  return own === null ? synced : Math.max(synced, own)
}

// A failed mutation is never repeated, even if the diary cannot be read.
// A definite gate refusal lets the caller offer Publicar's outbox path.
export async function sendTextReply ({ request, text, replyTo, lastSeq = null, lastSeqStale = false }) {
  const refused = refusalOf(text)
  if (refused) return { ok: false, ref: null, error: null, refused }
  let floor = Number.isSafeInteger(lastSeq) && lastSeq >= 0 ? lastSeq : null
  // Only a floor the caller passed can lag the diary: one read here is fresh.
  const stale = lastSeqStale && floor !== null
  if (floor === null) {
    try {
      const page = await request('log.read', {})
      const tip = maxSeq(page)
      if (tip >= 0) floor = tip
      else if (page && Array.isArray(page.entries) && page.entries.length === 0 &&
        page.entriesTruncated === 0 && (page.invalid === undefined ||
          (Array.isArray(page.invalid) && page.invalid.length === 0))) floor = 0
    } catch {
      // Sending is still possible, but an unknown floor cannot prove a match.
    }
  }
  const startedAt = Date.now()
  try {
    const value = await request('post.reply', { to: replyTo, text })
    const ref = value && parseRef(value.ref)
    if (!ref || ref.seq !== value.seq) {
      throw Object.assign(new Error('resposta inesperada'), { uncertain: true })
    }
    return { ok: true, ref: value.ref, error: null }
  } catch (error) {
    if (error && error.uncertain !== true && error.message === GATE_MESSAGE) {
      return { ok: false, ref: null, error, gated: true }
    }
    if (error && error.uncertain === true && floor !== null) {
      try {
        const res = await request('log.read', {})
        const match = sentMatcher({ text, replyTo }, { startedAt, seqFloor: floor, slackMs: stale ? 0 : MATCH_SLACK_MS })
        const found = (res.entries || []).filter((entry) => match(entry) &&
          Date.parse(entry.record.at) <= startedAt + ATTEMPT_WINDOW_MS)
        const ref = found.length === 1 ? res.key + ':' + found[0].seq : null
        if (parseRef(ref)) {
          return { ok: true, ref, error: null }
        }
      } catch {
        // Keep the mutation's uncertainty when reconciliation also fails.
      }
    }
    return { ok: false, ref: null, error }
  }
}

// One signed post, never repeated here. An uncertain failure hands back its
// err.retry (the same signed bytes, same nonce: the service writes it at most
// once) so the caller can resend on the person's next tap; passing that
// `retry` sends it instead of a new signature, and its answer settles the
// same way. An answer without a seq after a retry keeps that retry.
export async function sendPageTextReply ({ act, retry = null, page, text, replyTo }) {
  const refused = refusalOf(text)
  if (refused) return { ok: false, ref: null, error: null, refused }
  const again = typeof retry === 'function' ? retry : null
  try {
    const value = again !== null ? await again() : await act({ to: replyTo, text })
    const seq = value !== null && typeof value === 'object' ? value.seq : undefined
    if (!Number.isSafeInteger(seq) || seq < 0) {
      const error = Object.assign(new Error('resposta inesperada'), { uncertain: true })
      return again !== null ? { ok: false, ref: null, error, retry: again } : { ok: false, ref: null, error }
    }
    return { ok: true, ref: page + ':' + seq, error: null }
  } catch (error) {
    if (error && error.uncertain === true && typeof error.retry === 'function') {
      return { ok: false, ref: null, error, retry: error.retry }
    }
    return { ok: false, ref: null, error }
  }
}
