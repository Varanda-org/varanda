// The private snapshot codecs: Avisos, the Conversas list, the last page of
// a few private conversations and of a few groups, kept so a reopen paints
// them at once while the node answers. Terms and Privacidade say these
// private copies stay on the device for at most 14 days per conversation, so
// every kind and every thread or group entry expires 14 days after its own
// save. Registered in the DELEGATED table of ./screenSnapshot.js, which
// checks the binding, the actor (never a page), the envelope age and the
// byte size and wipes them with the other kinds. Pure: no React, no
// react-native, no Node built-ins.
//
// Bodies (an unknown key anywhere fails the whole parse; no cursor is kept):
// - 'avisos': { notices }: at most 60 notices.list rows (docs/rpc.md 5.28).
// - 'conversas': { rows, groups }: at most 30 dm.list rows (5.77) and at
//   most 256 { group, name } of private groups.
// - 'mensagens': { threads: { [peer]: { savedAt, messages } } }: at most 8
//   dm.thread pages (5.78), 30 messages and 28672 bytes each.
// - 'grupoMensagens': { groups: { [group]: { savedAt, items } } }: at most 6
//   group.read pages (5.40), 26 items and 40960 bytes each.
// A media item of a message or group item is kept only as the stub { mime,
// w, h, ms? } and a card with image: null: a media key or nonce never leaves
// the node (docs/rpc.md 5.78), and a parse that meets a property named key
// or nonce anywhere in those two kinds fails.

import rpc from '@varanda/rpc'
import { MAX_MEDIA_PER_POST } from './media/plan.js'
import { MAX_NAME_UNITS, MAX_TEXT_UNITS, avatarField, cardOf, exactKeys, hasOwn, isAt, isHex64, isName, isPlain, isSeq, isUsername } from './snapshotParts.js'

const { utf8ByteLength, GROUP_LIMIT_DEFAULT, GROUP_REACTIONS_MAX, DM_THREAD_LIMIT_DEFAULT } = rpc

const DAY = 24 * 60 * 60 * 1000
export const PRIVATE_SNAPSHOT_MAX_AGE_MS = 14 * DAY
// A clock moved back a little must not throw away a good entry (the same
// slack as ./screenSnapshot.js).
const FUTURE_SLACK_MS = DAY

export const NOTICES_MAX_BYTES = 131072
export const NOTICES_MAX_ROWS = 60
export const CONVERSAS_MAX_BYTES = 98304
export const CONVERSAS_MAX_ROWS = 30
export const CONVERSAS_MAX_GROUPS = 256
export const MESSAGES_MAX_BYTES = 262144
export const MESSAGES_MAX_PEERS = 8
export const MESSAGES_MAX_PER_THREAD = DM_THREAD_LIMIT_DEFAULT
export const THREAD_MAX_BYTES = 28672
export const GROUP_MESSAGES_MAX_BYTES = 262144
export const GROUP_MESSAGES_MAX_GROUPS = 6
// One default group.read page, so the live newest page never shrinks the
// painted list.
export const GROUP_MESSAGES_MAX_ITEMS = GROUP_LIMIT_DEFAULT
export const GROUP_ENTRY_MAX_BYTES = 40960

