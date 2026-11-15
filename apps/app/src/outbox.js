// The outbox ('fila de saída') of the browser node: posts and replies written
// while the node could not publish, kept on the device and sent later through
// the same RPC methods (post.create / post.reply). This module is the pure
// data layer: every function returns new arrays and never mutates its inputs.
// It has no imports and touches no browser global, so Node tests can load it.
//
// Sending is claim-before-send and reconcile-before-resend: an item is
// claimed ('sending', with the diary's highest seq as its floor) before the
// request goes out, and a 'sending' item found later (after a reload, or a
// request that never resolved) is reconciled against the diary before
// anything is sent again. The node appends before it pushes to the seeder,
// so a request that did not resolve may still have written the post.
//
// Ownership is strict: only a block appended DURING this attempt counts as
// sent (the diary stamps `at` at append time, right after the claim, and the
// request gives up after 30 s), so an identical post replicated from another
// device above the floor by the write gate's catch-up, earlier or later than
// the attempt, is never taken for this send. Net guarantee: reconcile never
// silently deletes a post that was not appended in this attempt (except an
// identical post by the same identity appended inside the attempt's own
// window) and never makes a resend possible while an append may exist.
//
// Item v2 stores the target and the text only inside `box`, sealed by the
// node (outbox.seal) with a key derived from the passkey over the id, author,
// association, kind and writtenAt too: storage and backups never hold the
// text in the clear, and an item planted or altered in storage fails to open.
// An open item is a v2 item with `to` and `text` added in memory from
// outbox.open (hydrate); serializeOutbox never writes them. A v1 item (clear
// `to` and `text`) is still parsed and kept as is until it is sealed after an
// unlock (sealedItem). An item merged from an older build's storage key may
// carry `migrated` (./outboxMigrate), which only ever makes it wait.

export const OUTBOX_MAX = 50
export const MAX_TEXT = 1000
export const GATE_MESSAGE = 'sincronize com o semeador antes de publicar'
export const LOCKED_MESSAGE = 'identidade bloqueada: entre com a passkey'
export const BUSY_MESSAGE = 'sincronização já em andamento'
export const CLOSED_MESSAGE = 'conexão encerrada'
export const NO_NODE_MESSAGE = 'sem conexão com o nó'
export const SESSION_CLOSED_MESSAGE = 'sessão encerrada'
export const TOO_MANY_MESSAGE = 'pedidos demais em andamento'
export const UNCERTAIN_MESSAGE = 'incerto: pode ter sido aplicado; confira antes de repetir'
export const RETRY_BASE_MS = 30000
export const RETRY_CAP_MS = 300000
// A block dated this long before the claim may still be this attempt's append
// (the same window screens/Publicar.js uses for its own reconciliation).
export const MATCH_SLACK_MS = 2000
// ...and at most this long after it: the request (write gate, append, push)
// times out after 30 s (packages/rpc/lib/limits.js), so a later block was not
// appended by this attempt (an abandoned claim, then the same text published
// from another device).
export const ATTEMPT_WINDOW_MS = 60000
// base64url (no padding) of nonce (24 bytes) || secretbox (16-byte MAC and
// the JSON payload). The upper bound is the node's (packages/rpc
// OUTBOX_BOX_MAX: 6 bytes per text char, a lone surrogate as \udXXX, plus
// 512 for the fixed fields); the lower one is the node's too
// (packages/web-member/lib/outbox-seal.js openOutbox refuses 40 bytes or
// fewer): 41 bytes are 55 characters.
export const BOX_MIN = 55
export const BOX_MAX = Math.ceil((24 + 16 + 6 * MAX_TEXT + 512) * 4 / 3)
// The node's bound on writtenAt (packages/rpc/lib/methods.js MAX_ISO).
export const WRITTEN_AT_MAX = 32
// A `migrated` mark longer than this is dropped when read.
export const MIGRATED_MAX = 128

const FULL_MESSAGE = 'Muitas publicações aguardando envio: envie ou apague algumas.'
const INVALID_MESSAGE = 'publicação inválida'
const TIME_MESSAGE = 'instante inválido'

