// The Espiadinha screen's building blocks: row keys, page merging, the notice
// shown in place of the list, useSocial's needs for a page, the error tests and
// the fixed texts, plus the in-memory warm state shared with Avisos.
// No platform imports, so Node tests load it directly. The rule text
// mirrors PEEK_RULE in packages/core/lib/peek.js (the app cannot import it).

import { validThumbs } from './media/variant.js'

export const PEEK_OFFLINE_MESSAGE = 'Confira sua internet.'
export const PEEK_RULE_TEXT = 'A Espiadinha mostra a publicação mais recente de cada diário que você não segue, da mais nova para a mais antiga; depois a segunda e, por fim, a terceira mais recente de cada um, do mesmo jeito: sem curtidas, sem sugestões e sem pesos escondidos.'
export const PEEK_SHORT_TEXT = 'Até três publicações de cada diário que você não segue.'

const WEB_ONLY_MESSAGES = ['método desconhecido', 'Espiadinha disponível só no navegador']
// The browser node's answer to a continuation whose snapshot expired or is
// gone (packages/web-member/lib/peek.js): the rows shown stay valid, only the
// cursor is dead, so the list asks for a refresh instead of ending.
const EXPIRED_MESSAGE = 'A lista expirou; atualize para continuar.'

export function peekKey (item) {
  return item.author + ':' + item.seq
}

// Appends the page's items to the current ones in the page's own order,
// skipping any key already present (including repeats inside the page). The
// inputs are never mutated.
export function mergePage (currentItems, pageItems) {
  const seen = new Set(currentItems.map(peekKey))
  const items = currentItems.slice()
  let added = 0
  for (const item of pageItems) {
    const key = peekKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
    added += 1
  }
  return { items, added }
}

// An incomplete page with a cursor is not the end even when empty: a node
// that pages candidates in batches may finish a read before any of them had
// a row to show, and only a read with that cursor goes on from there.
export function isLastPeekPage (page) {
  return page.next === null || (page.items.length === 0 && page.incomplete !== true)
}

// One read of such a node covers 8 batches of 48 diaries, so a person who
// follows nearly all of the 384 newest gets incomplete pages with nothing
// to show. A later page that added nothing to the list then reads on at once
// from its cursor, at most this many more reads per load, before the list's
// dry-page pause counts it. A peek read changes no state and a failed one
// ends the chain, so this never repeats a failed call. The cursor is not
// compared: an empty page held for candidates carries the cursor it was
// asked with while the node's candidate traversal moves on, so only max
// bounds a node that never gets further.
export const PEEK_EMPTY_FOLLOW_MAX = 3

export function followsEmptyPage ({ page, added, hops, max = PEEK_EMPTY_FOLLOW_MAX }) {
  return page.incomplete === true && page.next !== null && added === 0 && hops < max
}

// One load of later pages: read(after) asks for a page; take(page, after)
// puts it on the list and returns how many rows it added, or null to read no
// further (a newer read took over, the tab was hidden). A rejected read ends
// the load and reaches the caller. -> the last page read.
export async function readLaterPages ({ after, read, take, max = PEEK_EMPTY_FOLLOW_MAX }) {
  for (let hops = 0; ; hops++) {
    const page = await read(after)
    const added = take(page, after)
    if (added === null || !followsEmptyPage({ page, added, hops, max })) return page
    after = page.next
  }
}

// A live first page held behind the 'ver novidades' pill while the cached
// rows stay on screen. -> { fresh }: true when the page has a row the list
// does not show. The order is by rounds, not by time, so a row's position
// says nothing about whether it is new.
export function holdPeekPage ({ shown, rows }) {
  const have = new Set(Array.isArray(shown) ? shown.map(peekKey) : [])
  const fresh = Array.isArray(rows) && rows.some((item) => !have.has(peekKey(item)))
  return { fresh }
}