const HEX32 = /^[0-9a-f]{32}$/
const REF = /^[0-9a-f]{64}:[1-9][0-9]{0,15}$/
const MIME = /^[a-z]{1,32}\/[a-z0-9.+-]{1,64}$/
const NOTICE_KINDS = ['follow', 'reply', 'quote', 'mention', 'like', 'repost']
const NOTICE_REQUIRED = ['key', 'seq', 'at', 'name', 'username', 'seen', 'avatar']
const NOTICE_OPTIONAL = ['kind', 'post']
const DM_ROW_KEYS = ['peer', 'folder', 'preview', 'at', 'unread', 'mine']
const GROUP_NAME_KEYS = ['group', 'name']
const ENTRY_THREAD_KEYS = ['savedAt', 'messages']
const ENTRY_GROUP_KEYS = ['savedAt', 'items']
const MESSAGE_REQUIRED = ['id', 'from', 'text', 'replyTo', 'fwd', 'at', 'mine', 'media', 'card']
const MESSAGE_OPTIONAL = ['replyFrom', 'replyMissing', 'moment', 'reactable', 'reactions']
const ITEM_REQUIRED = ['writer', 'diary', 'seq', 'at', 'text', 'replyTo', 'fwd', 'media', 'card', 'hidden', 'name', 'username']
const ITEM_OPTIONAL = ['reactions']
const STUB_REQUIRED = ['mime', 'w', 'h']
const STUB_OPTIONAL = ['ms']
const SECRET_NAMES = ['key', 'nonce']
// dm.list cuts a preview to 140 code points.
const MAX_PREVIEW_UNITS = 140 * 2
const MAX_EMOJI_UNITS = 64
const MAX_DIMENSION = 16384
const MAX_MEDIA_MS = 10 * 60 * 1000
// One reaction per person of a conversation.
const DM_REACTIONS_MAX = 2

const isHex32 = (v) => typeof v === 'string' && HEX32.test(v)
const iterable = (v) => v !== null && typeof v === 'object' && typeof v[Symbol.iterator] === 'function'
const bytesOf = (v) => utf8ByteLength(JSON.stringify(v))
const isEmoji = (v) => typeof v === 'string' && v.length >= 1 && v.length <= MAX_EMOJI_UNITS
const isText = (v) => typeof v === 'string' && v.length <= MAX_TEXT_UNITS
const isDim = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_DIMENSION

function keySet (src) {
  const set = new Set()
  if (!iterable(src)) return set
  for (const k of src) if (typeof k === 'string') set.add(k.toLowerCase())
  return set
}

// Exactly the required keys plus any of the optional ones.
function shapeOk (o, required, optional) {
  const own = Object.keys(o)
  return required.every((k) => hasOwn(o, k)) && own.every((k) => required.includes(k) || optional.includes(k))
}

