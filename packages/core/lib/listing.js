'use strict'

// The Feira fold over one diary's entries ({ seq, record }) and the writer
// plans built on it (docs/protocol.md, "Feira"). A listing is a root
// `listing` record; a `listing-edit` replaces its content (never its kind)
// and a `listing-status` sets its status, the highest valid block winning
// for each. Records come from a peer: the fold never throws and skips
// whatever does not apply. Pure: no I/O, no Node built-ins (also loaded by
// the browser node).

const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { feira } = require('@varanda/rpc')
const { validRecordCopy, isCanonicalIso, listingEditRecord, deleteRecord } = require('./records')
const { deletedSeqs, liveMediaRefs, overlaps } = require('./deletion')

// A listing dated more than this past the reader's clock is kept but
// flagged, the same tolerance the seeder index applies.
const FUTURE_MS = 24 * 60 * 60 * 1000
const CONTENT_KEYS = ['title', 'text', 'price', 'unit', 'cat', 'place']
// A delete plan stays at eight records: the root and its newest seven edits.
const MAX_PLAN_EDITS = 7

function scan (entries) {
  const roots = new Map()
  const edits = []
  const statuses = []
  if (!Array.isArray(entries)) return { roots, edits, statuses }
  let deleted
  try {
    deleted = deletedSeqs(entries)
  } catch {
    deleted = new Set()
  }
  for (let i = 0; i < entries.length; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const seq = entry.seq
      if (!Number.isSafeInteger(seq) || deleted.has(seq)) continue
      const copy = validRecordCopy(entry.record, seq)
      if (copy === null) continue
      if (copy.type === 'listing') roots.set(seq, copy)
      else if (copy.type === 'listing-edit') edits.push({ seq, record: copy })
      else if (copy.type === 'listing-status') statuses.push({ seq, record: copy })
    } catch {}
  }
  return { roots, edits, statuses }
}

function content (root, edit) {
  const record = { type: 'listing', kind: root.kind }
  const source = edit === null ? root : edit
  for (const k of CONTENT_KEYS) record[k] = source[k]
  record.at = root.at
  if (Array.isArray(source.media)) record.media = source.media
  return record
}

// -> { items, bySeq }: items newest root first. A root's own delete hides it
// and with it every edit and status that targeted it, whatever their order.
function foldListings (entries, nowMs = Date.now()) {
  const items = []
  const bySeq = new Map()
  try {
    const { roots, edits, statuses } = scan(entries)
    const bestEdit = new Map()
    for (const e of edits) {
      const root = roots.get(e.record.seq)
      if (root === undefined) continue
      // An edit carries no kind: its unit is checked against the root's.
      if (!feira.unitAllowed(root.kind, e.record.price, e.record.unit)) continue
      const prev = bestEdit.get(e.record.seq)
      if (prev === undefined || e.seq > prev.seq) bestEdit.set(e.record.seq, e)
    }
    const bestStatus = new Map()
    for (const s of statuses) {
      const root = roots.get(s.record.seq)
      if (root === undefined) continue
      if (root.kind === 'procura' && s.record.status === 'reservado') continue
      const prev = bestStatus.get(s.record.seq)
      if (prev === undefined || s.seq > prev.seq) bestStatus.set(s.record.seq, s)
    }
    const limit = Number.isFinite(nowMs) ? nowMs + FUTURE_MS : Infinity
    for (const [seq, root] of roots) {
      const edit = bestEdit.get(seq)
      const status = bestStatus.get(seq)
      const item = {
        seq,
        record: content(root, edit === undefined ? null : edit.record),
        editSeq: edit === undefined ? null : edit.seq,
        editedAt: edit === undefined ? null : edit.record.at,
        status: status === undefined ? 'disponivel' : status.record.status,
        statusSeq: status === undefined ? null : status.seq,
        future: Date.parse(root.at) > limit
      }
      items.push(item)
      bySeq.set(seq, item)
    }
    items.sort((a, b) => b.seq - a.seq)
  } catch {}
  return { items, bySeq }
}

// Live roots, whatever their status, for the per-diary cap.
function countLive (entries) {
  return scan(entries).roots.size
}

function itemOf (entries, seq) {
  const item = foldListings(entries).bySeq.get(seq)
  return item === undefined ? null : item
}

