// Composer helpers for the rich-text markers that richText.js reads. Pure: no
// React, React Native or Node built-ins. They only add or remove marker
// characters; the typed text is otherwise left as it is.

import { textSegments } from './links.js'
import { isSpaceCp, isWordCp, parseRich } from './richText.js'

const MARKERS = new Set(['*', '**', '_', '__', '~', '||', '`'])

const STYLE = { '*': 'bold', '**': 'bold', _: 'italic', __: 'italic', '~': 'strike', '||': 'spoiler', '`': 'code' }

function isHigh (c) {
  return c >= 0xd800 && c <= 0xdbff
}

function isLow (c) {
  return c >= 0xdc00 && c <= 0xdfff
}

// A marker placed between the halves of a surrogate pair would leave two lone
// surrogates, and the whole message would then show as plain text.
function clampSelection (text, selection) {
  const len = text.length
  const at = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(len, Math.floor(v))) : len)
  let start = at(selection !== null && typeof selection === 'object' ? selection.start : undefined)
  let end = at(selection !== null && typeof selection === 'object' ? selection.end : undefined)
  if (start > end) [start, end] = [end, start]
  if (start > 0 && start < len && isHigh(text.charCodeAt(start - 1)) && isLow(text.charCodeAt(start))) start--
  if (end > 0 && end < len && isHigh(text.charCodeAt(end - 1)) && isLow(text.charCodeAt(end))) end++
  return { start, end }
}

// Where each link and mention points, in order, as the parser reads them.
function destinations (text) {
  let out = ''
  for (const s of textSegments(text, { mentions: true })) {
    if (typeof s.href === 'string') out += 'l' + s.href + '\n'
    else if (typeof s.username === 'string') out += 'm' + s.username + '\n'
  }
  return out
}

// Whether the parser gives every non-space, non-marker character of text in
// [from, to) the style. The output characters are the source's minus the
// removed markers and fence lines, in order, so each is matched to the first
// equal source character after the previous match. A character left
// unmatched counts as unstyled.
function styledRange (text, from, to, style) {
  const flags = new Array(text.length)
  let r = 0
  for (const block of parseRich(text)) {
    const pieces = block.kind === 'code' ? [{ text: block.text, on: style === 'code' }] : block.spans.map((s) => ({ text: s.text, on: s[style] === true }))
    for (const piece of pieces) {
      for (let k = 0; k < piece.text.length; k++) {
        while (r < text.length && text[r] !== piece.text[k]) r++
        if (r === text.length) return false
        flags[r++] = piece.on
      }
    }
  }
  for (let p = from; p < to; p++) {
    const c = text.charCodeAt(p)
    if (isSpaceCp(c) || '*_~|`'.includes(text[p])) continue
    if (flags[p] !== true) return false
  }
  return true
}

// Wraps [start, end) with spaces trimmed, or null when the range is empty,
// a link or mention would point elsewhere, or the parser would not show the
// style, so the composer never hands back text that only looks formatted.
function tryWrap (src, start, end, marker) {
  while (start < end && isSpaceCp(src.charCodeAt(start))) start++
  while (end > start && isSpaceCp(src.charCodeAt(end - 1))) end--
  if (start >= end) return null
  const m = marker.length
  const text = src.slice(0, start) + marker + src.slice(start, end) + marker + src.slice(end)
  if (destinations(text) !== destinations(src)) return null
  if (!styledRange(text, start + m, end + m, STYLE[marker])) return null
  return { text, selection: { start: start + m, end: end + m } }
}

// Toggles marker around the selection: removes it when it already sits just
// outside or at both ends inside the selection, otherwise wraps. The parser's
// rules decide the range: spaces at its edges stay outside, because a marker
// only closes after a non-space, and an edge inside a word moves out to the
// word's end, because a marker next to a letter neither opens nor closes.
// Surrogates are never word characters, so the move cannot split a pair.
export function wrapSelection (text, selection, marker) {
  const src = typeof text === 'string' ? text : ''
  const original = clampSelection(src, selection)
  let { start, end } = original
  if (!MARKERS.has(marker)) return { text: src, selection: { start, end } }
  if (start < end) {
    let s = start
    let e = end
    while (s < e && isSpaceCp(src.charCodeAt(s))) s++
    while (e > s && isSpaceCp(src.charCodeAt(e - 1))) e--
    if (s < e) {
      while (s > 0 && isWordCp(src.charCodeAt(s - 1))) s--
      while (e < src.length && isWordCp(src.charCodeAt(e))) e++
      start = s
      end = e
    }
  }
  const m = marker.length
  if (start >= m && src.slice(start - m, start) === marker && src.slice(end, end + m) === marker) {
    return {
      text: src.slice(0, start - m) + src.slice(start, end) + src.slice(end + m),
      selection: { start: start - m, end: end - m }
    }
  }
  const inner = src.slice(start, end)
  if (inner.length >= 2 * m && inner.startsWith(marker) && inner.endsWith(marker)) {
    return {
      text: src.slice(0, start) + inner.slice(m, inner.length - m) + src.slice(end),
      selection: { start, end: end - 2 * m }
    }
  }
  const unchanged = { text: src, selection: { start: original.start, end: original.end } }
  if (start === end) {
    // A marker next to a letter neither opens nor closes, so a space keeps
    // what is typed between the markers formatted.
    const before = start > 0 && isWordCp(src.charCodeAt(start - 1)) ? ' ' : ''
    const after = end < src.length && isWordCp(src.charCodeAt(end)) ? ' ' : ''
    const text = src.slice(0, start) + before + marker + marker + after + src.slice(end)
    if (destinations(text) !== destinations(src)) return unchanged
    const at = start + before.length + m
    return { text, selection: { start: at, end: at } }
  }
  const first = tryWrap(src, start, end, marker)
  if (first !== null) return first
  // Off an edge link or mention: a marker beside one can become part of it.
  let s = start
  let e = end
  let offset = 0
  for (const seg of textSegments(src, { mentions: true })) {
    const a = offset
    const b = offset + seg.text.length
    offset = b
    if (typeof seg.href !== 'string' && typeof seg.username !== 'string') continue
    if (a < e && e <= b) e = a
    if (a <= s && s < b) s = b
  }
  if (s === start && e === end) return unchanged
  return tryWrap(src, s, e, marker) || unchanged
}

// Puts the selection (or an empty line for the caret) inside a fenced block,
// each fence on a line of its own so the parser sees it. A block closes only
// on a line of exactly its fence's backticks, so the fence is longer than any
// line of backticks in the selection and the whole selection stays code.
export function insertCodeBlock (text, selection) {
  const src = typeof text === 'string' ? text : ''
  const { start, end } = clampSelection(src, selection)
  const inner = src.slice(start, end)
  let longest = 2
  for (const line of inner.split('\n')) {
    if (line.length > longest && /^`+$/.test(line)) longest = line.length
  }
  const fence = '`'.repeat(longest + 1)
  const open = (start > 0 && src[start - 1] !== '\n' ? '\n' : '') + fence + '\n'
  const close = '\n' + fence + (end < src.length && src[end] !== '\n' ? '\n' : '')
  const from = start + open.length
  return {
    text: src.slice(0, start) + open + inner + close + src.slice(end),
    selection: { start: from, end: from + inner.length }
  }
}

// Record text refuses TAB and CR (packages/core/lib/records.js), so pasted
// code would otherwise fail to send.
export function cleanPaste (text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
}
