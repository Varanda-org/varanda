// Pure group logic for the "Comunidades" screens: page merging,
// message rows, roles and permissions, pt-BR labels, join links, the
// reconciliation of an UNCERTAIN mutation and the invalidation of read
// pages. No React, react-native or Node built-ins: the Node tests import it.

import rpc from '@varanda/rpc'
import { shortKey } from './format.js'

const { displayText } = rpc

export const ROLES = Object.freeze(['creator', 'admin', 'member', 'requested', 'banned', 'left', 'pending'])

export const ROLE_LABELS = Object.freeze({
  creator: 'criador',
  admin: 'administrador',
  member: 'membro',
  requested: 'pedido enviado',
  banned: 'banido',
  left: 'saiu',
  pending: 'aguardando sincronização'
})

export const STATE_LABELS = Object.freeze({
  ok: '',
  'rekey-pending': 'aguardando nova chave',
  locked: 'bloqueado: entre com a passkey'
})

export const PRIVATE_LABEL = 'grupo privado'
export const PUBLIC_LABEL = 'grupo público'
export const GENERAL_LABEL = 'Geral'
export const ORPHAN_LABEL = 'grupo sem comunidade'
export const COMMUNITY_JOIN_LABELS = Object.freeze({ open: 'aberta a todos', approval: 'entrada com aprovação' })
export const HIDDEN_LABEL = 'mensagem escondida'
export const JOIN_LABELS = Object.freeze({ open: 'aberto a todos', approval: 'entrada com aprovação' })
export const REKEY_PENDING_LABEL = STATE_LABELS['rekey-pending']
export const DEVICE_JOIN_LABEL = 'Participar neste aparelho'
export const DEVICE_JOIN_TEXT = 'Sua conta já participa. Este aparelho costuma entrar sozinho depois da sincronização; se ainda não entrou, toque para participar por ele.'
export const DEVICE_RESERVE_TEXT = 'Sua conta já usa quase todos os aparelhos permitidos aqui. Entrar por este aparelho gasta uma das últimas vagas, que não voltam.'
export const DEVICE_RESERVE_JOIN_TEXT = 'Este aparelho ainda não participa desta comunidade, e a conta já usa quase todos os aparelhos permitidos aqui. Para participar por ele, toque em Participar neste aparelho na lista de grupos; a vaga não volta.'
export const DEVICE_PENDING_JOIN_TEXT = 'Este aparelho ainda não participa desta comunidade. Ele entra sozinho depois da sincronização; se não entrar, toque em Participar neste aparelho na lista de grupos.'
export const DEVICE_WAIT_TEXT = 'Este aparelho ainda não pode escrever aqui. Aguarde a sincronização.'
export const DEVICE_STAFF_TEXT = 'Algumas ações de administração só funcionam no aparelho que tem o cargo. Use aquele aparelho ou peça um novo cargo para este.'
export const DEVICE_ROOT_TEXT = 'Novo grupo, Ajustes e Quem pode convidar só funcionam no aparelho que criou a comunidade.'
export const DEVICE_APPROVAL_TEXT = 'Este aparelho precisa da aprovação de um administrador para escrever.'

const HEX64 = /^[0-9a-f]{64}$/

// The unread count the node reports caps at 99, meaning 99 or more.
export function unreadLabel (n) {
  if (!Number.isInteger(n) || n < 1) return ''
  return n >= 99 ? '99+' : String(n)
}

export const OWN_LABEL = 'Você'

// One line for a group row: who said it and what. A hidden message shows
// only the fixed label, never its preview or its author. The own message
// carries no author here: the screen draws OWN_LABEL apart (lastIsOwn), so
// a peer whose display name is "Você" can never look like it.
export function lastLine (last) {
  if (!last || typeof last !== 'object') return ''
  if (last.hidden === true) return HIDDEN_LABEL
  // A line break would show as U+FFFD.
  const text = displayText(typeof last.preview === 'string' ? last.preview.replace(/\r?\n/g, ' ') : '')
  if (last.mine === true) return text
  let who = ''
  if (typeof last.name === 'string' && displayText(last.name).trim() !== '') who = displayText(last.name)
  else if (typeof last.username === 'string' && displayText(last.username).trim() !== '') who = '@' + displayText(last.username)
  return who === '' ? text : who + ': ' + text
}