// -> { seq, record } of the edit shown for listing `seq`, or null.
function liveEditOf (entries, seq) {
  const item = itemOf(entries, seq)
  if (item === null || item.editSeq === null) return null
  for (const e of scan(entries).edits) {
    if (e.seq === item.editSeq) return { seq: e.seq, record: e.record }
  }
  return null
}

function displayedMedia (entries, seq) {
  const item = itemOf(entries, seq)
  return item !== null && Array.isArray(item.record.media) ? item.record.media : []
}

function toRange (d) {
  return { core: d.core, start: d.start, blocks: d.blocks }
}

// The ranges of `media` no surviving record (other than `except`) and no
// `keep` descriptor still shows, deduplicated, at most four.
function freedRanges (entries, media, except, keep = []) {
  if (!Array.isArray(media) || media.length === 0) return []
  const live = liveMediaRefs(entries, except).concat(keep.map(toRange))
  const out = []
  for (const d of media) {
    const r = toRange(d)
    if (live.some((l) => overlaps(l, r))) continue
    if (out.some((o) => o.core === r.core && o.start === r.start && o.blocks === r.blocks)) continue
    out.push(r)
  }
  return out.slice(0, 4)
}

function tombstone (seq, media, at) {
  const fields = { seq }
  if (at !== undefined) fields.at = at
  if (media.length > 0) fields.media = media
  return deleteRecord(fields)
}

// The records that edit listing `seq` to `snapshot` (its full new content),
// then retire the edit it replaces with the photos only that edit showed.
// Throws TypeError on a bad snapshot or when `seq` is not a live listing.
function editPlan (entries, seq, snapshot = {}) {
  const item = itemOf(entries, seq)
  if (item === null) throw new TypeError('not-found')
  if (!feira.unitAllowed(item.record.kind, snapshot.price, snapshot.unit === undefined ? null : snapshot.unit)) throw new TypeError('unit-invalid')
  const edit = listingEditRecord({ ...snapshot, seq })
  if (item.editSeq === null) return { records: [edit] }
  const previous = liveEditOf(entries, seq)
  const media = previous === null ? [] : previous.record.media
  const ranges = freedRanges(entries, media, [item.editSeq], Array.isArray(edit.media) ? edit.media : [])
  return { records: [edit, tombstone(item.editSeq, ranges, edit.at)] }
}

// The tombstones that remove listing `seq`: the root, then every live edit
// of it, newest first, each with the photos no other surviving record shows.
// More than MAX_PLAN_EDITS live edits only come from a hostile or broken
// writer: the newest are retired and the fold ignores the rest once the
// root is gone (as does liveMediaRefs).
function deletePlan (entries, seq, at) {
  const item = itemOf(entries, seq)
  if (item === null) throw new TypeError('not-found')
  const { roots, edits } = scan(entries)
  const root = roots.get(seq)
  const own = edits.filter((e) => e.record.seq === seq).sort((a, b) => b.seq - a.seq).slice(0, MAX_PLAN_EDITS)
  const except = [seq, ...own.map((e) => e.seq)]
  const planned = []
  const out = []
  for (const { seq: target, media } of [{ seq, media: root.media }, ...own.map((e) => ({ seq: e.seq, media: e.record.media }))]) {
    const ranges = freedRanges(entries, media, except, planned)
    planned.push(...ranges)
    out.push(tombstone(target, ranges, at))
  }
  return out
}

// The listing author's signature over the deal, checked under that key. A
// self-rating never counts.
function verifyConsent ({ listingAuthor, listingSeq, rater, offerId, consent } = {}) {
  try {
    if (rater === listingAuthor) return false
    if (typeof consent !== 'string' || !/^[0-9a-f]{128}$/.test(consent)) return false
    const payload = feira.dealPayload({ listingAuthor, listingSeq, rater, offerId })
    return crypto.verify(b4a.from(payload), b4a.from(consent, 'hex'), b4a.from(listingAuthor, 'hex')) === true
  } catch {
    return false
  }
}

// A rater's membership must be at least seven days old.
function certOldEnough (certDateIso, nowMs) {
  try {
    if (!isCanonicalIso(certDateIso) || !Number.isFinite(nowMs)) return false
    return nowMs - Date.parse(certDateIso) >= feira.RATE_MIN_AGE_MS
  } catch {
    return false
  }
}

module.exports = {
  FUTURE_MS,
  MAX_PLAN_EDITS,
  foldListings,
  countLive,
  liveEditOf,
  displayedMedia,
  editPlan,
  deletePlan,
  verifyConsent,
  certOldEnough
}