// A live first page over stored rows. -> null when it must replace the list
// (block.list has not answered, so no stored row could be drawn and the live
// rows would sit behind an empty list), else the list to show: the stored
// rows stay in their order (by rounds, not by time; a live page is a new
// sample), those the page has are replaced in place and leave `unconfirmed`,
// and `fresh` says whether the page has a row not shown (the pill).
export function holdLivePage ({ items, unconfirmed, rows, blocksOk }) {
  if (blocksOk !== true) return null
  const live = new Map(rows.map((item) => [peekKey(item), item]))
  const kept = items.map((item) => live.get(peekKey(item)) || item)
  const left = new Set()
  if (unconfirmed) for (const k of unconfirmed) if (!live.has(k)) left.add(k)
  return { items: kept, unconfirmed: left.size > 0 ? left : null, fresh: holdPeekPage({ shown: kept, rows }).fresh }
}

// A later page (or the held page at the end of the list) over the list: a
// row already listed is replaced in place by the page's copy and, if it was
// a stored row, is confirmed (it leaves `unconfirmed`); the others go after,
// in the page's order. -> { items, unconfirmed, added }
export function appendPeekPage ({ items, unconfirmed, rows }) {
  const page = new Map()
  for (const item of rows) if (!page.has(peekKey(item))) page.set(peekKey(item), item)
  const replaced = items.map((item) => page.get(peekKey(item)) || item)
  const merged = mergePage(replaced, rows)
  let left = unconfirmed || null
  if (left !== null) {
    const rest = new Set()
    for (const k of left) if (!page.has(k)) rest.add(k)
    left = rest.size > 0 ? rest : null
  }
  return { items: merged.items, unconfirmed: left, added: merged.added }
}

// The held page replaces the list whole. -> { items, unconfirmed }
export function takePeekPage (rows) {
  return { items: mergePage([], rows).items, unconfirmed: null }
}

// Whether a held page goes on screen without the pill: the block gate draws
// no row (all stored rows hidden or gone), so the list would look empty.
export function takesHeldPage ({ held, drawn }) {
  return held === true && drawn === 0
}

// Every author a row shows or names, lowercase: the poster (the reposter for
// a repost), the reposted original's author and the quoted or replied-to
// author. A field that is not a string stays as it is, so the block gate
// (../cachedRows.js) hides that row instead of guessing.
export function peekRowAuthors (item) {
  const out = []
  const add = (a) => out.push(typeof a === 'string' ? a.toLowerCase() : a)
  if (!item || typeof item !== 'object') return [null]
  add(item.author)
  for (const t of [item.to, item.quote, item.replyTo]) {
    if (t !== null && t !== undefined) add(typeof t === 'object' ? t.author : null)
  }
  return out
}

// The kept-store entries ({ kind, author, d }) of the photos the stored rows
// show: the avatar, the post photos, their thumbnails (only a list that
// passes validThumbs, as the rows' own codec) and the link card's image, all
// filed under the row's author (as PostRow loads them with persist 'peek').
export function peekKeptEntries (rows) {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.author !== 'string') continue
    if (row.avatar) out.push({ kind: 'peekAvatars', author: row.author, d: row.avatar })
    if (Array.isArray(row.media)) for (const d of row.media) out.push({ kind: 'peekPosts', author: row.author, d })
    if (validThumbs(row.thumbs, row.media)) {
      for (const d of row.thumbs) if (d !== null) out.push({ kind: 'peekPosts', author: row.author, d })
    }
    if (row.preview && row.preview.image) out.push({ kind: 'peekPosts', author: row.author, d: row.preview.image })
  }
  return out
}

// What a save retains: the saved rows' photos and those of the first-page
// rows still drawn (the only ones kept as peek), so a newer page saved while
// it waits behind the pill never deletes a photo on screen.
export function peekRetainEntries ({ saved, drawn, firstKeys }) {
  const shown = firstKeys ? drawn.filter((item) => firstKeys.has(peekKey(item))) : []
  return peekKeptEntries(saved).concat(peekKeptEntries(shown))
}

export function withoutAuthor (items, author) {
  return items.filter((item) => item.author !== author)
}

// `followed` maps a lowercase author to the stamp of the latest follow.
export function withoutFollowed (items, followed) {
  if (followed.size === 0) return items
  return items.filter((item) => typeof item.author !== 'string' || !followed.has(item.author.toLowerCase()))
}

