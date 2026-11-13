// Rich text in peer text: *negrito* or **negrito**, _itálico_ or __itálico__,
// ~riscado~, ||spoiler||, `código` and fenced blocks. The markers travel as
// plain text, so an older client shows them raw. Pure: no React, React Native
// or Node built-ins.
//
// Peer text is hostile. The parser never throws (any failure gives one plain
// paragraph), runs in linear time with no backtracking regex, and never
// re-reads links or mentions: textSegments runs once on the raw text, and each
// link or mention becomes one atom span carrying its segment unchanged, with
// any marker inside it literal. A style may wrap an atom only whole. Text
// outside the atoms is never scanned for links again, because a style split
// across a URL could otherwise produce a link to a different address.

import { poisoned, textSegments } from './links.js'

export const SPAN_MAX = 64

// Code blocks one bubble draws as boxes; the rest of the text from the next
// one on is one plain paragraph.
export const CODE_MAX = 8

const LANG_MAX = 16

const SPACE = 0
const PUNCT = 1
const WORD = 2

const STYLE = { '*': 'bold', '**': 'bold', _: 'italic', __: 'italic', '~': 'strike', '||': 'spoiler' }

const NO_STYLE = { bold: false, italic: false, strike: false, code: false, spoiler: false }

function isMark (c) {
  return c === 0x2a || c === 0x5f || c === 0x7e || c === 0x7c || c === 0x60
}

// Runs of any other length stay literal, so '***' or '|||' never open.
function kindOf (c, len) {
  if (c === 0x2a) return len === 1 ? '*' : len === 2 ? '**' : null
  if (c === 0x5f) return len === 1 ? '_' : len === 2 ? '__' : null
  if (c === 0x7e) return len === 1 ? '~' : null
  if (c === 0x7c) return len === 2 ? '||' : null
  return null
}

export function isSpaceCp (cp) {
  return (cp >= 0x09 && cp <= 0x0d) || cp === 0x20 || cp === 0xa0 || cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f ||
    cp === 0x205f || cp === 0x3000
}

// Code-point ranges instead of Unicode property escapes, which Hermes is not
// known to support (see links.js).
export function isWordCp (cp) {
  if (cp < 0x80) return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
  return (cp >= 0xc0 && cp <= 0x1fff && cp !== 0xd7 && cp !== 0xf7) ||
    (cp >= 0x3040 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3)
}

function classOf (cp) {
  if (isSpaceCp(cp)) return SPACE
  return isWordCp(cp) ? WORD : PUNCT
}

function classBefore (text, i) {
  const low = text.charCodeAt(i - 1)
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
    const high = text.charCodeAt(i - 2)
    if (high >= 0xd800 && high <= 0xdbff) return classOf(text.codePointAt(i - 2))
  }
  return classOf(low)
}

function isLangChar (c) {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x23 || c === 0x2d
}

// A fence is a run of three or more backticks, then an optional lang, alone
// on its line: { ticks, lang } with lang '' when bare, or null. A block closes
// only on a bare fence of the same length, so a longer fence can hold a line
// of three backticks.
function fenceOf (text, start, end) {
  let p = start
  while (p < end && text.charCodeAt(p) === 0x60) p++
  const ticks = p - start
  if (ticks < 3 || end - p > LANG_MAX) return null
  for (let i = p; i < end; i++) if (!isLangChar(text.charCodeAt(i))) return null
  return { ticks, lang: text.slice(p, end) }
}

// Offsets of every link or mention segment. textSegments promises to cover
// the whole text in order; anything else throws, so the caller falls back to
// plain text rather than placing an atom at a guessed offset.
function atomsOf (text, segments) {
  const atoms = []
  let offset = 0
  for (const segment of segments) {
    const t = segment.text
    if (typeof t !== 'string' || t === '' || !text.startsWith(t, offset)) throw new Error('segments out of step')
    if (typeof segment.href === 'string' || typeof segment.username === 'string') {
      atoms.push({ start: offset, end: offset + t.length, segment })
    }
    offset += t.length
  }
  if (offset !== text.length) throw new Error('segments out of step')
  return atoms
}

