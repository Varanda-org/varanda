// Recados (scraps on someone's page, with replies): the pure view model.
// Nothing here is trusted from the network. The seeder index only gives
// pointers (author, seq, the owner's follow seq for that author, the hide
// pointers and the wall pointer); the app re-reads every pointer with
// diary.peek and judges the records itself, with the same rules as the core
// fold (packages/core/lib/scraps.js, kept in step by hand: this file is ESM
// for the app and imports nothing from the core). No React, no platform
// module, no request: the caller does the reads this model plans.
//
// Reading a page takes two rounds. planPeeks gives the first (every writer's
// scrap blocks plus the owner's hide, wall and follow blocks); planReplyPeeks
// gives the second (the owner's own scraps that a reply names). Hand every
// peek read back to assemblePage; it never reads anything itself.
//
// What one peek cannot prove: the seeder names the owner's latest follow and
// wall blocks, and a superseded one (an older wall, a follow since undone)
// looks the same as the latest one, so those two pointers are trusted from
// the seeder. The one-reply-per-original rule also covers only the rows the
// seeder returned: a reply it left out cannot take the slot.
//
// Peer text is returned raw: the screen applies displayText.

const HEX64 = /^[0-9a-f]{64}$/

// Same value as PEEK_SEQS_MAX in @varanda/rpc (docs/rpc.md 5.27).
export const PEEK_BATCH_MAX = 29
export const SCRAP_TEXT_MAX = 400
// What the seeder caps per page (protocol, recados): 20 live scraps per
// writer, 500 per page. The page re-applies both, so a seeder that ignores
// the cap cannot make the app read or show more.
export const SCRAP_PER_WRITER_MAX = 20
export const SCRAP_PAGE_MAX = 500
// Hide pointers read per page.
export const SCRAP_HIDES_MAX = 1000
// A scrap dated further ahead of the reader's clock than this is not shown
// (MAX_FUTURE_MS of the core feed).
export const MAX_FUTURE_MS = 86400000

export const WALLS = Object.freeze(['following', 'everyone', 'nobody'])
export const DEFAULT_WALL = 'following'

export const NOTICES = Object.freeze({
  self: 'Você não pode deixar recado na sua própria página.',
  blocked: 'Você bloqueou esta pessoa. Desbloqueie para deixar um recado.',
  nobody: 'Esta pessoa não está recebendo recados.',
  following: 'Esta pessoa só recebe recados de quem ela segue.',
  unreachable: 'Não deu para alcançar a página agora: semeador indisponível. Tente de novo daqui a pouco.',
  indexing: 'O semeador ainda está montando esta página. Podem faltar recados por enquanto.',
  incomplete: 'A leitura ficou incompleta. Podem faltar recados nesta lista.',
  uncertain: 'Não sabemos se o recado foi enviado. Confira a página antes de enviar de novo.',
  failed: 'Não deu para enviar o recado.',
  empty: 'Escreva o recado antes de enviar.',
  tooLong: 'O recado passa de ' + SCRAP_TEXT_MAX + ' caracteres.',
  badChars: 'O recado tem um caractere que não pode ser enviado. Tire-o e tente de novo.',
  wallUnread: 'Não deu para ler quem pode deixar recados aqui. Nenhum recado é mostrado por enquanto.'
})

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isHex64 = (s) => typeof s === 'string' && HEX64.test(s)
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const keysAre = (obj, keys) => {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

function isCanonicalIso (s) {
  if (typeof s !== 'string') return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString() === s
}

// Code points, as the node counts the 400 limit (not UTF-16 units).
export function textLength (text) {
  return typeof text === 'string' ? [...text].length : 0
}

// C0 controls (LF allowed), DEL, C1, U+2028/9 and the bidi controls: the same
// set the node refuses in a text (records.js isForbiddenChar).
function forbiddenChar (cp) {
  if (cp < 0x20) return cp !== 0x0a
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp === 0x2028 || cp === 0x2029) return true
  return (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
}

function wellFormed (s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false
    }
  }
  return true
}