// Whether a property named key or nonce sits anywhere in `v`.
function hasSecret (v) {
  if (v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some(hasSecret)
  return Object.keys(v).some((k) => SECRET_NAMES.includes(k) || hasSecret(v[k]))
}

// An entry is kept for PRIVATE_SNAPSHOT_MAX_AGE_MS from its own savedAt. A
// time ahead of the clock past the slack is not fresh: it would otherwise
// outlive every later save.
function fresh (savedAt, now) {
  return Number.isSafeInteger(savedAt) && savedAt >= 0 && Number.isSafeInteger(now) &&
    now - savedAt <= PRIVATE_SNAPSHOT_MAX_AGE_MS && savedAt - now <= FUTURE_SLACK_MS
}

// The longest prefix of `list` for which fits(make(prefix)) holds, or null.
function fitPrefix (list, make, fits) {
  for (let n = list.length; n >= 0; n--) {
    const body = make(list.slice(0, n))
    if (fits(body) === true) return body
  }
  return null
}

// ---- 'avisos'

function noticeOf (v, strict) {
  if (!isPlain(v)) return null
  if (strict && !shapeOk(v, NOTICE_REQUIRED, NOTICE_OPTIONAL)) return null
  const loose = (x) => (x === undefined && !strict ? null : x)
  const name = loose(v.name)
  const username = loose(v.username)
  if (!isHex64(v.key) || !isSeq(v.seq) || !isAt(v.at) || !isName(name) || !isUsername(username) || !isHex32(v.seen)) return null
  if (hasOwn(v, 'kind') && !NOTICE_KINDS.includes(v.kind)) return null
  if (hasOwn(v, 'post') && !(typeof v.post === 'string' && REF.test(v.post))) return null
  const avatar = avatarField(v.avatar, strict)
  if (!avatar.ok) return null
  const out = {}
  if (hasOwn(v, 'kind')) out.kind = v.kind
  Object.assign(out, { key: v.key, seq: v.seq, at: v.at, name, username, seen: v.seen, avatar: avatar.value })
  if (hasOwn(v, 'post')) out.post = v.post
  return out
}

const noticeId = (n) => n.key + ':' + n.seq + ':' + (n.kind || 'follow') + ':' + (n.post || '')

// input: { notices (the shown notices.list rows, in order), blocked (a list
// or Set of keys, required: without it a notice could not be checked) }.
function buildAvisos (input, { fits } = {}) {
  if (!isPlain(input) || !Array.isArray(input.notices) || typeof fits !== 'function' || !iterable(input.blocked)) return null
  const blocked = keySet(input.blocked)
  const out = []
  const seen = new Set()
  for (const raw of input.notices) {
    if (out.length >= NOTICES_MAX_ROWS) break
    const n = noticeOf(raw, false)
    if (n === null || blocked.has(n.key) || seen.has(noticeId(n))) continue
    seen.add(noticeId(n))
    out.push(n)
  }
  return fitPrefix(out, (kept) => ({ notices: kept }), fits)
}

function parseAvisos (body) {
  if (!isPlain(body) || !exactKeys(body, ['notices'])) return null
  if (!Array.isArray(body.notices) || body.notices.length > NOTICES_MAX_ROWS) return null
  const notices = []
  const seen = new Set()
  for (const raw of body.notices) {
    const n = noticeOf(raw, true)
    if (n === null || seen.has(noticeId(n))) return null
    seen.add(noticeId(n))
    notices.push(n)
  }
  return { notices }
}

// A notice's key is the OTHER person; the owner's own key never removes one.
function withoutAuthorsAvisos (body, keys, { owner } = {}) {
  if (!isPlain(body) || !Array.isArray(body.notices)) return null
  const drop = keySet(keys)
  if (typeof owner === 'string') drop.delete(owner.toLowerCase())
  return { notices: body.notices.filter((n) => !drop.has(n.key)) }
}

export const avisosCodec = Object.freeze({
  KIND: 'avisos',
  maxBytes: NOTICES_MAX_BYTES,
  maxAgeMs: PRIVATE_SNAPSHOT_MAX_AGE_MS,
  build: buildAvisos,
  parse: parseAvisos,
  withoutAuthors: withoutAuthorsAvisos
})

// ---- 'conversas'

function dmRowOf (v, strict) {
  if (!isPlain(v) || (strict && !exactKeys(v, DM_ROW_KEYS))) return null
  if (!isHex64(v.peer) || (v.folder !== 'inbox' && v.folder !== 'request')) return null
  if (typeof v.preview !== 'string' || v.preview.length > MAX_PREVIEW_UNITS || !isAt(v.at)) return null
  if (typeof v.unread !== 'boolean' || typeof v.mine !== 'boolean') return null
  return { peer: v.peer, folder: v.folder, preview: v.preview, at: v.at, unread: v.unread, mine: v.mine }
}

// Building: only a row that says it is a private group (a Conversas group
// row with `visibility`); a public group's name lives in 'conversasGrupos'.
function groupNameOf (v, strict) {
  if (!isPlain(v)) return null
  if (strict) {
    if (!exactKeys(v, GROUP_NAME_KEYS) || !isHex64(v.group) || !isName(v.name)) return null
    return { group: v.group, name: v.name }
  }
  if (v.visibility !== 'private' || !isHex64(v.group)) return null
  const label = typeof v.title === 'string' && v.title !== '' ? v.title : v.name
  const name = typeof label === 'string' && label.length <= MAX_NAME_UNITS ? label : null
  return { group: v.group, name }
}

function uniqueList (list, max, rowOf, idOf, strict) {
  const out = []
  const seen = new Set()
  for (const raw of list) {
    if (out.length >= max) break
    const row = rowOf(raw, strict)
    if (row === null || seen.has(idOf(row))) {
      if (strict) return null
      continue
    }
    seen.add(idOf(row))
    out.push(row)
  }
  return out
}

// input: { rows (the dm.list rows shown, in order), groups (Conversas group
// rows with `visibility`), blocked (a list or Set of peers to leave out;
// without it nothing is built) }.
// Rows are cut from the end first, then groups, until fits(body).
function buildConversas (input, { fits } = {}) {
  if (!isPlain(input) || !Array.isArray(input.rows) || !Array.isArray(input.groups) || typeof fits !== 'function' || !iterable(input.blocked)) return null
  const blocked = keySet(input.blocked)
  const shown = input.rows.filter((r) => !(isPlain(r) && blocked.has(r.peer)))
  const rows = uniqueList(shown, CONVERSAS_MAX_ROWS, dmRowOf, (r) => r.peer, false)
  const groups = uniqueList(input.groups, CONVERSAS_MAX_GROUPS, groupNameOf, (g) => g.group, false)
  const whole = fitPrefix(rows, (kept) => ({ rows: kept, groups }), fits)
  if (whole !== null) return whole
  return fitPrefix(groups, (kept) => ({ rows: [], groups: kept }), fits)
}

function parseConversas (body) {
  if (!isPlain(body) || !exactKeys(body, ['rows', 'groups'])) return null
  if (!Array.isArray(body.rows) || body.rows.length > CONVERSAS_MAX_ROWS) return null
  if (!Array.isArray(body.groups) || body.groups.length > CONVERSAS_MAX_GROUPS) return null
  const rows = uniqueList(body.rows, CONVERSAS_MAX_ROWS, dmRowOf, (r) => r.peer, true)
  const groups = uniqueList(body.groups, CONVERSAS_MAX_GROUPS, groupNameOf, (g) => g.group, true)
  if (rows === null || groups === null) return null
  return { rows, groups }
}

function withoutAuthorsConversas (body, keys) {
  if (!isPlain(body) || !Array.isArray(body.rows) || !Array.isArray(body.groups)) return null
  const drop = keySet(keys)
  return { rows: body.rows.filter((r) => !drop.has(r.peer)), groups: body.groups }
}

export const conversasCodec = Object.freeze({
  KIND: 'conversas',
  maxBytes: CONVERSAS_MAX_BYTES,
  maxAgeMs: PRIVATE_SNAPSHOT_MAX_AGE_MS,
  build: buildConversas,
  parse: parseConversas,
  withoutAuthors: withoutAuthorsConversas
})

// ---- media stub, card and reactions shared by 'mensagens' and 'grupoMensagens'

// A DM item or a group item (public descriptor or decrypted private item) as
// the stub { mime, w, h, ms? }: enough to lay the row out, nothing to fetch
// or open it with. A private group item's real type is its plainMime.
function stubOf (v, strict) {
  if (!isPlain(v)) return null
  if (strict && !shapeOk(v, STUB_REQUIRED, STUB_OPTIONAL)) return null
  const mime = !strict && typeof v.plainMime === 'string' ? v.plainMime : v.mime
  const w = strict || hasOwn(v, 'w') ? v.w : v.width
  const h = strict || hasOwn(v, 'h') ? v.h : v.height
  const withMs = hasOwn(v, 'ms') && (strict || Number.isSafeInteger(v.ms))
  if (typeof mime !== 'string' || !MIME.test(mime) || !isDim(w) || !isDim(h)) return null
  if (withMs && !(Number.isSafeInteger(v.ms) && v.ms >= 0 && v.ms <= MAX_MEDIA_MS)) return null
  const out = { mime, w, h }
  if (withMs) out.ms = v.ms
  return out
}

// -> { ok, value }. `unavailable`: a dm.thread message may say its blob is
// gone ({ unavailable: true }), a group item never does.
function stubsOf (v, strict, unavailable) {
  if (v === null) return { ok: true, value: null }
  if (unavailable && isPlain(v) && exactKeys(v, ['unavailable']) && v.unavailable === true) return { ok: true, value: { unavailable: true } }
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_MEDIA_PER_POST) return { ok: false }
  const out = []
  for (const item of v) {
    const stub = stubOf(item, strict)
    if (stub === null) return { ok: false }
    out.push(stub)
  }
  return { ok: true, value: out }
}

