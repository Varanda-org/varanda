import rpc from '@varanda/rpc'
import { findTerm } from './wordCheck.js'

export const TOPIC_TREND_TITLE = 'Assuntos do momento'
export const TOPIC_TREND_ORDER_TEXT = 'As hashtags usadas por mais pessoas nas últimas 24 horas, em publicações públicas guardadas por este semeador. Cada pessoa conta uma vez. A mesma lista para todo mundo.'
export const TOPIC_TREND_INDEXING = 'Montando a lista…'
export const TOPIC_TREND_EMPTY = 'Nenhum assunto em alta agora'
export const TOPIC_TREND_REFRESH_MS = 60000

const TAG_RE = /^[a-z0-9]{2,32}$/

// A hashtag is one token, so a multi-word blocked term glued into one tag
// passes findTerm. Such a tag is dropped when it equals the glued term
// exactly, also without edge digits (as word-check.js reads a token); a
// longer word that merely contains it stays. The listed terms are already
// folded. Keep in step with packages/core/lib/topic-trend.js.
const EDGE_DIGITS = /^[0-9]+|[0-9]+$/g
const GLUED_TERMS = new Set(rpc.BLOCKED_TERMS.filter((term) => term.includes(' ')).map((term) => term.replace(/ /g, '')))

function gluedTerm (tag) {
  return GLUED_TERMS.has(tag) || GLUED_TERMS.has(tag.replace(EDGE_DIGITS, '') || tag)
}

export function authorsLabel (n) {
  return n === 1 ? '1 pessoa' : n + ' pessoas'
}

export function trendRows (topics) {
  if (!Array.isArray(topics)) return []

  const rows = []
  for (const topic of topics) {
    if (!topic || typeof topic !== 'object') return []
    const { tag, authors } = topic
    if (typeof tag !== 'string' || !TAG_RE.test(tag) || !Number.isSafeInteger(authors) || authors < 1) return []
    if (findTerm(tag) === null && !gluedTerm(tag)) rows.push({ tag, label: '#' + tag, meta: authorsLabel(authors) })
  }
  return rows
}