export function lastIsOwn (last) {
  return !!last && typeof last === 'object' && last.mine === true && last.hidden !== true
}

const ACTIONS = Object.freeze(['post', 'hide', 'ban', 'admit', 'admin', 'meta', 'rekey', 'leave', 'create', 'invite', 'invitePolicy'])

// --- merging ---

function keyOf (item) {
  if (!item || typeof item !== 'object') return null
  if (typeof item.key === 'string') return item.key
  if (typeof item.member === 'string') return item.member
  if (typeof item.group === 'string' && !('text' in item)) return item.group
  if (typeof item.writer === 'string' && Number.isSafeInteger(item.seq)) return item.writer + ':' + item.seq
  return null
}

// Pages (arrays of rows, or objects with `items`, `writers` or `members`) in
// the order given; a row seen twice (by key, member or writer:seq) keeps its
// first place and its first value. Rows with no key are dropped.
export function mergePages (pages) {
  const seen = new Set()
  const out = []
  if (!Array.isArray(pages)) return out
  for (const page of pages) {
    const rows = Array.isArray(page) ? page : page && (page.items || page.writers || page.members)
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      const k = keyOf(row)
      if (k === null || seen.has(k)) continue
      seen.add(k)
      out.push(row)
    }
  }
  return out
}

// --- message rows ---

function authorOf (item, names) {
  const own = typeof item.name === 'string' ? displayText(item.name).trim() : ''
  if (own) return own
  const user = typeof item.username === 'string' ? displayText(item.username).trim() : ''
  if (user) return '@' + user
  const known = names && typeof item.diary === 'string' && typeof names[item.diary] === 'string' ? displayText(names[item.diary]).trim() : ''
  if (known) return known
  return shortKey(typeof item.diary === 'string' ? item.diary : '')
}

// `items` as group.read answers (newest first, hidden ones included with
// empty text). Rows come oldest first, so the newest sits at the bottom of
// the conversation. `names` maps a diary key to a name already verified.
// `text` is escaped with its line breaks. `rawText` goes to MentionText, which
// escapes each piece itself: a word holding a control or direction mark is
// only kept unlinked while it still holds the mark, not its U+FFFD.
export function rowsOf (items, names = {}) {
  const rows = []
  for (const item of mergePages([items])) {
    if (typeof item.writer !== 'string' || !Number.isSafeInteger(item.seq)) continue
    const hidden = item.hidden === true
    const raw = hidden || typeof item.text !== 'string' ? '' : item.text
    const reply = item.replyTo && typeof item.replyTo.writer === 'string' && Number.isSafeInteger(item.replyTo.seq)
    rows.push({
      id: item.writer + ':' + item.seq,
      writer: item.writer,
      diary: typeof item.diary === 'string' ? item.diary : null,
      seq: item.seq,
      at: typeof item.at === 'string' ? item.at : null,
      author: authorOf(item, names),
      hidden,
      text: hidden ? HIDDEN_LABEL : displayText(raw, { multiline: true }),
      rawText: raw,
      replyTo: reply ? item.replyTo.writer + ':' + item.replyTo.seq : null
    })
  }
  return rows.reverse()
}

// --- roles and permissions ---

export function isRole (role) {
  return ROLES.includes(role)
}

// The caller's role in a group: from group.info / group.list when it names
// one, else from an index page (creator, or a live or departed writer of the
// caller's diary). null when the caller has no relation to the group.
export function roleOf (info, ownKey) {
  if (!info || typeof info !== 'object') return null
  if (isRole(info.role)) return info.role
  if (info.state === 'pending') return 'pending'
  if (typeof ownKey !== 'string' || !HEX64.test(ownKey)) return null
  if (info.creator === ownKey) return 'creator'
  if (Array.isArray(info.writers)) {
    const mine = info.writers.filter((w) => w && w.diary === ownKey)
    if (mine.length > 0) return mine.some((w) => w.left === false) ? 'member' : 'left'
  }
  return null
}

