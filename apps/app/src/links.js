// Tappable http(s) links in peer text. Pure: no React, React Native or Node
// built-ins. Peer text is untrusted, so detection fails closed per token: a
// token with any hidden or ambiguous code point, or a candidate that does not
// parse cleanly, stays plain in full, never as a shorter link, so the opened
// address is always exactly what the screen shows. No URL constructor: it
// punycode-decodes and rewrites backslashes, so the opened URL could differ
// from the text on screen. Code-point ranges instead of Unicode property
// escapes, which Hermes is not known to support. Variation selectors, keycaps
// and joiners are tolerated only inside an emoji sequence, which a link always
// ends before, so emoji typed flush against a link no longer hide it.

import rpc from '@varanda/rpc'

const { findMentions, displayText } = rpc

export const LINK_MAX = 2048

const BREAK_RANGES = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680],
  [0x2000, 0x2005], [0x2007, 0x2007], [0x2028, 0x2029], [0x3000, 0x3000],
  // A visible glyph (displayText's mark for an unsafe character), so it
  // cannot hide a target.
  [0xfffd, 0xfffd]
]

// Must stay a superset of INVISIBLE in who.js.
const INVISIBLE_RANGES = [
  [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfffc], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
]

// Spaces so narrow that 'a.com\u2009.b.com' reads as one host: a break there
// would link a prefix of what the eye takes as the address.
const NARROW_SPACE_RANGES = [
  [0x2006, 0x2006], [0x2008, 0x200a], [0x202f, 0x202f], [0x205f, 0x205f]
]

const OPENERS = new Set([
  0x28, 0x5b, 0x7b, 0x22, 0x27, 0x3c, 0xab, 0x201c, 0x2018, 0xbf, 0xa1
])
const EMOJI_RANGES = [
  [0x203c, 0x203c], [0x2049, 0x2049], [0x2300, 0x23ff], [0x2600, 0x27bf], [0x2b00, 0x2bff], [0x3030, 0x3030],
  [0x303d, 0x303d], [0x3297, 0x3297], [0x3299, 0x3299], [0x1f000, 0x1faff]
]

// Non-ASCII letters and marks that may continue a path, never a host.
const PATH_LETTER_RANGES = [
  [0xc0, 0xd6], [0xd8, 0xf6], [0xf8, 0x24f], [0x300, 0x36f],
  // U+0590-U+08FF (Hebrew, Arabic, Syriac and the other right-to-left
  // scripts, with their format controls) is left out: in a right-to-left
  // paragraph it would reorder the underlined link and show a domain from
  // the path first.
  // U+3297 and U+3299 are emoji (EMOJI_RANGES), so they end the link.
  [0x370, 0x58f], [0x900, 0x1fff], [0x3040, 0x3296], [0x3298, 0x3298],
  [0x329a, 0x9fff], [0xac00, 0xd7a3]
]

// ASCII the candidate may contain beyond letters and digits.
const URL_PUNCT = "-._~!$&'()*+,;=:/?#[]@%"

const TRAIL = new Set(['.', ',', ';', ':', '!', '?', '\'', '"', '…', '»', '”', '’'])
const PAIRS = { ')': '(', ']': '[', '}': '{' }

// Closing punctuation that may sit flush after a bare host: none of it can be
// read as more host, so stopping there does not change the visible address.
const HOST_TAIL = new Set([...TRAIL, ')', ']', '}'])

const START_RE = /https?:\/\/|www\./i
const LABEL_RE = /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])$/

function inRanges (cp, ranges) {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true
  return false
}

function isAsciiUrl (cp) {
  if (cp >= 0x30 && cp <= 0x39) return true
  if (cp >= 0x41 && cp <= 0x5a) return true
  if (cp >= 0x61 && cp <= 0x7a) return true
  return cp < 0x80 && URL_PUNCT.includes(String.fromCharCode(cp))
}

// Code point ending right before index i (a lone surrogate counts as itself).
function cpBefore (text, i) {
  const low = text.charCodeAt(i - 1)
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2)
    if (high >= 0xd800 && high <= 0xdbff) return { cp: text.codePointAt(i - 2), size: 2 }
  }
  return { cp: low, size: 1 }
}