// A card is kept without its image: the thumbnail is a media item too.
function cardField (v, strict) {
  if (v === null || (!strict && v === undefined)) return { ok: true, value: null }
  if (!isPlain(v)) return { ok: false }
  if (strict && v.image !== null) return { ok: false }
  return cardOf(strict ? v : { url: v.url, host: v.host, title: v.title, desc: v.desc, image: null })
}

// -> { ok, value }; value undefined when the row has none.
function reactionsOf (v, strict, max, withCount) {
  if (v === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(v) || v.length < 1 || v.length > max) return { ok: false }
  const keys = withCount ? ['emoji', 'count', 'mine'] : ['emoji', 'mine']
  const out = []
  for (const r of v) {
    if (!isPlain(r) || (strict && !exactKeys(r, keys))) return { ok: false }
    if (!isEmoji(r.emoji) || typeof r.mine !== 'boolean') return { ok: false }
    if (withCount && !(Number.isSafeInteger(r.count) && r.count >= 1)) return { ok: false }
    out.push(withCount ? { emoji: r.emoji, count: r.count, mine: r.mine } : { emoji: r.emoji, mine: r.mine })
  }
  return { ok: true, value: out }
}

// The shared map of per-peer or per-group entries. `entryOf(raw, savedAt)`
// gives the canonical entry or null. Expired, blocked or invalid entries are
// left out, the newest saves first, at most `max`. -> [[key, entry]].
function liveEntries (map, { now, max, skip, entryOf }) {
  if (!isPlain(map)) return []
  const out = []
  for (const [k, e] of Object.entries(map)) {
    if (!isHex64(k) || skip(k) || !isPlain(e) || !fresh(e.savedAt, now)) continue
    const entry = entryOf(e, e.savedAt)
    if (entry !== null) out.push([k, entry])
  }
  out.sort((a, b) => b[1].savedAt - a[1].savedAt)
  return out.slice(0, max)
}