// What a role may do. `opts.own`: the message is the caller's (its author may
// hide it, even after leaving). `opts.communityAdmin`: the caller holds power
// in the group through its community (the fold decides; the node still
// refuses what it does not allow).
export function can (action, role, opts = {}) {
  if (!ACTIONS.includes(action) || !isRole(role)) return false
  const staff = role === 'creator' || role === 'admin'
  const delegated = opts.communityAdmin === true && role !== 'banned' && role !== 'pending'
  switch (action) {
    case 'post': return staff || role === 'member'
    case 'hide': return staff || delegated || (opts.own === true && role === 'member')
    case 'ban':
    case 'admit':
    case 'rekey': return staff || delegated
    case 'admin':
    case 'meta': return role === 'creator'
    case 'create': return role === 'creator'
    case 'invitePolicy': return staff
    // Members invite only while the community or group allows it.
    case 'invite': return staff || (role === 'member' && opts.memberInvite === true)
    case 'leave': return role !== 'banned' && role !== 'left'
  }
  return false
}

// An older node omits writerHere, canWrite and rootHere. Only an explicit
// false changes the screen, so today's mocks keep the buttons they have.
const MEMBER_ROLES = Object.freeze(['creator', 'admin', 'member'])

export function needsDeviceJoin (info) {
  if (!info || typeof info !== 'object') return false
  return MEMBER_ROLES.includes(info.role) && info.writerHere === false
}

// The seeder never frees a device slot (8 per root); the app stops entering by
// itself at 6 and leaves the last two to the person.
export function reserveReachedAny (counts) {
  if (!Array.isArray(counts)) return false
  return counts.some((n) => Number.isSafeInteger(n) && n >= 6)
}

// At the reserve the first tap only shows the warning; the person confirms
// with a second tap, because the slot is never given back.
export function needsReserveConfirm (counts, confirmed) {
  return confirmed !== true && reserveReachedAny(counts)
}

export function deviceReserveReached (info) {
  if (!info || typeof info !== 'object') return false
  return reserveReachedAny([info.writersBound])
}

// community.join spends a slot in the community and in Geral, so either count
// can be the one that hits the reserve.
export function communityReserveReached (info) {
  if (!info || typeof info !== 'object') return false
  return reserveReachedAny([info.writersBound, info.generalWritersBound])
}

export function writerOnDevice (info) {
  if (!info || typeof info !== 'object') return true
  return info.writerHere !== false
}

export function canWriteHere (info) {
  if (!info || typeof info !== 'object') return true
  return info.canWrite !== false
}

// Root-only writes (rename, Entrada, Administradores, invite policy) go
// through the root, which only the creating device holds; staff writes need
// this device's own writer to carry authority. A missing field is an older
// node. Repair mode writes meta and invitePolicy through the creator's live
// community writer, not the root, so those controls stay whatever rootHere says.
export function rootAdminHere (info) {
  if (!info || typeof info !== 'object') return true
  return info.rootHere !== false || info.repair === true
}

// Which note explains hidden staff controls: 'root' for the creator's second
// device (a role never grants the root), 'staff' for a device without
// authority, 'join' when this device does not participate yet (the controls
// are hidden until it does). One reason at a time, root first for the creator.
export function deviceStaffNote (info, { owner, staff }) {
  if (!staff || !info || typeof info !== 'object') return null
  if (needsDeviceJoin(info)) return 'join'
  if (owner && !rootAdminHere(info) && info.repair !== true) return 'root'
  if (info.authorityHere === false) return 'staff'
  return null
}

export function authorityHere (info) {
  if (!info || typeof info !== 'object') return true
  return info.authorityHere !== false
}

export function showNewGroup (info) {
  if (!info || typeof info !== 'object') return false
  return info.role === 'creator' && info.rootHere !== false
}

