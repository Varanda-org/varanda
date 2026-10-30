// The Avisos tab's building blocks: lines for a follow, a reply, a quote and
// a mention, seen ids (the node's opaque `seen` tokens, never follower keys),
// page merging, the notice shown in place of the list and the fixed texts.
// Pure: no imports and no globals, so Node tests load it directly.

export const EMPTY_TITLE = 'Ninguém novo por aqui'
export const EMPTY_TEXT = 'Quando alguém começar a seguir você, responder, citar ou mencionar você, aparece aqui.'
export const NOTICES_WEB_ONLY_MESSAGE = 'Nesta versão, os Avisos só funcionam na versão web no site da associação.'
export const NOTICES_OFFLINE_MESSAGE = 'Confira sua internet.'
export const NOTICES_UNSUPPORTED_MESSAGE = 'Os Avisos ainda não estão disponíveis nesta associação.'
// activity false: this seeder still speaks the follows-only notices channel.
export const ACTIVITY_QUIET_TEXT = 'O semeador desta associação ainda só envia avisos de quem seguiu você.'
export const NOTICES_INCOMPLETE_TEXT = 'Alguns avisos ainda podem chegar.'
export const SEEN_STORAGE_KEY = 'varanda-notices-seen'
// Five minutes between polls while the tab is on screen.
export const NOTICES_POLL_MS = 300000
export const SEEN_MAX = 2048
// Pages read on their own after a short one with a cursor, per user action.
export const NOTICES_AUTO_PAGES = 4

// Mirrors UNNAMED in who.js (the app cannot import it).
const UNNAMED_TITLE = 'sem nome'

const WEB_ONLY_MESSAGES = ['método desconhecido', 'avisos disponíveis só no navegador']

// A row from an older node has no kind. Anything else is not one of the four
// notices this tab shows, so it reads as a follow too.
export function noticeKind (item) {
  const kind = item && item.kind
  if (kind === 'follow' || kind === 'reply' || kind === 'quote' || kind === 'mention') return kind
  return 'follow'
}

// "Bia começou a seguir você" (respondeu, citou, mencionou for the other
// kinds), or "Alguém" when the title is "sem nome" or not a non-empty
// string. The title is the only text used. kind defaults to follow.
export function noticeLine (who, kind = 'follow') {
  const title = who.title
  const name = typeof title !== 'string' || title.length === 0 || title === UNNAMED_TITLE ? 'Alguém' : title
  if (kind === 'reply') return name + ' respondeu à sua publicação'
  if (kind === 'quote') return name + ' citou sua publicação'
  if (kind === 'mention') return name + ' mencionou você'
  return name + ' começou a seguir você'
}

// A follow opens no post. A reply, quote or mention points at the signed
// block, in the '<key>:<seq>' form a conversa screen uses (nav.js).
export function noticeRef (item) {
  if (noticeKind(item) === 'follow') return null
  return item.key + ':' + item.seq
}

// Newest first by Date.parse(at): string order breaks for negative-year ISO
// dates (feed.js). Same instant: key ascending, then seq descending, so a
// later block of the same diary stays above the earlier one.
export function compareNotices (a, b) {
  const byTime = Date.parse(b.at) - Date.parse(a.at)
  if (byTime) return byTime
  if (a.key < b.key) return -1
  if (a.key > b.key) return 1
  return (b.seq - a.seq) || 0
}

// seq identifies the signed follow, so a later follow of the same diary is a
// new id even when `at` repeats. In memory only (list keys, merging): what
// is stored is the row's `seen` token, never this id.
export function noticeId (item) {
  return item.key + ':' + item.seq
}

const HEX32 = /^[0-9a-f]{32}$/

function isHex32 (s) {
  return typeof s === 'string' && HEX32.test(s)
}

// The stored id of a notice: its `seen` token, 32 lowercase hex the node
// keys with the identity secret (docs/rpc.md 5.28), so nothing derivable
// from a follower key is ever stored. null when the row has none.
function seenOf (item) {
  return item && isHex32(item.seen) ? item.seen : null
}