// Both ways to follow (the row and the search) go through here, so a page
// read before the follow never brings the author back.
export function recordFollow (followed, stamp, items, author) {
  followed.set(author.toLowerCase(), stamp)
  return withoutAuthor(items, author)
}

// The notice shown in place of the list, or null. Web-only wins over offline.
export function peekNotice ({ supported, hosted, online, loadedAt }) {
  if (hosted !== true || supported === false) return 'web-only'
  if (online === false && loadedAt === null) return 'offline'
  return null
}

// These reads use short links, independent of sync. The seeder accepts 32
// external sockets by default: serialize them so an opening phone does not
// hold three at once (sync, Espiadinha and Avisos). The warm read starts only
// after this long with no node request in flight.
export const PEEK_WARM_QUIET_MS = 500

export function shouldWarmPeek ({ hosted, online, phase, seederVerified, visible, active, loadedAt, loading, refreshing, unsupported, attempted, busy }) {
  return hosted === true && online !== false && phase === 'ready' && seederVerified === true &&
    visible !== false && active === false && loadedAt === null && !loading && !refreshing &&
    !unsupported && attempted !== true && busy !== true
}

let warmState = null
const warmListeners = new Set()

export function getPeekWarmState () {
  return warmState
}

export function subscribePeekWarm (listener) {
  warmListeners.add(listener)
  return () => warmListeners.delete(listener)
}

export function updatePeekWarmState (epoch, patch) {
  // A late completion must neither release nor refuse a newer epoch's read.
  if (warmState !== null && epoch < warmState.epoch) return
  const current = warmState !== null && warmState.epoch === epoch
    ? warmState
    : { epoch, eligible: false, pending: false, attempted: false, busy: false }
  const next = { ...current, ...patch }
  if (warmState === current && Object.keys(next).every((key) => next[key] === current[key])) return
  warmState = next
  for (const listener of warmListeners) listener()
}

export function isSeederBusyError (err) {
  // Both short-link readers translate a 1013 / lotado close to this RPC error.
  return Boolean(err && err.code === 'USAGE' && err.message === 'Semeador ocupado; tente novamente em instantes.')
}

export function isWebOnlyError (err) {
  return Boolean(err && err.code === 'USAGE' && WEB_ONLY_MESSAGES.includes(err.message))
}

export function isExpiredPeekError (err) {
  return Boolean(err && err.code === 'USAGE' && err.message === EXPIRED_MESSAGE)
}

// The note under the list for the diaries a page left out, or null. The
// reasons are in the help sheet 'ausentes' (src/help.js).
export function skippedText (n) {
  if (!Number.isSafeInteger(n) || n < 1) return null
  return n === 1 ? '1 diário não aparece.' : String(n) + ' diários não aparecem.'
}

// Same as ARua's refOf (a lowercase author:seq, or null), kept here so this
// file stays import-free.
function refOf (t) {
  if (!t || typeof t.author !== 'string' || !Number.isSafeInteger(t.seq) || t.seq < 1) return null
  return t.author.toLowerCase() + ':' + t.seq
}

// useSocial's ingest arguments for a page: the posts are originals at hand
// (a quote or a reply of a post on the list resolves locally); the posts
// they quote or answer and the originals of reposts are resolved; no author
// is followed. A repost's list key (peekKey) is the reposter's author:seq,
// but what it shows and needs is the original's (`to`).
// `unconfirmed` (optional): keys of stored rows no live page confirmed yet.
// They never become originals (`local`), so a live quote or repost of a post
// deleted since the snapshot still asks its diary.
export function pageNeeds (items, unconfirmed = null) {
  const local = new Map()
  const shown = []
  const need = []
  for (const item of items) {
    if (item.kind === 'repost') {
      const ref = refOf(item.to)
      if (ref !== null) {
        shown.push(ref)
        need.push(ref)
      }
      continue
    }
    const ref = peekKey(item)
    if (unconfirmed === null || !unconfirmed.has(ref)) local.set(ref, item)
    shown.push(ref)
    for (const r of [refOf(item.quote), refOf(item.replyTo)]) if (r !== null) need.push(r)
  }
  return { local, shown, need, authors: [] }
}