// --- labels ---

export function roleLabel (role) {
  return isRole(role) ? ROLE_LABELS[role] : ''
}

export function visibilityLabel (visibility) {
  return visibility === 'private' ? PRIVATE_LABEL : PUBLIC_LABEL
}

export function joinLabel (join) {
  return JOIN_LABELS[join] || ''
}

export function sealedLabel (n) {
  if (!Number.isSafeInteger(n) || n <= 0) return ''
  return n === 1 ? '1 mensagem cifrada' : n + ' mensagens cifradas'
}

export function stateLabel (state) {
  return STATE_LABELS[state] || ''
}

export function membersLabel (n) {
  if (!Number.isSafeInteger(n) || n < 0) return ''
  return n === 1 ? '1 membro' : n + ' membros'
}

// --- join links ---

export function joinLink (group) {
  if (typeof group !== 'string') return null
  const g = group.toLowerCase()
  return HEX64.test(g) ? '/g/' + g : null
}

// --- reconciliation of an uncertain mutation ---

// After a mutation answered `uncertain: true`, the screen re-reads and asks
// this before offering a retry. `change` names what was attempted:
//   { action: 'join' | 'leave', ... }                      view.state
//   { action: 'post', diary, text, sentAt }                view.items, next, state
//   { action: 'hide', writer, seq, on }                    view.items
//   { action: 'admit' | 'ban' | 'admin', member, on }      view.members
//     (admit on also needs `writer`, and view.requests and view.writers)
//   { action: 'meta', name?, join? }                       view.info
//   { action: 'rekey', epoch }  (the epoch seen before)    view.epoch
//   { action: 'community-join' }                          view.role
//   { action: 'create', community, name }                  view.community, groups
// -> 'landed' (do not retry), 'not-landed' (offer a retry) or 'unknown' (the
// re-read is missing or incomplete: offer another read, never a blind retry).
export function reconcile (change, view) {
  if (!change || typeof change !== 'object' || !view || typeof view !== 'object' || view.incomplete === true) return 'unknown'
  switch (change.action) {
    case 'join': {
      if (typeof view.state !== 'string') return 'unknown'
      return ['member', 'requested', 'pending'].includes(view.state) ? 'landed' : 'not-landed'
    }
    case 'community-join': {
      if (typeof view.role !== 'string') return 'unknown'
      return ['member', 'requested', 'pending'].includes(view.role) ? 'landed' : 'not-landed'
    }
    case 'leave': {
      if (typeof view.state !== 'string') return 'unknown'
      return view.state === 'left' ? 'landed' : 'not-landed'
    }
    case 'post': {
      if (!Array.isArray(view.items)) return 'unknown'
      if (typeof change.diary !== 'string' || !Number.isFinite(change.sentAt)) return 'unknown'
      // The caller's own writer key is not exposed to the screens: match the
      // diary, the text and a stamp not older than the send (this device's
      // clock stamps `at`; 2 s of slack).
      const floor = change.sentAt - 2000
      if (view.items.some((i) => i && i.diary === change.diary && i.text === change.text && i.hidden !== true && Date.parse(i.at) >= floor)) return 'landed'
      // Absence proves nothing unless the read covered every message.
      return view.next === null && view.state === 'ok' ? 'not-landed' : 'unknown'
    }
    case 'hide': {
      if (!Array.isArray(view.items)) return 'unknown'
      const item = view.items.find((i) => i && i.writer === change.writer && i.seq === change.seq)
      if (!item) return 'unknown'
      return (item.hidden === true) === (change.on === true) ? 'landed' : 'not-landed'
    }
    case 'admit':
    case 'ban':
    case 'admin': {
      if (!Array.isArray(view.members)) return 'unknown'
      const row = view.members.find((m) => m && m.member === change.member)
      const on = change.on === true
      if (change.action === 'admit' && on) {
        // A members row does not prove a new device: decide from the
        // request list and the specific writer.
        if (!Array.isArray(view.requests) || !Array.isArray(view.writers) || typeof change.writer !== 'string') return 'unknown'
        if (view.requests.some((r) => r && r.member === change.member)) return 'not-landed'
        return view.writers.some((w) => w && w.key === change.writer && w.left === false) ? 'landed' : 'unknown'
      }
      if (change.action === 'admit') {
        // A withdrawn admission drops the diary from the list.
        const listed = !!row && row.banned !== true
        return listed === on ? 'landed' : 'not-landed'
      }
      if (!row) return change.action === 'ban' && !on ? 'unknown' : (on ? 'not-landed' : 'landed')
      return (change.action === 'ban' ? row.banned === true : row.admin === true) === on ? 'landed' : 'not-landed'
    }
    case 'meta': {
      const info = view.info
      if (!info || typeof info !== 'object') return 'unknown'
      const nameOk = change.name === undefined || info.name === change.name
      const joinOk = change.join === undefined || info.join === change.join
      return nameOk && joinOk ? 'landed' : 'not-landed'
    }
    case 'invite-policy': {
      const info = view.info
      if (!info || typeof info !== 'object' || typeof info.memberInvite !== 'boolean') return 'unknown'
      return info.memberInvite === change.members ? 'landed' : 'not-landed'
    }
    case 'rekey': {
      const epoch = view.epoch
      // A locked node reads no epoch at all: that proves nothing.
      if (!epoch || view.state !== 'ok') return 'unknown'
      const before = change.epoch
      // No epoch seen before (the pre-read failed): nothing to compare with.
      if (!before) return 'unknown'
      const same = epoch.writer === before.writer && epoch.seq === before.seq
      return same ? 'not-landed' : 'landed'
    }
    case 'create': {
      if (typeof change.community !== 'string' || typeof change.name !== 'string') return 'unknown'
      if (view.community !== change.community || !Array.isArray(view.groups)) return 'unknown'
      return view.groups.some((g) => g && g.name === change.name && g.role === 'creator') ? 'landed' : 'not-landed'
    }
  }
  return 'unknown'
}

