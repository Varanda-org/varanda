// Depoimentos: profile rows, the own sent list and the pending list, from
// what the node already read. Pure: no crypto, no React. The node verifies
// each show against the live writer block (hash, recipient, not revoked) and
// leaves failed ones out of `entries`; the checks here only refuse anything
// that does not even point at a live writer block for this owner. Text is
// returned raw: the screen applies displayText.

const HEX64 = /^[0-9a-f]{64}$/

export const TESTIMONIAL_PENDING_MAX = 64

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isHex64 = (s) => typeof s === 'string' && HEX64.test(s)
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isText = (s) => typeof s === 'string' && s.length > 0

function isCanonicalIso (s) {
  if (typeof s !== 'string') return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString() === s
}

function entriesOf (peek, key) {
  if (!isObject(peek) || peek.key !== key || !Array.isArray(peek.entries)) return []
  return peek.entries.filter((e) => isObject(e) && isSeq(e.seq) && isObject(e.record))
}

function writerPeekOf (writerPeeks, from) {
  if (writerPeeks instanceof Map) return writerPeeks.get(from)
  if (isObject(writerPeeks) && Object.prototype.hasOwnProperty.call(writerPeeks, from)) return writerPeeks[from]
  return undefined
}

// The writer block the show points at, only while it is a live testimonial
// to this owner: a revoked block is cleared, so it is absent from entries.
function liveWriterBlock (writerPeek, from, seq, owner) {
  for (const e of entriesOf(writerPeek, from)) {
    if (e.seq !== seq) continue
    return e.record.type === 'testimonial' && e.record.to === owner ? e.record : null
  }
  return null
}

function nameOf (writerPeek) {
  const profile = isObject(writerPeek) && isObject(writerPeek.profile) ? writerPeek.profile : null
  return {
    name: profile && typeof profile.name === 'string' ? profile.name : null,
    username: isObject(writerPeek) && typeof writerPeek.username === 'string' ? writerPeek.username : null,
    avatar: profile && isObject(profile.avatar) ? profile.avatar : null
  }
}

// peek: the owner's diary.peek of the show blocks. writerPeeks: Map or object
// writer key -> that writer's diary.peek of the testimonial blocks (with the
// profile and username hints). One row per writer, the newest show wins;
// rows newest show first.
export function rowsFrom (peek, owner, writerPeeks) {
  if (!isHex64(owner)) return []
  const newest = new Map()
  for (const e of entriesOf(peek, owner)) {
    const r = e.record
    if (r.type !== 'testimonial-show' || !isHex64(r.from) || r.from === owner) continue
    if (!isSeq(r.seq) || !isText(r.text) || !isCanonicalIso(r.at)) continue
    const prev = newest.get(r.from)
    if (prev && prev.seq > e.seq) continue
    newest.set(r.from, { seq: e.seq, record: r })
  }
  const rows = []
  for (const [from, { seq, record }] of newest) {
    const writerPeek = writerPeekOf(writerPeeks, from)
    if (liveWriterBlock(writerPeek, from, record.seq, owner) === null) continue
    rows.push({ from, seq, text: record.text, at: record.at, ref: owner + ':' + seq, ...nameOf(writerPeek) })
  }
  rows.sort((a, b) => b.seq - a.seq)
  return rows
}

// ownLog: one log.read result of the own diary, or a list of its pages. A
// tombstoned block is in `invalid` (never in entries); a tombstone entry seen
// on another page is honoured too. Rows newest first, one per live block.
export function sentRows (ownLog, ownKey) {
  if (!isHex64(ownKey)) return []
  const pages = Array.isArray(ownLog) ? ownLog : [ownLog]
  const deleted = new Set()
  const live = new Map()
  for (const page of pages) {
    for (const e of entriesOf(page, ownKey)) {
      const r = e.record
      if (r.type === 'delete' && isSeq(r.seq) && r.seq < e.seq) deleted.add(r.seq)
      else if (r.type === 'testimonial' && isHex64(r.to) && r.to !== ownKey && isCanonicalIso(r.at)) live.set(e.seq, r)
    }
  }
  const rows = []
  for (const [seq, r] of live) {
    if (deleted.has(seq)) continue
    rows.push({ to: r.to, seq, at: r.at, ref: ownKey + ':' + seq })
  }
  rows.sort((a, b) => b.seq - a.seq)
  return rows
}

// result: testimonial.pending { items: [{ from, seq, text, at }], incomplete }
// (pendingIncomplete reads the flag). Malformed
// items are dropped, repeats of one writer block kept once, at most 64.
export function pendingRows (result) {
  if (!isObject(result) || !Array.isArray(result.items)) return []
  const seen = new Set()
  const rows = []
  for (const it of result.items) {
    if (rows.length >= TESTIMONIAL_PENDING_MAX) break
    if (!isObject(it) || !isHex64(it.from) || !isSeq(it.seq) || !isText(it.text) || !isCanonicalIso(it.at)) continue
    const ref = it.from + ':' + it.seq
    if (seen.has(ref)) continue
    seen.add(ref)
    rows.push({ from: it.from, seq: it.seq, text: it.text, at: it.at, ref })
  }
  return rows
}

// True when the node could not read the whole inbox (the seeder index is
// still indexing or incomplete, or a writer's blocks could not be read), so
// an empty or short list is not the full answer. An older node without the
// flag reads as complete.
export function pendingIncomplete (result) {
  return isObject(result) && result.incomplete === true
}
