'use strict'

// Pure text helpers shared by the whole package. No Node built-ins: this file
// must load unchanged in a browser bundle, in Node and in Bare.

// Bytes of the UTF-8 encoding of a JS string, computed without allocating.
// A lone surrogate counts 3 bytes (TextEncoder writes it as U+FFFD).
function utf8ByteLength (str) {
  let n = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4
        i++
      } else {
        n += 3
      }
    } else {
      n += 3
    }
  }
  return n
}

// Strict UTF-8 in pure JS (no TextEncoder/TextDecoder: Bare has neither,
// docs/rpc.md section 3). The encoder writes a lone surrogate as U+FFFD
// (EF BF BD), exactly like TextEncoder.
function utf8Encode (str) {
  const out = new Uint8Array(utf8ByteLength(str))
  let o = 0
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i)
    if (cp >= 0xd800 && cp <= 0xdfff) {
      const d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0
      if (cp <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (d - 0xdc00)
        i++
      } else {
        cp = 0xfffd
      }
    }
    if (cp < 0x80) {
      out[o++] = cp
    } else if (cp < 0x800) {
      out[o++] = 0xc0 | (cp >> 6)
      out[o++] = 0x80 | (cp & 0x3f)
    } else if (cp < 0x10000) {
      out[o++] = 0xe0 | (cp >> 12)
      out[o++] = 0x80 | ((cp >> 6) & 0x3f)
      out[o++] = 0x80 | (cp & 0x3f)
    } else {
      out[o++] = 0xf0 | (cp >> 18)
      out[o++] = 0x80 | ((cp >> 12) & 0x3f)
      out[o++] = 0x80 | ((cp >> 6) & 0x3f)
      out[o++] = 0x80 | (cp & 0x3f)
    }
  }
  return out
}

// Strict decoder, same accept/reject and output as
// new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }): overlong forms,
// surrogates U+D800-U+DFFF, code points above U+10FFFF, truncated sequences
// and stray continuation bytes throw TypeError('UTF-8 inválido'). A BOM is
// kept as U+FEFF.
function utf8Decode (bytes) {
  const units = []
  let out = ''
  const n = bytes.length
  let i = 0
  const bad = () => { throw new TypeError('UTF-8 inválido') }
  const cont = (k, lo = 0x80, hi = 0xbf) => {
    if (k >= n) bad()
    const b = bytes[k]
    if (b < lo || b > hi) bad()
    return b & 0x3f
  }
  while (i < n) {
    const b = bytes[i]
    let cp
    if (b < 0x80) {
      cp = b
      i += 1
    } else if (b >= 0xc2 && b <= 0xdf) {
      cp = ((b & 0x1f) << 6) | cont(i + 1)
      i += 2
    } else if (b >= 0xe0 && b <= 0xef) {
      const lo = b === 0xe0 ? 0xa0 : 0x80
      const hi = b === 0xed ? 0x9f : 0xbf
      cp = ((b & 0x0f) << 12) | (cont(i + 1, lo, hi) << 6) | cont(i + 2)
      i += 3
    } else if (b >= 0xf0 && b <= 0xf4) {
      const lo = b === 0xf0 ? 0x90 : 0x80
      const hi = b === 0xf4 ? 0x8f : 0xbf
      cp = ((b & 0x07) << 18) | (cont(i + 1, lo, hi) << 12) | (cont(i + 2) << 6) | cont(i + 3)
      i += 4
    } else {
      bad()
    }
    if (cp < 0x10000) {
      units.push(cp)
    } else {
      cp -= 0x10000
      units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff))
    }
    if (units.length >= 8192) {
      out += String.fromCharCode.apply(null, units)
      units.length = 0
    }
  }
  return out + String.fromCharCode.apply(null, units)
}

// Length in code points, measured exactly as packages/core/lib/records.js
// measures name, bio and text.
function charLength (str) {
  return Array.from(str).length
}

// First `max` code points of `str`, with U+2026 appended when anything was cut.
function clipText (str, max) {
  const chars = Array.from(str)
  if (chars.length <= max) return str
  return chars.slice(0, Math.max(0, max - 1)).join('') + '\u2026'
}

// The unsafe set of packages/core/lib/safe.js isUnsafe (C0, DEL, C1,
// U+2028/U+2029, U+202A-U+202E, U+2066-U+2069) plus the direction marks
// U+200E, U+200F and U+061C. LF is kept only in multiline mode.
function isDisplayUnsafe (cp, multiline) {
  if (cp < 0x20) return !(multiline && cp === 0x0a)
  if (cp >= 0x7f && cp <= 0x9f) return true
  if (cp === 0x2028 || cp === 0x2029) return true
  if (cp >= 0x202a && cp <= 0x202e) return true
  if (cp >= 0x2066 && cp <= 0x2069) return true
  // A lone surrogate (records accept it; for...of yields it alone).
  if (cp >= 0xd800 && cp <= 0xdfff) return true
  return cp === 0x200e || cp === 0x200f || cp === 0x061c
}

// The single escaper the UI uses for any peer-derived string (A8): every
// unsafe code point becomes U+FFFD. Pure, total, never throws.
function displayText (value, opts) {
  let multiline = false
  let str = ''
  try {
    multiline = opts !== null && typeof opts === 'object' && opts.multiline === true
    str = typeof value === 'string' ? value : String(value)
  } catch {
    return ''
  }
  let out = ''
  for (const ch of str) {
    out += isDisplayUnsafe(ch.codePointAt(0), multiline) ? '\ufffd' : ch
  }
  return out
}

module.exports = { utf8ByteLength, utf8Encode, utf8Decode, charLength, clipText, displayText, isDisplayUnsafe }