const HEX64 = /^[0-9a-f]{64}$/
const ID = /^[0-9a-f]{16}$/
const REPLY_TO = /^[0-9a-f]{64}:([1-9][0-9]*)$/
const BASE64URL = /^[A-Za-z0-9_-]+$/
const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const KINDS = ['post', 'reply']
const STATES = ['queued', 'sending', 'uncertain', 'failed']
// Failures after which nothing was written: the item is retried later.
const RETRY_MESSAGES = [GATE_MESSAGE, LOCKED_MESSAGE, BUSY_MESSAGE, CLOSED_MESSAGE, NO_NODE_MESSAGE, SESSION_CLOSED_MESSAGE, TOO_MANY_MESSAGE]

// Mirror of packages/core/lib/records.js isForbiddenChar(cp, allowLf = true)
// (this module stays a leaf, so it cannot import it): C0 controls except LF,
// DEL and C1 (U+007F-U+009F), the separators U+2028 and U+2029 and the bidi
// controls U+202A-U+202E and U+2066-U+2069. The outbox refuses at enqueue
// time the text the diary itself refuses, so a queued post is never stuck.
function isForbiddenChar (cp) {
  if (cp < 0x20) return cp !== 0x0a
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp === 0x2028 || cp === 0x2029) return true
  if (cp >= 0x202a && cp <= 0x202e) return true
  return cp >= 0x2066 && cp <= 0x2069
}

function validText (text) {
  if (typeof text !== 'string') return false
  const chars = Array.from(text)
  if (chars.length < 1 || chars.length > MAX_TEXT) return false
  return !chars.some((ch) => isForbiddenChar(ch.codePointAt(0)))
}

// A post has no target; a reply targets 'author:seq' (lowercase hex author,
// a seq the node reads as a safe integer, like packages/rpc isRef).
function validTarget (kind, to) {
  if (kind === 'post') return to === null
  if (typeof to !== 'string') return false
  const m = REPLY_TO.exec(to)
  return m !== null && Number.isSafeInteger(Number(m[1]))
}

// What the node's validator and Date.parse both accept.
function validWrittenAt (value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= WRITTEN_AT_MAX && !Number.isNaN(Date.parse(value))
}

function isTime (value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validFloor (value) {
  return Number.isInteger(value) && value >= -1
}

// The only spelling of its bytes: the node opens a box only when
// toBase64Url(fromBase64Url(box)) === box, i.e. no length that is 1 modulo 4
// and no set bits after the last whole byte.
function canonicalBase64Url (box) {
  const tail = box.length % 4
  if (tail === 1) return false
  if (tail === 0) return true
  const last = BASE64URL_CHARS.indexOf(box[box.length - 1])
  return (last & (tail === 2 ? 0x0f : 0x03)) === 0
}

export function validBox (box) {
  return typeof box === 'string' && box.length >= BOX_MIN && box.length <= BOX_MAX && BASE64URL.test(box) && canonicalBase64Url(box)
}

// The item as stored, or null when any field is malformed. A v2 item keeps
// only `box`: a `to` or `text` next to it in storage is ignored.
function reviveItem (raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.v !== 1 && raw.v !== 2) return null
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return null
  if (typeof raw.author !== 'string' || !HEX64.test(raw.author)) return null
  if (typeof raw.association !== 'string' || !HEX64.test(raw.association)) return null
  if (!KINDS.includes(raw.kind)) return null
  if (raw.v === 1) {
    if (!validTarget(raw.kind, raw.to)) return null
    if (!validText(raw.text)) return null
  } else if (!validBox(raw.box)) {
    return null
  }
  if (!validWrittenAt(raw.writtenAt)) return null
  if (!STATES.includes(raw.state)) return null
  if (!Number.isInteger(raw.attempts) || raw.attempts < 0) return null
  if (!isTime(raw.nextAt)) return null
  if (raw.floorSeq !== null && !validFloor(raw.floorSeq)) return null
  if (raw.attemptAt !== null && !isTime(raw.attemptAt)) return null
  if (typeof raw.lastError !== 'string') return null
  const item = {
    v: raw.v,
    id: raw.id,
    author: raw.author,
    association: raw.association,
    kind: raw.kind,
    ...(raw.v === 1 ? { to: raw.to, text: raw.text } : { box: raw.box }),
    writtenAt: raw.writtenAt,
    state: raw.state,
    attempts: raw.attempts,
    nextAt: raw.nextAt,
    floorSeq: raw.floorSeq,
    attemptAt: raw.attemptAt,
    lastError: raw.lastError
  }
  // A malformed mark is dropped, not the item.
  if (typeof raw.migrated === 'string' && raw.migrated.length <= MIGRATED_MAX) item.migrated = raw.migrated
  // A 'sending' item without a floor cannot be reconciled (claim always sets
  // one): it may have been written, so it is never resent automatically.
  if (item.state === 'sending' && item.floorSeq === null) {
    item.state = 'uncertain'
    item.lastError = UNCERTAIN_MESSAGE
  }
  return item
}