// --- read pages and their invalidation ---

// What the decryptable history depends on: a new epoch, a state change or a
// different number of messages this device cannot open all change it.
export function versionOf (read) {
  if (!read || typeof read !== 'object') return ''
  const e = read.epoch && typeof read.epoch === 'object' ? read.epoch.writer + ':' + read.epoch.seq : '-'
  return [e, typeof read.state === 'string' ? read.state : 'ok', Number.isSafeInteger(read.sealed) ? read.sealed : 0].join('|')
}

export function cursorKey (next) {
  return next && typeof next === 'object' && typeof next.writer === 'string' ? next.at + '|' + next.writer + '|' + next.seq : null
}

export const EMPTY_PAGES = Object.freeze({ version: '', pages: Object.freeze([]), next: null, stale: false })

// Adds one group.read answer. `before` is the cursor the request used (null
// for the newest page). The newest page replaces everything; an older page
// is kept only when it continues the cursor the store ended on and the read
// version has not changed. Otherwise it is dropped and `stale` is set: the
// screen reloads from the newest page.
export function applyPage (store, read, before = null) {
  const base = store && Array.isArray(store.pages) ? store : EMPTY_PAGES
  if (!read || typeof read !== 'object' || !Array.isArray(read.items)) return base
  const version = versionOf(read)
  const page = { items: read.items.slice(), next: read.next || null }
  if (before === null) {
    return Object.freeze({ version, pages: Object.freeze([page]), next: page.next, stale: false })
  }
  const expected = cursorKey(base.next)
  if (version !== base.version || expected === null || expected !== cursorKey(before)) {
    return Object.freeze({ version: base.version, pages: Object.freeze([]), next: null, stale: true })
  }
  return Object.freeze({ version, pages: Object.freeze(base.pages.concat([page])), next: page.next, stale: false })
}

export function itemsOf (store) {
  return store && Array.isArray(store.pages) ? mergePages(store.pages) : []
}
