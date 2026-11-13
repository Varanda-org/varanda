import rpc from '@varanda/rpc'
import { MONTHS } from './format.js'
import { findLinks } from './links.js'

export const MAX_TEXT = 1000
const EXCERPT = 60

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
// A context is a post unless it says it is a moment (moments.js replyContext).
const MOMENT = 'moment'
const isMoment = (context) => isObject(context) && context.kind === MOMENT
const isKey = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

// The caller supplies context only after verifying the public post.
export function makeIntent ({ id, peer, from, context = null, offer = null } = {}) {
  return {
    id,
    peer,
    from,
    context: context === null
      ? null
      : {
          author: context.author,
          seq: context.seq,
          at: context.at,
          text: Array.from(typeof context.text === 'string' ? context.text : '').slice(0, 140).join(''),
          hasMedia: Boolean(context.hasMedia),
          ...(context.kind === MOMENT ? { kind: MOMENT } : {})
        },
    offer: isObject(offer)
      ? {
          author: offer.author,
          seq: offer.seq,
          title: Array.from(typeof offer.title === 'string' ? offer.title : '').slice(0, 140).join('')
        }
      : offer
  }
}

export function validIntent (intent, ownKey) {
  if (!isObject(intent) || !intent.id || !isKey(intent.peer) || intent.peer === ownKey) return false
  const context = intent.context
  const { offer = null } = intent
  if (offer !== null && (context !== null || !isObject(offer) || !isKey(offer.author) || offer.author !== intent.peer ||
    !Number.isSafeInteger(offer.seq) || offer.seq <= 0 || typeof offer.title !== 'string')) return false
  return context === null || (isObject(context) && isKey(context.author) && Number.isSafeInteger(context.seq) && context.seq > 0 &&
    (context.kind === undefined || context.kind === MOMENT))
}

// An absolute short date ('5 nov', '5 nov 2025'), never 'agora' or 'ontem':
// a message sent later must still name the same day.
export function contextDate (at, now = Date.now()) {
  const date = new Date(String(at))
  if (Number.isNaN(date.getTime())) return null
  const short = date.getDate() + ' ' + MONTHS[date.getMonth()]
  return date.getFullYear() === new Date(now).getFullYear() ? short : short + ' ' + date.getFullYear()
}

// The post's own words, so the author knows which post is meant: one line,
// unsafe characters replaced, cut to EXCERPT code points.
// Links are cut out of the excerpt: it only names the post, and a link there
// would be the first one of the sent text, so the preview of the link the
// person typed (linkCard freezeSnapshot) would be dropped.
const flat = (s) => s.replace(/\s+/gu, ' ').trim()

function withoutLinks (s) {
  let bare = s
  for (const link of findLinks(s).reverse()) bare = bare.slice(0, link.start) + ' ' + bare.slice(link.end)
  return flat(bare)
}

export function contextExcerpt (text) {
  if (typeof text !== 'string') return ''
  // Whitespace is normalised first (displayText would turn newlines and tabs
  // into U+FFFD), so a link that only becomes one once its whitespace is plain
  // (U+202F before 'https') is found too; displayText then makes the rest safe.
  // A removed link can leave a dangling ':' or '-' behind ('Agenda: <link>').
  const line = Array.from(flat(rpc.displayText(withoutLinks(flat(text)))).replace(/\s*[:;,\-\u2013]+$/u, ''))
  const cut = line.length > EXCERPT ? line.slice(0, EXCERPT).join('') + '…' : line.join('')
  // Fail closed: an excerpt that still holds a link names the post by date only.
  return findLinks(cut).length > 0 ? '' : cut
}

// The chip title: the same absolute date as the text sent.
export function contextLabel (context, now = Date.now()) {
  if (!isObject(context)) return ''
  const what = isMoment(context)
    ? 'Sobre o seu momento'
    : contextExcerpt(context.text) === '' && context.hasMedia ? 'Sobre a sua foto' : 'Sobre a sua publicação'
  const date = contextDate(context.at, now)
  return date === null ? what : what + ' de ' + date
}

function contextPrefix (context, now) {
  const excerpt = contextExcerpt(context.text)
  const date = contextDate(context.at, now)
  const when = date === null ? '' : ' (' + date + ')'
  if (isMoment(context)) return 'Sobre o seu momento' + (excerpt !== '' ? ' "' + excerpt + '"' : '') + when + ': '
  if (excerpt !== '') return 'Sobre a sua publicação "' + excerpt + '"' + when + ': '
  if (context.hasMedia) return 'Sobre a sua foto' + when + ': '
  return 'Sobre a sua publicação' + when + ': '
}

// A post reference is not a DM id: context becomes text, never dm.send replyTo.
export function composeText (context, typed, now = Date.now()) {
  if (typeof typed !== 'string' || typed.trim().length === 0) return ''
  const prefix = isObject(context) ? contextPrefix(context, now) : ''
  return Array.from(prefix + typed).slice(0, MAX_TEXT).join('')
}

// The text of an Enviar press while a send is held: the same typed text and
// chip are a retry of the text composed for that attempt, never recomposed.
export function sendAttempt (hold, typed, context, composed) {
  return hold && hold.typed === typed && hold.ctx === context ? hold.text : composed
}
