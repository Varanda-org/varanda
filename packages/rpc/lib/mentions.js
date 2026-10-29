'use strict'

// '@nome' tokens inside a post's text. Mentions live in the text, not in a
// record key, because readers from before them skip a post whose key set
// they do not know (docs/protocol.md section 2). No Node built-ins: this file
// loads unchanged in a browser bundle, in Node and in Bare.

// Copies of methods.js: the username rule and the 6-hex fallback handle.
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const HEX6 = /^[0-9a-f]{6}$/
const RUN_CHAR = /^[A-Za-z0-9_]$/
const MENTION_MAX = 8

// A mention must notify only the name the text visibly shows, so the
// boundaries fail closed: invisible characters are looked past, and the
// visible neighbour must be one of the listed separators. Any other
// neighbour (a letter, mark or digit of any script) blocks the mention,
// because an unlisted one only costs a missed link, never a wrong notice.
const SEPARATOR_RANGES = [
  [0x00, 0x2f], [0x3a, 0x40], [0x5b, 0x5e], [0x60, 0x60], [0x7b, 0x7f],
  [0x85, 0x85], [0xa0, 0xa9], [0xab, 0xac], [0xae, 0xb1], [0xb4, 0xb4],
  [0xb6, 0xb8], [0xbb, 0xbb], [0xbf, 0xbf], [0xd7, 0xd7], [0xf7, 0xf7],
  [0x1680, 0x1680], [0x2000, 0x200a], [0x2010, 0x2029], [0x202f, 0x205f],
  // Symbols, minus the enclosed and dingbat digits and letters (U+2460-24FF,
  // U+2776-2793), which read as part of a name.
  [0x20a0, 0x20cf], [0x2190, 0x245f], [0x2500, 0x2775], [0x2794, 0x2bff],
  // CJK punctuation only: U+3005-3007, U+3021-302F, U+3031-3035 and
  // U+303B-303C are letters, marks or repeat signs.
  [0x3000, 0x3004], [0x3008, 0x3020], [0x3030, 0x3030], [0x3036, 0x3037],
  [0x303d, 0x303f],
  [0xff01, 0xff0f], [0xff1a, 0xff1f], [0xff3b, 0xff3e], [0xff40, 0xff40],
  [0xff5b, 0xff65],
  // Emoji, minus the enclosed alphanumerics (U+1F100-1F1E5); the regional
  // indicators that make flags stay.
  [0x1f000, 0x1f0ff], [0x1f1e6, 0x1faff]
]
const INVISIBLE_RANGES = [
  [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0x1d173, 0x1d17a], [0xe0000, 0xe0fff]
]
const AT = 0x40

function inRanges (cp, ranges) {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true
  return false
}

function isSeparator (cp) { return inRanges(cp, SEPARATOR_RANGES) }
function isInvisible (cp) { return inRanges(cp, INVISIBLE_RANGES) }

// Code point ending right before index i (a lone surrogate counts as itself).
function cpBefore (text, i) {
  const low = text.charCodeAt(i - 1)
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2)
    if (high >= 0xd800 && high <= 0xdbff) return { cp: text.codePointAt(i - 2), size: 2 }
  }
  return { cp: low, size: 1 }
}

function cpAt (text, i) {
  const cp = text.codePointAt(i)
  return { cp, size: cp > 0xffff ? 2 : 1 }
}

function leftBlocked (text, at) {
  let i = at
  while (i > 0) {
    const { cp, size } = cpBefore(text, i)
    if (isInvisible(cp)) { i -= size; continue }
    return cp === AT || !isSeparator(cp)
  }
  return false
}

function rightBlocked (text, from) {
  let i = from
  while (i < text.length) {
    const { cp, size } = cpAt(text, i)
    if (isInvisible(cp)) { i += size; continue }
    return !isSeparator(cp)
  }
  return false
}

function findMentions (text) {
  if (typeof text !== 'string') return []
  const mentions = []
  const tokens = /@([A-Za-z0-9_]+)/g
  let match
  while ((match = tokens.exec(text)) !== null) {
    const start = match.index
    if (leftBlocked(text, start) || rightBlocked(text, tokens.lastIndex)) continue
    const username = match[1].toLowerCase()
    if (!USERNAME_RE.test(username) || HEX6.test(username)) continue
    mentions.push({ start, end: tokens.lastIndex, username })
  }
  return mentions
}

function mentionTokens (text, max = MENTION_MAX) {
  if (typeof max !== 'number' || !(max >= 1)) return []
  max = Math.floor(max)
  const usernames = new Set()
  for (const { username } of findMentions(text)) {
    usernames.add(username)
    if (usernames.size >= max) break
  }
  return [...usernames]
}

function mentionSegments (text) {
  if (typeof text !== 'string') return []
  const segments = []
  let offset = 0
  for (const { start, end, username } of findMentions(text)) {
    if (start > offset) segments.push({ text: text.slice(offset, start), username: null })
    segments.push({ text: text.slice(start, end), username })
    offset = end
  }
  if (offset < text.length) segments.push({ text: text.slice(offset), username: null })
  return segments
}

function activeMention (text, caret) {
  if (typeof text !== 'string' || typeof caret !== 'number' || Number.isNaN(caret)) return null
  caret = Math.max(0, Math.min(text.length, Math.floor(caret)))
  let start = caret
  while (start > 0 && RUN_CHAR.test(text[start - 1])) {
    start--
    if (caret - start > 20) return null
  }
  start--
  if (text[start] !== '@' || leftBlocked(text, start)) return null
  let end = caret
  while (end < text.length) {
    const { cp, size } = cpAt(text, end)
    if (isSeparator(cp)) break
    end += size
  }
  return { start, end, query: text.slice(start + 1, caret).toLowerCase() }
}

module.exports = { findMentions, mentionTokens, mentionSegments, activeMention, MENTION_MAX }
