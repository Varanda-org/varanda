// Account search in the app (find people by display name or verified @nome):
// the search text helpers, the diary.peek plan for the seeder's search
// results, and the verification step that turns peeks into result rows.
// Pure ES module: no React, no Node built-ins and only pure app imports, so
// Metro bundles it and Node's import() loads it in tests.
//
// The search text part (TOKEN_MAX .. searchRank) is a verbatim local copy of
// @varanda/core lib/search-text.js (Metro cannot reach packages/core), pinned
// by a parity test (test/search.test.js); change both together.
//
// The seeder's search answer is UNTRUSTED: it only says where to look. A row
// exists only after diary.peek confirms it: the name comes from the peeked
// profile and the @nome only from the peeked, verified username field.

import { avatarOf } from './media/avatar.js'

export const TOKEN_MAX = 20
export const NAME_TOKENS_MAX = 16
export const QUERY_TOKENS_MAX = 4
export const QUERY_MIN_CHARS = 2
export const RESULTS_MAX = 20
export const INPUT_MAX = 80
export const QUERY_RE = /^[a-z0-9]{1,20}(?:-[a-z0-9]{1,20}){0,3}$/
const TOKEN_RE = /^[a-z0-9]{1,20}$/
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
const HEX6_RE = /^[0-9a-f]{6}$/

// Code point ranges dropped without separating: combining marks, then the
// Default_Ignorable ranges of the INVISIBLE table in apps/app/src/who.js.
const DROP = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x20d0, 0x20ff],
  [0xfe20, 0xfe2f],
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
]

// Latin letters without a decomposition, folded by hand.
const FOLD = Object.freeze({
  0x00df: 'ss', // ß
  0x1e9e: 'ss', // ẞ
  0x00e6: 'ae', // æ
  0x00c6: 'ae', // Æ
  0x0153: 'oe', // œ
  0x0152: 'oe', // Œ
  0x00f8: 'o', // ø
  0x00d8: 'o', // Ø
  0x0142: 'l', // ł
  0x0141: 'l', // Ł
  0x0111: 'd', // đ
  0x0110: 'd', // Đ
  0x00f0: 'd', // ð
  0x00d0: 'd', // Ð
  0x00fe: 'th', // þ
  0x00de: 'th', // Þ
  0x0131: 'i', // ı
  0x0127: 'h', // ħ
  0x0126: 'h', // Ħ
  0x0167: 't', // ŧ
  0x0166: 't', // Ŧ
  0x014b: 'n', // ŋ
  0x014a: 'n', // Ŋ
  0x0138: 'k' // ĸ
})

function dropped (cp) {
  for (let i = 0; i < DROP.length; i++) {
    if (cp >= DROP[i][0] && cp <= DROP[i][1]) return true
  }
  return false
}

// The input cut to 160 UTF-16 units (no trailing lone high surrogate), then
// to its first INPUT_MAX code points.
function bounded (text) {
  let s = text.slice(0, 160)
  if (s.length > 0) {
    const last = s.charCodeAt(s.length - 1)
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1)
  }
  let out = ''
  let n = 0
  for (const ch of s) {
    if (n >= INPUT_MAX) break
    out += ch
    n++
  }
  return out
}

// Every token of `text` in order, each cut to TOKEN_MAX; no dedupe and no
// count cap. A non-string gives [].
export function splitTokens (text) {
  try {
    if (typeof text !== 'string') return []
    let s = bounded(text)
    if (typeof String.prototype.normalize === 'function') {
      try {
        s = s.normalize('NFKD')
      } catch {}
    }
    const tokens = []
    let cur = ''
    for (const ch of s) {
      const cp = ch.codePointAt(0)
      if ((cp >= 0x61 && cp <= 0x7a) || (cp >= 0x30 && cp <= 0x39)) {
        cur += ch
      } else if (cp >= 0x41 && cp <= 0x5a) {
        cur += String.fromCharCode(cp + 0x20)
      } else if (Object.prototype.hasOwnProperty.call(FOLD, cp)) {
        cur += FOLD[cp]
      } else if (dropped(cp)) {
        // dropped without separating
      } else if (cur !== '') {
        tokens.push(cur.slice(0, TOKEN_MAX))
        cur = ''
      }
    }
    if (cur !== '') tokens.push(cur.slice(0, TOKEN_MAX))
    return tokens
  } catch {
    return []
  }
}

