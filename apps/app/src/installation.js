/* global URL */

// Native builds have no document origin. Callers prefix same-origin paths
// with an installation the person chose, or with a build-time value. While
// this is unset, resolveUrl returns the path unchanged, which is what the
// hosted web app does today. No imports: Metro bundles the file and the
// tests load it with import().

let current = null
// The optional media origin a live /varanda.json answer named. Memory only,
// never persisted: until a live answer arrives, media uses the installation.
let media = null

export function setInstallation (value) {
  if (value === null) {
    if (current !== null) media = null
    current = null
    return true
  }
  const url = readInstallation(value)
  if (url === null) return false
  // Callers join this to a path and compare it, so the stored spelling cannot
  // carry a trailing slash or a default port.
  // An answer of another installation does not carry over.
  if (url.origin !== current) media = null
  current = url.origin
  return true
}

export function installationOrigin () {
  return current
}

// -> the validated https origin, or null (use the installation origin).
export function mediaOrigin () {
  return media
}

// value: the media of a live discovery answer. Stored only when valid,
// otherwise cleared, so a changed or invalid answer never leaves an old one.
export function setMediaOrigin (value) {
  media = validMediaOrigin(value)
  return media !== null
}

// The shape finish-web.js and the service worker enforce at build time:
// https://host[:port], ASCII lowercase DNS labels, a port from 1 to 65535.
// The platform URL parsers differ (some keep raw non-ASCII, a zero-width
// space or a soft hyphen in a host), so this regex, not the parser, decides.
const MEDIA_ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$/

// An https origin with no path, query, fragment or userinfo, written exactly
// as URL.origin writes it (so no default port, no uppercase, no trailing
// slash but one), that also passes MEDIA_ORIGIN_RE. IP literals (v4 and
// bracketed v6) and localhost are refused: an edge is a public DNS name.
// Anything else is ignored. -> the origin or null.
export function validMediaOrigin (value) {
  const url = tryUrl(value)
  if (url === null || url.protocol !== 'https:' || url.origin === 'null') return null
  if (value !== url.origin && value !== url.origin + '/') return null
  const origin = url.origin
  if (!MEDIA_ORIGIN_RE.test(origin)) return null
  const colon = origin.indexOf(':', 8)
  if (colon !== -1) {
    const port = Number(origin.slice(colon + 1))
    if (port < 1 || port > 65535) return null
  }
  const host = url.hostname
  if (/^[0-9.]+$/.test(host) || host === 'localhost' || host.endsWith('.localhost')) return null
  return origin
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
