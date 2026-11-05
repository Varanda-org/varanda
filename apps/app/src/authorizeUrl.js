/* global URL */

// Where the account service may send the person to sign in. No imports, so the
// tests load it with import().

const LOOPBACK = new Set(['localhost', '127.0.0.1'])

function parse (value) {
  if (typeof value !== 'string' || value === '') return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function loopbackHttp (url) {
  return url !== null && url.protocol === 'http:' && LOOPBACK.has(url.hostname)
}

// https, without userinfo, anywhere. Cleartext only to a loopback host and only
// when the account service itself is a loopback http origin (the hosted lab's
// stand-in for Google). A production installation always has an https account
// origin (config.js), so there nothing but https passes.
export function acceptableAuthorizeUrl (url, accountOrigin) {
  const u = parse(url)
  if (u === null || u.host === '' || u.username !== '' || u.password !== '') return false
  // The parser drops tabs and newlines, reads a backslash as a slash and
  // accepts 'https:host', so only the plain spelling is read the way it looks.
  if (/[\s\\]/.test(url) || !/^https?:\/\//.test(url)) return false
  if (u.protocol === 'https:') return true
  if (!loopbackHttp(u)) return false
  const origin = parse(accountOrigin)
  return loopbackHttp(origin) && origin.username === '' && origin.password === '' &&
    (origin.pathname === '/' || origin.pathname === '') && origin.search === '' && origin.hash === ''
}
