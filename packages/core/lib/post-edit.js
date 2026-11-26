'use strict'

// Post edits (docs/protocol.md section 2, "Post edit"). A `post-edit` record
// at block e names an EARLIER block P of the same diary and carries the full
// replacement text of the post there. The diary's Hypercore signature is the
// only authority (there is no author field), so an edit in another diary
// targets only that diary, and the block index orders edits: `at` never
// decides anything.
//
// Rule, inside one diary, after the page cut and the tombstones: the current
// text of post P is the text of the live, valid post-edit with the HIGHEST
// block seq among those that name P and that P admits (editable and
// admitsText below); with none, the text as written. A tombstoned edit does
// not count, so the next lower one wins. An edit changes only the text: `at`,
// `replyTo`, `quote`, `media`, `poll` and `event` stay as signed. A link card
// stays only while the text still holds its URL.
//
// Pure: no I/O, never throws, inputs are not mutated (also loaded by the
// browser node). The writer plan (editPlan) is shared by both nodes so they
// cannot drift.

const { validRecordCopy, postEditRecord, deleteRecord, isPlainObject } = require('./records')

// Seeder pointer map bound, as for shares and covers (lib/post-share.js).
const POST_EDITS_PER_DIARY = 4096
// Tombstones one edit may carry in its append (the core node's APPEND_MAX is
// 8: the new edit plus at most 7 older live edits of the same post).
const MAX_SUPERSEDE = 7

function isSeq (v) {
  return Number.isSafeInteger(v) && v >= 1
}

// A post an edit may change: a valid `post` copy that is neither a poll
// (votes were given to the question as written) nor an event (events are
// immutable, docs/rpc.md, "Eventos").
function editable (post) {
  try {
    if (!isPlainObject(post) || post.type !== 'post') return false
    return !Object.prototype.hasOwnProperty.call(post, 'poll') && !Object.prototype.hasOwnProperty.call(post, 'event')
  } catch {
    return false
  }
}

// The post `post` (a valid copy at block `seq`) as it reads with `text`, or
// null when the post does not admit that text: the result must itself be a
// valid post at the same seq, so every bound of a post (length, control
// characters, empty text only for a media post that is not a quote) applies
// unchanged. The link card stays only while the text still holds its URL.
function withText (post, seq, text) {
  try {
    if (!editable(post) || typeof text !== 'string') return null
    const next = { ...post, text }
    if (next.preview && typeof next.preview.url === 'string' && !text.includes(next.preview.url)) delete next.preview
    const copy = validRecordCopy(next, seq)
    return copy !== null && editable(copy) ? copy : null
  } catch {
    return null
  }
}

function admitsText (post, seq, text) {
  return withText(post, seq, text) !== null
}

// Post seq -> { seq: editSeq, record: the post as it reads now } for every
// post with an applicable edit. `copies`: [{ seq, record }] of validated
// copies with the page cut and the tombstones applied (record null for a
// deleted or invalid block), as buildFeed and diaryPeek hold them.
function editsOfCopies (copies) {
  const out = new Map()
  try {
    if (!Array.isArray(copies)) return out
    const posts = new Map()
    const edits = []
    for (let i = 0; i < copies.length; i++) {
      const e = copies[i]
      if (e === null || typeof e !== 'object') continue
      const { seq, record } = e
      if (!isSeq(seq) || record === null || typeof record !== 'object') continue
      if (record.type === 'post') posts.set(seq, record)
      else if (record.type === 'post-edit' && Number.isSafeInteger(record.seq) && record.seq < seq) edits.push({ seq, target: record.seq, text: record.text })
    }
    // Highest block first: the first applicable edit per post wins.
    edits.sort((a, b) => b.seq - a.seq)
    for (const { seq, target, text } of edits) {
      if (out.has(target)) continue
      const post = posts.get(target)
      if (post === undefined) continue
      const record = withText(post, target, text)
      if (record !== null) out.set(target, { seq, record })
    }
  } catch {}
  return out
}

// editsOfCopies over raw entries ({ seq, record, deleted? }) whose deleted
// blocks are already { record: null } or marked `deleted`; each record is
// validated here.
function editsOf (entries) {
  const copies = []
  try {
    if (!Array.isArray(entries)) return new Map()
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      if (e === null || typeof e !== 'object' || e.deleted === true || !isSeq(e.seq)) continue
      copies.push({ seq: e.seq, record: validRecordCopy(e.record, e.seq) })
    }
  } catch {}
  return editsOfCopies(copies)
}

// The live, valid post-edit blocks naming post `postSeq`, ascending.
// `copies` as for editsOfCopies.
function liveEditSeqs (copies, postSeq) {
  const out = []
  try {
    if (!Array.isArray(copies)) return out
    for (const e of copies) {
      if (e === null || typeof e !== 'object' || !isSeq(e.seq)) continue
      const r = e.record
      if (r !== null && typeof r === 'object' && r.type === 'post-edit' && r.seq === postSeq && r.seq < e.seq) out.push(e.seq)
    }
  } catch {}
  return out.sort((a, b) => a - b)
}

// The writer's plan, shared by both nodes. `copies` as for editsOfCopies
// over the WHOLE own diary; `to` the target post seq; `length` the diary's
// length. Returns one of
//   { refuse: 'bad-ref' | 'not-a-post' | 'not-editable' | 'text' }
//   { unchanged: true, seq: <live edit seq> | null } when `text` is the
//     current text already (nothing is written)
//   { records: [post-edit, ...tombstones], supersede: [edit seqs] }:
//     the new edit and the tombstones of the post's older live edits, in ONE
//     append, so the writer keeps at most one live edit per post.
function editPlan ({ copies, to, length, text, at }) {
  if (!isSeq(to) || !Number.isSafeInteger(length) || to >= length) return { refuse: 'bad-ref' }
  let post = null
  for (const e of copies) {
    if (e && e.seq === to) { post = e.record; break }
  }
  if (post === null || typeof post !== 'object') return { refuse: 'bad-ref' }
  if (post.type !== 'post') return { refuse: 'not-a-post' }
  if (!editable(post)) return { refuse: 'not-editable' }
  if (!admitsText(post, to, text)) return { refuse: 'text' }
  const current = editsOfCopies(copies).get(to)
  const shown = current === undefined ? post.text : current.record.text
  if (text === shown) return { unchanged: true, seq: current === undefined ? null : current.seq }
  const supersede = liveEditSeqs(copies, to).slice(-MAX_SUPERSEDE)
  const records = [postEditRecord({ seq: to, text, at })]
  for (const seq of supersede) records.push(deleteRecord({ seq, at }))
  return { records, supersede }
}

// Seeder: post seq -> the highest post-edit seq seen (lib/post-share.js
// foldShare semantics). false for bad input or a full map.
function foldEdit (map, postSeq, editSeq, { maxPosts = POST_EDITS_PER_DIARY } = {}) {
  if (!(map instanceof Map) || !isSeq(postSeq) || !isSeq(editSeq)) return false
  const prev = map.get(postSeq)
  if (prev !== undefined) {
    if (editSeq > prev) map.set(postSeq, editSeq)
    return true
  }
  if (map.size >= maxPosts) return false
  map.set(postSeq, editSeq)
  return true
}

function newestEdit (map, postSeq) {
  if (!(map instanceof Map)) return null
  const v = map.get(postSeq)
  return v === undefined ? null : v
}

module.exports = {
  POST_EDITS_PER_DIARY,
  MAX_SUPERSEDE,
  editable,
  withText,
  admitsText,
  editsOfCopies,
  editsOf,
  liveEditSeqs,
  editPlan,
  foldEdit,
  newestEdit
}
