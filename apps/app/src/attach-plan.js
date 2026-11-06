import rpc from '@varanda/rpc'
import { MAX_MEDIA_PER_POST } from './media/plan.js'

const { displayText, dmTextBudget: textBudget, dmTextBytes, validateParams, MEMBER_CERT_STANDIN } = rpc

// The widest DM media item (packages/rpc isDmMediaItem bounds), so a caption
// is measured before any upload: a photo is never put on the blob channel for
// a message that cannot carry it.
const WIDEST_DM_ITEM = Object.freeze({
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

export const PREVIEW_PHOTO = 'Foto'
export const PREVIEW_GIF = 'GIF'

export function attachmentPreview (text, attachments = []) {
  if (typeof text === 'string' && text !== '') return displayText(text.replace(/\r?\n/g, ' '))
  if (attachments.length === 0) return ''
  return attachments.every(item => item && (item.plainMime || item.mime) === 'image/gif') ? PREVIEW_GIF : PREVIEW_PHOTO
}

function checked (method, params) {
  const result = validateParams(method, params)
  if (!result.ok) throw new Error(result.message)
  return { method, params: result.value }
}

// target is { kind: 'dm', to, replyTo?, cert? } or
// { kind: 'group', group, visibility: 'public' | 'private', replyTo? }.
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
  // Without its own certificate the app measures with the largest one a msg
  // can carry, so the node never refuses as too long what fit here.
  const cert = target.cert == null ? MEMBER_CERT_STANDIN : JSON.parse(JSON.stringify(target.cert))
  const count = attachments.length
  const uploads = Array.from(attachments, item => {
    if (!item || typeof item !== 'object') throw new Error('anexo inválido')
    const { name, mime, width, height } = item
    const params = { name, mime, width, height }
    if (sealed) params.sealed = true
    return checked(dm ? 'dm.putMedia' : 'media.uploadFile', params)
  })
  if (dm && count > 0 && dmTextBytes(text) > textBudget({ ...base, media: Array(count).fill(WIDEST_DM_ITEM), cert })) {
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

// This is only a decision for an explicit send press, never an automatic
// retry. Attachment identity and order must stay the same as the held send.
export function sendPlan (hold, text, quoteId, attachments = []) {
  if (!hold) return 'send'
  if (hold.text !== text || (hold.quoteId || null) !== (quoteId || null)) return 'confirm'
  const previous = hold.attachments || []
  if (previous.length !== attachments.length || previous.some((item, i) => item !== attachments[i])) return 'confirm'
  return 'retry'
}
