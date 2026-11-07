// Which actions a post may offer. The inline row is reply, repost, like and,
// when a public link exists, share. Quote is not on that row: the pencil
// glyph reads as edit, so Citar sits in the repost sheet next to Republicar.
// A private chat never yields a share link, even when the caller passes a
// URL, because sharing or copying it would publish the conversation.
// The screen chooses the system share sheet or the clipboard from canShare.
// This module only decides whether a link exists.

import { canDelete } from './deletion.js'
import { isAuthorKey } from './nav.js'

const LINK_MAX = 2048
const PRIVATE_KIND = new Set(['dm', 'mensagem', 'message', 'private'])

function action (id, icon, label) {
  return { id, icon, label }
}

function ownKeyOf (caps) {
  if (!caps || typeof caps !== 'object') return null
  if (typeof caps.ownKey === 'string' && caps.ownKey !== '') return caps.ownKey.toLowerCase()
  if (typeof caps.own === 'string' && caps.own !== '') return caps.own.toLowerCase()
  return null
}

// Acting as a page: that page's posts are the ones you can delete, same rule
// as canDelete. A non-key is ignored so a bad string cannot match an author.
function pageKeyOf (caps) {
  if (!caps || typeof caps !== 'object') return null
  let raw = ''
  if (typeof caps.page === 'string') raw = caps.page
  else if (typeof caps.actingPage === 'string') raw = caps.actingPage
  if (raw === '') return null
  const key = raw.toLowerCase()
  return isAuthorKey(key) ? key : null
}

function authorOf (item) {
  if (!item || typeof item !== 'object' || typeof item.author !== 'string') return ''
  return item.author.toLowerCase()
}

function ownsAuthor (item, caps) {
  if (!item || typeof item !== 'object') return false
  const author = authorOf(item)
  if (author === '') return false
  if (author === ownKeyOf(caps)) return true
  const page = pageKeyOf(caps)
  return page !== null && author === page
}

// Delete targets the post itself. A repost row points at the original, and
// the feed already refuses to delete from there: undo is the repost control.
function isRepostRow (item) {
  if (!item || typeof item !== 'object') return false
  if (item.repostedBy) return true
  return item.type === 'repost'
}

function canApagar (item, caps) {
  if (!item || typeof item !== 'object' || isRepostRow(item)) return false
  const author = authorOf(item)
  if (author === '') return false
  return canDelete({ author, seq: item.seq }, ownKeyOf(caps), pageKeyOf(caps))
}

function kindOf (item) {
  if (typeof item.kind === 'string') return item.kind
  if (typeof item.channel === 'string') return item.channel
  if (typeof item.type === 'string' && item.type !== 'post' && item.type !== 'repost' && item.type !== 'like') {
    return item.type
  }
  return ''
}

function isPrivateChat (item, caps) {
  if (caps && typeof caps === 'object' && (caps.private === true || caps.dm === true)) return true
  if (!item || typeof item !== 'object') return false
  if (item.private === true || item.dm === true || item.sealed === true) return true
  if (item.visibility === 'private') return true
  return PRIVATE_KIND.has(kindOf(item))
}

// Only an already-clean http(s) URL. No trim and no URL parser: either would
// rewrite what the caller asked to share.
function publicUrl (value) {
  if (typeof value !== 'string' || value.length > LINK_MAX) return null
  const scheme = value.startsWith('https://') ? 8 : value.startsWith('http://') ? 7 : 0
  if (scheme === 0 || value.length <= scheme) return null
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c <= 0x20 || c === 0x7f) return null
  }
  return value
}

function linkCandidates (caps) {
  const c = caps && typeof caps === 'object' ? caps : null
  // Only the screen decides the link (built from the installation origin and
  // the verified post identity): a field riding on the post item itself could
  // be shaped by a peer and must never become the URL a share hands out.
  return [
    c && c.link,
    c && c.url,
    c && c.publicLink
  ]
}

// The only producer of a share link. Null for a private chat, and null when
// nothing the caller passed is a public http(s) URL.
export function shareLink (item, caps) {
  if (isPrivateChat(item, caps)) return null
  for (const value of linkCandidates(caps)) {
    const url = publicUrl(value)
    if (url !== null) return url
  }
  return null
}

export function primaryActions (item, caps) {
  const actions = [
    action('reply', 'resposta', 'Responder'),
    action('repost', 'republicar', 'Republicar'),
    action('like', 'coracao', 'Curtir')
  ]
  const href = shareLink(item, caps)
  if (href !== null) actions.push({ ...action('share', 'compartilhar', 'Compartilhar'), href })
  return actions
}

// Opened from the repost button, not from the inline row.
export function repostActions (item, caps) {
  if (isPrivateChat(item, caps)) return []
  return [
    action('repost', 'republicar', 'Republicar'),
    action('quote', 'citar', 'Citar')
  ]
}

// onReport may be the handler or true. Ownership wins: your own post is
// never a Denunciar row, even when a handler was passed.
function reportSet (caps) {
  if (!caps || typeof caps !== 'object') return false
  const value = caps.onReport
  return value === true || typeof value === 'function'
}

// Copiar link, then Denunciar, then Apagar. Share itself is the primary
// action, so Compartilhar is not a row here. The screen attaches onPress
// and the delete confirmation.
export function moreActions (item, caps) {
  const rows = []
  const href = shareLink(item, caps)
  if (href !== null) rows.push({ ...action('copy', 'link', 'Copiar link'), href })
  if (reportSet(caps) && !ownsAuthor(item, caps)) rows.push(action('report', 'bandeira', 'Denunciar'))
  if (canApagar(item, caps)) {
    const row = action('delete', 'lixeira', 'Apagar')
    row.danger = true
    rows.push(row)
  }
  return rows
}
