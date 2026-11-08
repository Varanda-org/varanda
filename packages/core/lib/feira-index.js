'use strict'

// The seeder updates STATE before attempting search admission. Search caps
// must never prevent a later status, edit or tombstone from being folded.
// Only references and copied, bounded search keys survive a call.
const HEX = /^[0-9a-f]{64}$/
const TOKEN = /^[a-z0-9]{2,32}$/
const CITY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const CURSOR = /^(0|[1-9][0-9]{0,15})\.([0-9a-f]{64})\.([1-9][0-9]{0,14})$/
const KINDS = ['produto', 'servico', 'procura']
const STATUSES = ['disponivel', 'reservado', 'vendido']
const PAGE = 30
const SCAN = 2000
const FUTURE_MS = 86400000
const WINDOW = 16
const MAX_TOKENS = 32
const TOMBSTONES = 1024
const RECENT_MAX = 5000

function hex (value) { return typeof value === 'string' && HEX.test(value) }
function sequence (value) { return Number.isSafeInteger(value) && value > 0 && value <= 999999999999999 }
function millis (value) { return Number.isSafeInteger(value) && value >= 0 }
function ref (author, seq) { return author + ':' + seq }
function flat (value) { return String.fromCharCode(...Array.from(value, c => c.charCodeAt(0))) }
function newest (a, b) {
  return b.atMs - a.atMs || (a.author < b.author ? -1 : a.author > b.author ? 1 : b.seq - a.seq)
}
function cursorOf (row) { return row.atMs + '.' + row.author + '.' + row.seq }
function parseCursor (value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return undefined
  const match = CURSOR.exec(value)
  if (!match || !millis(Number(match[1]))) return undefined
  return { atMs: Number(match[1]), author: match[2], seq: Number(match[3]) }
}
function visibleTo (visible, author) {
  try { return visible === undefined || visible(author) === true } catch { return false }
}
function guarded (fn, fallback) {
  return (...args) => {
    try { return fn(...args) } catch { return fallback() }
  }
}
function option (options, name, fallback) {
  try {
    const value = options[name]
    return Number.isSafeInteger(value) && value >= 0 ? value : fallback
  } catch { return fallback }
}
function future (row, now) { return row.atMs - now > FUTURE_MS }

// Lists append during diary scans and sort lazily. Cursor positioning does
// not spend the scan budget walking entries from previous pages. Rows sit
// oldest-first so a prefix search can skip anything dated too far ahead.
function list () { return { rows: [], dirty: false, dead: 0 } }
function append (bucket, row) {
  const last = bucket.rows[bucket.rows.length - 1]
  if (last && newest(last, row) < 0) bucket.dirty = true
  bucket.rows.push(row)
}
function ordered (bucket) {
  if (bucket.dead) compact(bucket)
  if (bucket.dirty) {
    bucket.rows.sort((a, b) => newest(b, a))
    bucket.dirty = false
  }
  return bucket.rows
}
// Removal marks the row dead (row.dead, set once by dropEntry) and counts it
// per bucket. Splicing each bucket would make removing many rows from a full
// index quadratic. Buckets compact when half is dead or when next read.
function compact (bucket) {
  bucket.rows = bucket.rows.filter(row => !row.dead)
  bucket.dead = 0
}
function live (bucket) { return bucket.rows.length - bucket.dead }
function erase (bucket) {
  bucket.dead++
  if (bucket.dead * 2 > bucket.rows.length) compact(bucket)
}
function prefix (rows, predicate) {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (predicate(rows[mid])) lo = mid + 1
    else hi = mid
  }
  return lo
}

