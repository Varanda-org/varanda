// GIF search client helpers. Pure ES module. The account service proxies the
// GIF provider: it hands the app opaque ids, never URLs, so a hostile or
// compromised answer cannot point the app at another host.
import { accountOriginOf } from './pageGate.js'
import { gifSize } from './media/gif.js'
import { checkFile } from './media/plan.js'
import { boundedFile } from './chatSend.js'

export const MAX_ITEMS = 50
export const MAX_DIMENSION = 4096
export const MAX_BYTES = 8388608
export const MAX_QUERY = 64
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_CURSOR = 512

// '' (the hosted web app, same origin) keeps a relative path; anything else
// must be an https account origin, or the result is null.
function base (origin) {
  if (origin === undefined || origin === null || origin === '') return ''
  const o = accountOriginOf(origin)
  return o === undefined ? null : o
}

// The search request's JSON body, { q } or { q, cursor }, or null. The text
// rides in a POST body, never the URL, so a proxy's error log that keeps the
// request line cannot record what a member searched for.
export function searchBody (q, cursor) {
  if (typeof q !== 'string') return null
  const text = q.trim()
  const length = Array.from(text).length
  if (length < 1 || length > MAX_QUERY) return null
  if (cursor === undefined || cursor === null || cursor === '') return { q: text }
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR) return null
  return { q: text, cursor }
}

export function imageUrl (origin, id, size) {
  const b = base(origin)
  if (b === null || typeof id !== 'string' || !ID_RE.test(id)) return null
  if (size !== 'tiny' && size !== 'full') return null
  return b + '/account/gif/image/' + id + '?size=' + size
}

// The GIF origin of a node: undefined (the installation's own account
// service) for a hosted node, else null. A node that is not hosted has no
// invite.sign, which the GIF session needs, whatever accountOrigin it names.
export function gifOriginOf (node) {
  return node !== null && node !== undefined && node.hosted === true ? undefined : null
}

const inRange = (v, max) => Number.isInteger(v) && v >= 1 && v <= max

function exactKeys (o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k))
}

// { items, next } or null. Strict: any extra key, URL-looking value or size
// out of range refuses the whole page.
export function parseSearch (json) {
  if (!exactKeys(json, ['items', 'next'])) return null
  const { items, next } = json
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return null
  if (next !== null && (typeof next !== 'string' || next.length < 1 || next.length > MAX_CURSOR || /[/\\]{2}|:\/\//.test(next))) return null
  const out = []
  for (const item of items) {
    if (!exactKeys(item, ['id', 'width', 'height', 'bytes'])) return null
    if (typeof item.id !== 'string' || !ID_RE.test(item.id)) return null
    if (!inRange(item.width, MAX_DIMENSION) || !inRange(item.height, MAX_DIMENSION) || !inRange(item.bytes, MAX_BYTES)) return null
    out.push({ id: item.id, width: item.width, height: item.height, bytes: item.bytes })
  }
  return { items: out, next }
}

// Picker texts (GifPicker.js). A 429 says so; every other failure is one
// calm sentence, never the server's words.
export const GIF_DEBOUNCE_MS = 350
export const GIF_EMPTY_TEXT = 'Nenhum GIF encontrado'
export const GIF_UNAVAILABLE_TEXT = 'Busca de GIF indisponível'
export const GIF_LIMIT_TEXT = 'Limite de buscas de GIF por hoje'

export function gifErrorText (err) {
  return err && err.code === 'limite-gif' ? GIF_LIMIT_TEXT : GIF_UNAVAILABLE_TEXT
}

// The query a search would send, or '' when there is nothing to search.
export function gifQuery (text) {
  if (typeof text !== 'string') return ''
  const q = text.trim()
  const length = Array.from(q).length
  return length >= 1 && length <= MAX_QUERY ? q : ''
}

// A next page appended to the grid: an id already shown is skipped, so a
// provider that repeats a result never gives the grid two cells with one key.
export function mergeGifPage (items, page) {
  const seen = new Set()
  const out = []
  for (const item of [...(Array.isArray(items) ? items : []), ...(page && Array.isArray(page.items) ? page.items : [])]) {
    if (!item || typeof item.id !== 'string' || seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

// Picker state: one search at a time, identified by `gen`; a late page of an
// older query (or an older cursor) is dropped by the caller comparing gens.
export const gifIdle = Object.freeze({ query: '', items: [], next: null, phase: 'idle', error: '', gen: 0 })

export function gifReduce (state, action) {
  switch (action && action.type) {
    case 'query': {
      const query = gifQuery(action.text)
      if (query === state.query && state.phase !== 'error') return state
      return query === ''
        ? { ...gifIdle, gen: state.gen + 1 }
        : { query, items: [], next: null, phase: 'loading', error: '', gen: state.gen + 1 }
    }
    case 'more':
      if (state.phase !== 'ready' || state.next === null) return state
      return { ...state, phase: 'more', gen: state.gen + 1 }
    case 'page':
      if (action.gen !== state.gen) return state
      return { ...state, items: mergeGifPage(state.items, action.page), next: action.page.next, phase: 'ready', error: '' }
    case 'fail':
      if (action.gen !== state.gen) return state
      // A failed next page keeps what is shown and stops asking for more.
      return state.items.length > 0
        ? { ...state, phase: 'ready', next: null, error: gifErrorText(action.error) }
        : { ...state, phase: 'error', error: gifErrorText(action.error) }
    default:
      return state
  }
}

// What the grid says under the search field, or '' when it shows GIFs.
export function gifNotice (state) {
  if (state.phase === 'error') return state.error
  if (state.phase === 'ready' && state.items.length === 0) return GIF_EMPTY_TEXT
  return ''
}

// The picked GIF's full bytes as a composer file ({ bytes, mime, width,
// height }), through the same checks as a gallery GIF (the header, the
// composer's size limits, then mediaBounds from @varanda/rpc), or null.
export function gifFileFrom (bytes, bounds) {
  if (!(bytes instanceof Uint8Array)) return null
  const size = gifSize(bytes)
  if (size === null) return null
  if (checkFile({ mime: 'image/gif', bytes: bytes.byteLength, ...size }) !== null) return null
  return bounds === undefined ? boundedFile({ bytes, mime: 'image/gif' }) : boundedFile({ bytes, mime: 'image/gif' }, bounds)
}

// At most `max` tiny GIFs downloading at once: a page of fifty cells must
// not open fifty requests. run(task) -> the task's promise.
export function gifQueue (max = 4) {
  let active = 0
  const waiting = []
  const pump = () => {
    while (active < max && waiting.length > 0) {
      const { task, resolve, reject } = waiting.shift()
      active++
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active--
        pump()
      })
    }
  }
  return {
    run (task) {
      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject })
        pump()
      })
    },
    get active () { return active },
    get waiting () { return waiting.length }
  }
}
