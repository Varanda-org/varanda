// The keys of the browser outbox in localStorage (outboxStore.web.js). The
// sealed queue lives under OUTBOX_KEY. Builds from before the seal kept their
// clear v1 items under LEGACY_OUTBOX_KEY and rewrite the whole value there on
// every change, so a tab still running one of them would overwrite a sealed
// queue kept under the same key (`{ v: 1, items: [] }` erases it). Their
// items are merged into the new key instead. Pure: the storage is a
// parameter ({ getItem, setItem, removeItem }, localStorage in the app), so
// Node tests run it. Natively the queue is a file (outboxStore.native.js).
//
// An old tab stays open after a deploy and keeps the items it merged in memory:
// it may send one and rewrite the old key afterwards. Merged items are never
// sent on their own (they wait for the person's "Enviar"), and so that the
// person is not offered to send again what the old tab sent:
// - an item already 'sending' under the old key is merged as 'uncertain': its
//   request may still be in flight, and a reconciliation here would find it
//   absent and put it back to 'queued';
// - a queued item merged from the old key carries a mark in the stored item
//   (`migrated`: the merged copy's state, attemptAt and floorSeq), so every
//   window of this build, in this page session or a later one, follows the old
//   tab the same way on the shared queue. While the item is still that queued
//   copy, an old-key value that holds it past 'queued' moves it to 'uncertain'
//   ('sending' and 'uncertain': this window cannot know the outcome) or
//   'failed', and drops the mark. Discarding it drops the mark too
//   (forgetMigrated); releasing ("Enviar") or retrying it does not: until this
//   build claims it ('sending', which no longer matches the stamp), an old-tab
//   claim still makes the approved item 'uncertain', and the drain never sends
//   an 'uncertain' item. A planted mark can only make an item wait: it never
//   makes one sendable.
// The values read are each storage event's newValue, in order (the provider
// passes it: the old key itself may already be gone), then the old key as it
// is now.
//
// An old-key value that no longer holds the item is NOT evidence: once a merge
// removed the old key, an old tab reads an empty queue and writes
// `{ v: 1, items: [] }` on its next change (a wake, a retry, the filter after a
// send) without having sent anything. The old build cannot send an item it
// does not hold: every change re-reads the old key, and its drain saves the
// 'sending' claim there before the request (a claim it cannot save sends
// nothing). So a send by the old tab always shows as an old-key value with the
// item 'sending'.
//
// An id merged once, or found already in the queue, is remembered under
// MERGED_IDS_KEY (the newest MERGED_IDS_MAX), so an old-key value that comes
// back after the removal (an old tab's write racing it, or a removal that
// failed) does not merge again an item that was sent or discarded here since.
// A list that could not be saved is completed by the next load that reads
// those ids under the old key.
//
// Not covered (no lock between tabs): an old-key value with the item past
// 'queued' that no window of this build read (none was open, or what it led to
// could not be saved) followed by one without the item; and this build's claim
// (right after the person's "Enviar") landing before the old tab's claim
// arrives here: both tabs send. The merge has no per-author cap (keeping the
// old key for what does not fit would let the old tab claim items already
// merged): while an old tab keeps writing new items, the queue can hold more
// than OUTBOX_MAX for an author, and a new post here fails as full (enqueue)
// until the person sends or deletes some.

import { markFailed, markUncertain, parseOutbox, serializeOutbox } from './outbox'

export const OUTBOX_KEY = 'varanda-web-outbox-v2'
export const LEGACY_OUTBOX_KEY = 'varanda-web-outbox'
export const MERGED_IDS_KEY = 'varanda-web-outbox-merged'
export const MERGED_IDS_MAX = 256

const ID = /^[0-9a-f]{16}$/

// What changes when a window sends the item (claim, retry, reconcile); not the
// backoff time, which a wake rewrites, nor the seal, which keeps these fields.
const stampOf = (item) => `${item.state}|${item.attemptAt}|${item.floorSeq}`

function unmarked (item) {
  if (item.migrated === undefined) return item
  const { migrated, ...rest } = item
  return rest
}

// Whether the item is still the queued copy merged from the old key.
export function followsLegacy (item) {
  return item.state === 'queued' && typeof item.migrated === 'string' && item.migrated === stampOf(item)
}

