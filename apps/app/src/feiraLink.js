// Feira listing links: the public page <origin>/f/<hex>/<seq> and the path
// inside the app /anuncio/<hex>/<seq> (the public page's "Entrar para
// conversar" button). Pure ES module: no React, no globals, no Node
// built-ins; location, history and storage are passed in, so Node's import()
// tests every branch with fakes.
//
// The pending listing is a small record kept in tab storage, untrusted on
// every read (anything on the origin could have written it), so it is
// rebuilt field by field and dropped when doubtful or older than one hour.
// Opening a listing never acts on its own: the screen only shows it.

export const LISTING_LINK_KEY = 'varanda-feira-listing'
export const LISTING_LINK_TTL_MS = 3600000

const MAX_PATH = 120
const MAX_RAW = 256
const CLOCK_SKEW_MS = 60000
const HEX64 = /^[0-9a-f]{64}$/
const LISTING_PATH = /^\/(?:anuncio|f)\/([0-9a-fA-F]{64})\/([1-9][0-9]{0,15})$/

// Cheap prefix test: any path under /anuncio/ or /f/ is a listing link
// attempt and gets cleaned from the address bar, valid or not.
export function isListingPath (p) {
  return typeof p === 'string' && (p.startsWith('/anuncio/') || p.startsWith('/f/'))
}

// { author, seq } | null. Strict regex over the raw path, never
// decodeURIComponent: '%', '..', '//', a query and extra segments all fail.
// A fragment (#oferta=...) is ignored.
export function parseListingPath (p) {
  if (typeof p !== 'string') return null
  const hash = p.indexOf('#')
  const path = hash === -1 ? p : p.slice(0, hash)
  if (path.length > MAX_PATH) return null
  const m = LISTING_PATH.exec(path)
  if (!m) return null
  const seq = Number(m[2])
  if (!Number.isSafeInteger(seq)) return null
  return { author: m[1].toLowerCase(), seq }
}

// A bare https origin only: no path, trailing slash, userinfo or query.
export function validOrigin (origin) {
  if (typeof origin !== 'string') return false
  let url
  try { url = new URL(origin) } catch { return false }
  return url.protocol === 'https:' && url.origin === origin
}

// The public link of a listing. `seq` is always the root listing's block,
// never an edit's: an edit replaces the content, the link stays the same.
export function shareUrlOf (origin, author, seq) {
  if (!validOrigin(origin)) return null
  if (typeof author !== 'string' || !HEX64.test(author)) return null
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  return origin + '/f/' + author + '/' + seq
}

function makeRecord (author, seq, at) {
  return Object.freeze({ v: 1, author, seq, at })
}

export function encodeListingLink (rec) {
  return JSON.stringify({ v: 1, author: rec.author, seq: rec.seq, at: rec.at })
}

// Frozen record or null. Extra keys (including __proto__) are never copied.
export function decodeListingLink (raw, now) {
  if (typeof raw !== 'string' || raw.length > MAX_RAW) return null
  let o
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return null
  if (typeof o.author !== 'string' || !HEX64.test(o.author)) return null
  if (!Number.isSafeInteger(o.seq) || o.seq < 1) return null
  if (!Number.isSafeInteger(o.at) || !Number.isFinite(now)) return null
  if (o.at > now + CLOCK_SKEW_MS || now - o.at > LISTING_LINK_TTL_MS) return null
  return makeRecord(o.author, o.seq, o.at)
}

// Storage access is always guarded: private modes and quota errors throw,
// and a missing storage means nothing remembered.
export function readListingLink (storage, now = Date.now()) {
  if (!storage) return null
  let raw
  try { raw = storage.getItem(LISTING_LINK_KEY) } catch { return null }
  if (raw === null || raw === undefined) return null
  const rec = decodeListingLink(raw, now)
  if (rec === null) {
    try { storage.removeItem(LISTING_LINK_KEY) } catch {}
  }
  return rec
}

export function clearListingLink (storage) {
  if (!storage) return false
  try {
    storage.removeItem(LISTING_LINK_KEY)
    return true
  } catch {
    return false
  }
}

// Runs once at startup. A listing path first clears the stored record,
// valid or not, so a newer link always wins; a valid one stores a fresh
// record for an hour (it survives the sign-in round trip). The path is then
// cleaned to '/', keeping search and hash byte for byte for the account flow.
// Any other path only reads what is stored. -> record | null.
export function captureListingLink (location, history, storage, now = Date.now()) {
  try {
    const pathname = location && location.pathname
    if (!isListingPath(pathname)) return readListingLink(storage, now)
    clearListingLink(storage)
    const target = parseListingPath(pathname)
    let fresh = null
    if (target !== null) {
      fresh = makeRecord(target.author, target.seq, now)
      try { storage.setItem(LISTING_LINK_KEY, encodeListingLink(fresh)) } catch {}
    }
    try {
      history.replaceState(history.state, '', '/' + (location.search || '') + (location.hash || ''))
    } catch {}
    return fresh
  } catch {
    return null
  }
}