export function validScrapText (text) {
  if (typeof text !== 'string') return false
  const n = textLength(text)
  if (n < 1 || n > SCRAP_TEXT_MAX || !wellFormed(text)) return false
  for (const ch of text) if (forbiddenChar(ch.codePointAt(0))) return false
  return true
}

const validTarget = (r) => isObject(r) && keysAre(r, ['author', 'seq']) && isHex64(r.author) && isSeq(r.seq)

// A scrap record as the node would accept it, or null.
function scrapOf (record) {
  if (!isObject(record) || record.type !== 'scrap' || !keysAre(record, ['type', 'to', 'text', 'replyTo', 'at'])) return null
  if (!isHex64(record.to) || !(record.replyTo === null || validTarget(record.replyTo))) return null
  if (!validScrapText(record.text) || !isCanonicalIso(record.at)) return null
  return record
}

const hideOf = (r) => isObject(r) && r.type === 'scrap-hide' && keysAre(r, ['type', 'from', 'seq', 'at']) && isHex64(r.from) && isSeq(r.seq) && isCanonicalIso(r.at) ? r : null
const wallOfRecord = (r) => isObject(r) && r.type === 'scrap-wall' && keysAre(r, ['type', 'who', 'at']) && WALLS.includes(r.who) && isCanonicalIso(r.at) ? r : null
const followOf = (r) => isObject(r) && r.type === 'follow' && keysAre(r, ['type', 'key', 'on', 'at']) && isHex64(r.key) && typeof r.on === 'boolean' && isCanonicalIso(r.at) ? r : null

// ---- the index answer -----------------------------------------------------

const seqOf = (v) => isSeq(v) ? v : isObject(v) && isSeq(v.seq) ? v.seq : null

// index: the /index/scraps/<owner> answer, any extra field ignored:
//   rows     [{ author, seq, followSeq? }]  pointers, in index order
//   hides    [seq | { seq }]                the owner's scrap-hide blocks
//   wall     seq | null                     the owner's latest scrap-wall block
//   indexing, complete                      the honesty flags (complete is boolean)
// An answer that is not an object, has no rows array or no boolean complete
// is not a page: `valid` is false and nothing is read from it. isBlocked
// drops a blocked writer's pointers first, so they are never planned,
// peeked or counted as unread. keepBlocked (the owner reading their own
// page) keeps them: the owner must be able to remove a blocked person's
// recado, so those rows are peeked as usual and marked blocked by assemblePage.
export function readPointers (index, owner, isBlocked, keepBlocked = false) {
  const src = isObject(index) ? index : {}
  const valid = isObject(index) && Array.isArray(src.rows) && typeof src.complete === 'boolean'
  const blocked = typeof isBlocked === 'function' && keepBlocked !== true ? (key) => isBlocked(key) === true : () => false
  const perWriter = new Map()
  const seen = new Set()
  const listed = []
  for (const row of valid ? src.rows : []) {
    if (!isObject(row) || !isHex64(row.author) || row.author === owner || !isSeq(row.seq) || blocked(row.author)) continue
    const ref = row.author + ':' + row.seq
    if (seen.has(ref)) continue
    seen.add(ref)
    const item = { author: row.author, seq: row.seq, followSeq: isSeq(row.followSeq) ? row.followSeq : null }
    listed.push(item)
    const list = perWriter.get(row.author) || []
    list.push(item.seq)
    perWriter.set(row.author, list)
  }
  // 20 per writer (that writer's highest seqs), then 500 in index order.
  const allowed = new Map()
  for (const [author, seqs] of perWriter) allowed.set(author, new Set(seqs.sort((a, b) => b - a).slice(0, SCRAP_PER_WRITER_MAX)))
  const rows = listed.filter((r) => allowed.get(r.author).has(r.seq)).slice(0, SCRAP_PAGE_MAX)
  const allHides = [...new Set((valid && Array.isArray(src.hides) ? src.hides : []).map(seqOf).filter((n) => n !== null))]
  const wallGiven = valid && src.wall !== null && src.wall !== undefined
  return {
    valid,
    rows,
    hides: allHides.slice(0, SCRAP_HIDES_MAX),
    hidesCut: allHides.length > SCRAP_HIDES_MAX,
    wall: wallGiven && isSeq(src.wall) ? src.wall : null,
    wallBad: wallGiven && !isSeq(src.wall),
    indexing: valid && src.indexing === true,
    complete: valid && src.complete === true
  }
}

