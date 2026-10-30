// Pure assembly of the Conversa (thread) and Membro (member) screens from
// two sources of different trust:
// - the seeder index (indexClient.js), which only says where to look: refs,
//   seq hints and counts; its claims are never shown as content;
// - diary.peek results from the node, whose entries were fetched and
//   verified against the author's signed log and already validated as
//   records (validRecordCopy) by the node.
// Rules: an item is built only from a peeked entry whose record is a post; a
// reply is kept only if its own signed replyTo is the focal post, and the
// parent only if the focal post's signed replyTo is that parent; the name
// comes from the peek's profile and the username only from the peek's
// verified `username` field (never from a raw record); refs the index did
// not list are ignored; a listed ref that cannot be shown counts in
// `unavailable`. Never throws on malformed input.

import { isAuthorKey, isRef } from './nav.js'
import { avatarOf } from './media/avatar.js'

// Same value as packages/rpc/lib/limits.js PEEK_SEQS_MAX.
export const PEEK_SEQS_MAX = 36

function parseRef (ref) {
  if (!isRef(ref)) return null
  const i = ref.indexOf(':')
  return { author: ref.slice(0, i), seq: Number(ref.slice(i + 1)) }
}

const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o)

// { author, seq } with a lowercase hex64 author and a safe seq >= 0, copied.
function target (t) {
  if (!isObject(t) || !isAuthorKey(t.author) || !Number.isSafeInteger(t.seq) || t.seq < 0) return null
  return { author: t.author, seq: t.seq }
}

const sameTarget = (t, r) => t !== null && r !== null && t.author === r.author && t.seq === r.seq

// Groups refs by author (first-seen order): seqs ascending and distinct, in
// chunks of at most PEEK_SEQS_MAX; the seeder's hints only on the first chunk
// and only when known (the keys are omitted otherwise). Each chunk is directly
// usable as diary.peek params { author, seqs[, profileSeq][, usernameSeq] }.
export function planPeeks ({ refs, authors } = {}) {
  const byAuthor = new Map()
  for (const ref of Array.isArray(refs) ? refs : []) {
    const r = parseRef(ref)
    if (r === null) continue
    if (!byAuthor.has(r.author)) byAuthor.set(r.author, new Set())
    byAuthor.get(r.author).add(r.seq)
  }
  const plan = []
  for (const [author, set] of byAuthor) {
    const seqs = [...set].sort((a, b) => a - b)
    const hint = isObject(authors) && Object.prototype.hasOwnProperty.call(authors, author) && isObject(authors[author]) ? authors[author] : {}
    for (let i = 0; i < seqs.length; i += PEEK_SEQS_MAX) {
      const chunk = { author, seqs: seqs.slice(i, i + PEEK_SEQS_MAX) }
      // diary.peek accepts the hints only omitted or >= 1, never null.
      if (i === 0 && isSeq(hint.profileSeq)) chunk.profileSeq = hint.profileSeq
      if (i === 0 && isSeq(hint.usernameSeq)) chunk.usernameSeq = hint.usernameSeq
      plan.push(chunk)
    }
  }
  return plan
}

// The peek result for an author, or null when absent or for another key.
function peekOf (peeked, author) {
  if (!(peeked instanceof Map)) return null
  const peek = peeked.get(author)
  if (!isObject(peek) || (peek.key !== undefined && peek.key !== author)) return null
  return peek
}

function identity (peek) {
  const profile = peek && isObject(peek.profile) && typeof peek.profile.name === 'string'
    ? { name: peek.profile.name, bio: typeof peek.profile.bio === 'string' ? peek.profile.bio : '', avatar: avatarOf(peek.profile.avatar) }
    : null
  const username = peek && typeof peek.username === 'string' ? peek.username : null
  return { profile, username }
}

function recordAt (peek, seq) {
  if (!peek || !Array.isArray(peek.entries)) return null
  for (const e of peek.entries) {
    if (isObject(e) && e.seq === seq && isObject(e.record)) return e.record
  }
  return null
}

// Minimal post shape (the node already validated the record with the same
// rules as records.js): text and at strings, replyTo null or a target, quote
// absent/null or a target and never with a replyTo, media absent or a list.
function postItem (author, seq, record, peek) {
  if (record.type !== 'post' || typeof record.text !== 'string' || typeof record.at !== 'string') return null
  const replyTo = record.replyTo === null ? null : target(record.replyTo)
  if (record.replyTo !== null && replyTo === null) return null
  const hasQuote = record.quote !== undefined && record.quote !== null
  const quote = hasQuote ? target(record.quote) : null
  if (hasQuote && (quote === null || replyTo !== null)) return null
  if (record.media !== undefined && !Array.isArray(record.media)) return null
  const { profile, username } = identity(peek)
  return {
    kind: 'post',
    author,
    seq,
    at: record.at,
    text: record.text,
    replyTo,
    quote,
    media: Array.isArray(record.media) && record.media.length > 0 ? record.media.slice() : null,
    name: profile ? profile.name : null,
    username,
    avatar: profile ? profile.avatar : null
  }
}

function repostItem (author, seq, record, peek) {
  if (record.type !== 'repost' || record.on !== true || typeof record.at !== 'string') return null
  const to = target(record.to)
  if (to === null || to.seq < 1) return null
  const { profile, username } = identity(peek)
  return { kind: 'repost', author, seq, at: record.at, to, name: profile ? profile.name : null, username, avatar: profile ? profile.avatar : null }
}

function lookupPost (peeked, ref) {
  const r = typeof ref === 'string' ? parseRef(ref) : null
  if (r === null) return null
  const peek = peekOf(peeked, r.author)
  const record = recordAt(peek, r.seq)
  return record === null ? null : postItem(r.author, r.seq, record, peek)
}

export function assembleThread ({ focal, index, peeked } = {}) {
  const f = parseRef(focal)
  const post = f === null ? null : lookupPost(peeked, focal)
  const listed = isObject(index) && index.ref === focal ? index : null
  let unavailable = 0
  let parent = null
  if (listed && listed.parent !== null && listed.parent !== undefined) {
    const p = parseRef(listed.parent)
    const candidate = p !== null && post !== null && sameTarget(post.replyTo, p) ? lookupPost(peeked, listed.parent) : null
    if (candidate) parent = candidate
    else unavailable++
  }
  const replies = []
  const seen = new Set()
  for (const ref of listed && Array.isArray(listed.replies) ? listed.replies : []) {
    if (seen.has(ref)) continue
    seen.add(ref)
    const item = f === null ? null : lookupPost(peeked, ref)
    if (item && sameTarget(item.replyTo, f)) replies.push(item)
    else unavailable++
  }
  return { parent, post, replies, unavailable }
}

// Items in index order (newest first): posts (replies and quotes included)
// and reposts still on; `unavailable` counts listed seqs that cannot be shown.
export function assembleMember ({ author, index, peeked } = {}) {
  if (!isAuthorKey(author)) return { profile: null, username: null, items: [], unavailable: 0 }
  const peek = peekOf(peeked, author)
  const { profile, username } = identity(peek)
  const items = []
  let unavailable = 0
  const seen = new Set()
  for (const seq of isObject(index) && Array.isArray(index.posts) ? index.posts : []) {
    if (!isSeq(seq) || seen.has(seq)) continue
    seen.add(seq)
    const record = recordAt(peek, seq)
    const item = record === null ? null : (postItem(author, seq, record, peek) || repostItem(author, seq, record, peek))
    if (item) items.push(item)
    else unavailable++
  }
  return { profile, username, items, unavailable }
}