// True when some loaded notice with a valid seen token is absent from the
// seen list. A row without a valid token never counts as new.
export function hasNew (items, seenIds) {
  const seen = new Set(seenIds)
  for (const item of items) {
    const id = seenOf(item)
    if (id !== null && !seen.has(id)) return true
  }
  return false
}

// 32 lowercase hex from 16 bytes of randomBytes(n) => Uint8Array, injected
// so this file stays pure. Throws on anything but 16 bytes.
export function randomToken (randomBytes) {
  const bytes = randomBytes(16)
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error('randomBytes must return 16 bytes')
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

// A uniform integer in [0, n) from 32-bit draws, by rejection sampling (no
// modulo bias).
function randomIndex (randomBytes, n) {
  const limit = Math.floor(0x100000000 / n) * n
  for (;;) {
    const bytes = randomBytes(4)
    if (!(bytes instanceof Uint8Array) || bytes.length !== 4) throw new Error('randomBytes must return 4 bytes')
    const x = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3]
    if (x < limit) return x % n
  }
}

// Fisher-Yates, in place.
function shuffle (arr, randomBytes) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIndex(randomBytes, i + 1)
    const tmp = arr[i]
    arr[i] = arr[j]
    arr[j] = tmp
  }
  return arr
}

// A fresh token not in `taken` (a collision of 128 random bits means the
// random source is broken: give up rather than loop).
function freshToken (randomBytes, taken) {
  for (let tries = 0; tries < 16; tries++) {
    const id = randomToken(randomBytes)
    if (!taken.has(id)) return id
  }
  throw new Error('randomBytes keeps repeating')
}

// A new array of exactly `size` entries: every id of `ids` (deduplicated,
// the last `size` when longer) and random tokens in the other slots, in a
// uniformly shuffled order, so the stored list never shows how many notices
// were seen (real and padding entries look the same). Never mutates `ids`.
export function padSeen (ids, randomBytes, size = SEEN_MAX) {
  const real = [...new Set(ids)].slice(-size)
  const taken = new Set(real)
  const out = real.slice()
  while (out.length < size) {
    const id = freshToken(randomBytes, taken)
    taken.add(id)
    out.push(id)
  }
  return shuffle(out, randomBytes)
}

// Marks the valid seen tokens of `items` as seen in `stored` (the padded
// array read from storage, where every entry counts as seen). -> { ids,
// changed }. Nothing new: the same array, changed false. A stored array
// shorter than `size` (the first write, or an older unpadded v3 entry) is
// padded with every real id kept. Otherwise each new token replaces an entry
// chosen uniformly at random among the entries that are not tokens of
// `items` (a row on screen is never evicted), so the length stays `size`;
// should there be fewer such entries than new tokens, the newest new tokens
// that fit are kept. A row without a valid token is never stored. The
// inputs are never mutated.
export function markSeenPadded (stored, items, randomBytes, size = SEEN_MAX) {
  const have = new Set(stored)
  const onScreen = new Set()
  const newIds = []
  for (const item of items) {
    const id = seenOf(item)
    if (id === null) continue
    onScreen.add(id)
    if (have.has(id)) continue
    have.add(id)
    newIds.push(id)
  }
  if (newIds.length === 0) return { ids: stored, changed: false }
  if (stored.length !== size) {
    // Rows are newest first: appended oldest first, so the newest survive a cut.
    return { ids: padSeen([...stored, ...newIds.slice().reverse()], randomBytes, size), changed: true }
  }
  const evictable = []
  for (let i = 0; i < stored.length; i++) {
    if (!onScreen.has(stored[i])) evictable.push(i)
  }
  const fitting = newIds.slice(0, evictable.length)
  if (fitting.length === 0) return { ids: stored, changed: false }
  const ids = stored.slice()
  // A partial Fisher-Yates over the evictable slots picks them uniformly.
  for (let k = 0; k < fitting.length; k++) {
    const j = k + randomIndex(randomBytes, evictable.length - k)
    const tmp = evictable[k]
    evictable[k] = evictable[j]
    evictable[j] = tmp
    ids[evictable[k]] = fitting[k]
  }
  return { ids, changed: true }
}

