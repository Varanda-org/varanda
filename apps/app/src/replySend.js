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
  if (actingAsPage || !nodeReady || hasLink || [...text].length > 1000) return { kind: 'expand' }
  return { kind: 'send' }
}

// A failed mutation is never repeated, even if the diary cannot be read.
// A definite gate refusal lets the caller offer Publicar's outbox path.
export async function sendTextReply ({ request, text, replyTo, lastSeq = null }) {
  const refused = refusalOf(text)
  if (refused) return { ok: false, ref: null, error: null, refused }
  let floor = Number.isSafeInteger(lastSeq) && lastSeq >= 0 ? lastSeq : null
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
        const match = sentMatcher({ text, replyTo }, { startedAt, seqFloor: floor })
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