// Splits into paragraph ranges and fenced code blocks. The bare fences of each
// length are listed once, in line order, and each list is read with a cursor
// that only moves forward, so finding every closer stays linear. A clipped
// text's last line may be the start of a longer one, so it never closes.
function splitBlocks (text, clipped) {
  const lines = []
  const fences = []
  const bare = new Map()
  let from = 0
  for (;;) {
    const nl = text.indexOf('\n', from)
    const to = nl === -1 ? text.length : nl
    const fence = fenceOf(text, from, to)
    if (fence !== null && fence.lang === '' && !(clipped && nl === -1)) {
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
  let paraFirst = -1
  const endPara = (last) => {
    if (paraFirst === -1) return
    const start = lines[paraFirst][0]
    const end = lines[last][1]
    if (end > start) blocks.push({ kind: 'para', start, end })
    paraFirst = -1
  }
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
        endPara(i - 1)
        const body = k === i + 1 ? '' : text.slice(lines[i + 1][0], lines[k - 1][1])
        blocks.push({ kind: 'code', lang: fence.lang === '' ? null : fence.lang, text: body, start: lines[i][0] })
        i = k + 1
        continue
      }
    }
    // In a clipped text the closer may have been cut off, so a fence with
    // none runs to the end as a cut block rather than as literal text.
    if (clipped && fence !== null) {
      endPara(i - 1)
      const body = i + 1 < lines.length ? text.slice(lines[i + 1][0]) : ''
      blocks.push({ kind: 'code', lang: fence.lang === '' ? null : fence.lang, text: body, cut: true })
      return blocks
    }
    if (paraFirst === -1) paraFirst = i
    i++
  }
  endPara(lines.length - 1)
  return blocks
}

// Index of the next backtick run of exactly one, or -1.
function findTick (text, from, end) {
  let p = from
  while (p < end) {
    const at = text.indexOf('`', p)
    if (at === -1 || at >= end) return -1
    let q = at + 1
    while (q < end && text.charCodeAt(q) === 0x60) q++
    if (q - at === 1) return at
    p = q
  }
  return -1
}

// Units of one paragraph: literal text, atoms, inline code (opaque: nothing
// inside is parsed) and delimiter runs with whether each may open or close.
// endClass is what the end of the text counts as. What follows a clipped
// text is unknown, so there it counts as a word character: nothing closes
// against it.
function tokenize (text, start, end, atoms, cursor, endClass) {
  const tail = end === text.length ? endClass : SPACE
  while (cursor.at < atoms.length && atoms[cursor.at].start < start) {
    if (atoms[cursor.at].end > start) throw new Error('atom crosses a block')
    cursor.at++
  }
  const units = []
  let lit = start
  let opaqueEnd = -1
  let ticks = true
  const flush = (to) => {
    if (to > lit) units.push({ type: 'text', text: text.slice(lit, to) })
  }
  let i = start
  while (i < end) {
    const atom = atoms[cursor.at]
    const nextAtom = atom !== undefined && atom.start < end ? atom.start : end
    if (atom !== undefined && atom.start === i) {
      if (atom.end > end) throw new Error('atom crosses a block')
      flush(i)
      units.push({ type: 'atom', segment: atom.segment })
      i = atom.end
      lit = i
      opaqueEnd = i
      cursor.at++
      continue
    }
    const c = text.charCodeAt(i)
    if (!isMark(c)) {
      i++
      continue
    }
    let j = i + 1
    while (j < nextAtom && text.charCodeAt(j) === c) j++
    // Inline code needs the same outside boundary as the other markers: the
    // ticks are not rendered, so code flush against a word or a link would
    // read as part of it. A longer run is literal. Only a lone tick with no
    // lone tick after it turns the search off, since then none can close.
    // Each search ends at the next lone tick and the loop resumes past it or
    // past an atom holding it, so the scans never overlap.
    if (c === 0x60) {
      const before = i === start ? SPACE : i === opaqueEnd ? WORD : classBefore(text, i)
      if (j - i !== 1 || !ticks || before === WORD) {
        i = j
        continue
      }
      const close = findTick(text, j, end)
      if (close === -1) {
        ticks = false
        i = j
        continue
      }
      const saved = cursor.at
      const pieces = []
      let p = j
      let crossed = false
      while (cursor.at < atoms.length && atoms[cursor.at].start <= close) {
        const a = atoms[cursor.at]
        if (a.end > close) {
          crossed = true
          break
        }
        if (a.start > p) pieces.push({ type: 'text', text: text.slice(p, a.start) })
        pieces.push({ type: 'atom', segment: a.segment })
        p = a.end
        cursor.at++
      }
      const after = close + 1 === end
        ? tail
        : cursor.at < atoms.length && atoms[cursor.at].start === close + 1 ? WORD : classOf(text.codePointAt(close + 1))
      if (crossed || after === WORD) {
        cursor.at = saved
        i = j
        continue
      }
      if (close > p) pieces.push({ type: 'text', text: text.slice(p, close) })
      flush(i)
      units.push({ type: 'code', pieces })
      i = close + 1
      lit = i
      opaqueEnd = i
      continue
    }
    const kind = kindOf(c, j - i)
    if (kind === null) {
      i = j
      continue
    }
    const before = i === start ? SPACE : i === opaqueEnd ? WORD : classBefore(text, i)
    const after = j === end ? tail : j === nextAtom ? WORD : classOf(text.codePointAt(j))
    flush(i)
    units.push({
      type: 'delim',
      kind,
      text: text.slice(i, j),
      open: before !== WORD && after !== SPACE,
      close: before !== SPACE && after !== WORD,
      pair: -1
    })
    i = j
    lit = i
  }
  flush(end)
  return units
}

