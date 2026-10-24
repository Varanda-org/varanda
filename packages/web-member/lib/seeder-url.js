// The seeder's WebSocket address as the browser node accepts it: ws: or wss:,
// a host, an optional port and path, and nothing else (no credentials, query
// or fragment). It is node configuration, never a request parameter, and is
// never logged or returned by the node (it can name a private host).
const { UsageError } = require('@varanda/core/lib/errors')

const MAX_URL = 2048

// -> the normalized URL string, or throws UsageError('endereço do semeador inválido').
function checkSeederUrl (value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL || /\s/.test(value)) {
    throw new UsageError('endereço do semeador inválido')
  }
  let url
  try {
    url = new URL(value)
  } catch {
    throw new UsageError('endereço do semeador inválido')
  }
  if ((url.protocol !== 'ws:' && url.protocol !== 'wss:') || url.hostname === '' ||
      url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' ||
      value.includes('#') || value.includes('?')) {
    throw new UsageError('endereço do semeador inválido')
  }
  return url.href
}

module.exports = { checkSeederUrl, MAX_URL }
