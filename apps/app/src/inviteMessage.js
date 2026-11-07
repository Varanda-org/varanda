// Invites sent as private messages (Conversas): the text a member sends and
// the strict recognition of an invite link of this installation inside a
// received message. Pure ES module: no React, no globals, no Node built-ins.
//
// A received message is untrusted peer text. Recognizing a link only offers
// an "Abrir convite" button that opens the community or group screen; a link
// never joins anyone. Only links on this installation's own origin count, and
// the path goes through the same strict parsers as a tapped link.

import { parseCommunityPath, parseGroupPath } from './groupLink.js'

const MAX_TEXT = 1000
const MAX_SCAN = 4000
const ELLIPSIS = '…'
const ORIGIN = /^https:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(?::[0-9]{1,5})?$/
const TRAILING = new Set(['.', ',', ';', '!', '?', ')', ']', '"', "'"])
const SPACE = /\s/

export const INVITE_SENT = 'Convite enviado pelas Conversas.'
export const INVITE_UNSURE = 'Não deu para confirmar se o convite foi enviado. Tente de novo: a mensagem não se repete.'
export const INVITE_NO_DM = 'Essa pessoa ainda não usa as Conversas. Mande o link pelo Compartilhar.'
export const INVITE_NOTE = 'O convite chega como mensagem privada. A pessoa só entra se tocar em Entrar.'
export const OPEN_INVITE = 'Abrir convite'

function cleanName (name) {
  return typeof name === 'string' ? Array.from(name.trim()) : []
}

function cut (points, budget) {
  if (points.length <= budget) return points.join('')
  if (budget <= 1) return ELLIPSIS
  return points.slice(0, budget - 1).join('').trimEnd() + ELLIPSIS
}

function compose (community, group, link, isGroup) {
  if (isGroup && group === null) {
    return community !== null
      ? 'Convite para um grupo da comunidade ' + community + ' na Varanda: ' + link
      : 'Convite para um grupo de uma comunidade na Varanda: ' + link
  }
  if (group !== null) {
    return community !== null
      ? 'Convite para o grupo ' + group + ' da comunidade ' + community + ' na Varanda: ' + link
      : 'Convite para o grupo ' + group + ' de uma comunidade na Varanda: ' + link
  }
  return community !== null
    ? 'Convite para a comunidade ' + community + ' na Varanda: ' + link
    : 'Convite para uma comunidade na Varanda: ' + link
}

const length = (s) => Array.from(s).length

// The message text for an invite. Names are cut so the text fits one private
// message (1000 code points); `group` keeps the group wording when the group
// title is unreadable, so the text never says community over a /g/ link. The link is never cut, so a link that cannot
// fit even with the unnamed wording is refused.
export function inviteText ({ communityName, groupName, link, group = false } = {}) {
  if (typeof link !== 'string' || !link.startsWith('https://')) {
    throw new TypeError('invite link must be an https:// string')
  }
  const c = cleanName(communityName)
  const g = cleanName(groupName)
  const hasC = c.length > 0
  const hasG = g.length > 0
  const isGroup = group === true || hasG

  const fixed = length(compose(hasC ? '' : null, hasG ? '' : null, link, isGroup))
  // Each name needs at least one code point; otherwise use the unnamed form.
  if (fixed + (hasC ? 1 : 0) + (hasG ? 1 : 0) > MAX_TEXT) {
    if (length(compose(null, null, link, isGroup)) > MAX_TEXT) {
      throw new TypeError('invite link is too long for a message')
    }
    return compose(null, null, link, isGroup)
  }

  const avail = MAX_TEXT - fixed
  let cBudget = c.length
  let gBudget = g.length
  if (cBudget + gBudget > avail) {
    if (!hasG) cBudget = avail
    else if (!hasC) gBudget = avail
    else {
      // Split evenly; a name shorter than its half leaves the rest to the other.
      const half = Math.floor(avail / 2)
      if (c.length <= half) gBudget = avail - c.length
      else if (g.length <= avail - half) cBudget = avail - g.length
      else { cBudget = half; gBudget = avail - half }
    }
  }
  return compose(hasC ? cut(c, cBudget) : null, hasG ? cut(g, gBudget) : null, link, isGroup)
}

// The last invite link of this installation in a message, or null. Last, not
// first: inviteText puts the (peer chosen) names before the real link, and a
// title can itself be an invite URL.
// Never throws: the text comes from a peer.
export function inviteLinkOf (text, origin) {
  try {
    if (typeof origin !== 'string' || !ORIGIN.test(origin)) return null
    if (typeof text !== 'string' || text.length > MAX_SCAN) return null
    let from = 0
    let found = null
    while (from <= text.length) {
      const at = text.indexOf(origin, from)
      if (at === -1) return found
      from = at + 1
      if (at > 0) {
        // Only whitespace may precede it: a link glued to another token
        // (https://evil.example/a:https://...) is part of that token.
        if (!SPACE.test(text[at - 1])) continue
      }
      const start = at + origin.length
      // The next character must open the path, or the origin was only the
      // prefix of a longer host (https://bora.varanda.app.evil).
      if (text[start] !== '/') continue
      let end = start
      while (end < text.length && !SPACE.test(text[end])) end++
      while (end > start && TRAILING.has(text[end - 1])) end--
      const path = text.slice(start, end)
      const community = parseCommunityPath(path)
      if (community !== null) found = { kind: 'comunidade', key: community }
      else {
        const group = parseGroupPath(path)
        if (group !== null) found = { kind: 'grupo', key: group }
      }
    }
    return found
  } catch {
    return null
  }
}
