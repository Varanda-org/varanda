// The Avisos tab's building blocks: follow lines, seen ids (the node's
// opaque `seen` tokens, never follower keys), page merging, the notice shown
// in place of the list and the fixed texts. Pure: no imports and no globals,
// so Node tests load it directly.

export const FOLLOW_BACK_LABEL = 'Seguir de volta'
export const EMPTY_TITLE = 'Ninguém novo por aqui'
export const EMPTY_TEXT = 'Quando alguém começar a seguir você, aparece aqui.'
export const NOTICES_WEB_ONLY_MESSAGE = 'Nesta versão, os Avisos só funcionam na versão web no site da associação.'
export const NOTICES_OFFLINE_MESSAGE = 'Os Avisos precisam de conexão com o semeador.'
export const NOTICES_UNSUPPORTED_MESSAGE = 'O semeador desta associação ainda não envia avisos.'
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

// "Bia começou a seguir você", or "Alguém" when the title is "sem nome" or
// not a non-empty string. The title is the only text used.
export function noticeLine (who) {
  const title = who.title
  if (typeof title !== 'string' || title.length === 0 || title === UNNAMED_TITLE) {
    return 'Alguém começou a seguir você'
  }
  return title + ' começou a seguir você'
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
// keys with the identity secret (docs/rpc.md 5.23), so nothing derivable
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
// that does not move ends the list (compared by value). `live` false between
// pages stops early with what was read. -> { notices, next, incomplete,
// supported }, one page's shape; a page with supported false is returned as
// is. request: (method, params) => Promise.
export async function readNotices (request, { limit, after = null, maxContinuations = NOTICES_AUTO_PAGES, live = () => true }) {
  let notices = []
  let cursor = after
  let incomplete = false
  for (let reads = 0; ; reads++) {
    const page = await request('notices.list', cursor === null ? { limit } : { limit, after: cursor })
    if (page.supported === false) return page
    notices = mergePage(notices, page.notices).items
    incomplete = incomplete || page.incomplete === true
    const stuck = page.next !== null && cursor !== null && page.next.at === cursor.at && page.next.key === cursor.key
    const next = stuck ? null : page.next
    if (next === null || notices.length >= limit || reads >= maxContinuations || !live()) {
      return { notices, next, incomplete, supported: true }
    }
    cursor = next
  }
}

export function withoutAuthor (items, key) {
  return items.filter((item) => item.key !== key)
}

export function isWebOnlyError (err) {
  return Boolean(err && err.code === 'USAGE' && WEB_ONLY_MESSAGES.includes(err.message))
}
