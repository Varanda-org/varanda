// Native: a link preview read by the device itself, once, while the person
// writes (docs/protocol.md, "Link cards"). Only https, a dotted hostname the
// card rules accept (cardUrlHost: never an IP literal), no cookies, at most
// PAGE_TIMEOUT_MS and PAGE_CAP bytes of text/html; the page is read inertly
// by preview.js extractPreview (nothing is run or loaded), then its og:image
// the same way (IMAGE_CAP, an image type confirmed by its leading bytes).
// No redirect is ever used: the device cannot check where a name resolves,
// so a link that redirects (a shortener, or a public page sending to an
// intranet page the sender's network reaches) gets no preview, and an
// og:image that redirects gets no thumbnail. The web proxy instead follows
// up to 3 redirects, checking each address.
// Shared code imports './previewBuild'; previewBuild.web.js has the same
// export. Only called while "Prévia de links" is on (previewPref.js).
// -> { url, host, title, desc, imageBytes, imageMime } or null; never rejects.

import rpc from '@varanda/rpc'
import { fetch as expoFetch } from 'expo/fetch'
import { extractPreview } from './preview.js'

const { cardUrlHost } = rpc
const PAGE_TIMEOUT_MS = 5000
const PAGE_CAP = 512 * 1024
const IMAGE_CAP = 256 * 1024
const PAGE_TYPES = ['text/html']
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

// The image type its leading bytes say, or null.
export function sniffImage (b) {
  if (!(b instanceof Uint8Array) || b.byteLength < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

function typeOf (res) {
  const raw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : ''
  return typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : ''
}

// True when the answer came through a redirect: the transport says so, or
// its URL is not the one asked (both normalized). React Native may follow a
// redirect despite redirect: 'manual', so this is checked on every answer.
function redirected (res, url) {
  try {
    if (res.redirected === true) return true
    if (typeof res.url !== 'string' || res.url === '') return false
    return new URL(res.url).href !== new URL(url).href
  } catch {
    return true
  }
}

// The body as bytes, read as a stream that is cancelled (and the request
// aborted) as soon as it passes `cap`, or null. A transport without a stream
// gives no preview: a whole body is never buffered before the cap.
async function readBody (res, cap, stop) {
  if (!res.body || typeof res.body.getReader !== 'function') return null
  const reader = res.body.getReader()
  const parts = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!(value instanceof Uint8Array) || total + value.byteLength > cap) {
      try { reader.cancel().catch(() => {}) } catch {}
      stop()
      return null
    }
    parts.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

// One GET under the caps, never through a redirect -> Uint8Array, or null.
async function getCapped (url, { fetchImpl, signal, cap, types, accept }) {
  if (cardUrlHost(url) === null) return null
  const ctl = new AbortController()
  const stop = () => ctl.abort()
  const timer = setTimeout(stop, PAGE_TIMEOUT_MS)
  if (signal) {
    if (signal.aborted) return null
    signal.addEventListener('abort', stop)
  }
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'manual',
      headers: { accept },
      signal: ctl.signal
    })
    if (!res || res.status !== 200 || redirected(res, url) || !types.includes(typeOf(res))) {
      stop()
      return null
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > cap) {
      stop()
      return null
    }
    const bytes = await readBody(res, cap, stop)
    if (bytes === null || ctl.signal.aborted || bytes.byteLength === 0 || bytes.byteLength > cap) return null
    return bytes
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', stop)
  }
}

// UTF-8 to text (a malformed sequence as U+FFFD); TextDecoder when the
// runtime has one.
export function utf8 (bytes) {
  try {
    if (typeof TextDecoder === 'function') return new TextDecoder('utf-8').decode(bytes)
  } catch {}
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]
    const need = b < 0x80 ? 0 : b >= 0xc2 && b < 0xe0 ? 1 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xf0 && b < 0xf5 ? 3 : -1
    if (need < 0) { out += '�'; i++; continue }
    let cp = need === 0 ? b : b & (0x3f >> need)
    let ok = i + need < bytes.length
    for (let k = 1; ok && k <= need; k++) {
      const c = bytes[i + k]
      if ((c & 0xc0) !== 0x80) ok = false
      else cp = (cp << 6) | (c & 0x3f)
    }
    if (!ok || (need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) || (need === 3 && (cp < 0x10000 || cp > 0x10ffff))) {
      out += '�'
      i++
      continue
    }
    out += String.fromCodePoint(cp)
    i += need + 1
  }
  return out
}

export function sameSiteImage (pageHost, imageUrl) {
  const host = cardUrlHost(imageUrl)
  return typeof pageHost === 'string' && host !== null && (host === pageHost || host.endsWith('.' + pageHost))
}

// `fetch` defaults to expo/fetch, whose body is a stream (React Native's
// global fetch buffers the whole body first); only tests replace it.
export async function buildPreview (url, { signal, fetch: fetchImpl = expoFetch } = {}) {
  try {
    if (typeof fetchImpl !== 'function' || cardUrlHost(url) === null) return null
    const page = await getCapped(url, { fetchImpl, signal, cap: PAGE_CAP, types: PAGE_TYPES, accept: 'text/html' })
    if (page === null) return null
    const html = utf8(page)
    const found = html === null ? null : extractPreview(html, url)
    if (found === null || (signal && signal.aborted)) return null
    let imageBytes = null
    let imageMime = null
    // The phone cannot check where a name resolves, so a page may not point
    // it at another host (an intranet one) for the image: same host or a
    // subdomain of it only. The web proxy, which checks addresses, has no
    // such limit.
    if (found.imageUrl && sameSiteImage(found.host, found.imageUrl)) {
      const got = await getCapped(found.imageUrl, { fetchImpl, signal, cap: IMAGE_CAP, types: IMAGE_TYPES, accept: IMAGE_TYPES.join(', ') })
      const mime = sniffImage(got)
      if (mime !== null) {
        imageBytes = got
        imageMime = mime
      }
    }
    if (signal && signal.aborted) return null
    return { url: found.url, host: found.host, title: found.title, desc: found.desc, imageBytes, imageMime }
  } catch {
    return null
  }
}

// "Prévia de links" (previewPref.js) on the phone: a small JSON file in the
// app's document directory, read synchronously like the appearance choice.
let prefStore = null
export function previewPrefStore () {
  if (prefStore !== null) return prefStore
  const { File, Paths } = require('expo-file-system')
  const file = () => new File(Paths.document, 'varanda-previas-links.json')
  prefStore = {
    getItem () {
      try {
        const f = file()
        return f.exists ? f.textSync() : null
      } catch {
        return null
      }
    },
    setItem (_key, value) {
      const f = file()
      if (!f.exists) f.create()
      f.write(value)
    }
  }
  return prefStore
}