// The folded tokens of a display name: first occurrences, at most
// NAME_TOKENS_MAX.
export function foldTokens (text) {
  const out = []
  const tokens = splitTokens(text)
  for (let i = 0; i < tokens.length && out.length < NAME_TOKENS_MAX; i++) {
    if (!out.includes(tokens[i])) out.push(tokens[i])
  }
  return out
}

// The first QUERY_TOKENS_MAX tokens of a typed query (repeats and 1-char
// tokens kept).
export function queryTokens (text) {
  return splitTokens(text).slice(0, QUERY_TOKENS_MAX)
}

function tokensLength (tokens) {
  let n = 0
  for (let i = 0; i < tokens.length; i++) n += tokens[i].length
  return n
}

// The route path segment of a typed query ('@João Silva' -> 'joao-silva'),
// or null when it carries fewer than QUERY_MIN_CHARS letters or digits.
// A non-null result always matches QUERY_RE.
export function queryPath (text) {
  const tokens = queryTokens(text)
  if (tokens.length === 0 || tokensLength(tokens) < QUERY_MIN_CHARS) return null
  return tokens.join('-')
}

export function isQueryTokens (t) {
  try {
    if (!Array.isArray(t) || t.length < 1 || t.length > QUERY_TOKENS_MAX) return false
    let n = 0
    for (let i = 0; i < t.length; i++) {
      if (typeof t[i] !== 'string' || !TOKEN_RE.test(t[i])) return false
      n += t[i].length
    }
    return n >= QUERY_MIN_CHARS
  } catch {
    return false
  }
}

// The query tokens of a route path segment, or null.
export function parseQuery (segment) {
  if (typeof segment !== 'string' || !QUERY_RE.test(segment)) return null
  const tokens = segment.split('-')
  return isQueryTokens(tokens) ? tokens : null
}

export function isValidUsername (u) {
  return typeof u === 'string' && USERNAME_RE.test(u) && !HEX6_RE.test(u)
}

// Rank of a member for a query, lower is better, -1 for no match:
// 0 the @nome is the query joined by '_', 1 the @nome without '_' equals the
// query without separators, 2 it starts with it, 3 every query token
// prefixes a token of the display name or of the @nome. A display name alone
// reaches only rank 3. An invalid username counts as none. `usernameTokens`,
// optional, is foldTokens(username) computed once by the caller (the seeder's
// name index), so a search does not fold every @nome again.
export function searchRank (qTokens, nameTokens, username, usernameTokens) {
  try {
    if (!isQueryTokens(qTokens) || !Array.isArray(nameTokens)) return -1
    const u = isValidUsername(username) ? username : null
    if (u !== null) {
      if (u === qTokens.join('_')) return 0
      const compactQ = qTokens.join('')
      const compactU = u.split('_').join('')
      if (compactU === compactQ) return 1
      if (compactU.startsWith(compactQ)) return 2
    }
    const uTokens = u === null ? [] : Array.isArray(usernameTokens) ? usernameTokens : foldTokens(u)
    for (let i = 0; i < qTokens.length; i++) {
      const q = qTokens[i]
      let hit = false
      for (let j = 0; j < nameTokens.length && !hit; j++) {
        if (typeof nameTokens[j] === 'string' && nameTokens[j].startsWith(q)) hit = true
      }
      for (let j = 0; j < uTokens.length && !hit; j++) {
        if (uTokens[j].startsWith(q)) hit = true
      }
      if (!hit) return -1
    }
    return 3
  } catch {
    return -1
  }
}

