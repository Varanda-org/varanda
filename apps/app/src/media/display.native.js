// Turns verified media bytes into something an Image can show. React Native
// has no blob: URLs, so the bytes go to a file under the cache directory
// (never Documents) and the Image gets its file:// URI. revokeUrl deletes it,
// and the whole directory is swept on the module's first use after a start,
// so photos of authors the device does not follow (persist: false) leave no
// copy once revoked or by the next start. File names are random, never taken
// from a peer.

import { Directory, File, Paths } from 'expo-file-system'

const DIR = 'varanda-media'
const EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' })
const NAME = /^[0-9a-f]{32}\.(jpg|png|webp|gif)$/

let swept = false

const dir = () => new Directory(Paths.cache, DIR)

function randomHex () {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

// Deletes every cached photo. Idempotent; never throws.
export function sweepMediaCache () {
  swept = true
  try {
    const d = dir()
    if (d.exists) d.delete()
  } catch {}
}

export function urlFromBytes (bytes, mime) {
  const ext = Object.hasOwn(EXT, mime) ? EXT[mime] : null
  if (ext === null || !(bytes instanceof Uint8Array)) throw new Error('foto inválida')
  if (!swept) sweepMediaCache()
  const d = dir()
  d.create({ intermediates: true, idempotent: true })
  const file = new File(d, randomHex() + '.' + ext)
  try {
    file.create()
    file.write(bytes)
  } catch (err) {
    try { file.delete() } catch {}
    throw err
  }
  return file.uri
}

// Deletes a file urlFromBytes wrote; any other URL is ignored, so a caller
// can never make this delete outside the media directory. Never throws.
export function revokeUrl (url) {
  try {
    if (typeof url !== 'string') return
    const name = url.slice(url.lastIndexOf('/') + 1)
    if (!NAME.test(name)) return
    const file = new File(dir(), name)
    if (file.uri !== url) return
    if (file.exists) file.delete()
  } catch {}
}
