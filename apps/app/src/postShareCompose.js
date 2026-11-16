// The composer's "Publicar também na web" box: one post.share after the post
// is written, never repeated. Pure ES module: the caller passes the rpc
// `call(method, params)`, so tests run it without a node.
import { UNCERTAIN_MESSAGE, publish } from './postShare.js'

export const WEB_SHARE_LABEL = 'Publicar também na web'
export const WEB_SHARE_SENT = 'Enviado para a web. Se o link ainda não mostrar a publicação, tente de novo em instantes.'
export const WEB_SHARE_UNKNOWN = 'A publicação saiu. Não deu para confirmar o envio para a web.'
export const WEB_SHARE_FAILED = 'A publicação saiu, mas não foi para a web.'
export const WEB_SHARE_NO_REF = 'Publicado, mas não foi para a web. Para publicar na web, abra o menu da publicação.'
export const REOPEN_FOR_LINK = 'Abra de novo para ver o link.'
export const REOPEN_TO_CHECK = 'Abra de novo para conferir.'

// postShare.js words a refusal it has no better words for this way; after
// WEB_SHARE_FAILED it would only repeat it.
const PUBLISH_FALLBACK = 'Não deu para publicar na web.'

const KEY = /^[0-9a-f]{64}$/i

// Only a plain post offers the box. rpc 5.121 lets a reply or a quote be
// shared too, but that is a product choice: the public page never shows the
// parent of a reply or a quote, and polls and events render only as text
// there, so those are shared later from the post's menu, on purpose.
export function webShareOffered ({ enabled, online, author, page, moment, reply, quote, poll, event } = {}) {
  return enabled === true &&
    online !== false &&
    typeof author === 'string' && KEY.test(author) &&
    !page && !moment && !reply && !quote && !poll && !event
}

export function webShareRef (author, seq) {
  if (typeof author !== 'string' || !KEY.test(author)) return null
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  return author.toLowerCase() + ':' + seq
}

// Never rejects and sends at most one request: a lost answer is unknown, not
// a reason to ask again.
export async function shareNew (call, author, seq) {
  const ref = webShareRef(author, seq)
  if (ref === null) return { ref: null, result: null }
  let result
  try {
    result = await publish(call, ref)
  } catch (err) {
    result = { state: 'uncertain', shareSeq: null, message: UNCERTAIN_MESSAGE }
  }
  return { ref, result }
}

export function webShareAfter (web) {
  if (web === null || typeof web !== 'object') return null
  const { ref, result } = web
  if (typeof ref !== 'string' || result === null || typeof result !== 'object') {
    return { ref: null, notice: '', toast: WEB_SHARE_NO_REF }
  }
  if (result.state === 'on') return { ref, notice: WEB_SHARE_SENT, toast: '' }
  if (result.state === 'error') {
    const reason = result.message
    const more = typeof reason === 'string' && reason !== '' && reason !== PUBLISH_FALLBACK ? ' ' + reason : ''
    return { ref, notice: WEB_SHARE_FAILED + more, toast: '' }
  }
  // 'uncertain', and any state this version does not know: "não foi" would
  // claim more than the app knows.
  return { ref, notice: WEB_SHARE_UNKNOWN, toast: '' }
}

// What the publish sheet shows after its first post.shared read, given the
// notice it was opened with (r is a readShared result). The read is what this
// device holds, so it decides the words: a live share is "sent" whatever the
// write answered (and the sent note hides the ON line, as after the sheet's
// own publish), no share is "não foi", and an unknown read never says more
// than the notice did.
export function firstReadView (notice, r) {
  const lead = typeof notice === 'string' ? notice : ''
  const read = r !== null && typeof r === 'object' ? r : { state: 'uncertain', message: UNCERTAIN_MESSAGE }
  const message = typeof read.message === 'string' ? read.message : ''
  if (read.state === 'on') {
    return { phase: 'on', note: lead === '' ? '' : WEB_SHARE_SENT, error: '' }
  }
  if (read.state === 'off') {
    let note = WEB_SHARE_FAILED
    if (lead === '' || lead === WEB_SHARE_SENT) note = ''
    else if (lead.startsWith(WEB_SHARE_FAILED)) note = lead
    return { phase: 'off', note, error: '' }
  }
  if (read.state === 'uncertain') {
    let note = WEB_SHARE_UNKNOWN + ' ' + REOPEN_TO_CHECK
    if (lead === '') note = message || UNCERTAIN_MESSAGE
    else if (lead === WEB_SHARE_SENT) note = WEB_SHARE_SENT + ' ' + REOPEN_FOR_LINK
    return { phase: 'unknown', note, error: '' }
  }
  return { phase: 'unknown', note: lead, error: message }
}