// ---- 'mensagens'

function messageOf (v, strict) {
  if (!isPlain(v) || (strict && !shapeOk(v, MESSAGE_REQUIRED, MESSAGE_OPTIONAL))) return null
  if (!isHex32(v.id) || !isHex64(v.from) || !isText(v.text) || !(v.replyTo === null || isHex32(v.replyTo))) return null
  if ((v.fwd !== 0 && v.fwd !== 1) || !isAt(v.at) || typeof v.mine !== 'boolean') return null
  if (hasOwn(v, 'replyFrom') && !isHex64(v.replyFrom)) return null
  if (hasOwn(v, 'replyMissing') && v.replyMissing !== true) return null
  if (hasOwn(v, 'moment') && !isSeq(v.moment)) return null
  if (hasOwn(v, 'reactable') && v.reactable !== false) return null
  const media = stubsOf(v.media, strict, true)
  const card = cardField(v.card, strict)
  const reactions = reactionsOf(v.reactions, strict, DM_REACTIONS_MAX, false)
  if (!media.ok || !card.ok || !reactions.ok) return null
  const out = { id: v.id, from: v.from, text: v.text, replyTo: v.replyTo }
  if (hasOwn(v, 'replyFrom')) out.replyFrom = v.replyFrom
  if (hasOwn(v, 'replyMissing')) out.replyMissing = true
  Object.assign(out, { fwd: v.fwd, at: v.at, mine: v.mine, media: media.value, card: card.value })
  if (hasOwn(v, 'moment')) out.moment = v.moment
  if (hasOwn(v, 'reactable')) out.reactable = false
  if (reactions.value !== undefined) out.reactions = reactions.value
  return out
}

