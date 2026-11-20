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

const LANG_MAX = 16

function isLangChar (c) {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x23 || c === 0x2d
}

// A fence line is three or more backticks and an optional lang, as richText.js
// reads it: { ticks, lang }, or null.
function fenceOf (text, start, end) {
  let p = start
  while (p < end && text.charCodeAt(p) === 0x60) p++
  const ticks = p - start
  if (ticks < 3 || end - p > LANG_MAX) return null
  for (let i = p; i < end; i++) if (!isLangChar(text.charCodeAt(i))) return null
  return { ticks, lang: text.slice(p, end) }
}

// Where each fenced block sits, found with the same rules as richText.js (a
// block closes only on a bare fence of the same length): { open, bodyStart,
// bodyEnd, close } are the offsets of the opening fence line, the body and
// the end of the closing fence line. richText.js does not expose offsets, and
// the tests compare the two.
export function codeBlocks (text) {
  const lines = []
  const fences = []
  const bare = new Map()
  let from = 0
  for (;;) {
    const nl = text.indexOf('\n', from)
    const to = nl === -1 ? text.length : nl
    const fence = fenceOf(text, from, to)
    if (fence !== null && fence.lang === '') {
      const list = bare.get(fence.ticks)
      if (list === undefined) bare.set(fence.ticks, [lines.length])
      else list.push(lines.length)
    }
    lines.push([from, to])
    fences.push(fence)
    if (nl === -1) break
    from = nl + 1
  }
  const read = new Map()
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const fence = fences[i]
    const list = fence === null ? undefined : bare.get(fence.ticks)
    if (list !== undefined) {
      let p = read.get(fence.ticks) || 0
      while (p < list.length && list[p] <= i) p++
      read.set(fence.ticks, p)
      if (p < list.length) {
        const k = list[p]
        blocks.push({
          open: lines[i][0],
          bodyStart: lines[i + 1][0],
          bodyEnd: k === i + 1 ? lines[k][0] : lines[k - 1][1],
          close: lines[k][1]
        })
        i = k + 1
        continue
      }
    }
    i++
  }
  return blocks
}

// For each source character, whether the parser gives it the style (true or
// false), or undefined when it is syntax (a marker or a fence line) that the
// parser does not show. The output characters are the source's minus the
// removed markers and fence lines, in order, so each is matched to the first
// equal source character after the previous match; a code block's body is
// placed by its offsets instead, so the letters of its fence's lang are never
// taken for text. blockOn says whether the characters of a block count as
// having the style: a block is code, but no marker the buttons add formats
// inside one. Null when the output cannot be matched.
function styleFlags (text, style, blockOn) {
  const flags = new Array(text.length)
  const blocks = codeBlocks(text)
  let r = 0
  let nth = 0
  for (const block of parseRich(text)) {
    if (block.kind === 'code') {
      const at = blocks[nth++]
      if (at !== undefined && text.slice(at.bodyStart, at.bodyEnd) === block.text) {
        r = Math.max(r, at.bodyStart)
        for (let k = 0; k < block.text.length; k++) flags[r++] = blockOn && style === 'code'
        continue
      }
    }
    const pieces = block.kind === 'code' ? [{ text: block.text, on: blockOn && style === 'code' }] : block.spans.map((s) => ({ text: s.text, on: s[style] === true }))
    for (const piece of pieces) {
      for (let k = 0; k < piece.text.length; k++) {
        while (r < text.length && text[r] !== piece.text[k]) r++
        if (r === text.length) return null
        flags[r++] = piece.on
      }
    }
  }
  return flags
}

// Whether the parser gives every non-space, non-marker character of text in
// [from, to) the style, and at least one character in it shows the style. A
// marker in the range counts only when the parser shows it as text: a range
// of nothing but markers inside code shows no style.
function styledRange (text, from, to, style) {
  const flags = styleFlags(text, style, false)
  if (flags === null) return false
  let seen = false
  for (let p = from; p < to; p++) {
    if (isSpaceCp(text.charCodeAt(p))) continue
    if ('*_~|`'.includes(text[p])) {
      if (flags[p] === true) seen = true
      continue
    }
    if (flags[p] !== true) return false
    seen = true
  }
  return seen
}

// A character the parser reads as plain punctuation, to stand for a typed
// letter at a caret; null when the text holds them all.
function probeFor (text) {
  for (const c of ['\u00b7', '\u00a7', '\u00b6', '\u2022']) if (!text.includes(c)) return c
  return null
}

