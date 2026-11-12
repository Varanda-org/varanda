// Turns verified media bytes into something an Image can show. React Native
// has no blob: URLs, so the bytes go to a file under the cache directory
// (never Documents) and the Image gets its file:// URI. revokeUrl deletes it,
// and the whole directory is swept on the module's first use after a start,
// so nothing written here outlives the run. File names are random, never
// taken from a peer. Photos of the own and followed authors that should
// survive a restart live in a separate store (./keep, directory
// varanda-media-keep): the sweep removes only varanda-media, and revokeUrl
// accepts only a 32-hex name inside it, so neither ever deletes a kept file.

import { Directory, File, Paths } from 'expo-file-system'

const DIR = 'varanda-media'
const EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4' })
const NAME = /^[0-9a-f]{32}\.(jpg|png|webp|gif|mp4)$/
// media.readFile output (../client/webnode.native.js readFileUri): the
// worklet names every file it writes there <32 hex>.bin.
const READ_NAME = /^[0-9a-f]{32}\.bin$/

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

function readDirUri () {
  const base = Paths.document.uri.endsWith('/') ? Paths.document.uri : Paths.document.uri + '/'
  return base + 'varanda/media-read/'
}

// Moves a video media.readFile wrote (the worklet measured it strictly
// first) into the swept media directory as <32 hex>.mp4 and returns its
// file:// URI, so revokeUrl and the start sweep own it like any shown
// photo. Only a .bin directly under the read directory is taken; anything
// else throws and nothing moves.
export function adoptVideoFile (uri) {
  const base = readDirUri()
  if (typeof uri !== 'string' || !uri.startsWith(base) || !READ_NAME.test(uri.slice(base.length))) {
    throw new Error('vídeo inválido')
  }
  if (!swept) sweepMediaCache()
  const d = dir()
  d.create({ intermediates: true, idempotent: true })
  const target = new File(d, randomHex() + '.mp4')
  new File(uri).move(target)
  return target.uri
}