// A closer pairs with the nearest open opener of its kind; openers left above
// it can no longer close properly nested, so they drop back to literal. Each
// opener is pushed and popped once, so this is linear.
function pairUp (units) {
  const stack = []
  const depths = new Map()
  for (let u = 0; u < units.length; u++) {
    const d = units[u]
    if (d.type !== 'delim') continue
    const mine = depths.get(d.kind)
    if (d.close && mine !== undefined && mine.length > 0) {
      const depth = mine[mine.length - 1]
      while (stack.length > depth + 1) depths.get(units[stack.pop()].kind).pop()
      const opener = stack.pop()
      mine.pop()
      units[opener].pair = u
      d.pair = opener
      continue
    }
    if (d.open) {
      if (mine === undefined) depths.set(d.kind, [stack.length])
      else mine.push(stack.length)
      stack.push(u)
    }
  }
  return units
}

function isStyled (f) {
  return f.bold || f.italic || f.strike || f.code || f.spoiler
}

function sameStyle (a, b) {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike &&
    a.code === b.code && a.spoiler === b.spoiler
}

// From unit number rawFrom on (counted across paragraphs), everything is shown
// as its raw source with no style, except spoilers: they never count toward
// cap and always apply, so the cap can never uncover one (the text length
// bounds them). overflowAt is where the styled span count first passed cap,
// moved back to the outermost pair still open there, so no pair loses its
// opening marker while its closer shows raw. With clipped, an unclosed ||
// ends the output with an empty spoiler span.
function render (parsed, cap, rawFrom, clipped) {
  const blocks = []
  let styled = 0
  let overflowAt = -1
  let ordinal = 0
  for (const block of parsed) {
    if (block.kind === 'code') {
      blocks.push(block.cut ? { kind: 'code', lang: block.lang, text: block.text, cut: true } : { kind: 'code', lang: block.lang, text: block.text })
      continue
    }
    const spans = []
    const depth = { bold: 0, italic: 0, strike: 0, spoiler: 0 }
    const open = []
    let raw = false
    let cut = false
    const add = (text, code, segment) => {
      if (text === '') return
      const f = raw
        ? { ...NO_STYLE, spoiler: depth.spoiler > 0 }
        : {
            bold: depth.bold > 0,
            italic: depth.italic > 0,
            strike: depth.strike > 0,
            code,
            spoiler: depth.spoiler > 0
          }
      const atom = segment !== null
      const last = spans[spans.length - 1]
      if (!atom && last !== undefined && !last.atom && sameStyle(last, f)) {
        last.text += text
        return
      }
      if (isStyled(f) && !f.spoiler) {
        if (styled >= cap && overflowAt === -1) overflowAt = open.length > 0 ? open[0] : ordinal
        styled++
      }
      spans.push({
        text,
        bold: f.bold,
        italic: f.italic,
        strike: f.strike,
        code: f.code,
        spoiler: f.spoiler,
        atom,
        segment
      })
    }
    const pieceOut = (piece, code) => {
      if (piece.type === 'atom') add(piece.segment.text, code, piece.segment)
      else add(piece.text, code, null)
    }
    for (const unit of block.units) {
      if (ordinal >= rawFrom) raw = true
      if (unit.type === 'text' || unit.type === 'atom') {
        pieceOut(unit, false)
      } else if (unit.type === 'code') {
        if (raw) add('`', false, null)
        for (const piece of unit.pieces) pieceOut(piece, !raw)
        if (raw) add('`', false, null)
      } else if (unit.pair === -1 || (raw && unit.kind !== '||')) {
        if (clipped && !raw && unit.kind === '||' && unit.open) {
          spans.push({ text: '', ...NO_STYLE, spoiler: true, atom: false, segment: null })
          cut = true
          break
        }
        add(unit.text, false, null)
      } else {
        const opens = unit.pair > unit.index
        depth[STYLE[unit.kind]] += opens ? 1 : -1
        if (opens) open.push(ordinal)
        else open.pop()
      }
      ordinal++
    }
    if (spans.length > 0) blocks.push({ kind: 'para', spans })
    if (cut) break
  }
  return { blocks, overflowAt }
}