// ---- reading peeks --------------------------------------------------------

function peeksOf (peeks, author) {
  let v
  if (peeks instanceof Map) v = peeks.get(author)
  else if (isObject(peeks) && Object.prototype.hasOwnProperty.call(peeks, author)) v = peeks[author]
  if (v === undefined || v === null) return []
  return (Array.isArray(v) ? v : [v]).filter((p) => isObject(p) && p.key === author)
}

// One author's reads: live records by seq and the seqs the node judged
// invalid.
function readOf (peeks, author) {
  const list = peeksOf(peeks, author)
  const live = new Map()
  const invalid = new Set()
  for (const p of list) {
    for (const e of Array.isArray(p.entries) ? p.entries : []) {
      if (isObject(e) && isSeq(e.seq) && isObject(e.record) && !live.has(e.seq)) live.set(e.seq, e.record)
    }
    for (const s of Array.isArray(p.invalid) ? p.invalid : []) if (isSeq(s)) invalid.add(s)
  }
  return { live, invalid }
}

// Strictly ascending diary.peek params of at most PEEK_BATCH_MAX seqs.
export function peekBatches (author, seqs) {
  const sorted = [...new Set(seqs.filter(isSeq))].sort((a, b) => a - b)
  const out = []
  for (let i = 0; i < sorted.length; i += PEEK_BATCH_MAX) out.push({ author, seqs: sorted.slice(i, i + PEEK_BATCH_MAX) })
  return out
}

// Round one: [{ author, seqs }] peek params. Writers' scrap blocks and the
// owner's hide, wall and follow blocks. Empty when the owner is not a key or
// the index is not a page. Blocked writers are left out, except on the
// reader's own page (self === owner).
export function planPeeks (index, owner, isBlocked, self = null) {
  if (!isHex64(owner)) return []
  const p = readPointers(index, owner, isBlocked, self === owner)
  const byWriter = new Map()
  const ownerSeqs = [...p.hides]
  if (p.wall !== null) ownerSeqs.push(p.wall)
  for (const r of p.rows) {
    if (!byWriter.has(r.author)) byWriter.set(r.author, [])
    byWriter.get(r.author).push(r.seq)
    if (r.followSeq !== null) ownerSeqs.push(r.followSeq)
  }
  let out = []
  for (const [author, seqs] of byWriter) out = out.concat(peekBatches(author, seqs))
  return out.concat(peekBatches(owner, ownerSeqs))
}

// The wall in force from the owner's reads, or null when it cannot be known.
// No pointer means 'following'. A pointer that does not lead to a live
// scrap-wall (unread, invalid, another type) fails closed: null, so nothing
// is shown, never a fall back to the default.
function wallFrom (pointers, ownerRead) {
  if (pointers.wallBad) return null
  if (pointers.wall === null) return DEFAULT_WALL
  const rec = ownerRead.live.has(pointers.wall) ? wallOfRecord(ownerRead.live.get(pointers.wall)) : null
  return rec === null ? null : rec.who
}

// Does the owner's follow block at the row's pointer name this writer? null
// when the block was not read at all.
function followVerdict (ownerRead, c) {
  if (c.followSeq === null) return false
  if (ownerRead.live.has(c.followSeq)) {
    const f = followOf(ownerRead.live.get(c.followSeq))
    return f !== null && f.on === true && f.key === c.author
  }
  return ownerRead.invalid.has(c.followSeq) ? false : null
}

