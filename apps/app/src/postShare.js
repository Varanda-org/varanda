// What the publish sheet shows for post.shared, post.share and post.unshare
// (docs/rpc.md 5.121 to 5.123). Pure ES module: the caller passes the rpc
// `call(method, params)`, so tests run it without a node.
//
// Every function resolves to { state, shareSeq, message } and never rejects:
// - 'on' / 'off': what this device's node answered (after a write, what it
//   wrote, not what the seeder holds; the sheet words it that way);
// - 'uncertain': the outcome is unknown (an uncertain error, a timeout, a
//   lost connection, an internal error, an answer of the wrong shape);
// - 'error': the node refused, with plain words, never the raw message.
// One call sends one request. Nothing here retries.
// post.shared also answers `cover` (5.121): true when the newest post-cover of
// a shared post is live. An older node omits it, read as false.
import { sha256 } from '@noble/hashes/sha2.js'
import { buildCover, coverSource, needsCover, validShareCover } from './media/shareCover.js'

export const UNCERTAIN_MESSAGE = 'Não deu para confirmar. Abra de novo para conferir.'

const REF = /^[0-9a-f]{64}:[1-9][0-9]*$/

// Codes the node answers before it changes anything for these methods.
const REFUSAL_CODES = new Set(['USAGE', 'NOT_FOUND', 'UNAUTHORIZED', 'LOCKED'])

const REFUSALS = Object.freeze({
  'referência inválida': 'Não encontramos esta publicação. Ela pode ter sido apagada.',
  'parâmetro inválido: to': 'Não encontramos esta publicação. Ela pode ter sido apagada.',
  'o registro não é uma publicação': 'Só uma publicação pode ir para a web.',
  'limite do diário atingido': 'Seu diário chegou ao limite de registros.',
  'limite de publicações na web atingido': 'Você chegou ao limite de publicações na web.',
  'identidade bloqueada: entre com a passkey': 'Entre com sua passkey para continuar.',
  'identidade não encontrada': 'Entre na sua conta para continuar.',
  'A página pública de uma publicação só pode ser ligada pelo app ou pelo navegador.': 'Publicar na web só funciona pelo app ou pelo navegador.',
  'método desconhecido': 'Esta versão ainda não publica na web.'
})

const OFFLINE = 'Sem conexão com o servidor agora. Tente de novo em instantes.'

const FALLBACK = Object.freeze({
  read: 'Não deu para ver se esta publicação está na web.',
  publish: 'Não deu para publicar na web.',
  unpublish: 'Não deu para tirar da web.'
})

// -> { state: 'on' | 'off' | ..., shareSeq, cover? }: `cover` only on 'on'
// and 'off', a cover of a post that is not shared counting as none.
export function readShared (call, ref) {
  return run(call, 'post.shared', ref, 'read', (r) => {
    if (hasKeys(r, ['shareSeq']) && r.shareSeq === null) return { ...result('off', null, ''), cover: false }
    if (hasKeys(r, ['shareSeq']) && isSeq(r.shareSeq)) return { ...result('on', r.shareSeq, ''), cover: r.cover === true }
    return null
  })
}

export function publish (call, ref) {
  return run(call, 'post.share', ref, 'publish', (r) => {
    if (hasKeys(r, ['shareSeq', 'created']) && isSeq(r.shareSeq) && typeof r.created === 'boolean') return result('on', r.shareSeq, '')
    return null
  })
}

export function unpublish (call, ref) {
  return run(call, 'post.unshare', ref, 'unpublish', (r) => {
    if (hasKeys(r, ['ok', 'changed']) && r.ok === true && typeof r.changed === 'boolean') return result('off', null, '')
    return null
  })
}

// The words the sheet shows after a cover attempt: quiet, never alarming.
export const COVER_DONE = 'Capa enviada para a prévia do link.'
export const COVER_NOT_BUILT = 'Não foi possível preparar a capa neste aparelho.'
export const COVER_NOT_SENT = 'Não deu para adicionar a capa agora.'
export const COVER_NOT_FETCHED = 'Não foi possível baixar a foto. Tente de novo.'

// After a cover attempt, the sheet keeps its row only when the stored still
// could not be downloaded: nothing was written, and another tap may get it.
export function coverRowStays (r) {
  return r !== null && typeof r === 'object' && r.state === 'off' && r.message === COVER_NOT_FETCHED
}

// After a publish or unpublish, the cover row goes unless the node refused
// ('error'): then the post is where it was, still on the web without a cover.
export function coverRowAfterWrite (r) {
  return r !== null && typeof r === 'object' && r.state === 'error'
}

// The posts ('<author>:<seq>', lowercase) with a cover attempt in flight on
// this device. Closing the sheet does not stop an encode, an upload or a
// post.cover already under way, so a reopened sheet must not offer the row
// (and a second upload) until that attempt settles.
const coversInFlight = new Set()

export function coverInFlight (ref) {
  return typeof ref === 'string' && coversInFlight.has(ref.toLowerCase())
}

// -> true when this caller now holds `ref`'s one attempt; release it after.
export function claimCover (ref) {
  if (typeof ref !== 'string' || coverInFlight(ref)) return false
  coversInFlight.add(ref.toLowerCase())
  return true
}

export function releaseCover (ref) {
  if (typeof ref === 'string') coversInFlight.delete(ref.toLowerCase())
}

