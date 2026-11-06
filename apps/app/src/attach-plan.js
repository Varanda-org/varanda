import rpc from '@varanda/rpc'
import { MAX_MEDIA_PER_POST } from './media/plan.js'

const { displayText, dmTextBudget: textBudget, dmTextBytes, validateParams, MEMBER_CERT_STANDIN } = rpc

// The widest DM media item (packages/rpc isDmMediaItem bounds), so a caption
// is measured before any upload: a photo is never put on the blob channel for
// a message that cannot carry it.
export const WIDEST_DM_ITEM = Object.freeze({
  id: '0'.repeat(64),
  key: '0'.repeat(64),
  nonce: '0'.repeat(48),
  chunks: 257,
  bytes: 257 * 32768,
  sha256: '0'.repeat(64),
  mime: 'image/jpeg',
  w: 16384,
  h: 16384,
  ms: 0
})

export const VOICE_MIME = 'audio/mp4'
export const MAX_VOICE_MS = 120000
// The plaintext cap of a voice note (packages/core records MAX_AUDIO_BYTES);
// its blob adds the 16-byte MAC.
const MAX_VOICE_BYTES = 1572864

// The widest DM voice item, measured like WIDEST_DM_ITEM.
export const WIDEST_DM_VOICE = Object.freeze({
  ...WIDEST_DM_ITEM,
  chunks: Math.ceil((MAX_VOICE_BYTES + 16) / 32768),
  bytes: MAX_VOICE_BYTES + 16,
  mime: VOICE_MIME,
  w: 0,
  h: 0,
  ms: MAX_VOICE_MS
})

export const PREVIEW_PHOTO = 'Foto'
export const PREVIEW_GIF = 'GIF'
export const PREVIEW_VOICE = 'Áudio'

function isVoice (item) {
  return !!item && typeof item === 'object' && (typeof item.plainMime === 'string' ? item.plainMime : item.mime) === VOICE_MIME
}

// The staged attachment of a recorded note ({ ms } from stopRecording):
// composePlan takes it like a photo, with no picture size.
export function stagedVoice (recording, index = 0) {
  return {
    name: index.toString(16).padStart(32, '0') + '.bin',
    mime: VOICE_MIME,
    width: 0,
    height: 0,
    ms: recording && recording.ms
  }
}

// The node refuses a recording with the message it gives a bad photo
// ('mídia inválida'); a voice note's send shows its own words instead
// (BAD_VOICE in ui PLAIN). Anything else passes through unchanged.
export const BAD_VOICE = 'áudio inválido'

export function voiceUploadError (err) {
  return err && err.message === 'mídia inválida' && err.uncertain !== true ? new TypeError(BAD_VOICE) : err
}

export function attachmentPreview (text, attachments = []) {
  if (typeof text === 'string' && text !== '') return displayText(text.replace(/\r?\n/g, ' '))
  if (attachments.length === 0) return ''
  if (attachments.some(isVoice)) return PREVIEW_VOICE
  return attachments.every(item => item && (item.plainMime || item.mime) === 'image/gif') ? PREVIEW_GIF : PREVIEW_PHOTO
}

function checked (method, params) {
  const result = validateParams(method, params)
  if (!result.ok) throw new Error(result.message)
  // validateParams fills fwd: 0 when it is absent; the request keeps the
  // caller's shape, so only a forward (fwd 1) carries the field.
  const value = { ...result.value }
  if (!Object.prototype.hasOwnProperty.call(params, 'fwd') && value.fwd === 0) delete value.fwd
  return { method, params: value }
}