// The scraps that are well formed, to the owner and not dated more than
// MAX_FUTURE_MS past `now`, ascending by seq, with what is missing.
function candidates (pointers, owner, peeks, now) {
  const out = []
  let rejected = 0
  let unread = 0
  const reads = new Map()
  for (const r of pointers.rows.slice().sort((a, b) => a.seq - b.seq)) {
    if (!reads.has(r.author)) reads.set(r.author, readOf(peeks, r.author))
    const read = reads.get(r.author)
    const raw = read.live.get(r.seq)
    if (raw === undefined) {
      if (read.invalid.has(r.seq)) rejected++
      else unread++
      continue
    }
    const rec = scrapOf(raw)
    if (rec === null || rec.to !== owner || Date.parse(rec.at) - now > MAX_FUTURE_MS) {
      rejected++
      continue
    }
    out.push({ author: r.author, seq: r.seq, followSeq: r.followSeq, record: rec, t: Date.parse(rec.at) })
  }
  return { candidates: out, rejected, unread }
}

// Round two: peek params for the owner's own blocks that a reply names and
// round one did not read. Needed only under 'following' (the reply
// exception), and not for a writer whose follow pointer already verified.
export function planReplyPeeks (index, owner, peeks, isBlocked, now = Date.now(), self = null) {
  if (!isHex64(owner)) return []
  const p = readPointers(index, owner, isBlocked, self === owner)
  const ownerRead = readOf(peeks, owner)
  if (wallFrom(p, ownerRead) !== 'following') return []
  const need = []
  for (const c of candidates(p, owner, peeks, now).candidates) {
    const rt = c.record.replyTo
    if (rt === null || rt.author !== owner || followVerdict(ownerRead, c) === true) continue
    if (ownerRead.live.has(rt.seq) || ownerRead.invalid.has(rt.seq)) continue
    need.push(rt.seq)
  }
  return peekBatches(owner, need)
}

