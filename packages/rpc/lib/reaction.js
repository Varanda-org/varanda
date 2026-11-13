'use strict'

// A reaction to a group message (`group-react`, docs/protocol.md section 10):
// exactly one emoji, peer data checked by explicit code-point ranges rather
// than \p{...} property escapes, which Hermes is not known to support.

const REACTION_MAX_POINTS = 8
const REACTION_MAX_BYTES = 40

// A frozen table, a consensus rule: every replica must accept the same
// reactions whatever its Unicode version, so it never changes without a
// protocol change. It is a superset of Unicode 17's Extended_Pictographic
// (from an older emoji-data list, so it keeps some symbols that are no
// longer pictographic) made only of symbols: no letter (but U+2139
// INFORMATION SOURCE, an emoji Unicode classes as one), number, separator,
// control, format or private-use code point (test/reaction.test.js). The
// regional indicators and skin tones are left out: they only count in their
// own positions.
const PICTOGRAPHIC = [
  [0x00a9, 0x00a9], [0x00ae, 0x00ae], [0x203c, 0x203c], [0x2049, 0x2049],
  [0x2122, 0x2122], [0x2139, 0x2139], [0x2194, 0x2199], [0x21a9, 0x21aa],
  [0x231a, 0x231b], [0x2328, 0x2328], [0x2388, 0x2388], [0x23cf, 0x23cf],
  [0x23e9, 0x23f3], [0x23f8, 0x23fa], [0x24c2, 0x24c2], [0x25aa, 0x25ab],
  [0x25b6, 0x25b6], [0x25c0, 0x25c0], [0x25fb, 0x25fe], [0x2600, 0x2605],
  [0x2607, 0x2612], [0x2614, 0x2685], [0x2690, 0x2705], [0x2708, 0x2712],
  [0x2714, 0x2714], [0x2716, 0x2716], [0x271d, 0x271d], [0x2721, 0x2721],
  [0x2728, 0x2728], [0x2733, 0x2734], [0x2744, 0x2744], [0x2747, 0x2747],
  [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757],
  [0x2763, 0x2767], [0x2795, 0x2797], [0x27a1, 0x27a1], [0x27b0, 0x27b0],
  [0x27bf, 0x27bf], [0x2934, 0x2935], [0x2b05, 0x2b07], [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x3030, 0x3030], [0x303d, 0x303d],
  [0x3297, 0x3297], [0x3299, 0x3299], [0x1f000, 0x1f0ff], [0x1f10d, 0x1f10f],
  [0x1f12f, 0x1f12f], [0x1f16c, 0x1f171], [0x1f17e, 0x1f17f], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f1ad, 0x1f1e5], [0x1f201, 0x1f20f], [0x1f21a, 0x1f21a],
  [0x1f22f, 0x1f22f], [0x1f232, 0x1f23a], [0x1f23c, 0x1f23f], [0x1f249, 0x1f3fa],
  [0x1f400, 0x1f53d], [0x1f546, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f774, 0x1f77f],
  [0x1f7d5, 0x1f7ff], [0x1f80c, 0x1f80f], [0x1f848, 0x1f84f], [0x1f85a, 0x1f85f],
  [0x1f888, 0x1f88f], [0x1f8ae, 0x1f8ff], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945],
  [0x1f947, 0x1faff], [0x1fc00, 0x1fffd]
]
const VS16 = 0xfe0f
const ZWJ = 0x200d
const KEYCAP = 0x20e3

function inRanges (cp, ranges) {
  for (let i = 0; i < ranges.length; i++) {
    if (cp < ranges[i][0]) return false
    if (cp <= ranges[i][1]) return true
  }
  return false
}

const isPictographic = (cp) => inRanges(cp, PICTOGRAPHIC)
const isSkinTone = (cp) => cp >= 0x1f3fb && cp <= 0x1f3ff
const isRegional = (cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff
const isKeycapBase = (cp) => cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39)

// Code points of s, or null on a lone surrogate.
function codePoints (s) {
  const out = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1)
      if (!(d >= 0xdc00 && d <= 0xdfff)) return null
      out.push((c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000)
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return null
    } else {
      out.push(c)
    }
  }
  return out
}

// One element of a ZWJ sequence: a pictograph, then an optional skin tone,
// then an optional VS16. Returns the index after it, or -1.
function element (cps, i) {
  if (i >= cps.length || !isPictographic(cps[i])) return -1
  i++
  if (i < cps.length && isSkinTone(cps[i])) i++
  if (i < cps.length && cps[i] === VS16) i++
  return i
}

// Exactly one emoji: a regional indicator pair (a flag), a keycap
// ([0-9#*] VS16? U+20E3), or pictographs joined by ZWJ. Never throws.
function isReaction (s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > REACTION_MAX_BYTES) return false
  const cps = codePoints(s)
  if (cps === null || cps.length < 1 || cps.length > REACTION_MAX_POINTS) return false
  let bytes = 0
  for (const cp of cps) bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  if (bytes > REACTION_MAX_BYTES) return false
  if (isRegional(cps[0])) return cps.length === 2 && isRegional(cps[1])
  if (isKeycapBase(cps[0])) {
    return (cps.length === 2 && cps[1] === KEYCAP) ||
      (cps.length === 3 && cps[1] === VS16 && cps[2] === KEYCAP)
  }
  let i = element(cps, 0)
  while (i !== -1 && i < cps.length) {
    if (cps[i] !== ZWJ) return false
    i = element(cps, i + 1)
  }
  return i === cps.length
}

module.exports = { isReaction, REACTION_MAX_POINTS, REACTION_MAX_BYTES }