const messageId = (m) => m.from + ':' + m.id

// A dm.thread page (oldest first) as one entry: the newest
// MESSAGES_MAX_PER_THREAD messages, then the oldest cut until the entry is
// within THREAD_MAX_BYTES.
function threadEntry (messages, savedAt, strict) {
  if (!Array.isArray(messages) || (strict && messages.length > MESSAGES_MAX_PER_THREAD)) return null
  const list = []
  const seen = new Set()
  for (const raw of messages) {
    const m = messageOf(raw, strict)
    if (m === null || seen.has(messageId(m))) {
      if (strict) return null
      continue
    }
    seen.add(messageId(m))
    list.push(m)
  }
  if (strict) {
    const entry = { savedAt, messages: list }
    return bytesOf(entry) <= THREAD_MAX_BYTES ? entry : null
  }
  for (let start = Math.max(0, list.length - MESSAGES_MAX_PER_THREAD); start <= list.length; start++) {
    const entry = { savedAt, messages: list.slice(start) }
    if (bytesOf(entry) <= THREAD_MAX_BYTES) return entry
  }
  return null
}

const looseThread = (e, savedAt) => threadEntry(e.messages, savedAt, false)

// `body` with the thread of `peer` saved now from `messages` (a dm.thread
// page, oldest first); only that entry is renewed. -> a body or null.
export function putThread (body, peer, messages, now) {
  if (!isHex64(peer) || !Array.isArray(messages) || !Number.isSafeInteger(now) || now < 0) return null
  const entry = threadEntry(messages, now, false)
  if (entry === null) return null
  const threads = isPlain(body) ? body.threads : null
  const others = liveEntries(threads, { now, max: MESSAGES_MAX_PEERS - 1, skip: (k) => k === peer, entryOf: looseThread })
  return { threads: Object.fromEntries([[peer, entry]].concat(others)) }
}

export function removeThread (body, peer) {
  if (!isPlain(body) || !isPlain(body.threads)) return null
  return { threads: Object.fromEntries(Object.entries(body.threads).filter(([k]) => k !== peer)) }
}

// input: { previous (the stored body or null), peer and messages (the page
// to save now, optional), blocked (a list or Set of keys, required) }. The
// thread saved longest ago leaves first when over the count or the bytes.
function buildMensagens (input, { fits, now } = {}) {
  if (!isPlain(input) || typeof fits !== 'function' || !iterable(input.blocked) || !Number.isSafeInteger(now)) return null
  let base = isPlain(input.previous) ? input.previous : null
  if (input.peer !== undefined) {
    base = putThread(base, input.peer, input.messages, now)
    if (base === null) return null
  }
  const blocked = keySet(input.blocked)
  const list = liveEntries(base === null ? null : base.threads, { now, max: MESSAGES_MAX_PEERS, skip: (k) => blocked.has(k), entryOf: looseThread })
  return fitPrefix(list, (kept) => ({ threads: Object.fromEntries(kept) }), fits)
}

// Strict: an unknown key, a key or nonce anywhere, or a thread over its caps
// fails the whole body; an expired thread is dropped.
function parseMensagens (body, { now } = {}) {
  if (!isPlain(body) || !exactKeys(body, ['threads']) || !isPlain(body.threads) || hasSecret(body)) return null
  const entries = Object.entries(body.threads)
  if (entries.length > MESSAGES_MAX_PEERS) return null
  const threads = {}
  for (const [peer, e] of entries) {
    if (!isHex64(peer) || !isPlain(e) || !exactKeys(e, ENTRY_THREAD_KEYS)) return null
    if (!Number.isSafeInteger(e.savedAt) || e.savedAt < 0) return null
    const entry = threadEntry(e.messages, e.savedAt, true)
    if (entry === null) return null
    if (fresh(entry.savedAt, now)) threads[peer] = entry
  }
  return { threads }
}