// What a character typed at the offset would be: inside code (inline or a
// block), or null when that cannot be told.
function typedInCode (text, at) {
  const probe = probeFor(text)
  if (probe === null) return null
  const typed = text.slice(0, at) + probe + text.slice(at)
  const flags = styleFlags(typed, 'code', true)
  return flags === null ? null : flags[at] === true
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

// A marker pair at a caret. A marker next to a letter neither opens nor
// closes, so a space keeps what is typed between the markers formatted.
function caretText (src, at, marker) {
  const before = at > 0 && isWordCp(src.charCodeAt(at - 1)) ? ' ' : ''
  const after = at < src.length && isWordCp(src.charCodeAt(at)) ? ' ' : ''
  return {
    text: src.slice(0, at) + before + marker + marker + after + src.slice(at),
    at: at + before.length + marker.length
  }
}

// The text without the marker pair at open and close, or null unless the
// pair is one the button itself would add: the parser reads it as a pair
// (not markers inside a word, a mention or a link), no link or mention
// ends up pointing elsewhere, and wrapping what is left gives the text back.
function unwrapPair (src, open, close, marker) {
  const m = marker.length
  const out = src.slice(0, open) + src.slice(open + m, close) + src.slice(close + m)
  if (destinations(out) !== destinations(src)) return null
  const again = close === open + m ? caretText(out, open, marker) : tryWrap(out, open, close - m, marker)
  return again !== null && again.text === src ? out : null
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
    const out = unwrapPair(src, start - m, end, marker)
    if (out !== null) return { text: out, selection: { start: start - m, end: end - m } }
  }
  const inner = src.slice(start, end)
  if (inner.length >= 2 * m && inner.startsWith(marker) && inner.endsWith(marker)) {
    const out = unwrapPair(src, start, end - m, marker)
    if (out !== null) return { text: out, selection: { start, end: end - 2 * m } }
  }
  const unchanged = { text: src, selection: { start: original.start, end: original.end } }
  if (start === end) {
    // Markers typed inside code stay literal, so a caret there gets none.
    if (typedInCode(src, start) !== false) return unchanged
    const { text, at } = caretText(src, start, marker)
    if (destinations(text) !== destinations(src)) return unchanged
    const probe = probeFor(text)
    if (probe === null || !styledRange(text.slice(0, at) + probe + text.slice(at), at, at + 1, STYLE[marker])) return unchanged
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

// Takes the fences off block b and keeps the selection on the same text of
// its body.
function unfence (src, b, start, end) {
  const head = b.bodyStart - b.open
  const at = (v) => Math.min(Math.max(v, b.bodyStart), b.bodyEnd) - head
  return {
    text: src.slice(0, b.open) + src.slice(b.bodyStart, b.bodyEnd) + src.slice(b.close),
    selection: { start: at(start), end: at(end) }
  }
}

// Puts the selection (or an empty line for the caret) inside a fenced block,
// each fence on a line of its own so the parser sees it. A block closes only
// on a line of exactly its fence's backticks, so the fence is longer than any
// line of backticks in the selection and the whole selection stays code.
// Like the other buttons it toggles: a selection or caret inside a block takes
// that block's fences off, and a selection that only partly overlaps a block
// or starts or ends inside inline code is left as it is, since a fence there
// would split the code. A fence left open earlier in the text would pair with
// ours, so the length is raised until the parser reads our block as written.
// Like wrapSelection, it refuses a change that would move a link or mention:
// a fence line inside @nome or a URL splits it.
export function insertCodeBlock (text, selection) {
  const src = typeof text === 'string' ? text : ''
  const { start, end } = clampSelection(src, selection)
  for (const b of codeBlocks(src)) {
    const inside = start === end ? b.open < start && start < b.close : b.open <= start && end <= b.close
    if (inside) {
      const out = unfence(src, b, start, end)
      return destinations(out.text) === destinations(src) ? out : { text: src, selection: { start, end } }
    }
    if (start < b.close && end > b.open && !(start <= b.open && end >= b.close)) return { text: src, selection: { start, end } }
  }
  if (typedInCode(src, start) !== false || typedInCode(src, end) !== false) return { text: src, selection: { start, end } }
  const inner = src.slice(start, end)
  let longest = 2
  for (const line of inner.split('\n')) {
    if (line.length > longest && /^`+$/.test(line)) longest = line.length
  }
  const lead = start > 0 && src[start - 1] !== '\n' ? '\n' : ''
  const close = (fence) => '\n' + fence + (end < src.length && src[end] !== '\n' ? '\n' : '')
  for (let ticks = longest + 1; ticks <= longest + 8; ticks++) {
    const fence = '`'.repeat(ticks)
    const open = lead + fence + '\n'
    const from = start + open.length
    const out = src.slice(0, start) + open + inner + close(fence) + src.slice(end)
    const read = codeBlocks(out).find((b) => b.open === start + lead.length)
    if (read !== undefined && read.bodyStart === from && read.bodyEnd === from + inner.length) {
      if (destinations(out) !== destinations(src)) break
      return { text: out, selection: { start: from, end: from + inner.length } }
    }
  }
  return { text: src, selection: { start, end } }
}

// Where the caret goes after `next` replaced `prev` (a paste) when the stored
// selection did not fit the change: the end of the inserted stretch, in `next`.
// A draft that repeats a stretch lets the insertion sit at several places that
// all explain the change; the one nearest the stored caret wins, and without
// a usable caret the last one does.
export function pasteCaret (prev, next, selection) {
  const limit = Math.min(prev.length, next.length)
  let prefix = 0
  while (prefix < limit && prev[prefix] === next[prefix]) prefix++
  let common = 0
  while (common < limit && prev[prev.length - common - 1] === next[next.length - common - 1]) common++
  const grown = next.length - prev.length
  const first = Math.max(0, prev.length - common)
  if (grown >= 0 && first <= prefix) {
    const at = selection !== null && typeof selection === 'object' ? selection.end : undefined
    return (Number.isInteger(at) && at >= first && at <= prefix ? at : prefix) + grown
  }
  let tail = 0
  while (tail < prev.length - prefix && tail < next.length - prefix && prev[prev.length - tail - 1] === next[next.length - tail - 1]) tail++
  return next.length - tail
}

// Record text refuses TAB and CR (packages/core/lib/records.js), so pasted
// code would otherwise fail to send.
export function cleanPaste (text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
}