// The valid items of the stored JSON text { v: 2, items } (or { v: 1, items }
// written before the seal; each item carries its own version). Never throws.
export function parseOutbox (text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  if (data === null || typeof data !== 'object' || (data.v !== 1 && data.v !== 2) || !Array.isArray(data.items)) return []
  const items = []
  for (const raw of data.items) {
    const item = reviveItem(raw)
    if (item !== null) items.push(item)
  }
  return items
}

// The item as it may be stored: a v2 item without the opened `to` and `text`.
export function storedItem (item) {
  const stored = {
    v: item.v,
    id: item.id,
    author: item.author,
    association: item.association,
    kind: item.kind,
    ...(item.v === 1 ? { to: item.to, text: item.text } : { box: item.box }),
    writtenAt: item.writtenAt,
    state: item.state,
    attempts: item.attempts,
    nextAt: item.nextAt,
    floorSeq: item.floorSeq,
    attemptAt: item.attemptAt,
    lastError: item.lastError
  }
  if (typeof item.migrated === 'string') stored.migrated = item.migrated
  return stored
}

export function serializeOutbox (items) {
  return JSON.stringify({ v: 2, items: items.map(storedItem) })
}

// An open item, in memory only: `opened` is what outbox.open answered.
export function hydrate (item, opened) {
  return { ...item, to: opened.to, text: opened.text }
}

// What outbox.seal seals (the item's own fields, `to` and `text` included).
export function sealParams (item) {
  return { id: item.id, author: item.author, association: item.association, kind: item.kind, to: item.to, text: item.text, writtenAt: item.writtenAt }
}

// What outbox.open checks against the sealed copy.
export function openParams (item) {
  return { box: item.box, id: item.id, author: item.author, association: item.association, kind: item.kind, writtenAt: item.writtenAt }
}

// The v1 item rewritten as v2 under `box` (the one-time migration).
export function sealedItem (item, box) {
  if (!validBox(box)) throw new Error(INVALID_MESSAGE)
  const { to, text, ...rest } = storedItem(item)
  return { ...rest, v: 2, box }
}

// Throws when the draft is not a valid queued post or reply: also checked
// before the node seals it, and on what the node opens.
export function checkDraft ({ author, association, kind, to, text }) {
  const target = to === undefined ? null : to
  if (typeof author !== 'string' || !HEX64.test(author)) throw new Error(INVALID_MESSAGE)
  if (typeof association !== 'string' || !HEX64.test(association)) throw new Error(INVALID_MESSAGE)
  if (!KINDS.includes(kind)) throw new Error(INVALID_MESSAGE)
  if (!validTarget(kind, target)) throw new Error(INVALID_MESSAGE)
  if (!validText(text)) throw new Error(INVALID_MESSAGE)
}

export function writtenAtOf (now) {
  if (!isTime(now)) throw new Error(INVALID_MESSAGE)
  return new Date(now).toISOString()
}

function belongs (item, author, association) {
  return item.author === author && item.association === association
}

function update (items, id, change) {
  return items.map((item) => item.id === id ? change(item) : item)
}

// `box`: outbox.seal of exactly these fields (writtenAt = writtenAtOf(now)).
// The item is stored as v2: `to` and `text` are checked, never kept.
export function enqueue (items, { author, association, kind, to, text, box, now, id }) {
  checkDraft({ author, association, kind, to, text })
  if (!validBox(box)) throw new Error(INVALID_MESSAGE)
  if (typeof id !== 'string' || !ID.test(id)) throw new Error(INVALID_MESSAGE)
  if (!isTime(now)) throw new Error(INVALID_MESSAGE)
  if (items.filter((item) => item.author === author).length >= OUTBOX_MAX) throw new Error(FULL_MESSAGE)
  return [...items, {
    v: 2,
    id,
    author,
    association,
    kind,
    box,
    writtenAt: writtenAtOf(now),
    state: 'queued',
    attempts: 0,
    nextAt: 0,
    floorSeq: null,
    attemptAt: null,
    lastError: ''
  }]
}