function withoutAuthorsMensagens (body, keys, { now } = {}) {
  if (!isPlain(body) || !isPlain(body.threads)) return null
  const drop = keySet(keys)
  const threads = {}
  for (const [peer, e] of Object.entries(body.threads)) {
    if (!drop.has(peer) && isPlain(e) && fresh(e.savedAt, now)) threads[peer] = e
  }
  return { threads }
}

export const mensagensCodec = Object.freeze({
  KIND: 'mensagens',
  maxBytes: MESSAGES_MAX_BYTES,
  maxAgeMs: PRIVATE_SNAPSHOT_MAX_AGE_MS,
  build: buildMensagens,
  parse: parseMensagens,
  withoutAuthors: withoutAuthorsMensagens
})

// ---- 'grupoMensagens'

function groupItemOf (v, strict) {
  if (!isPlain(v) || (strict && !shapeOk(v, ITEM_REQUIRED, ITEM_OPTIONAL))) return null
  if (!isHex64(v.writer) || !isHex64(v.diary) || !isSeq(v.seq) || !isAt(v.at) || !isText(v.text)) return null
  if ((v.fwd !== 0 && v.fwd !== 1) || typeof v.hidden !== 'boolean') return null
  const loose = (x) => (x === undefined && !strict ? null : x)
  const name = loose(v.name)
  const username = loose(v.username)
  if (!isName(name) || !isUsername(username)) return null
  let replyTo = null
  if (v.replyTo !== null) {
    if (!isPlain(v.replyTo) || !isHex64(v.replyTo.writer) || !isSeq(v.replyTo.seq)) return null
    if (strict && !exactKeys(v.replyTo, ['writer', 'seq'])) return null
    replyTo = { writer: v.replyTo.writer, seq: v.replyTo.seq }
  }
  const media = stubsOf(v.media, strict, false)
  const card = cardField(v.card, strict)
  const reactions = reactionsOf(v.reactions, strict, GROUP_REACTIONS_MAX, true)
  if (!media.ok || !card.ok || !reactions.ok) return null
  const out = { writer: v.writer, diary: v.diary, seq: v.seq, at: v.at, text: v.text, replyTo, fwd: v.fwd, media: media.value, card: card.value, hidden: v.hidden, name, username }
  if (reactions.value !== undefined) out.reactions = reactions.value
  return out
}

const itemId = (i) => i.writer + ':' + i.seq

// A group.read page (newest first) as one entry: the newest
// GROUP_MESSAGES_MAX_ITEMS items, then the oldest cut until the entry is
// within GROUP_ENTRY_MAX_BYTES. `blocked` diaries are left out.
function groupEntry (items, savedAt, strict, blocked) {
  if (!Array.isArray(items) || (strict && items.length > GROUP_MESSAGES_MAX_ITEMS)) return null
  const list = []
  const seen = new Set()
  for (const raw of items) {
    if (list.length >= GROUP_MESSAGES_MAX_ITEMS) break
    const item = groupItemOf(raw, strict)
    if (item === null || seen.has(itemId(item))) {
      if (strict) return null
      continue
    }
    if (blocked && blocked.has(item.diary)) continue
    seen.add(itemId(item))
    list.push(item)
  }
  if (strict) {
    const entry = { savedAt, items: list }
    return bytesOf(entry) <= GROUP_ENTRY_MAX_BYTES ? entry : null
  }
  for (let n = list.length; n >= 0; n--) {
    const entry = { savedAt, items: list.slice(0, n) }
    if (bytesOf(entry) <= GROUP_ENTRY_MAX_BYTES) return entry
  }
  return null
}