// assemblePage({ index, owner, self, peeks, isBlocked, now }) -> page
//   index      the /index/scraps/<owner> answer (readPointers)
//   owner      the page owner's key
//   self       the reader's own key (null when there is no identity)
//   peeks      Map or object: key -> one diary.peek result or a list of them
//              (rounds one and two together)
//   isBlocked  (key) => boolean, the reader's own block list
//   now        the reader's clock in ms (default Date.now()): a scrap dated
//              more than a day ahead is not shown
// page: { owner, wall, rows, hidden, rejected, unread, indexing, complete,
// incomplete, blocked, notice }. Rows are newest first (at desc, author asc,
// seq desc) and each is { author, seq, ref, text, at, replyTo, via, mine }.
// On the reader's own page a recado by a writer the reader blocked is kept,
// with `blocked: true` and an empty text.
export function assemblePage ({ index, owner, self = null, peeks, isBlocked, now = Date.now() } = {}) {
  const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const base = { owner: isHex64(owner) ? owner : null, wall: DEFAULT_WALL, rows: [], hidden: 0, rejected: 0, unread: 0, indexing: false, complete: true, incomplete: false, blocked: false, notice: null }
  if (!isHex64(owner)) return { ...base, wall: null, incomplete: true, notice: NOTICES.unreachable }
  if (typeof isBlocked === 'function' && isBlocked(owner) === true) return { ...base, blocked: true, notice: NOTICES.blocked }
  const keepBlocked = self !== null && self === owner
  const p = readPointers(index, owner, isBlocked, keepBlocked)
  if (!p.valid) return { ...base, wall: null, complete: false, incomplete: true, notice: NOTICES.unreachable }
  const ownerRead = readOf(peeks, owner)
  const wall = wallFrom(p, ownerRead)
  let incomplete = p.indexing || !p.complete || p.hidesCut
  const page = { ...base, indexing: p.indexing, complete: p.complete }
  if (wall === null) return { ...page, wall: null, incomplete: true, notice: NOTICES.wallUnread }
  if (wall === 'nobody') return { ...page, wall, incomplete, notice: incompleteNotice(p, incomplete) }

  const hidden = new Set()
  for (const seq of p.hides) {
    const rec = ownerRead.live.has(seq) ? hideOf(ownerRead.live.get(seq)) : null
    if (rec !== null) hidden.add(rec.from + ':' + rec.seq)
    else if (!ownerRead.invalid.has(seq)) incomplete = true
  }

  // The owner's live scraps (the originals a reply answers) by seq.
  const originals = new Map()
  for (const [seq, raw] of ownerRead.live) {
    const rec = scrapOf(raw)
    if (rec !== null) originals.set(seq, { to: rec.to, t: Date.parse(rec.at) })
  }

  const read = candidates(p, owner, peeks, clock)
  const admitted = []
  const replied = new Map()
  let hiddenCount = 0
  // Ascending seq, so the lowest verified reply to an original wins whatever
  // order the seeder listed the rows in.
  for (const c of read.candidates) {
    const ref = c.author + ':' + c.seq
    let answers = false
    if (wall === 'following') {
      const rt = c.record.replyTo
      const original = rt !== null && rt.author === owner ? originals.get(rt.seq) : undefined
      const done = replied.get(c.author) || new Set()
      if (original !== undefined && original.to === c.author && c.t >= original.t && !done.has(rt.seq)) {
        answers = true
        done.add(rt.seq)
        replied.set(c.author, done)
      }
    }
    // A hidden first reply keeps the original's slot: it is judged above.
    if (hidden.has(ref)) {
      hiddenCount++
      continue
    }
    let via = null
    if (wall === 'everyone') via = 'everyone'
    else {
      const verdict = followVerdict(ownerRead, c)
      if (verdict === null) incomplete = true
      if (verdict === true) via = 'following'
      else if (answers) via = 'reply'
    }
    if (via === null) continue
    // On my own page a blocked writer's recado stays listed so I can take it
    // off, but its text never reaches the row.
    const blockedWriter = keepBlocked && typeof isBlocked === 'function' && isBlocked(c.author) === true
    admitted.push({
      author: c.author,
      seq: c.seq,
      ref,
      text: blockedWriter ? '' : c.record.text,
      at: c.record.at,
      replyTo: c.record.replyTo === null ? null : c.record.replyTo.author + ':' + c.record.replyTo.seq,
      via,
      mine: self !== null && c.author === self,
      ...(blockedWriter ? { blocked: true } : {}),
      t: c.t
    })
  }

  const rows = admitted
    .sort((a, b) => b.t - a.t || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0) || b.seq - a.seq)
    .slice(0, SCRAP_PAGE_MAX)
    .map(({ t, ...row }) => row)
  if (read.unread > 0) incomplete = true
  return { ...page, wall, rows, hidden: hiddenCount, rejected: read.rejected, unread: read.unread, incomplete, notice: incompleteNotice(p, incomplete) }
}

function incompleteNotice (pointers, incomplete) {
  if (pointers.indexing) return NOTICES.indexing
  if (!pointers.complete || incomplete) return NOTICES.incomplete
  return null
}

// ---- who may write, and the refusal notices ---------------------------------

// Whether the reader can leave a recado on this page, from what the app
// already knows. { ok: true } or { ok: false, reason, notice }.
//   wall            the page's policy, or null when it could not be read
//   followedByOwner true / false / null (unknown): does the owner follow me
//   reply           true for a reply to a recado the owner left me (the
//                   exception under 'following')
//   reachable       false when the page could not be read at all
export function composeGate ({ owner, self, isBlocked, wall = null, followedByOwner = null, reply = false, reachable = true } = {}) {
  if (!isHex64(owner) || !isHex64(self)) return refusal('unreachable')
  if (owner === self) return refusal('self')
  if (typeof isBlocked === 'function' && isBlocked(owner) === true) return refusal('blocked')
  if (reachable === false) return refusal('unreachable')
  if (wall === 'nobody') return refusal('nobody')
  if (wall === 'following' && followedByOwner === false && reply !== true) return refusal('following')
  return { ok: true, reason: null, notice: null }
}

function refusal (reason) {
  return { ok: false, reason, notice: NOTICES[reason] }
}