const HEX64_RE = /^[0-9a-f]{64}$/

function isHint (v) {
  return Number.isSafeInteger(v) && v >= 1
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function lowerKey (v) {
  return typeof v === 'string' ? v.toLowerCase() : null
}

function memberAuthor (m) {
  return isPlainObject(m) && typeof m.author === 'string' ? m.author : null
}

// diary.peek params for the seeder's search members, in member order:
// { author, seqs[, profileSeq][, usernameSeq] } where seqs are the member's
// hints (distinct, ascending). Members that are ownKey, have a non-hex64
// author, or carry no hint >= 1 are skipped; a hint key is present only when
// it is a safe integer >= 1 (diary.peek refuses null). Never throws.
export function planSearchPeeks (members, ownKey) {
  const plan = []
  try {
    if (!Array.isArray(members)) return plan
    const own = lowerKey(ownKey)
    for (let i = 0; i < members.length; i++) {
      const m = members[i]
      const author = memberAuthor(m)
      if (author === null || !HEX64_RE.test(author)) continue
      if (author === own) continue
      const profileSeq = isHint(m.profileSeq) ? m.profileSeq : null
      const usernameSeq = isHint(m.usernameSeq) ? m.usernameSeq : null
      const seqs = []
      if (profileSeq !== null) seqs.push(profileSeq)
      if (usernameSeq !== null && usernameSeq !== profileSeq) seqs.push(usernameSeq)
      if (seqs.length === 0) continue
      seqs.sort((a, b) => a - b)
      const item = { author, seqs }
      if (profileSeq !== null) item.profileSeq = profileSeq
      if (usernameSeq !== null) item.usernameSeq = usernameSeq
      plan.push(item)
    }
  } catch {}
  return plan
}

// The confirmed result rows: for each seeder member (seeder order, ownKey
// excluded), the peek in `peeked` (the Map peekAll fills) decides. No peek,
// or a peek that is not a plain object keyed to that author: unconfirmed.
// Else the name is the peeked profile name and the @nome the peeked username
// only when valid (never derived from the name; entries and bio unread); the
// member is kept when searchRank matches, else dropped. Hits are ordered by
// that verified rank, seeder order breaking ties. Never throws.
export function confirmedHits (qTokens, members, peeked, ownKey) {
  try {
    const list = Array.isArray(members) ? members : []
    const own = lowerKey(ownKey)
    const others = []
    for (let i = 0; i < list.length; i++) {
      const author = memberAuthor(list[i])
      if (author !== null && author.toLowerCase() === own) continue
      others.push(author)
    }
    const out = { hits: [], dropped: 0, unconfirmed: 0 }
    const ranked = []
    if (!(peeked instanceof Map) || !isQueryTokens(qTokens)) {
      out.unconfirmed = others.length
      return out
    }
    for (let i = 0; i < others.length; i++) {
      const author = others[i]
      const peek = author === null ? undefined : peeked.get(author)
      if (!isPlainObject(peek) || peek.key !== author) {
        out.unconfirmed++
        continue
      }
      const profile = isPlainObject(peek.profile) ? peek.profile : null
      const name = profile !== null && typeof profile.name === 'string' ? profile.name : null
      const username = isValidUsername(peek.username) ? peek.username : null
      const avatar = profile !== null && name !== null ? avatarOf(profile.avatar) : null
      const rank = searchRank(qTokens, foldTokens(name || ''), username)
      if (rank >= 0) {
        ranked.push({ rank, i, hit: { author, name, username, avatar } })
      } else {
        out.dropped++
      }
    }
    // The order shown comes from the verified rank; the seeder's order (a
    // claim) only breaks ties.
    ranked.sort((a, b) => a.rank - b.rank || a.i - b.i)
    out.hits = ranked.map((r) => r.hit)
    return out
  } catch {
    return { hits: [], dropped: 0, unconfirmed: 0 }
  }
}