function createFeiraIndex (options = {}) {
  const maxEntries = option(options, 'maxEntries', 100000)
  const perAuthorMax = option(options, 'perAuthorMax', 30)
  const maxTerms = option(options, 'maxTerms', 100000)
  const maxPostings = option(options, 'maxPostings', 1000000)
  const maxRatingsPerTarget = option(options, 'maxRatingsPerTarget', 200)
  const maxRatings = option(options, 'maxRatings', 200000)
  const stateCap = Math.min(64, option(options, 'stateListingsPerDiary', 64))
  const diaries = new Map()
  const entries = new Map()
  const authors = new Map()
  const terms = new Map()
  const places = new Map()
  const all = list()
  const ratings = new Map()
  const targets = new Map()
  let postings = 0

  function diary (author) {
    let d = diaries.get(author)
    if (!d) {
      d = { roots: new Map(), deleted: new Set(), actions: new Map() }
      diaries.set(author, d)
    }
    return d
  }
  function root (author, seq) { return diaries.get(author)?.roots.get(seq) }
  function state (author) {
    const out = new Map()
    for (const [seq, row] of diaries.get(author)?.roots || []) {
      const { status, statusSeq, editSeq, atMs, kind } = row
      const snapshot = { status, statusSeq, deleted: false, editSeq, atMs, kind }
      if (row.stale) snapshot.stale = true
      if (row.stale && row.editSeq === null && row.editOverflowed) snapshot.editStale = true
      out.set(seq, snapshot)
    }
    return out
  }
  // The seeder scans a diary in order, so a delete always follows its target.
  // The newest 1024 tombstones are enough to stop resurrection on that
  // forward pass. An older seq is never offered again after it is evicted.
  function rememberDeleted (d, seq) {
    if (d.deleted.has(seq)) d.deleted.delete(seq)
    d.deleted.add(seq)
    if (d.deleted.size > TOMBSTONES) d.deleted.delete(d.deleted.values().next().value)
  }
  function upsertListing (author, seq, data) {
    if (!hex(author) || !sequence(seq)) return false
    let atMs, kind
    try {
      atMs = data.atMs
      kind = data.kind
    } catch { return false }
    if (!millis(atMs) || !KINDS.includes(kind)) return false
    const existing = diaries.get(author)
    if (existing?.deleted.has(seq)) return false
    // A seq already used as a status or edit action cannot also be a root.
    if (existing?.actions.has(seq)) return false
    if (existing?.roots.has(seq)) return true
    if ((existing?.roots.size || 0) >= stateCap) return false
    const d = existing || diary(author)
    d.roots.set(seq, {
      author,
      seq,
      atMs,
      kind,
      status: 'disponivel',
      statusSeq: null,
      editSeq: null,
      statuses: [],
      edits: [],
      statusOverflowed: false,
      editOverflowed: false,
      stale: false
    })
    return true
  }
  function actionAllowed (d, rootSeq, actionSeq) {
    if (d.deleted.has(actionSeq) || d.roots.has(actionSeq)) return false
    const owner = d.actions.get(actionSeq)
    return owner === undefined || owner === rootSeq
  }
  function attach (d, row, list, action, overflowKey) {
    if (list.some(item => item.seq === action.seq)) return
    list.push(action)
    list.sort((a, b) => b.seq - a.seq)
    d.actions.set(action.seq, row.seq)
    if (list.length <= WINDOW) return
    const dropped = list.pop()
    if (overflowKey) row[overflowKey] = true
    const inStatus = row.statuses.some(item => item.seq === dropped.seq)
    const inEdit = row.edits.some(item => item.seq === dropped.seq)
    if (!inStatus && !inEdit) d.actions.delete(dropped.seq)
  }
  function recompute (row) {
    row.stale = false
    if (row.statuses.length) {
      row.status = row.statuses[0].status
      row.statusSeq = row.statuses[0].seq
    } else if (!row.statusOverflowed) {
      row.status = 'disponivel'
      row.statusSeq = null
    } else {
      // Documented limit: the window once dropped a status it cannot see
      // again, and the sixteen that remain are gone. The true status is
      // unknown, so the root is stale (out of query and recent, listed by
      // byAuthor with a null status) until a later setStatus. The seeder may
      // refold from its replica. An emptied edit window falls back to null,
      // which means the root text, and that is safe.
      row.stale = true
    }
    row.editSeq = row.edits.length ? row.edits[0].seq : null
    // Same limit for edits: once the window dropped an edit and the rest are
    // gone, an older edit may still be live, so the current content is
    // unknown and the root is stale rather than shown as the root text.
    if (row.editSeq === null && row.editOverflowed) row.stale = true
  }
  function applyEdit (author, seq, editSeq) {
    if (!sequence(seq) || !sequence(editSeq) || editSeq <= seq) return false
    const d = diaries.get(author)
    const row = d?.roots.get(seq)
    if (!row || !actionAllowed(d, seq, editSeq)) return false
    attach(d, row, row.edits, { seq: editSeq }, 'editOverflowed')
    recompute(row)
    return true
  }
  function setStatus (author, seq, status, statusSeq) {
    if (!STATUSES.includes(status) || !sequence(seq) || !sequence(statusSeq) || statusSeq <= seq) return false
    const d = diaries.get(author)
    const row = d?.roots.get(seq)
    if (!row || !actionAllowed(d, seq, statusSeq)) return false
    // foldListings ignores reservado on a procura, so the index must too.
    if (row.kind === 'procura' && status === 'reservado') return false
    attach(d, row, row.statuses, { seq: statusSeq, status }, 'statusOverflowed')
    recompute(row)
    return true
  }
  function markDeleted (author, seq) {
    if (!hex(author) || !sequence(seq)) return false
    const d = diaries.get(author)
    if (!d) return false
    const row = d.roots.get(seq)
    if (row) {
      d.roots.delete(seq)
      for (const action of row.statuses) d.actions.delete(action.seq)
      for (const action of row.edits) d.actions.delete(action.seq)
      rememberDeleted(d, seq)
      dropEntry(entries.get(ref(author, seq)))
      // A rating of a deleted listing rates nothing: its slot is freed.
      for (const rated of [...(targets.get(author)?.values() || [])]) {
        if (rated.targetSeq === seq) removeRating(rated.author, rated.seq)
      }
      return true
    }
    const rootSeq = d.actions.get(seq)
    if (rootSeq !== undefined) {
      const owner = d.roots.get(rootSeq)
      d.actions.delete(seq)
      if (owner) {
        owner.statuses = owner.statuses.filter(action => action.seq !== seq)
        owner.edits = owner.edits.filter(action => action.seq !== seq)
        recompute(owner)
      }
      rememberDeleted(d, seq)
      return true
    }
    if (d.deleted.has(seq)) return true
    return false
  }
  function metadata (data) {
    let cat, uf, cityKey, tokens
    try {
      cat = data.cat
      uf = data.uf
      cityKey = data.cityKey
      tokens = data.tokens
    } catch { return null }
    if (typeof cat !== 'string' || !/^[a-z]{2,32}$/.test(cat)) return null
    if (typeof uf !== 'string' || !/^[A-Z]{2}$/.test(uf)) return null
    if (typeof cityKey !== 'string' || cityKey.length < 2 || cityKey.length > 48 || !CITY.test(cityKey)) return null
    // Length before any Set: one call must not allocate past the caps.
    if (!Array.isArray(tokens) || tokens.length > MAX_TOKENS) return null
    const copied = []
    const seen = new Set()
    for (const token of tokens) {
      if (typeof token !== 'string' || !TOKEN.test(token)) return null
      const value = flat(token)
      if (seen.has(value)) continue
      seen.add(value)
      copied.push(value)
    }
    return { cat: flat(cat), uf: flat(uf), cityKey: flat(cityKey), tokens: copied }
  }
  function fits (tokens, oldTokens) {
    let freed = 0
    if (oldTokens) {
      for (const token of oldTokens) {
        if (tokens.includes(token)) continue
        const bucket = terms.get(token)
        if (bucket && live(bucket) === 1) freed++
      }
    }
    let fresh = 0
    for (const token of tokens) if (!terms.has(token)) fresh++
    const oldCount = oldTokens ? oldTokens.length : 0
    return terms.size - freed + fresh <= maxTerms && postings - oldCount + tokens.length <= maxPostings
  }
  function putBucket (map, key, row) {
    let bucket = map.get(key)
    if (!bucket) map.set(key, (bucket = list()))
    append(bucket, row)
  }
  function dropBucket (map, key, row) {
    const bucket = map.get(key)
    if (!bucket) return
    erase(bucket)
    if (!live(bucket)) map.delete(key)
  }
  function putEntry (row) {
    entries.set(ref(row.author, row.seq), row)
    let own = authors.get(row.author)
    if (!own) authors.set(row.author, (own = new Set()))
    own.add(row)
    append(all, row)
    putBucket(places, row.uf, row)
    putBucket(places, row.uf + ':' + row.cityKey, row)
    for (const token of row.tokens) putBucket(terms, token, row)
    postings += row.tokens.length
  }
  function dropEntry (row) {
    if (!row) return
    row.dead = true
    entries.delete(ref(row.author, row.seq))
    const own = authors.get(row.author)
    own.delete(row)
    if (!own.size) authors.delete(row.author)
    erase(all)
    dropBucket(places, row.uf, row)
    dropBucket(places, row.uf + ':' + row.cityKey, row)
    for (const token of row.tokens) dropBucket(terms, token, row)
    postings -= row.tokens.length
  }
  function add (author, seq, data) {
    if (!hex(author) || !sequence(seq)) return false
    if (entries.has(ref(author, seq))) return true
    // The 64-live cap is enforced here too: search cannot outlive STATE.
    const current = root(author, seq)
    if (!current) return false
    const fields = metadata(data)
    if (!fields) return false
    // Date and kind come from STATE so ordering cannot disagree with it.
    const { atMs, kind } = current
    if (entries.size >= maxEntries || (authors.get(author)?.size || 0) >= perAuthorMax || !fits(fields.tokens)) return false
    putEntry({ author, seq, atMs, kind, ...fields })
    return true
  }
  function update (author, seq, data) {
    if (!hex(author) || !sequence(seq)) return false
    const row = entries.get(ref(author, seq))
    if (!row) return false
    const fields = metadata(data)
    // Fit the replacement before unlinking. A refusal leaves the old entry.
    if (!fields || !fits(fields.tokens, row.tokens)) return false
    const atMs = row.atMs
    const kind = row.kind
    dropEntry(row)
    putEntry({ author, seq, atMs, kind, ...fields })
    return true
  }
  function remove (author, seq) {
    if (!hex(author) || !sequence(seq)) return false
    // Search only. STATE and tombstones stay, so a later add can index again.
    dropEntry(entries.get(ref(author, seq)))
    return true
  }
  function item (row) {
    const current = root(row.author, row.seq)
    return {
      ref: ref(row.author, row.seq),
      status: current?.stale ? null : current?.status || 'disponivel',
      statusSeq: current?.stale ? null : current?.statusSeq ?? null,
      editSeq: current?.editSeq ?? null
    }
  }
  function page (rows, cursor, accepts, makeItem, now) {
    const key = parseCursor(cursor)
    if (key === undefined) return null
    let end = prefix(rows, row => !future(row, now))
    if (key) end = Math.min(end, prefix(rows, row => newest(row, key) > 0))
    const items = []
    let scanned = 0
    let last = null
    while (end > 0 && items.length < PAGE && scanned < SCAN) {
      const row = rows[--end]
      last = row
      scanned++
      if (accepts(row)) items.push(makeItem(row))
    }
    const next = end > 0 && last ? cursorOf(last) : null
    return { items, next, complete: next === null }
  }
  function query ({ uf, cityKey, kind = 'todos', cat = 'todas', tokens = [], cursor, visible, now = Date.now() } = {}) {
    if (parseCursor(cursor) === undefined || !millis(now) || !['todos', ...KINDS].includes(kind)) return null
    if (uf !== undefined && (typeof uf !== 'string' || !/^[A-Z]{2}$/.test(uf))) return null
    if (cityKey !== undefined && (!uf || typeof cityKey !== 'string' || cityKey.length < 2 || cityKey.length > 48 || !CITY.test(cityKey))) return null
    if (typeof cat !== 'string' || !/^[a-z]{2,32}$/.test(cat) || !Array.isArray(tokens) || tokens.length > 8) return null
    const words = [...tokens]
    if (words.some(token => typeof token !== 'string' || !TOKEN.test(token))) return null
    const buckets = [uf ? places.get(cityKey ? uf + ':' + cityKey : uf) : all]
    for (const token of words) buckets.push(terms.get(token))
    if (buckets.some(bucket => !bucket)) return { items: [], next: null, complete: true }
    let rows = null
    let shortest = Infinity
    for (const bucket of buckets) {
      const candidate = ordered(bucket)
      const length = prefix(candidate, row => !future(row, now))
      if (length < shortest) {
        rows = candidate
        shortest = length
      }
    }
    return page(rows, cursor, row => {
      const current = root(row.author, row.seq)
      return current && !current.stale && current.status !== 'vendido' &&
        (kind === 'todos' ? row.kind !== 'procura' : row.kind === kind) &&
        (cat === 'todas' || cat === row.cat) && (!uf || uf === row.uf) &&
        (!cityKey || cityKey === row.cityKey) && words.every(token => row.tokens.includes(token)) &&
        visibleTo(visible, row.author)
    }, item, now)
  }
  function byAuthor (author, cursor, visible, now = Date.now()) {
    if (!hex(author) || !millis(now)) return null
    const rows = [...(diaries.get(author)?.roots.values() || [])]
    rows.sort((a, b) => newest(b, a))
    return page(rows, cursor, () => visibleTo(visible, author), item, now)
  }
  function addRating (target, targetSeq, rater, rateSeq, atMs) {
    if (!hex(target) || !sequence(targetSeq) || !hex(rater) || rater === target || !sequence(rateSeq) || !millis(atMs)) return false
    if (!root(target, targetSeq)) return false
    const id = ref(rater, rateSeq)
    const pair = ref(rater, targetSeq)
    const own = targets.get(target)
    const previous = own?.get(pair)
    if (previous && previous.seq >= rateSeq) return true
    const existing = ratings.get(id)
    if (existing) return false
    if (!previous && (ratings.size >= maxRatings || (own?.size || 0) >= maxRatingsPerTarget)) return false
    if (previous) removeRating(rater, previous.seq)
    const row = { target, targetSeq, author: rater, seq: rateSeq, atMs }
    let bucket = targets.get(target)
    if (!bucket) targets.set(target, (bucket = new Map()))
    bucket.set(pair, row)
    ratings.set(id, row)
    return true
  }
  function removeRating (rater, seq) {
    if (!hex(rater) || !sequence(seq)) return false
    const id = ref(rater, seq)
    const row = ratings.get(id)
    if (!row) return true
    ratings.delete(id)
    const bucket = targets.get(row.target)
    bucket.delete(ref(rater, row.targetSeq))
    if (!bucket.size) targets.delete(row.target)
    return true
  }
  function byTarget (target, cursor, visible, now = Date.now()) {
    if (!hex(target) || !millis(now)) return null
    const rows = [...(targets.get(target)?.values() || [])]
    rows.sort((a, b) => newest(b, a))
    const result = page(
      rows,
      cursor,
      row => visibleTo(visible, target) && visibleTo(visible, row.author),
      row => ({ ref: ref(row.author, row.seq) }),
      now
    )
    return result && { items: result.items, next: result.next }
  }
  // Copies of every rating an author's listings received, for the seeder
  // to keep while that diary is away (oldest first).
  function ratingsFor (target) {
    if (!hex(target)) return []
    const rows = [...(targets.get(target)?.values() || [])]
    rows.sort((a, b) => newest(b, a))
    return rows.map(({ target, targetSeq, author, seq, atMs }) => ({ target, targetSeq, rater: author, seq, atMs }))
  }
  function removeDiary (author) {
    if (!hex(author)) return false
    for (const row of [...(authors.get(author) || [])]) dropEntry(row)
    diaries.delete(author)
    for (const row of [...ratings.values()]) {
      if (row.author === author || row.target === author) removeRating(row.author, row.seq)
    }
    return true
  }
  function recent ({ limit = RECENT_MAX, visible, now = Date.now() } = {}) {
    if (!millis(now) || !Number.isSafeInteger(limit) || limit < 0) return []
    const cap = Math.min(limit, RECENT_MAX)
    if (cap === 0) return []
    const rows = []
    for (const d of diaries.values()) {
      for (const row of d.roots.values()) {
        // A future root must not take a seat, or it would push an in-window
        // root out of this bounded list.
        if (future(row, now) || row.stale || row.status === 'vendido' || !visibleTo(visible, row.author)) continue
        const i = prefix(rows, other => newest(other, row) <= 0)
        if (i >= cap) continue
        rows.splice(i, 0, row)
        if (rows.length > cap) rows.pop()
      }
    }
    return rows.map(row => ref(row.author, row.seq))
  }
  function stats () {
    let stateListings = 0
    for (const d of diaries.values()) stateListings += d.roots.size
    return {
      entries: entries.size,
      authors: authors.size,
      terms: terms.size,
      postings,
      ratings: ratings.size,
      targets: targets.size,
      diaries: diaries.size,
      stateListings,
      stateLive: stateListings
    }
  }
  return {
    state: guarded(state, () => new Map()),
    upsertListing: guarded(upsertListing, () => false),
    applyEdit: guarded(applyEdit, () => false),
    setStatus: guarded(setStatus, () => false),
    markDeleted: guarded(markDeleted, () => false),
    add: guarded(add, () => false),
    update: guarded(update, () => false),
    remove: guarded(remove, () => false),
    removeDiary: guarded(removeDiary, () => false),
    query: guarded(query, () => null),
    byAuthor: guarded(byAuthor, () => null),
    addRating: guarded(addRating, () => false),
    removeRating: guarded(removeRating, () => false),
    byTarget: guarded(byTarget, () => null),
    ratingsFor: guarded(ratingsFor, () => []),
    recent: guarded(recent, () => []),
    stats
  }
}

module.exports = { createFeiraIndex }