// The notice for a failed page read (the index or a peek), or null for an
// error that is not about reaching the page.
export function readFailureNotice (err) {
  const message = isObject(err) && typeof err.message === 'string' ? err.message : typeof err === 'string' ? err : ''
  if (/indispon[ií]vel/i.test(message) || (isObject(err) && err.code === 'NOT_FOUND')) return NOTICES.unreachable
  return null
}

// ---- composer and reply draft ---------------------------------------------

export function counterLabel (n) {
  return n + '/' + SCRAP_TEXT_MAX
}

// State of the write box for one page. `replyTo` is the ref ('<key>:<seq>')
// of the recado being answered, or null; `needsCheck` is set by an uncertain
// result and stays until the person confirms they looked (markChecked).
export function initialComposer (to) {
  return { to: isHex64(to) ? to : null, text: '', replyTo: null, sending: false, needsCheck: false, notice: null }
}

// A reply draft: the writer of one of the recados on my own page, answered on
// their page. Null when the row cannot be answered (not my page, my own
// recado, a blocked author or an unusable row).
export function replyDraft (row, { owner, self, isBlocked } = {}) {
  if (!isObject(row) || !isHex64(row.author) || !isSeq(row.seq)) return null
  if (!isHex64(owner) || owner !== self || row.author === self) return null
  if (typeof isBlocked === 'function' && isBlocked(row.author) === true) return null
  return { ...initialComposer(row.author), replyTo: row.author + ':' + row.seq }
}

// CRLF (a pasted text, some keyboards) becomes LF: the node accepts LF only.
const normalize = (text) => typeof text === 'string' ? text.replace(/\r\n/g, '\n') : ''

export function setText (state, text) {
  if (state.sending) return state
  return { ...state, text: normalize(text), notice: state.needsCheck ? state.notice : null }
}

export function composerView (state) {
  const count = textLength(state.text)
  const blank = state.text.trim().length === 0
  const over = count > SCRAP_TEXT_MAX
  const badChars = !over && !validScrapText(state.text) && !(state.text === '')
  return {
    count,
    counter: counterLabel(count),
    blank,
    over,
    badChars,
    canSend: !state.sending && !state.needsCheck && !blank && !over && !badChars,
    notice: state.notice
  }
}

// Starts a send. `params` are the fields of the write request for the caller
// to send exactly once, or null when nothing may be sent (already sending,
// waiting for a check, blank or too long): the model never queues a retry.
export function beginSend (state) {
  const view = composerView(state)
  if (state.sending || state.needsCheck || state.to === null) return { state, params: null }
  if (view.blank) return { state: { ...state, notice: NOTICES.empty }, params: null }
  if (view.over) return { state: { ...state, notice: NOTICES.tooLong }, params: null }
  if (view.badChars) return { state: { ...state, notice: NOTICES.badChars }, params: null }
  const params = { to: state.to, text: normalize(state.text) }
  if (state.replyTo !== null) params.replyTo = state.replyTo
  return { state: { ...state, sending: true, notice: null }, params }
}

// The write went through: the box clears.
export function sendSucceeded (state) {
  return { ...state, text: '', replyTo: null, sending: false, needsCheck: false, notice: null }
}

// The write failed. `uncertain: true` (the outcome is unknown: the recado may
// or may not exist) keeps the text, never retries, and holds the box until the
// person confirms they checked the page. A definite failure keeps the text
// and tells why; sending again is the person's tap, never automatic.
export function sendFailed (state, err) {
  if (isObject(err) && err.uncertain === true) return { ...state, sending: false, needsCheck: true, notice: NOTICES.uncertain }
  return { ...state, sending: false, notice: failureNotice(err) }
}

export function markChecked (state) {
  return { ...state, needsCheck: false, notice: null }
}

// Only the node's known unreachable answers are mapped; anything else gets
// the generic notice rather than a guess from loose wording.
function failureNotice (err) {
  const message = isObject(err) && typeof err.message === 'string' ? err.message : ''
  if (message === 'semeador indisponível' || message === 'diário indisponível') return NOTICES.unreachable
  return NOTICES.failed
}
