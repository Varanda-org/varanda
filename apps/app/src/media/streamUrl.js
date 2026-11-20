// The only audio a stream player may open: a ticket path of the account
// service that audiusPlay answered, relative on the hosted web app (no base)
// or joined to the https base audiusPlay actually used. The match is on the
// exact string, so a query, a fragment, credentials, a dot segment or any
// other host never passes, whatever URL parsing would make of it. No URL
// parser: React Native's differs from the browser's.

const PATH_RE = /^\/account\/audius\/audio\/[A-Za-z0-9_-]{43}$/

// Lowercase dotted hostname, optional non-default port, nothing after. The
// spelling must already be canonical (what URL.origin gives), so the joined
// string is the one audiusPlay built.
const ORIGIN_RE = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/

export function isHttpsOrigin (origin) {
  if (typeof origin !== 'string') return false
  const m = ORIGIN_RE.exec(origin)
  if (m === null) return false
  // A URL parser reads a host whose last label is a number (decimal or 0x
  // hex) as an IPv4 literal: 1.2.3.4, 10.0x7f.
  const last = m[1].slice(m[1].lastIndexOf('.') + 1)
  if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last)) return false
  if (m[2] !== undefined) {
    const port = Number(m[2])
    if (port === 443 || port > 65535) return false
  }
  return true
}

export function isStreamPath (path) {
  return typeof path === 'string' && PATH_RE.test(path)
}

// origin: the base audiusPlay returned, never a node origin. null or
// undefined means the hosted web app's own origin, so only the bare path.
export function isStreamUrl (url, origin) {
  if (typeof url !== 'string') return false
  if (origin === null || origin === undefined) return isStreamPath(url)
  if (!isHttpsOrigin(origin)) return false
  if (!url.startsWith(origin)) return false
  return isStreamPath(url.slice(origin.length))
}