// Past codeMax code blocks, the text from the next one on is plain, with its
// spoilers hidden as for text the parser cannot read.
function parse (text, atoms, cap, clipped, codeMax = Infinity, endClass = clipped ? WORD : SPACE) {
  const cursor = { at: 0 }
  let split = splitBlocks(text, clipped)
  let rest = null
  let code = 0
  for (let b = 0; b < split.length; b++) {
    if (split[b].kind === 'code' && ++code > codeMax) {
      rest = text.slice(split[b].start)
      split = split.slice(0, b)
      break
    }
  }
  const parsed = split.map((block) => {
    if (block.kind === 'code') return block
    const units = pairUp(tokenize(text, block.start, block.end, atoms, cursor, endClass))
    for (let u = 0; u < units.length; u++) units[u].index = u
    return { kind: 'para', units }
  })
  const first = render(parsed, cap, Infinity, clipped)
  const blocks = first.overflowAt === -1 ? first.blocks : render(parsed, cap, first.overflowAt, clipped).blocks
  if (rest !== null) blocks.push(plainParagraph([{ text: rest }], barsFrom(rest)))
  return blocks
}

function plainSpan (text, segment) {
  return { text, ...NO_STYLE, atom: segment !== null, segment }
}

// Offset of the first || that could open a spoiler (a non-space follows it),
// or Infinity. Text the parser did not read is hidden from there on, since a
// spoiler could start at any such ||.
function barsFrom (text) {
  let from = 0
  for (;;) {
    const at = text.indexOf('||', from)
    if (at === -1 || at + 2 >= text.length) return Infinity
    if (!isSpaceCp(text.codePointAt(at + 2))) return at
    from = at + 1
  }
}

// hideFrom hides everything from that offset: an atom holding it is hidden
// whole and a plain segment crossing it splits there.
function plainParagraph (segments, hideFrom) {
  const spans = []
  let offset = 0
  for (const s of segments) {
    const end = offset + s.text.length
    const atom = typeof s.href === 'string' || typeof s.username === 'string'
    if (atom) {
      spans.push({ ...plainSpan(s.text, s), spoiler: end > hideFrom })
    } else if (offset < hideFrom && hideFrom < end) {
      spans.push(plainSpan(s.text.slice(0, hideFrom - offset), null))
      spans.push({ ...plainSpan(s.text.slice(hideFrom - offset), null), spoiler: true })
    } else {
      spans.push({ ...plainSpan(s.text, null), spoiler: offset >= hideFrom })
    }
    offset = end
  }
  return { kind: 'para', spans }
}