// The person discarded the item: the old tab's view of it no longer matters.
// The same array when there is no mark to drop.
export function forgetMigrated (items, id) {
  if (!items.some((item) => item.id === id && item.migrated !== undefined)) return items
  return items.map((item) => item.id === id ? unmarked(item) : item)
}

// A storage event the queue depends on (null: the storage was cleared).
export function isOutboxKey (key) {
  return key === OUTBOX_KEY || key === LEGACY_OUTBOX_KEY || key === null
}

// What the provider passes to loadMigrated for a storage event: the value an
// older build wrote under its key, or null.
export function seenOf (event) {
  return event !== null && typeof event === 'object' && event.key === LEGACY_OUTBOX_KEY && typeof event.newValue === 'string'
    ? event.newValue
    : null
}

// The ids merged before, as stored (untrusted: anything else reads as none).
function mergedIds (storage) {
  let data
  try {
    data = JSON.parse(storage.getItem(MERGED_IDS_KEY))
  } catch {
    return []
  }
  if (!Array.isArray(data) || data.length > MERGED_IDS_MAX) return []
  return data.filter((id) => typeof id === 'string' && ID.test(id))
}

// `items` after what the old-key items `theirs` show of the items that follow
// the old tab: only an item past 'queued' there changes the copy here.
function followLegacy (items, theirs) {
  const byId = new Map()
  for (const item of theirs) if (!byId.has(item.id)) byId.set(item.id, item)
  let next = items
  for (const item of items) {
    if (!followsLegacy(item)) continue
    const other = byId.get(item.id)
    if (other === undefined || other.state === 'queued') continue
    next = other.state === 'failed' ? markFailed(next, item.id, other.lastError) : markUncertain(next, item.id)
    next = forgetMigrated(next, item.id)
  }
  return next
}

// An item as merged from the old key: 'sending' becomes 'uncertain' (the old
// tab's request may be in flight), and a queued one is marked.
function mergedItem (item) {
  const plain = unmarked(item.state === 'sending' ? markUncertain([item], item.id)[0] : item)
  return plain.state === 'queued' ? { ...plain, migrated: stampOf(plain) } : plain
}

// The stored queue, with what the old key showed applied (`seen`: a storage
// event's newValue for it, read before the old key as it is now; see the top
// of the file) and the items found under LEGACY_OUTBOX_KEY merged in by id
// (an id already queued keeps the queued item, and an id merged before is not
// merged again). The result is saved before the old key is removed, and the
// old key is removed only while its raw value is still the one read: a crash
// between the two, or an old tab writing in between, only merges the same ids
// again. When the result cannot be saved, the old key stays and its items are
// left out until it can be (what `seen` alone showed is then lost). Throws
// only when the storage cannot be read.
export function loadMigrated (storage, seen = null) {
  const current = parseOutbox(storage.getItem(OUTBOX_KEY))
  const legacyRaw = storage.getItem(LEGACY_OUTBOX_KEY)
  const legacyItems = legacyRaw === null ? [] : parseOutbox(legacyRaw)
  let next = typeof seen === 'string' ? followLegacy(current, parseOutbox(seen)) : current
  next = followLegacy(next, legacyItems)

  const ids = new Set(next.map((item) => item.id))
  const done = legacyItems.length > 0 ? new Set(mergedIds(storage)) : new Set()
  // The ids of the old key not yet in the list: merged now, or already queued.
  const fresh = new Set()
  const added = []
  for (const item of legacyItems) {
    if (done.has(item.id) || fresh.has(item.id)) continue
    fresh.add(item.id)
    if (ids.has(item.id)) continue
    ids.add(item.id)
    added.push(mergedItem(item))
  }
  const merged = added.length > 0 ? [...next, ...added] : next
  if (merged !== current) {
    try {
      storage.setItem(OUTBOX_KEY, serializeOutbox(merged))
    } catch {
      return current
    }
  }
  if (fresh.size > 0) {
    try {
      storage.setItem(MERGED_IDS_KEY, JSON.stringify([...done, ...fresh].slice(-MERGED_IDS_MAX)))
    } catch {}
  }
  if (legacyRaw === null) return merged
  try {
    if (storage.getItem(LEGACY_OUTBOX_KEY) === legacyRaw) storage.removeItem(LEGACY_OUTBOX_KEY)
  } catch {}
  return merged
}