// The last gate before opening, so it repeats every rule findLinks applies to
// what it returns rather than trusting the caller.
export function isHttpUrl (href) {
  try {
    if (typeof href !== 'string' || href.length > LINK_MAX + 'https://'.length) return false
    const scheme = href.startsWith('https://') ? 8 : href.startsWith('http://') ? 7 : 0
    if (scheme === 0 || poisoned(href)) return false
    const rest = href.slice(scheme)
    let left = false
    for (const ch of rest) {
      const cp = ch.codePointAt(0)
      if (inRanges(cp, BREAK_RANGES)) return false
      if (isAsciiUrl(cp)) {
        if (cp === 0x2f || cp === 0x3f || cp === 0x23) left = true
      } else if (!(left && inRanges(cp, PATH_LETTER_RANGES))) {
        return false
      }
    }
    const stop = rest.search(/[/?#]/)
    return validAuthority(stop === -1 ? rest : rest.slice(0, stop), 2)
  } catch {
    return false
  }
}

function tokens (text) {
  const out = []
  let start = -1
  for (let i = 0; i < text.length; i++) {
    if (inRanges(text.charCodeAt(i), BREAK_RANGES)) {
      if (start !== -1) out.push([start, i])
      start = -1
    } else if (start === -1) {
      start = i
    }
  }
  if (start !== -1) out.push([start, text.length])
  return out
}

const isEmoji = (cp) => cp !== undefined && inRanges(cp, EMOJI_RANGES)
const isKeycapBase = (cp) => (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a

// Whether the joiner at cps[i] belongs to an emoji sequence. Anywhere else it
// could hide or fake part of an address, so it poisons the token.
function emojiJoiner (cps, i) {
  const cp = cps[i]
  const prev = cps[i - 1]
  if (cp === 0xfe0e) return isEmoji(prev)
  if (cp === 0xfe0f) return isEmoji(prev) || (isKeycapBase(prev) && cps[i + 1] === 0x20e3)
  if (cp === 0x20e3) return isEmoji(prev) || (prev === 0xfe0f && isKeycapBase(cps[i - 2]))
  if (cp === 0x200d) {
    return (isEmoji(prev) || (prev === 0xfe0f && isEmoji(cps[i - 2]))) && isEmoji(cps[i + 1])
  }
  return false
}

const JOINERS = new Set([0xfe0e, 0xfe0f, 0x20e3, 0x200d])

export function poisoned (token) {
  if (displayText(token, { multiline: true }) !== token) return true
  const cps = Array.from(token, (ch) => ch.codePointAt(0))
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]
    if (JOINERS.has(cp)) {
      if (!emojiJoiner(cps, i)) return true
    } else if (inRanges(cp, INVISIBLE_RANGES) || inRanges(cp, NARROW_SPACE_RANGES)) {
      return true
    }
  }
  return false
}

// An emoji right before the scheme may end in a selector or keycap; checked
// again here rather than trusting that poisoned ran first.
function validStart (token, at) {
  if (at === 0) return true
  const last = cpBefore(token, at)
  if (OPENERS.has(last.cp) || isEmoji(last.cp)) return true
  if (last.size !== 1 || at < 2) return false
  const prev = cpBefore(token, at - 1)
  if (last.cp === 0xfe0f || last.cp === 0xfe0e) return isEmoji(prev.cp)
  if (last.cp !== 0x20e3) return false
  if (isEmoji(prev.cp)) return true
  if (prev.cp !== 0xfe0f || at < 3) return false
  return isKeycapBase(cpBefore(token, at - 2).cp)
}

function onlyHostTail (token, from) {
  for (const ch of token.slice(from)) {
    if (!HOST_TAIL.has(ch)) return false
  }
  return true
}

// Counted once and kept in step as characters are cut, so a long run of
// closers stays linear.
function trim (candidate) {
  const counts = {}
  for (const c of candidate) counts[c] = (counts[c] || 0) + 1
  let end = candidate.length
  while (end > 0) {
    // U+2026 and the closing quotes are single UTF-16 units.
    const last = candidate[end - 1]
    const open = PAIRS[last]
    if (!TRAIL.has(last) && !(open !== undefined && counts[last] > (counts[open] || 0))) break
    counts[last]--
    end--
  }
  return candidate.slice(0, end)
}

function validPort (port) {
  if (!/^[0-9]{1,5}$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

function validHost (host, minLabels) {
  const labels = host.split('.')
  if (labels.length < minLabels) return false
  for (const label of labels) if (!LABEL_RE.test(label)) return false
  // A browser reads a host whose last label is a number (decimal or 0x hex)
  // as IPv4, with octal and short forms, so only plain dotted quads pass.
  const last = labels[labels.length - 1]
  if (/^[0-9]+$/.test(last) || /^0x/i.test(last)) {
    if (labels.length !== 4) return false
    for (const label of labels) {
      if (!/^(?:0|[1-9][0-9]{0,2})$/.test(label) || Number(label) > 255) return false
    }
  }
  return true
}

function validAuthority (authority, minLabels) {
  if (authority === '' || authority.includes('@') || authority.includes('[') ||
    authority.includes(']')) return false
  const parts = authority.split(':')
  if (parts.length > 2) return false
  if (parts.length === 2 && !validPort(parts[1])) return false
  return validHost(parts[0], minLabels)
}

// Returns { start, end, href } relative to the token, or null.
function linkInToken (token) {
  if (poisoned(token)) return null
  const match = START_RE.exec(token)
  if (match === null) return null
  const start = match.index
  if (!validStart(token, start)) return null
  const www = match[0].length === 4 && match[0].toLowerCase() === 'www.'
  const authorityStart = www ? start : start + match[0].length
  let left = false
  let end = start
  let i = start
  while (i < token.length) {
    const cp = token.codePointAt(i)
    const size = cp > 0xffff ? 2 : 1
    if (isAsciiUrl(cp)) {
      if (!left && i >= authorityStart && (cp === 0x2f || cp === 0x3f || cp === 0x23)) left = true
    } else if (!(left && inRanges(cp, PATH_LETTER_RANGES))) {
      break
    }
    i += size
    end = i
  }
  if (end < token.length) {
    const next = token.codePointAt(end)
    if (next === 0x5c) return null
    // A keycap's base is ASCII, so the candidate would swallow half the glyph.
    if (JOINERS.has(next)) return null
    // An emoji cannot be read as more host, so the link may end before it.
    if (!left && !isEmoji(next) && !onlyHostTail(token, end)) return null
  }
  const candidate = trim(token.slice(start, end))
  if (candidate.length > LINK_MAX) return null
  const rest = candidate.slice(authorityStart - start)
  const stop = rest.search(/[/?#]/)
  // 'www.' is not a domain of its own, so it needs two more labels.
  if (!validAuthority(stop === -1 ? rest : rest.slice(0, stop), www ? 3 : 2)) return null
  let href
  if (www) {
    href = 'https://' + candidate
  } else {
    const sep = candidate.indexOf('://')
    href = candidate.slice(0, sep).toLowerCase() + candidate.slice(sep)
  }
  if (!isHttpUrl(href)) return null
  return { start, end: start + candidate.length, href }
}

export function findLinks (text) {
  try {
    if (typeof text !== 'string') return []
    const links = []
    for (const [from, to] of tokens(text)) {
      const found = linkInToken(text.slice(from, to))
      if (found !== null) links.push({ start: from + found.start, end: from + found.end, href: found.href })
    }
    return links
  } catch {
    return []
  }
}

export function hasLink (text) {
  return findLinks(text).length > 0
}

export function textSegments (text, { mentions = false } = {}) {
  try {
    if (typeof text !== 'string' || text === '') return []
    const spans = findLinks(text).map(({ start, end, href }) => ({ start, end, username: null, href }))
    if (mentions === true) {
      for (const m of findMentions(text)) {
        if (spans.some((s) => m.start < s.end && s.start < m.end)) continue
        spans.push({ start: m.start, end: m.end, username: m.username, href: null })
      }
      spans.sort((a, b) => a.start - b.start)
    }
    const segments = []
    let offset = 0
    for (const span of spans) {
      if (span.start < offset) continue
      if (span.start > offset) segments.push({ text: text.slice(offset, span.start), username: null, href: null })
      segments.push({ text: text.slice(span.start, span.end), username: span.username, href: span.href })
      offset = span.end
    }
    if (offset < text.length) segments.push({ text: text.slice(offset), username: null, href: null })
    return segments
  } catch {
    return typeof text === 'string' && text !== '' ? [{ text, username: null, href: null }] : []
  }
}

// Trim's whitespace, so "whitespace-only" matches the final trim.
function hasText (s) {
  return s.trim() !== ''
}

// JS line terminators. CRLF is one break: a dropped line must not leave a CR.
function splitLines (text) {
  const lines = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    let len = 0
    const ch = text[i]
    if (ch === '\r') len = text[i + 1] === '\n' ? 2 : 1
    else if (ch === '\n' || ch === '\u2028' || ch === '\u2029') len = 1
    if (len === 0) continue
    lines.push({ text: text.slice(start, i), sep: text.slice(i, i + len), start })
    i += len - 1
    start = i + 1
  }
  lines.push({ text: text.slice(start), sep: '', start })
  return lines
}

// The module's own separators. A regex whitespace class would also take U+FEFF
// and the narrow spaces, which do not break a token here, so tidying could
// join 'www.evil' and '.com' across one of them. Every BREAK_RANGES entry is
// in the BMP, so one code unit decides.
function isBreakAt (s, i) {
  return i >= 0 && i < s.length && inRanges(s.charCodeAt(i), BREAK_RANGES)
}

// A run of closing punctuation followed by a separator or the end of the line.
function punctuationRunAt (s, i) {
  let j = i
  while (j < s.length && ',.;:!?)]}'.includes(s[j])) j++
  return j > i && (j === s.length || isBreakAt(s, j))
}

function tidyLine (line, drops) {
  let out = ''
  let cursor = 0
  const cuts = []
  for (const drop of drops) {
    out += line.slice(cursor, drop.start)
    cuts.push(out.length)
    cursor = drop.end
  }
  out += line.slice(cursor)
  for (let c = 0; c < cuts.length; c++) {
    let start = cuts[c]
    let end = start
    while (true) {
      let from = start
      let to = end
      while (from > 0 && (out[from - 1] === ' ' || out[from - 1] === '\t')) from--
      while (to < out.length && (out[to] === ' ' || out[to] === '\t')) to++
      if (from === 0 || to === out.length || PAIRS[out[to]] !== out[from - 1]) break
      start = from - 1
      end = to + 1
    }
    if (start === end) continue
    // Check the outside of the whole nested pair, so no text can be joined.
    if (start > 0 && !isBreakAt(out, start - 1)) continue
    if (end < out.length && !isBreakAt(out, end) && !punctuationRunAt(out, end)) continue
    out = out.slice(0, start) + out.slice(end)
    // Keep every cut aligned, including another removed link in this pair.
    for (let k = 0; k < cuts.length; k++) {
      if (cuts[k] >= start) cuts[k] = Math.max(start, cuts[k] - (end - start))
    }
  }
  const runs = []
  let i = 0
  while (i < out.length) {
    if (out[i] !== ' ' && out[i] !== '\t') {
      i++
      continue
    }
    const from = i
    while (i < out.length && (out[i] === ' ' || out[i] === '\t')) i++
    if (cuts.some((cut) => cut >= from && cut <= i)) runs.push([from, i])
  }
  let result = out
  for (let r = runs.length - 1; r >= 0; r--) {
    const [from, to] = runs[r]
    // One space only when the line still has text on both sides of the hole.
    const { cp, size } = cpBefore(out, from)
    const ch = out.slice(from - size, from)
    // The path ranges also cover scripts without upper and lower case.
    const word = (cp >= 0x30 && cp <= 0x39) || ch.toLowerCase() !== ch.toUpperCase() || inRanges(cp, PATH_LETTER_RANGES)
    const attaches = word && punctuationRunAt(out, to)
    const gap = !attaches && hasText(out.slice(0, from)) && hasText(out.slice(to)) ? ' ' : ''
    result = result.slice(0, from) + gap + result.slice(to)
  }
  return result
}

function withoutDroppedSpans (text, drops) {
  const kept = []
  for (const line of splitLines(text)) {
    const end = line.start + line.text.length
    const local = []
    for (const drop of drops) {
      if (drop.start >= line.start && drop.end <= end) {
        local.push({ start: drop.start - line.start, end: drop.end - line.start })
      }
    }
    if (local.length === 0) {
      kept.push(line.text + line.sep)
      continue
    }
    const tidied = tidyLine(line.text, local)
    // An emptied line goes with the break after it. A last line has none;
    // the final trim drops the break that stood before it.
    if (hasText(tidied)) kept.push(tidied + line.sep)
  }
  return kept.join('').trim()
}

// Display only. A removed address must not leave a double space or a blank
// line, and text that lost nothing stays the same string.
export function textWithoutHrefs (text, omit) {
  if (typeof text !== 'string') return ''
  try {
    if (typeof omit !== 'function') return text
    const links = findLinks(text)
    if (links.length === 0) return text
    const drops = []
    for (const link of links) {
      if (omit(link.href) === true) drops.push(link)
    }
    if (drops.length === 0) return text
    const result = withoutDroppedSpans(text, drops)
    // Tidying must preserve every remaining target, including its count.
    const expectedLinks = links.filter((link) => !drops.includes(link))
    const actualLinks = findLinks(result)
    if (actualLinks.length !== expectedLinks.length || actualLinks.some((link, i) => link.href !== expectedLinks[i].href)) return text
    const expectedMentions = findMentions(text)
      .filter((m) => !drops.some((drop) => m.start < drop.end && drop.start < m.end))
      .map((m) => text.slice(m.start, m.end))
    const actualMentions = findMentions(result).map((m) => result.slice(m.start, m.end))
    if (actualMentions.length !== expectedMentions.length || actualMentions.some((handle, i) => handle !== expectedMentions[i])) return text
    return result
  } catch {
    return text
  }
}