// The pair's items, oldest first (a stable sort keeps the queue order on ties).
export function itemsOf (items, author, association) {
  return items
    .filter((item) => belongs(item, author, association))
    .sort((a, b) => a.writtenAt < b.writtenAt ? -1 : a.writtenAt > b.writtenAt ? 1 : 0)
}

export function sendingOf (items, author, association) {
  return itemsOf(items, author, association).find((item) => item.state === 'sending') || null
}

// Nothing is sent while an item of the pair is still 'sending' (unreconciled).
export function nextToSend (items, author, association, now) {
  if (sendingOf(items, author, association) !== null) return null
  return itemsOf(items, author, association).find((item) => item.state === 'queued' && item.nextAt <= now) || null
}

export function nextDueAt (items, author, association) {
  let due = null
  for (const item of itemsOf(items, author, association)) {
    if (item.state === 'queued' && (due === null || item.nextAt < due)) due = item.nextAt
  }
  return due
}

// floorSeq: the highest seq of the diary before the send (-1 when empty).
export function claim (items, id, { now, floorSeq }) {
  if (!validFloor(floorSeq)) throw new Error('floorSeq inválido')
  if (!isTime(now)) throw new Error(TIME_MESSAGE)
  return update(items, id, (item) => ({ ...item, state: 'sending', attemptAt: now, floorSeq }))
}

function sameTarget (record, item) {
  const replyTo = record.replyTo
  if (replyTo === null || replyTo === undefined) return item.to === null
  if (item.to === null || typeof replyTo !== 'object' || typeof replyTo.author !== 'string') return false
  return (replyTo.author.toLowerCase() + ':' + replyTo.seq) === item.to.toLowerCase()
}

// A quote is a post record carrying a non-null `quote` key. The outbox never
// queues quotes, so a quote record is never the append of a queued post or
// reply, even with identical text (Publicar's reconciliation uses the same
// rule).
export function isQuoteRecord (record) {
  return record !== null && typeof record === 'object' &&
    Object.prototype.hasOwnProperty.call(record, 'quote') && record.quote !== null && record.quote !== undefined
}

// A candidate: a post identical to the item (never a quote), above the claim
// floor. It may still be an older identical post replicated from another
// device by the write gate's catch-up, so it is not yet proof of our append.
function isCandidate (entry, item) {
  if (entry === null || typeof entry !== 'object') return false
  const record = entry.record
  if (record === null || typeof record !== 'object') return false
  if (isQuoteRecord(record)) return false
  return record.type === 'post' &&
    record.text === item.text &&
    sameTarget(record, item) &&
    Number.isInteger(entry.seq) && entry.seq > item.floorSeq
}

// Ours: appended during this attempt, i.e. dated inside the attempt's window
// [claim - MATCH_SLACK_MS, claim + ATTEMPT_WINDOW_MS]. A candidate dated
// outside it is an identical post from another device, or our own append
// under a clock that jumped: a person decides.
function isOurs (entry, item) {
  if (!isTime(item.attemptAt)) return false
  const at = Date.parse(entry.record.at)
  return at >= item.attemptAt - MATCH_SLACK_MS && at <= item.attemptAt + ATTEMPT_WINDOW_MS
}

// A whole log.read result: { entries, invalid, entriesTruncated }, where
// entriesTruncated is the smallest seq of the returned window.
function deletedAbove (entry, floorSeq) {
  return entry !== null && typeof entry === 'object' && entry.reason === 'deleted' &&
    Number.isInteger(entry.seq) && entry.seq > floorSeq
}

function validPage (page) {
  return page !== null && typeof page === 'object' && !Array.isArray(page) &&
    Array.isArray(page.entries) &&
    (page.invalid === undefined || Array.isArray(page.invalid)) &&
    Number.isInteger(page.entriesTruncated) && page.entriesTruncated >= 0
}

