// The "Meu QR" code: the own profile link (src/profileLink.js) as a QR
// matrix. Pure ES module: no React, no react-native, no Node built-ins.
//
// Reading needs no camera in the app: the phone's own camera opens the link,
// which reaches App.js like any profile link (src/linkReturn.js parses it
// strictly, and the profile opens with a Seguir button, never a silent
// follow). A QR that is not a profile link of this installation opens
// nothing in the app.

import { toQR } from 'toqr'
import { parseProfilePath } from './profileLink.js'

// toqr's error-correction levels: 0 is M (about 15% of the code can be lost,
// enough for a screen held up to another phone's camera).
const EC_M = 0
// The blank margin a reader needs around the code, in modules.
export const QUIET_ZONE = 4
const MAX_TEXT = 120

// ASCII only: a profile link never needs more, and the bytes stay exactly the
// characters shown under the code.
function asciiBytes (text) {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x21 || c > 0x7e) return null
    out[i] = c
  }
  return out
}

const ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/

// True for https://<host>/@nome or https://<host>/m/<hex64> exactly, as
// buildProfileUrl makes them.
export function isProfileUrl (url) {
  if (typeof url !== 'string' || url.length > MAX_TEXT || !url.startsWith('https://')) return false
  const slash = url.indexOf('/', 'https://'.length)
  if (slash === -1) return false
  return ORIGIN.test(url.slice(0, slash)) && parseProfilePath(url.slice(slash)) !== null
}

// -> { size, dark(x, y) } | null. Only a profile link is drawn, so the code
// never carries anything else.
export function profileQr (url) {
  if (!isProfileUrl(url)) return null
  const bytes = asciiBytes(url)
  if (bytes === null) return null
  let cells
  try { cells = toQR(bytes, EC_M) } catch { return null }
  const size = Math.round(Math.sqrt(cells.length))
  if (size < 21 || size * size !== cells.length) return null
  return Object.freeze({ size, dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && cells[y * size + x] === 1 })
}

// One SVG path of every dark module, each a 1x1 square, offset by the quiet
// zone. viewBox side: size + 2 * QUIET_ZONE.
export function qrPath (qr) {
  let d = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.dark(x, y)) d += 'M' + (x + QUIET_ZONE) + ' ' + (y + QUIET_ZONE) + 'h1v1h-1z'
    }
  }
  return d
}