// post.cover (5.169): one request. -> { state: 'on' | 'off' | 'uncertain',
// coverSeq, message }. Every refusal is 'off', an older node's 'método
// desconhecido' included: the page then keeps the seeder's own preview.
export async function addCover (call, ref, image) {
  if (typeof call !== 'function' || typeof ref !== 'string' || !REF.test(ref) || !validShareCover(image)) {
    return coverResult('off', null, COVER_NOT_SENT)
  }
  let answer
  try {
    answer = await call('post.cover', { to: ref, image })
  } catch (err) {
    return coverErrorState(err)
  }
  return coverAnswerState(answer)
}

// Shared with pageShare.js: the person's post.cover and the page's
// 'post-cover' answer the same { coverSeq, created }.
export function coverAnswerState (answer) {
  if (hasKeys(answer, ['coverSeq', 'created']) && isSeq(answer.coverSeq) && typeof answer.created === 'boolean') {
    return coverResult('on', answer.coverSeq, COVER_DONE)
  }
  return coverResult('uncertain', null, UNCERTAIN_MESSAGE)
}

export function coverErrorState (err) {
  if (err === null || typeof err !== 'object' || err.uncertain === true) return coverResult('uncertain', null, UNCERTAIN_MESSAGE)
  return coverResult('off', null, COVER_NOT_SENT)
}

function coverResult (state, coverSeq, message) {
  return { state, coverSeq, message }
}

// The whole cover step, for the composer and the sheet alike. `post` the
// post record (its media), `held` the bytes this device still holds of the
// post's first still ({ bytes, mime }) or null, `fetchStill(descriptor)` the
// stored bytes when nothing is held, `upload(built)` the media upload the
// post photos use (-> descriptor), `setCover(descriptor)` the one cover
// write (-> an addCover result). Never rejects; each step runs at most once.
// -> an addCover result, { state: 'off', message: COVER_NOT_FETCHED } when
// the stored still could not be read, or { state: 'skipped' } when the post
// needs none.
export async function sendCover ({ post, held = null, fetchStill = null, encodeThumbnail, upload, setCover } = {}) {
  try {
    if (!needsCover(post)) return { state: 'skipped', coverSeq: null, message: '' }
    const src = coverSource(post)
    let input = heldInput(held, src)
    if (input === null && typeof fetchStill === 'function') {
      // A failed download (network, 404, short body, the deadline) says
      // nothing about this device's encoder: its own words, and a new tap.
      let bytes = null
      try {
        bytes = await fetchStill(src)
      } catch {}
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== src.bytes) return coverResult('off', null, COVER_NOT_FETCHED)
      input = { bytes, mime: src.mime }
    }
    const built = input === null ? null : await buildCover({ encodeThumbnail, bytes: input.bytes, mime: input.mime })
    if (built === null) return coverResult('off', null, COVER_NOT_BUILT)
    const hash = Array.from(sha256(built.bytes), (b) => b.toString(16).padStart(2, '0')).join('')
    let image
    try {
      image = await upload(built)
    } catch {
      return coverResult('off', null, COVER_NOT_SENT)
    }
    // Matching dimensions alone do not identify the uploaded photo.
    if (!validShareCover(image) || image.bytes !== built.bytes.byteLength || image.width !== built.width || image.height !== built.height || image.sha256 !== hash) {
      return coverResult('off', null, COVER_NOT_SENT)
    }
    const r = await setCover(image)
    return r !== null && typeof r === 'object' && typeof r.state === 'string' ? r : coverResult('uncertain', null, UNCERTAIN_MESSAGE)
  } catch {
    return coverResult('off', null, COVER_NOT_SENT)
  }
}

// The held bytes of the cover's source still. A held AVIF is the stored
// still byte for byte (the composer uploads what it encoded), so it is used
// as such: fetching it again would decode the same bytes.
function heldInput (held, src) {
  if (held === null || typeof held !== 'object' || !(held.bytes instanceof Uint8Array) || held.bytes.byteLength < 1) return null
  if (typeof held.mime !== 'string' || held.mime !== src.mime) return null
  return { bytes: held.bytes, mime: held.mime }
}

// The words for a failed call: exported for the tests.
export function errorState (err, action) {
  if (err === null || typeof err !== 'object' || err.uncertain === true || !REFUSAL_CODES.has(err.code)) {
    return result('uncertain', null, UNCERTAIN_MESSAGE)
  }
  const message = typeof err.message === 'string' ? err.message : ''
  if (Object.hasOwn(REFUSALS, message)) return result('error', null, REFUSALS[message])
  if (/semeador|conexão/.test(message)) return result('error', null, OFFLINE)
  return result('error', null, Object.hasOwn(FALLBACK, action) ? FALLBACK[action] : FALLBACK.read)
}

async function run (call, method, ref, action, read) {
  if (typeof call !== 'function' || typeof ref !== 'string' || !REF.test(ref)) {
    return result('error', null, REFUSALS['referência inválida'])
  }
  let answer
  try {
    answer = await call(method, { to: ref })
  } catch (err) {
    return errorState(err, action)
  }
  return read(answer) || result('uncertain', null, UNCERTAIN_MESSAGE)
}

function result (state, shareSeq, message) {
  return { state, shareSeq, message }
}

function isSeq (value) {
  return Number.isSafeInteger(value) && value >= 1
}

// Presence only: a key a later node adds does not make the answer unknown.
function hasKeys (value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return keys.every((k) => Object.hasOwn(value, k))
}