// displayText turns some of the code points poisoned() looks for into U+FFFD, so a
// quote or a reply bar fed display-cleaned text still gets the fallback the
// bubble of the raw text got.
function unparsable (text) {
  return poisoned(text) || text.indexOf('\ufffd') !== -1
}

// Cheap test for any marker character, so plain text skips the parser.
export function hasRich (text) {
  return typeof text === 'string' && /[*_~|`]/.test(text)
}

export function parseRich (text) {
  if (typeof text !== 'string' || text === '') return []
  try {
    const segments = textSegments(text, { mentions: true })
    const atoms = atomsOf(text, segments)
    if (!hasRich(text) || unparsable(text)) return [plainParagraph(segments, barsFrom(text))]
    return parse(text, atoms, SPAN_MAX, false, CODE_MAX)
  } catch {
    const at = barsFrom(text)
    if (at === Infinity) return [{ kind: 'para', spans: [plainSpan(text, null)] }]
    const hidden = { ...plainSpan(text.slice(at), null), spoiler: true }
    return [{ kind: 'para', spans: at === 0 ? [hidden] : [plainSpan(text.slice(0, at), null), hidden] }]
  }
}

function firstLine (text) {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

// One 'spoiler' per run of hidden spans, so a spoiler split by an atom or a
// nested style still reads as one word.
function plainSpans (spans) {
  let out = ''
  let hidden = false
  for (const span of spans) {
    if (span.spoiler) {
      if (!hidden) out += 'spoiler'
      hidden = true
    } else {
      out += span.text
      hidden = false
    }
  }
  return out
}

// Hides the same range as parseRich does for text it cannot parse.
function hideFromBars (text) {
  const at = barsFrom(text)
  return at === Infinity ? text : text.slice(0, at) + 'spoiler'
}

// Text without markers for previews and notifications. No span cap here, so
// every spoiler stays hidden however many styles precede it, but the same
// CODE_MAX as the bubble, so the text past it hides what the bubble hides.
// A code block gives its first line, or every line with full. clipped is for
// a text cut short: how the whole reads past the first || depends on what
// follows the cut (a closing tick, a poisoned code point, a mention), so
// nothing from there on is shown. Text before the first || never sits inside
// a spoiler, so it is parsed as usual, its end a boundary since a | follows.
export function plainOf (text, { clipped = false, full = false } = {}) {
  if (typeof text !== 'string' || text === '') return ''
  if (clipped !== true) return plainText(text, false, SPACE, full === true)
  const bars = text.indexOf('||')
  if (bars === -1) return plainText(text, true, WORD, false)
  const head = plainText(text.slice(0, bars), true, PUNCT, false)
  const apart = head !== '' && text.charCodeAt(bars - 1) === 0x0a && !head.endsWith('\n')
  return head + (apart ? '\n' : '') + 'spoiler'
}

function plainText (text, clipped, endClass, full) {
  if (text === '') return ''
  try {
    const segments = textSegments(text, { mentions: true })
    const atoms = atomsOf(text, segments)
    if (!hasRich(text)) return text
    if (unparsable(text)) return hideFromBars(text)
    const blocks = parse(text, atoms, Infinity, clipped, clipped ? Infinity : CODE_MAX, endClass)
    // A cut block may not be code in the whole text, where a spoiler could
    // open on its first line, so that line hides from its first ||.
    const lineOf = (b) => (full ? b.text : b.cut ? hideFromBars(firstLine(b.text)) : firstLine(b.text))
    return blocks.map((b) => (b.kind === 'code' ? lineOf(b) : plainSpans(b.spans))).join('\n')
  } catch {
    return hideFromBars(text)
  }
}