// The ids from { v: 3, own, ids } when own is this key and ids holds 0 to
// SEEN_MAX entries, each 32 lowercase hex. Anything else, including a v1
// entry (raw follower keys), a v2 entry (salted digests a reader of the
// storage could confirm) and an over-long list, is []. Never throws.
export function parseSeen (text, ownKey) {
  try {
    const parsed = JSON.parse(text)
    if (!parsed || parsed.v !== 3 || parsed.own !== ownKey || !Array.isArray(parsed.ids)) return []
    if (parsed.ids.length > SEEN_MAX) return []
    for (const id of parsed.ids) {
      if (!isHex32(id)) return []
    }
    return parsed.ids
  } catch {
    return []
  }
}

export function serializeSeen (ownKey, ids) {
  return JSON.stringify({ v: 3, own: ownKey, ids })
}

// The notice shown in place of the list, or null. Web-only wins over
// unsupported, which wins over offline.
export function noticesNotice ({ hosted, supported, online, loadedAt }) {
  if (hosted !== true) return 'web-only'
  if (supported === false) return 'unsupported'
  if (online === false && loadedAt === null) return 'offline'
  return null
}

export function shouldPoll ({ hosted, online, visible }) {
  return hosted === true && online === true && visible === true
}

// Appends the page's notices to the current ones in the page's own order,
// skipping any id already present (including repeats inside the page). The
// inputs are never mutated.
export function mergePage (currentItems, pageItems) {
  const seen = new Set(currentItems.map(noticeId))
  const items = currentItems.slice()
  let added = 0
  for (const item of pageItems) {
    const id = noticeId(item)
    if (seen.has(id)) continue
    seen.add(id)
    items.push(item)
    added += 1
  }
  return { items, added }
}

// Only the cursor says so: a page can be empty while the node still has a
// cursor (every candidate behind it was filtered: already followed, blocked
// or unverified), and the followers after that gap come from the next page.
export function isLastNoticesPage (page) {
  return page.next === null
}

// One read of the list from `after`: the first page and, while a page holds
// fewer rows than `limit` and the node still has a cursor (a gap of filtered
// candidates), the pages after it, at most NOTICES_AUTO_PAGES more per call;
// past that the cursor is returned for the person to continue. A cursor
// that does not move ends the list (compared by value, seq included; two
// cursors with no seq still match). `live` false between pages stops early
// with what was read. -> { notices, next, incomplete, supported, activity }.
// activity is false when any page said so, and true when every page omits it
// or says true: an older node has no activity field and only sends follows.
// A page with supported false is returned as is.
// request: (method, params) => Promise.
export async function readNotices (request, { limit, after = null, maxContinuations = NOTICES_AUTO_PAGES, live = () => true }) {
  let notices = []
  let cursor = after
  let incomplete = false
  // Omitted activity is a node that only knows follows: not the quiet state.
  let activity = true
  for (let reads = 0; ; reads++) {
    const page = await request('notices.list', cursor === null ? { limit } : { limit, after: cursor })
    if (page.supported === false) return page
    notices = mergePage(notices, page.notices).items
    incomplete = incomplete || page.incomplete === true
    if (page.activity === false) activity = false
    // No seq on either side (undefined === undefined) still counts as stuck,
    // which is how a node that only sends follows pages today. A cursor that
    // advances only in seq is a new page.
    const nextPage = page.next
    const stuck = nextPage !== null && cursor !== null &&
      nextPage.at === cursor.at && nextPage.key === cursor.key && nextPage.seq === cursor.seq
    const next = stuck ? null : nextPage
    if (next === null || notices.length >= limit || reads >= maxContinuations || !live()) {
      return { notices, next, incomplete, supported: true, activity }
    }
    cursor = next
  }
}

// Following back clears that diary's follow notice. A reply, quote or
// mention from the same key is about a post and stays in the list.
export function withoutAuthor (items, key) {
  return items.filter((item) => item.key !== key || noticeKind(item) !== 'follow')
}

export function isWebOnlyError (err) {
  return Boolean(err && err.code === 'USAGE' && WEB_ONLY_MESSAGES.includes(err.message))
}