// target is { kind: 'dm', to, replyTo?, cert?, fwd? } or
// { kind: 'group', group, visibility: 'public' | 'private', replyTo?, fwd? }.
// fwd: 1 marks a forwarded message (forward.js); it rides in the request and
// counts in the DM text budget.
// Attachments are staged { name, mime, width, height } files. Uploads run
// in order; send(uploadResults) builds the final request without doing I/O.
// Real upload descriptors are needed to measure the sealed DM text budget.
export function composePlan ({ text = '', attachments = [], target }) {
  if (!Array.isArray(attachments)) throw new Error('anexos inválidos')
  if (attachments.length > MAX_MEDIA_PER_POST) throw new Error('no máximo quatro imagens')
  if (!target || !['dm', 'group'].includes(target.kind)) throw new Error('destino inválido')
  const dm = target.kind === 'dm'
  if (!dm && !['public', 'private'].includes(target.visibility)) throw new Error('visibilidade inválida')
  const sealed = !dm && target.visibility === 'private'
  const method = dm ? 'dm.send' : 'group.post'
  const base = dm ? { to: target.to, text } : { group: target.group, text }
  if (target.replyTo != null) base.replyTo = dm ? target.replyTo : { ...target.replyTo }
  if (target.fwd === 1) base.fwd = 1
  // Without its own certificate the app measures with the largest one a msg
  // can carry, so the node never refuses as too long what fit here.
  const cert = target.cert == null ? MEMBER_CERT_STANDIN : JSON.parse(JSON.stringify(target.cert))
  const count = attachments.length
  // A voice note is the only item of its message, never next to photos.
  const voice = Array.from(attachments).some(isVoice)
  if (voice && count !== 1) throw new Error('áudio vai sozinho na mensagem')
  const uploads = Array.from(attachments, item => {
    if (!item || typeof item !== 'object') throw new Error('anexo inválido')
    if (voice) return voiceUpload(item, dm, sealed, target.to)
    const { name, mime, width, height } = item
    // A DM blob is sealed for one destination (docs/rpc.md 5.95).
    const params = dm ? { name, to: target.to, mime, width, height } : { name, mime, width, height }
    if (sealed) params.sealed = true
    return checked(dm ? 'dm.putMedia' : 'media.uploadFile', params)
  })
  if (dm && count > 0 && dmTextBytes(text) > textBudget({ ...base, media: Array(count).fill(voice ? WIDEST_DM_VOICE : WIDEST_DM_ITEM), cert })) {
    throw new Error('texto longo demais com anexo')
  }

  function send (media = []) {
    if (!Array.isArray(media) || media.length !== count) throw new Error('anexos pendentes')
    const params = { ...base }
    if (base.replyTo && !dm) params.replyTo = { ...base.replyTo }
    if (count > 0) {
      params.media = media.map(item => ({ ...item }))
      if (sealed) params.sealed = true
    }
    if (dm && dmTextBytes(text) > textBudget({ ...params, cert })) {
      throw new Error(count > 0 ? 'texto longo demais com anexo' : 'mensagem longa demais')
    }
    return checked(method, params)
  }

  // A text-only request can be checked immediately. Media requests are
  // checked once their uploads supply the actual descriptors.
  if (count === 0) send()
  return { uploads, send, preview: attachmentPreview(text, attachments) }
}

// The node checks the recorded bytes (audioBounds) when it uploads them; here
// only the shape the upload call takes: { name, mime, width: 0, height: 0,
// ms }, sealed for a private group.
function voiceUpload (item, dm, sealed, to) {
  const { name, mime, width, height, ms } = item
  if (typeof name !== 'string' || name === '' || mime !== VOICE_MIME || width !== 0 || height !== 0) throw new Error('áudio inválido')
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_VOICE_MS) throw new Error('áudio inválido')
  const params = dm ? { name, to, mime, width, height, ms } : { name, mime, width, height, ms }
  if (sealed) params.sealed = true
  return { method: dm ? 'dm.putMedia' : 'media.uploadFile', params }
}

// This is only a decision for an explicit send press, never an automatic
// retry. Attachment identity and order must stay the same as the held send.
export function sendPlan (hold, text, quoteId, attachments = []) {
  if (!hold) return 'send'
  if (hold.text !== text || (hold.quoteId || null) !== (quoteId || null)) return 'confirm'
  const previous = hold.attachments || []
  if (previous.length !== attachments.length || previous.some((item, i) => item !== attachments[i])) return 'confirm'
  return 'retry'
}