// page: the log.read result of the author's diary. Settles the pair's
// 'sending' item: 'sent' (our append found, removed), 'absent' (the window
// reaches back to the claim floor without it: back to 'queued') or 'unknown'
// (it may be beyond the window, or an identical post not dated within this
// attempt sits above the floor: 'uncertain', never resent and never removed
// automatically).
//
// A 'sending' item that is not open (no text yet) cannot be compared with
// the diary: 'sealed', nothing changes until it is opened.
export function reconcile (items, author, association, page, now) {
  const sending = sendingOf(items, author, association)
  if (sending === null) return { items, sent: null, status: 'none' }
  if (typeof sending.text !== 'string') return { items, sent: null, status: 'sealed' }
  const unknown = {
    items: update(items, sending.id, (item) => ({ ...item, state: 'uncertain', lastError: UNCERTAIN_MESSAGE })),
    sent: null,
    status: 'unknown'
  }
  if (!validPage(page)) return unknown
  const candidates = page.entries.filter((entry) => isCandidate(entry, sending))
  let seq = null
  for (const entry of candidates) {
    if (isOurs(entry, sending) && (seq === null || entry.seq > seq)) seq = entry.seq
  }
  if (seq !== null) {
    return {
      items: items.filter((item) => item.id !== sending.id),
      sent: { item: sending, seq, ref: author + ':' + seq },
      status: 'sent'
    }
  }
  if (candidates.length > 0) return unknown
  // A deleted slot hides what was there: it may be our append, so never requeue.
  if ((page.invalid || []).some((entry) => deletedAbove(entry, sending.floorSeq))) return unknown
  const covered = page.entriesTruncated <= sending.floorSeq + 1
  if (covered) {
    return {
      items: update(items, sending.id, (item) => ({ ...item, state: 'queued', attemptAt: null, floorSeq: null })),
      sent: null,
      status: 'absent'
    }
  }
  return unknown
}

export function retryDelayMs (attempts) {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (Math.max(1, attempts) - 1))
}

export function markRetry (items, id, { error, now }) {
  if (!isTime(now)) throw new Error(TIME_MESSAGE)
  return update(items, id, (item) => {
    const attempts = item.attempts + 1
    return { ...item, state: 'queued', attempts, lastError: String(error), attemptAt: null, nextAt: now + retryDelayMs(attempts) }
  })
}

export function markUncertain (items, id) {
  return update(items, id, (item) => ({ ...item, state: 'uncertain', lastError: UNCERTAIN_MESSAGE }))
}

export function markFailed (items, id, error) {
  return update(items, id, (item) => ({ ...item, state: 'failed', lastError: String(error) }))
}

// Manual retry. A 'sending' item is left to reconcile.
export function markQueued (items, id) {
  return update(items, id, (item) => item.state === 'sending'
    ? item
    : { ...item, state: 'queued', nextAt: 0, attempts: 0, attemptAt: null })
}

export function wake (items, author, association, now) {
  if (!isTime(now)) throw new Error(TIME_MESSAGE)
  return items.map((item) => belongs(item, author, association) && item.state === 'queued' ? { ...item, nextAt: now } : item)
}

// A 'sending' item may have been written: it stays until reconciled.
export function remove (items, id) {
  if (items.some((item) => item.id === id && item.state === 'sending')) return items
  return items.filter((item) => item.id !== id)
}

export function removeAuthor (items, author) {
  return items.filter((item) => item.author !== author)
}

export function classifyFailure (err) {
  if (err && err.uncertain === true) return 'uncertain'
  if (err && err.code === 'CLOSED') return 'retry'
  if (err && RETRY_MESSAGES.includes(err.message)) return 'retry'
  return 'fail'
}

// The RPC parameters. Never `at`: the diary date is the append time.
export function rpcParams (item) {
  if (item.kind === 'reply') return { to: item.to, text: item.text }
  return { text: item.text }
}

// The diary tip seen by a log.read result, counting invalid blocks too; -1
// when there is none or the result is malformed.
export function maxSeq (page) {
  let max = -1
  if (!validPage(page)) return max
  for (const entry of [...page.entries, ...(page.invalid || [])]) {
    if (entry && Number.isInteger(entry.seq) && entry.seq > max) max = entry.seq
  }
  return max
}

// 16 lowercase hex from 8 random bytes supplied by the caller.
export function hexId (bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 8) throw new Error('hexId: 8 bytes')
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
