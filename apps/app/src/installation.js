/* global URL */

// Native builds have no document origin. Callers prefix same-origin paths
// with an installation the person chose, or with a build-time value. While
// this is unset, resolveUrl returns the path unchanged, which is what the
// hosted web app does today. No imports: Metro bundles the file and the
// tests load it with import().

let current = null

export function setInstallation (value) {
  if (value === null) {
    current = null
    return true
  }
  const url = readInstallation(value)
  if (url === null) return false
  // Callers join this to a path and compare it, so the stored spelling cannot
  // carry a trailing slash or a default port.
  current = url.origin
  return true
}

export function installationOrigin () {
  return current
}

// A protocol-relative path would leave the installation, and URL parsing reads
// a backslash as a slash and drops tabs and newlines, so '/\host' or '/\t/host'
// would too.
export function resolveUrl (path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
      /[\\\s]/.test(path) || hasControl(path)) {
    throw new TypeError('path must start with a single /')
  }
  if (current === null) return path
  return current + path
}

// rp.id is the exact host: no port and no IP literal, so no other machine
// under a shared parent can ask for the passkey. Same rules as the web
// passkey helper, copied here because this module imports nothing.
export function rpIdOf (origin) {
  const host = readOrigin(origin).hostname.trim().toLowerCase()
  if (host === '' || host.includes(':') || host.includes('[') || host.includes(']') ||
      /^[0-9.]+$/.test(host) || !/^[a-z0-9.-]+$/.test(host)) {
    throw new TypeError('invalid rpId')
  }
  return host
}

// The port stays when it is not the default, for a later wss://<host>/seeder.
export function hostOf (origin) {
  return readOrigin(origin).host
}

function hasControl (text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

function readInstallation (value) {
  const url = tryUrl(value)
  if (url === null || !isBareOrigin(url)) return null
  // Cleartext is only the dev server. Any other host has to be https.
  if (url.protocol === 'http:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null
  // The parser folds Example.Test to example.test. Refuse that fold: the host
  // must already be lowercase in the string the person typed.
  if (!hostSpellingIsLower(value, url)) return null
  return url
}

function readOrigin (value) {
  const url = tryUrl(value)
  if (url === null || !isBareOrigin(url)) throw new TypeError('invalid origin')
  return url
}

function tryUrl (value) {
  if (typeof value !== 'string') return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isBareOrigin (url) {
  if (url.origin === 'null') return false
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.pathname !== '' && url.pathname !== '/') return false
  if (url.search !== '' || url.hash !== '') return false
  if (url.hostname === '') return false
  return true
}

// The case is read from the original string: URL.hostname is already folded.
function hostSpellingIsLower (value, url) {
  const spelled = authorityOf(value)
  if (spelled === null || spelled !== spelled.toLowerCase()) return false
  // Re-parse the isolated authority so a bad slice cannot look lowercase
  // while the real host was folded.
  let again
  try {
    again = new URL(url.protocol + '//' + spelled)
  } catch {
    return false
  }
  return again.hostname === url.hostname && again.host === url.host
}

function authorityOf (value) {
  const at = value.indexOf('://')
  if (at < 1) return null
  let authority = value.slice(at + 3)
  const cut = authority.search(/[/?#]/)
  if (cut !== -1) authority = authority.slice(0, cut)
  if (authority === '' || authority.includes('@')) return null
  return authority
}
