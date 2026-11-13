'use strict'

// The direct message folders (docs/protocol.md section 11): which verified
// messages show, in which thread, inbox or request, and whether any is
// unread. The only copy of these rules: the node calls it and the app
// renders what the RPC returns. Pure: no sodium, no I/O.
//
// Nothing here produces a read, delivered or typing state for the other
// side: unread is local and never leaves the device. A reaction (inner v4)
// only adds `reactions` to the row it names: it never changes unread, the
// preview, the thread order, a cutoff or the DM_MESSAGES_PER_PEER cap.
// A bound reply quotes only the kept row with its sender, id and digest.

const { copyLinkCard } = require('./link-card')
const { DM_REQUESTS_MAX, DM_MESSAGES_PER_PEER } = require('./dm')

const HEX64 = /^[0-9a-f]{64}$/
const HEX32 = /^[0-9a-f]{32}$/
const FOLDER_OPS = ['accepted', 'declined']
const PREVIEW_PHOTO = 'Foto'
const PREVIEW_GIF = 'GIF'
const PREVIEW_AUDIO = 'Áudio'
const BLOCK_OPS = ['blocked', 'unblocked']

function isHex64 (s) {
  return typeof s === 'string' && HEX64.test(s)
}

function time (at) {
  if (typeof at !== 'string') return NaN
  return Date.parse(at)
}

function toSet (x) {
  if (x instanceof Set) return x
  return new Set(Array.isArray(x) ? x : [])
}

// A local filing time in ms (assigned by this device), or NaN.
// Outside the Date range a row would make toISOString throw for every thread.
const MAX_TIME = 8.64e15

function filed (x) {
  return typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= MAX_TIME ? x : NaN
}

// Newest op per class and peer, by local filing time: `at` is chosen by
// whoever wrote the envelope, so no cutoff ever reads it. At equal times the
// restrictive op wins (blocked over unblocked, declined over accepted), so
// the result does not depend on input order.
function opState (ops) {
  const state = new Map()
  for (const o of Array.isArray(ops) ? ops : []) {
    if (o === null || typeof o !== 'object' || !isHex64(o.peer)) continue
    const t = filed(o.filedAt)
    if (!Number.isFinite(t)) continue
    let s = state.get(o.peer)
    if (!s) {
      s = { folder: null, block: null, deleted: -Infinity, lastBlocked: -Infinity, lastDeclined: -Infinity }
      state.set(o.peer, s)
    }
    if (FOLDER_OPS.includes(o.op)) {
      if (o.op === 'declined' && t > s.lastDeclined) s.lastDeclined = t
      if (s.folder === null || t > s.folder.t || (t === s.folder.t && o.op === 'declined')) s.folder = { op: o.op, t }
    } else if (BLOCK_OPS.includes(o.op)) {
      if (o.op === 'blocked' && t > s.lastBlocked) s.lastBlocked = t
      if (s.block === null || t > s.block.t || (t === s.block.t && o.op === 'blocked')) s.block = { op: o.op, t }
    } else if (o.op === 'deleted') {
      if (t > s.deleted) s.deleted = t
    }
  }
  return state
}

function isBlocked (s) {
  return s !== undefined && s.block !== null && s.block.op === 'blocked'
}

