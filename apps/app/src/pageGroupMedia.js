// A Página in one of its private groups (docs/rpc.md 5.114). Its photos,
// GIFs, voice notes and card thumbnails are sealed on the device
// (media.sealPage), the ciphertext goes up as the page (the `media` action
// with the `group` op) and each post, reaction or hide is one record the node
// seals (group.seal) and the service appends as 'group-seal'. The service
// reads none of it. No React, no I/O: Grupo.js does the calls.

const HEX64 = /^[0-9a-f]{64}$/
export const SEALED_MIME = 'application/octet-stream'

// The signed op of the ciphertext's upload: exactly these four keys, so no
// size, duration or kind of the hidden media reaches the service.
export function sealedUploadOp ({ group, item } = {}) {
  return { group, sha256: item.sha256, mime: SEALED_MIME, bytes: item.bytes }
}

// The private item a post carries: where the service stored the ciphertext
// (core, start) and the rest from the node's item. null unless the
// descriptor is the upload of that very ciphertext, so a service answer for
// other bytes never lands in a post.
export function privateItemOf (descriptor, item) {
  if (!descriptor || typeof descriptor !== 'object' || !item || typeof item !== 'object') return null
  if (descriptor.mime !== SEALED_MIME || typeof descriptor.core !== 'string' || !HEX64.test(descriptor.core)) return null
  if (!Number.isSafeInteger(descriptor.start) || descriptor.start < 1) return null
  if (descriptor.sha256 !== item.sha256 || descriptor.bytes !== item.bytes || descriptor.blocks !== item.blocks) return null
  return {
    core: descriptor.core,
    mime: SEALED_MIME,
    start: descriptor.start,
    blocks: item.blocks,
    bytes: item.bytes,
    sha256: item.sha256,
    key: item.key,
    nonce: item.nonce,
    plainMime: item.plainMime,
    plainSha256: item.plainSha256,
    w: item.w,
    h: item.h,
    ms: item.ms
  }
}

const POST_KEYS = ['text', 'replyTo', 'fwd', 'media', 'card']

// group.seal params for a post, from the person's group.post params
// (composePlan): the same post, said by the page. Only the keys group.seal
// takes; fwd only when set.
export function pageSealParams (op, page) {
  const out = { group: op.group, page }
  for (const k of POST_KEYS) {
    if (op[k] === undefined || op[k] === null) continue
    if (k === 'fwd' && op.fwd !== 1) continue
    out[k] = op[k]
  }
  return out
}

// The 'group-seal' op from the node's sealed record.
export function groupSealOp (group, sealed) {
  return { group, kid: { writer: sealed.kid.writer, seq: sealed.kid.seq }, nonce: sealed.nonce, box: sealed.box, at: sealed.at, writer: sealed.writer, seq: sealed.seq }
}

// Seals one record and sends it. seal() is node group.seal (writes nothing),
// send(action, op) the page's signed statement, which throws { uncertain,
// retry } on an unknown outcome: the caller keeps that retry for the
// person's tap. A reaction the fold already counts ({ ok: true }) sends
// nothing. -> the service's answer, or { ok: true }.
export async function sendSealed ({ group, seal, send }) {
  const sealed = await seal()
  if (sealed && sealed.ok === true && sealed.box === undefined) return { ok: true }
  return send('group-seal', groupSealOp(group, sealed))
}

// A refusal after which the same media may be sealed again on the person's
// tap: another record took the writer's next seq ('sequencia'), or the
// group's key is being changed. Never an uncertain outcome.
export function sealAgainAfter (err) {
  if (!err || err.uncertain === true) return false
  return err.code === 'sequencia' || err.code === 'aguardando-chave' || err.message === 'aguardando nova chave'
}

const PRIVATE_ITEM_KEYS = ['key', 'nonce', 'plainSha256']
const privateItem = (item) => !!item && typeof item === 'object' && PRIVATE_ITEM_KEYS.some((k) => Object.prototype.hasOwnProperty.call(item, k))

// Whether a post's params are the private kind: marked sealed, or a photo,
// voice note or card image that carries its item key. Such a post goes out
// only sealed (group.seal); as a plain 'group-post' its keys would be read by
// the service and every member of the open group.
export function carriesPrivateItems (params) {
  if (!params || typeof params !== 'object') return false
  if (params.sealed === true) return true
  if (Array.isArray(params.media) && params.media.some(privateItem)) return true
  return !!params.card && typeof params.card === 'object' && privateItem(params.card.image)
}

// How a page's held post is sent again on the person's tap, chosen from the
// held post and never from the screen's current read: 'retry' (the same
// signed statement it kept), 'sealed' (sealed again, only while the node
// still reads the group as private), 'plain' (a 'group-post' of public items)
// or null (nothing is sent: the group's kind is not known now).
export function heldPageSender (held, visibility) {
  if (!held || !held.op) return null
  if (typeof held.retry === 'function') return 'retry'
  if (held.sealed === true || carriesPrivateItems(held.op.params)) return visibility === 'private' ? 'sealed' : null
  return visibility === 'public' ? 'plain' : null
}