// `body` with the page of `group` saved now from `items` (a group.read
// page, newest first); only that entry is renewed. -> a body or null.
export function putGroup (body, group, items, now) {
  if (!isHex64(group) || !Array.isArray(items) || !Number.isSafeInteger(now) || now < 0) return null
  const entry = groupEntry(items, now, false, null)
  if (entry === null) return null
  const groups = isPlain(body) ? body.groups : null
  const others = liveEntries(groups, { now, max: GROUP_MESSAGES_MAX_GROUPS - 1, skip: (k) => k === group, entryOf: (e, savedAt) => groupEntry(e.items, savedAt, false, null) })
  return { groups: Object.fromEntries([[group, entry]].concat(others)) }
}

export function removeGroup (body, group) {
  if (!isPlain(body) || !isPlain(body.groups)) return null
  return { groups: Object.fromEntries(Object.entries(body.groups).filter(([k]) => k !== group)) }
}

// `body` without the groups missing from `groups` (every group id the member
// still reads, from a complete list). -> a body, or null for a bad input.
export function keepGroups (body, groups) {
  if (!isPlain(body) || !isPlain(body.groups) || !iterable(groups)) return null
  const keep = new Set(groups)
  return { groups: Object.fromEntries(Object.entries(body.groups).filter(([k]) => keep.has(k))) }
}

// input: { previous (the stored body or null), group and items (the page to
// save now, optional), blocked (a list or Set of diary keys, required) }. A
// block names member diaries, so items go by `diary`, not by writer. The
// group saved longest ago leaves first when over the count or the bytes.
function buildGrupoMensagens (input, { fits, now } = {}) {
  if (!isPlain(input) || typeof fits !== 'function' || !iterable(input.blocked) || !Number.isSafeInteger(now)) return null
  let base = isPlain(input.previous) ? input.previous : null
  if (input.group !== undefined) {
    base = putGroup(base, input.group, input.items, now)
    if (base === null) return null
  }
  const blocked = keySet(input.blocked)
  const list = liveEntries(base === null ? null : base.groups, { now, max: GROUP_MESSAGES_MAX_GROUPS, skip: () => false, entryOf: (e, savedAt) => groupEntry(e.items, savedAt, false, blocked) })
  return fitPrefix(list, (kept) => ({ groups: Object.fromEntries(kept) }), fits)
}

function parseGrupoMensagens (body, { now } = {}) {
  if (!isPlain(body) || !exactKeys(body, ['groups']) || !isPlain(body.groups) || hasSecret(body)) return null
  const entries = Object.entries(body.groups)
  if (entries.length > GROUP_MESSAGES_MAX_GROUPS) return null
  const groups = {}
  for (const [group, e] of entries) {
    if (!isHex64(group) || !isPlain(e) || !exactKeys(e, ENTRY_GROUP_KEYS)) return null
    if (!Number.isSafeInteger(e.savedAt) || e.savedAt < 0) return null
    const entry = groupEntry(e.items, e.savedAt, true, null)
    if (entry === null) return null
    if (fresh(entry.savedAt, now)) groups[group] = entry
  }
  return { groups }
}

function withoutAuthorsGrupoMensagens (body, keys, { now } = {}) {
  if (!isPlain(body) || !isPlain(body.groups)) return null
  const drop = keySet(keys)
  const groups = {}
  for (const [group, e] of Object.entries(body.groups)) {
    if (!isPlain(e) || !Array.isArray(e.items) || !fresh(e.savedAt, now)) continue
    groups[group] = { savedAt: e.savedAt, items: e.items.filter((i) => !drop.has(i.diary)) }
  }
  return { groups }
}

export const grupoMensagensCodec = Object.freeze({
  KIND: 'grupoMensagens',
  maxBytes: GROUP_MESSAGES_MAX_BYTES,
  maxAgeMs: PRIVATE_SNAPSHOT_MAX_AGE_MS,
  build: buildGrupoMensagens,
  parse: parseGrupoMensagens,
  withoutAuthors: withoutAuthorsGrupoMensagens
})