function byTime (a, b) {
  return a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function byNewest (a, b) {
  return b.t - a.t || (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0)
}

// The verified reactions of one conversation, by peer, as { r, f }.
// reactions: { id, from, to, target: { from, id, digest }, emoji, rev, filedAt }.
// The reactor is the signed `from`, one of the two people; the target names
// a message of the same conversation by sender and id, and by the hex64
// digest of its opened inner body (core dm.js bodyDigest).
function reactionsByPeer (self, reactions) {
  const out = new Map()
  for (const r of Array.isArray(reactions) ? reactions : []) {
    if (r === null || typeof r !== 'object' || typeof r.id !== 'string' || !HEX32.test(r.id)) continue
    if (!isHex64(r.from) || !isHex64(r.to) || r.from === r.to) continue
    const peer = r.from === self ? r.to : r.to === self ? r.from : null
    if (peer === null) continue
    const tg = r.target
    if (tg === null || typeof tg !== 'object' || typeof tg.id !== 'string' || !HEX32.test(tg.id)) continue
    if (tg.from !== self && tg.from !== peer) continue
    if (!isHex64(tg.digest)) continue
    if (typeof r.emoji !== 'string' || !Number.isInteger(r.rev) || r.rev < 1) continue
    const f = filed(r.filedAt)
    if (!Number.isFinite(f)) continue
    if (!out.has(peer)) out.set(peer, [])
    out.get(peer).push({ r, f })
  }
  return out
}

// Per (target, reactor) the op with the highest `rev` wins, ties by the
// higher `id`; '' as the winner removes. Never the sender's `at` nor the
// local filing time. One id signed twice with one rev falls to the higher
// emoji, so the input order never decides.
function beats (a, b) {
  if (a.rev !== b.rev) return a.rev > b.rev
  if (a.id !== b.id) return a.id > b.id
  return a.emoji > b.emoji
}

// Sets `reactions` on the kept rows that a reaction names. A target that is
// absent, cut off or past the cap has no row here, so its reactions count
// once it is present (the fold runs over everything stored). A reaction
// applies only to the row whose digest it names: another message filed
// under the same sender and id is not the one it was made for, and a row
// stored without a digest (an earlier build) takes none.
function applyReactions (self, kept, list) {
  if (list === undefined || list.length === 0) return
  const rows = new Map()
  for (const row of kept) rows.set(row.from + ':' + row.id, row)
  const winners = new Map()
  for (const r of list) {
    const target = r.target.from + ':' + r.target.id
    const row = rows.get(target)
    if (row === undefined || row.digest === '' || row.digest !== r.target.digest) continue
    const key = target + ':' + r.from
    const best = winners.get(key)
    if (best === undefined || beats(r, best)) winners.set(key, r)
  }
  for (const [key, r] of winners) {
    if (r.emoji === '') continue
    const row = rows.get(key.slice(0, key.lastIndexOf(':')))
    if (!row.reactions) row.reactions = []
    row.reactions.push({ emoji: r.emoji, mine: r.from === self })
  }
  // The other person's first, then mine: the same on every device.
  for (const row of kept) if (row.reactions) row.reactions.sort((a, b) => Number(a.mine) - Number(b.mine))
}

// A reply as a row keeps it: `replyTo` the bare id (null for none) and
// `bind` { from, digest } for a bound reply (inner v2 or v3), else null. A
// bare id is what earlier builds wrote; a malformed bound one is no reply.
function replyOf (r) {
  if (r === undefined || r === null) return { replyTo: null, bind: null }
  if (typeof r === 'string') return { replyTo: r, bind: null }
  if (typeof r !== 'object' || typeof r.id !== 'string' || !HEX32.test(r.id) || !isHex64(r.from) || !isHex64(r.digest)) return { replyTo: null, bind: null }
  return { replyTo: r.id, bind: { from: r.from, digest: r.digest } }
}

// Marks each bound reply of the kept rows: `quoted` is true only when the
// row it names by sender and id is kept here with the digest it names. A
// row without a digest, another message filed under that sender and id, or
// one cut off or past the cap is not the message the reply was made for.
function bindReplies (kept) {
  const rows = new Map()
  for (const row of kept) rows.set(row.from + ':' + row.id, row)
  for (const row of kept) {
    if (row.bind === null) continue
    const target = rows.get(row.bind.from + ':' + row.replyTo)
    row.quoted = target !== undefined && target.digest !== '' && target.digest === row.bind.digest
  }
}

// fold({ self, followSet, messages, ops, seen, reactions }) -> { inbox, requests },
// each a list of { peer, folder, messages, at, unread } newest first.
// seen: Set of seenKey(from, id) strings.
// messages: verified bodies { id, from, to, text, replyTo, media?, fwd?, at,
// filedAt, digest? } (media null or absent for a v1 body; replyTo null, a
// bare id or a bound { from, id, digest }; digest the hex64
// of the canonical inner JSON, absent for a row stored without one);
// ops: { op, peer, at, filedAt }; reactions: see reactionsByPeer, under
// the same filing cutoffs as the rows. filedAt is the LOCAL time in ms at which
// this device stored the row (monotonic, assigned by the node; the send
// time for own messages, the filing or creation time for own ctl ops). A
// row without a valid filedAt is ignored. Cutoffs compare filedAt only;
// ordering uses min(at, filedAt), so a future `at` cannot pin a thread.
function fold ({ self, followSet, messages, ops, seen, reactions } = {}) {
  if (!isHex64(self)) return { inbox: [], requests: [] }
  const follows = toSet(followSet)
  const seenKeys = toSet(seen)
  const state = opState(ops)
  const reacts = reactionsByPeer(self, reactions)

  const candidates = []
  const input = Array.isArray(messages) ? messages : []
  for (let i = 0; i < input.length; i++) {
    const m = input[i]
    if (m === null || typeof m !== 'object' || typeof m.id !== 'string' || !HEX32.test(m.id)) continue
    if (!isHex64(m.from) || !isHex64(m.to) || typeof m.text !== 'string') continue
    const at = time(m.at)
    const f = filed(m.filedAt)
    if (!Number.isFinite(at) || !Number.isFinite(f)) continue
    candidates.push({ m, f, t: Math.min(at, f), i })
  }
  // Within one conversation an id belongs to one row, which keeps quotes and
  // the dm.thread cursor unambiguous. An own message always keeps its id: it
  // is signed by the own key, so a peer copy can only be the peer reusing an id
  // it received, and on another own device that copy may be filed before the
  // self copy arrives. Between other copies the first FILED wins.
  const ownFirst = (c) => (c.m.from === self ? 0 : 1)
  candidates.sort((a, b) => ownFirst(a) - ownFirst(b) || a.f - b.f || a.i - b.i)

  const byPeer = new Map()
  const ids = new Set()
  for (const { m, f, t } of candidates) {
    let peer
    if (m.from === self) peer = m.to
    else if (m.to === self) peer = m.from
    else continue
    if (peer === self) continue
    const key = peer + ':' + m.id
    if (ids.has(key)) continue
    ids.add(key)
    const mine = m.from === self
    const media = Array.isArray(m.media) && m.media.length > 0 ? m.media : null
    const row = { id: m.id, from: m.from, to: m.to, text: m.text, ...replyOf(m.replyTo), fwd: m.fwd === 1 ? 1 : 0, media, card: media || !m.card ? null : copyLinkCard(m.card, (d) => ({ ...d })), at: new Date(t).toISOString(), sentAt: m.at, mine, peer, t, f, digest: isHex64(m.digest) ? m.digest : '' }
    if (!byPeer.has(peer)) byPeer.set(peer, [])
    byPeer.get(peer).push(row)
  }

  const inbox = []
  const requests = []
  for (const [peer, rows] of byPeer) {
    const s = state.get(peer)
    // A block hides everything while it lasts.
    if (isBlocked(s)) continue
    let kept = rows.filter(r => s === undefined || (r.f > s.lastBlocked && r.f > s.deleted))
    let peerReacts = (reacts.get(peer) || []).filter(x => s === undefined || (x.f > s.lastBlocked && x.f > s.deleted))
    const accepted = s !== undefined && s.folder !== null && s.folder.op === 'accepted'
    let folder = 'inbox'
    if (!follows.has(peer) && !accepted) {
      // Only the peer's side: an own reply from another device may predate
      // a decline, and only `deleted` removes own messages.
      if (s !== undefined) {
        kept = kept.filter(r => r.mine || r.f > s.lastDeclined)
        peerReacts = peerReacts.filter(x => x.r.from === self || x.f > s.lastDeclined)
      }
      if (!kept.some(r => r.mine)) folder = 'request'
    }
    if (kept.length === 0) continue
    kept.sort(byTime)
    if (kept.length > DM_MESSAGES_PER_PEER) kept = kept.slice(kept.length - DM_MESSAGES_PER_PEER)
    applyReactions(self, kept, peerReacts.map(x => x.r))
    bindReplies(kept)
    const last = kept[kept.length - 1]
    const thread = {
      peer,
      folder,
      messages: kept.map(publicRow),
      at: last.at,
      unread: kept.some(r => !r.mine && !seenKeys.has(seenKey(r.from, r.id))),
      t: last.t
    }
    if (folder === 'inbox') inbox.push(thread)
    else requests.push(thread)
  }
  inbox.sort(byNewest)
  requests.sort(byNewest)
  return { inbox: inbox.map(dropT), requests: requests.slice(0, DM_REQUESTS_MAX).map(dropT) }
}

// `at` is the effective time min(sender at, filedAt) in canonical ISO: what
// every reader orders and pages by. `sentAt` is the sender's claim, shown
// only as information. `reactions` ([{ emoji, mine }], at most one per
// person) only when there is one. `digest` only when the row has one: what
// a new reaction or a bound reply to it names (callers never hand it out in
// dm.thread). `replyTo` is always the bare id; a bound reply adds
// `replyFrom`, the quoted sender, when the message it names is kept here,
// and `replyMissing: true` when it is not.
function publicRow (r) {
  const row = { id: r.id, from: r.from, to: r.to, text: r.text, replyTo: r.replyTo, fwd: r.fwd, media: r.media, card: r.card, at: r.at, sentAt: r.sentAt, mine: r.mine, peer: r.peer }
  if (r.bind !== null) {
    if (r.quoted) row.replyFrom = r.bind.from
    else row.replyMissing = true
  }
  if (r.digest !== '') row.digest = r.digest
  if (r.reactions) row.reactions = r.reactions
  return row
}

// What a conversation list shows for a message: its text, or a fixed label
// when it is only media, so no peer-chosen string stands in for the photo.
// GIF only when every item is one; a voice note is 'Áudio'.
function previewText (m) {
  if (m === null || typeof m !== 'object') return ''
  const text = typeof m.text === 'string' ? m.text : ''
  if (text !== '' || !Array.isArray(m.media) || m.media.length === 0) return text
  if (m.media.some(d => d !== null && typeof d === 'object' && d.mime === 'audio/mp4')) return PREVIEW_AUDIO
  const gif = m.media.every(d => d !== null && typeof d === 'object' && d.mime === 'image/gif')
  return gif ? PREVIEW_GIF : PREVIEW_PHOTO
}

function dropT (thread) {
  const { t, ...rest } = thread
  return rest
}

// Ids are unique per sender only, so seen marks name the sender too.
function seenKey (from, id) {
  return from + ':' + id
}

// A boolean, never a count: the tab shows a dot.
function tabDot (threads) {
  const list = Array.isArray(threads)
    ? threads
    : threads !== null && typeof threads === 'object'
      ? [...(threads.inbox || []), ...(threads.requests || [])]
      : []
  return list.some(t => t !== null && typeof t === 'object' && t.unread === true)
}

// The message a reply points at, only inside one peer's thread. fold keeps
// one row per id per thread; rows sharing an id only reach here from other
// input, and then the smaller sender key wins, the same on every device.
// A new reply binds to the row found here when it has a digest.
function replyTarget (messages, id) {
  if (!Array.isArray(messages) || typeof id !== 'string' || !HEX32.test(id)) return null
  if (!messages.every(m => m !== null && typeof m === 'object')) return null
  const matches = messages.filter(m => m.id === id)
  const target = matches.reduce((best, m) => (best === undefined || String(m.from) < String(best.from) ? m : best), undefined)
  if (!target || !isHex64(target.peer)) return null
  if (!messages.every(m => m.peer === target.peer)) return null
  if (target.from !== target.peer && target.to !== target.peer) return null
  return target
}

function canSend ({ self, peer, ops } = {}) {
  if (!isHex64(self) || !isHex64(peer) || peer === self) return false
  return !isBlocked(opState(ops).get(peer))
}

module.exports = Object.freeze({
  fold,
  seenKey,
  tabDot,
  replyTarget,
  canSend,
  previewText,
  PREVIEW_PHOTO,
  PREVIEW_GIF,
  PREVIEW_AUDIO
})
