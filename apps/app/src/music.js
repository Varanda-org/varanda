// Audius music rules for the app. Pure ES module: no React, React Native or
// Node built-ins. The account service proxies Audius (docs/protocol.md,
// "Service answers: music (Audius)"), so the app only ever talks to its own
// account origin; every answer is checked here before anything uses it.
//
// A post carries music without a new record key: a link card whose URL is
// the item's audius.co page plus a fragment, `#varanda-musica=t:<id>` (a full
// track), `s:<id>:<start>` (a SNIPPET_S second snippet from <start> seconds)
// or `p:<id>` (a playlist). The card comes from a peer, so only an id and a
// start that match the grammar exactly ever reach a request.

import rpc from '@varanda/rpc'

const { cardText, cardUrlHost, MAX_CARD_URL, MAX_CARD_TITLE, MAX_CARD_DESC } = rpc

export const SNIPPET_S = 15
// The picker badge for that fixed window, not a length measured from the track.
export const SNIPPET_BADGE = '15 s'
export const MUSIC_ID_RE = /^[A-Za-z0-9]{1,32}$/
export const MUSIC_HOST = 'audius.co'
export const MAX_START = 7200
export const MAX_DURATION = 7200
export const MAX_PLAYLIST = 500
export const MAX_PLAYLIST_TRACKS = 50
export const MAX_ITEMS = 50
export const MAX_QUERY = 64
export const MAX_CURSOR = 500
// Within this much of the asked start, a seek counts as reached: players land
// on a nearby frame, never exactly on the second asked.
export const SEEK_SLACK_MS = 2000

const PAGE_ORIGIN = 'https://' + MUSIC_HOST
// The service's own limits on a page URL (audius-provider.js
// isAudiusPermalink): with the longest fragment, a card URL stays within
// MAX_CARD_URL.
const MAX_PAGE_URL = 240
const SEGMENT_RE = /^[A-Za-z0-9\-._~%@!$&'()*+,;=:]+$/
const FRAGMENT_RE = /^varanda-musica=(?:t:([A-Za-z0-9]{1,32})|s:([A-Za-z0-9]{1,32}):(0|[1-9][0-9]{0,3})|p:([A-Za-z0-9]{1,32}))$/
const CURSOR_RE = /^(0|[1-9][0-9]{0,2})$/
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/ // eslint-disable-line no-control-regex
const KINDS = ['track', 'playlist']

const isId = (v) => typeof v === 'string' && MUSIC_ID_RE.test(v)
const isDuration = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_DURATION
const isStart = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_START

function exactKeys (o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k))
}

// An audius.co page as the service accepts one: https, no port, credentials,
// query or fragment, 2 to 4 path segments. The same test for a pasted link
// and for a page URL the service answered.
export function isAudiusPage (url) {
  if (typeof url !== 'string' || url.length > MAX_PAGE_URL) return false
  if (!url.startsWith(PAGE_ORIGIN + '/') || cardUrlHost(url) !== MUSIC_HOST) return false
  if (url.includes('?') || url.includes('#')) return false
  const segments = url.slice(PAGE_ORIGIN.length + 1).split('/')
  if (segments.length < 2 || segments.length > 4) return false
  return segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')
}

// The music a card URL names, or null: frozen { kind, id, start }, start
// null unless a snippet. The page before the fragment must be an audius.co
// page and the whole fragment must match, so nothing else in a peer's URL is
// read.
export function musicRefOf (url) {
  if (typeof url !== 'string' || url.length > MAX_CARD_URL || cardUrlHost(url) !== MUSIC_HOST) return null
  const hash = url.indexOf('#')
  if (hash === -1 || !isAudiusPage(url.slice(0, hash))) return null
  const m = FRAGMENT_RE.exec(url.slice(hash + 1))
  if (m === null) return null
  if (m[1] !== undefined) return Object.freeze({ kind: 'track', id: m[1], start: null })
  if (m[4] !== undefined) return Object.freeze({ kind: 'playlist', id: m[4], start: null })
  const start = Number(m[3])
  if (!isStart(start)) return null
  return Object.freeze({ kind: 'snippet', id: m[2], start })
}

function fragmentOf (ref) {
  if (!ref || typeof ref !== 'object' || !isId(ref.id)) return null
  if (ref.kind === 'snippet') return isStart(ref.start) ? 's:' + ref.id + ':' + ref.start : null
  if (ref.start !== null && ref.start !== undefined) return null
  if (ref.kind === 'track') return 't:' + ref.id
  if (ref.kind === 'playlist') return 'p:' + ref.id
  return null
}

// The card URL for an item's page and a ref, or null when the page is not an
// audius.co page (it already has a fragment, say) or the result would pass
// MAX_CARD_URL.
export function musicCardUrl (itemUrl, ref) {
  if (!isAudiusPage(itemUrl)) return null
  const fragment = fragmentOf(ref)
  if (fragment === null) return null
  const url = itemUrl + '#varanda-musica=' + fragment
  if (url.length > MAX_CARD_URL || musicRefOf(url) === null) return null
  return url
}

const faixas = (n) => (n === 1 ? '1 faixa' : n + ' faixas')

// The link card fields for a picked item: { url, host, title, desc }, or
// null. A playlist ref needs a playlist item, a track or snippet ref a track
// item, both with the ref's id; a snippet must start where SNIPPET_S seconds
// still fit.
export function musicCardFields (item, ref) {
  if (!item || typeof item !== 'object' || !ref || typeof ref !== 'object' || item.id !== ref.id) return null
  const playlist = ref.kind === 'playlist'
  if (playlist ? !(Number.isInteger(item.count) && item.count >= 1 && item.count <= MAX_PLAYLIST) : !isDuration(item.duration)) return null
  if (ref.kind === 'snippet' && clampStart(ref.start, item.duration) !== ref.start) return null
  const url = musicCardUrl(item.url, ref)
  if (url === null) return null
  const title = cardText(item.title, MAX_CARD_TITLE)
  const artist = cardText(item.artist, MAX_CARD_DESC)
  if (title === '' || artist === '') return null
  const desc = cardText(playlist ? artist + ' · ' + faixas(item.count) : artist, MAX_CARD_DESC)
  return { url, host: MUSIC_HOST, title, desc }
}

// The latest start that still leaves a whole snippet (0 for a track shorter
// than SNIPPET_S or an unknown duration).
export function maxStart (duration) {
  if (!isDuration(duration)) return 0
  return Math.min(MAX_START, Math.max(0, duration - SNIPPET_S))
}

export function clampStart (v, duration) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0
  return Math.min(maxStart(duration), Math.max(0, Math.floor(v)))
}

export function snippetEndMs (start, duration) {
  const s = clampStart(start, duration)
  const end = isDuration(duration) ? Math.min(s + SNIPPET_S, duration) : s + SNIPPET_S
  return end * 1000
}

// Whether the player's position has reached a start it was asked to seek to.
export function seekReached (ms, startMs) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || typeof startMs !== 'number' || !Number.isFinite(startMs)) return false
  return ms >= startMs - SEEK_SLACK_MS
}

// A snippet plays only inside its window: before the start (a seek that did
// not land, so never from 0) or at its end it stops.
export function snippetTick ({ ms, startMs, endMs } = {}) {
  if (typeof endMs !== 'number' || !Number.isFinite(endMs)) return 'stop'
  return seekReached(ms, startMs) && ms < endMs ? 'play' : 'stop'
}

const isKind = (v) => KINDS.includes(v)

function queryOf (text) {
  if (typeof text !== 'string') return null
  const q = text.trim()
  const length = Array.from(q).length
  if (length < 1 || length > MAX_QUERY || CONTROL_RE.test(q)) return null
  return q
}

const isCursor = (v) => typeof v === 'string' && CURSOR_RE.test(v) && Number(v) <= MAX_CURSOR

// The search request's JSON body, { q, kind } or { q, kind, cursor }, or
// null. The text rides in a POST body, never the URL.
export function searchBody (q, kind, cursor) {
  const text = queryOf(q)
  if (text === null || !isKind(kind)) return null
  if (cursor === undefined || cursor === null || cursor === '') return { q: text, kind }
  if (!isCursor(cursor)) return null
  return { q: text, kind, cursor }
}

// A title or artist exactly as the service cuts it: cardText's output, never
// empty.
const isText = (v) => typeof v === 'string' && v !== '' && cardText(v, MAX_CARD_TITLE) === v

function trackItem (json) {
  if (!exactKeys(json, ['id', 'title', 'artist', 'duration', 'url'])) return null
  const { id, title, artist, duration, url } = json
  if (!isId(id) || !isText(title) || !isText(artist) || !isDuration(duration) || !isAudiusPage(url)) return null
  return { id, title, artist, duration, url }
}

function playlistFields (json) {
  const { id, title, artist, count, url } = json
  if (!isId(id) || !isText(title) || !isText(artist) || !isAudiusPage(url)) return null
  if (!Number.isInteger(count) || count < 1 || count > MAX_PLAYLIST) return null
  return { id, title, artist, count, url }
}

function playlistItem (json) {
  return exactKeys(json, ['id', 'title', 'artist', 'count', 'url']) ? playlistFields(json) : null
}

// { items, next } or null. Strict: any extra key, bad item or cursor out of
// range refuses the whole page.
export function parseSearch (json, kind) {
  if (!isKind(kind) || !exactKeys(json, ['items', 'next'])) return null
  const { items, next } = json
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return null
  if (next !== null && !isCursor(next)) return null
  const out = []
  for (const it of items) {
    const parsed = kind === 'track' ? trackItem(it) : playlistItem(it)
    if (parsed === null) return null
    out.push(parsed)
  }
  return { items: out, next }
}

// The item answer: a track, or a playlist plus its first tracks (at most
// MAX_PLAYLIST_TRACKS), or null.
export function parseItem (json, kind) {
  if (kind === 'track') return trackItem(json)
  if (kind !== 'playlist' || !exactKeys(json, ['id', 'title', 'artist', 'count', 'url', 'tracks'])) return null
  const playlist = playlistFields(json)
  if (playlist === null || !Array.isArray(json.tracks) || json.tracks.length > MAX_PLAYLIST_TRACKS) return null
  const tracks = []
  for (const it of json.tracks) {
    const track = trackItem(it)
    if (track === null) return null
    tracks.push(track)
  }
  return { ...playlist, tracks }
}

// A resolved page: { kind, item } (a playlist item without tracks), or null.
export function parseResolve (json) {
  if (!exactKeys(json, ['kind', 'item'])) return null
  if (json.kind === 'track') {
    const item = trackItem(json.item)
    return item && { kind: 'track', item }
  }
  if (json.kind === 'playlist') {
    const item = playlistItem(json.item)
    return item && { kind: 'playlist', item }
  }
  return null
}

// { ticket, expiresAt } or null.
export function parsePlay (json) {
  if (!exactKeys(json, ['ticket', 'expiresAt'])) return null
  const { ticket, expiresAt } = json
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return null
  if (typeof expiresAt !== 'string' || !ISO_RE.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) return null
  return { ticket, expiresAt }
}

// The audio path of a ticket, or null. The ticket is the capability, so it
// rides the path (a media element cannot send a header).
export function audioPath (ticket) {
  if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return null
  return '/account/audius/audio/' + ticket
}

// The music origin of a node, by the rule of gifOriginOf: undefined (the
// installation's own account service) for a hosted node, else null. The
// session needs the node's invite.sign, which only a hosted node has.
export function musicOriginOf (node) {
  return node !== null && node !== undefined && node.hosted === true ? undefined : null
}

// A playlist's play queue. `tracks` are parsed track items; `index` is the
// one playing (-1 with none); `done` is set when the last one ended.
export const queueIdle = Object.freeze({ tracks: [], index: -1, done: false })

export function queueStep (state, action) {
  const s = state && Array.isArray(state.tracks) ? state : queueIdle
  const length = s.tracks.length
  switch (action && action.type) {
    case 'load': {
      const tracks = Array.isArray(action.tracks)
        ? action.tracks.filter((t) => t && isId(t.id) && isDuration(t.duration)).slice(0, MAX_PLAYLIST_TRACKS)
        : []
      if (tracks.length === 0) return queueIdle
      const at = Number.isInteger(action.index) && action.index >= 0 && action.index < tracks.length ? action.index : 0
      return { tracks, index: at, done: false }
    }
    case 'select':
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= length) return s
      return { ...s, index: action.index, done: false }
    case 'next':
      return s.index + 1 < length ? { ...s, index: s.index + 1, done: false } : s
    case 'prev':
      return s.index > 0 ? { ...s, index: s.index - 1, done: false } : s
    case 'ended':
      if (length === 0) return s
      return s.index + 1 < length ? { ...s, index: s.index + 1, done: false } : { ...s, done: true }
    default:
      return s
  }
}

// The query a search would send, or '' when there is nothing to search.
export function musicQuery (text) {
  const q = queryOf(text)
  return q === null ? '' : q
}

// Picker and player texts. A daily limit says so; every other failure (the
// feature off, an item gone, a retired ticket, no answer) is one calm
// sentence, never the server's words.
export const MUSIC_DEBOUNCE_MS = 350
export const MUSIC_SOURCE = 'Audius'
export const MUSIC_EMPTY_TEXT = 'Nenhuma música encontrada'
export const MUSIC_UNAVAILABLE_TEXT = 'Música indisponível agora'
export const MUSIC_LIMIT_TEXT = 'Limite de músicas por hoje'
export const MUSIC_NEEDS_TEXT = 'Escreva algo para publicar com a música'
export const MUSIC_SEEK_TEXT = 'Não foi possível começar nesse ponto'
export const MUSIC_FULL_LIST_TEXT = 'Ver a playlist inteira no Audius'

export function musicErrorText (err) {
  return err && err.code === 'limite-musica' ? MUSIC_LIMIT_TEXT : MUSIC_UNAVAILABLE_TEXT
}

// What a playlist player says when the service sent fewer tracks than the
// playlist has ('' when it sent them all): it plays at most
// MAX_PLAYLIST_TRACKS, and the rest is on the Audius page.
export function musicPartialText (item) {
  if (!item || typeof item !== 'object' || !Array.isArray(item.tracks) || !Number.isInteger(item.count)) return ''
  const got = item.tracks.length
  return item.count > got ? 'Tocando ' + got + ' de ' + faixas(item.count) : ''
}

// 'm:ss', minutes unpadded. A value that is not a finite number is the start
// of the track, not a thrown clock.
export function musicClock (seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '0:00'
  const total = Math.max(0, Math.floor(seconds))
  const rest = total % 60
  return Math.floor(total / 60) + ':' + String(rest).padStart(2, '0')
}

// Raw provider text. The screen wraps the whole line in displayText, so a
// cut here would drop a character the provider sent.
export function musicRowLine (item) {
  if (!item || typeof item !== 'object') return ''
  if (typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration >= 1) {
    return item.artist + ' · ' + musicClock(item.duration)
  }
  if (Number.isInteger(item.count) && item.count >= 1 && item.count <= MAX_PLAYLIST) {
    return item.artist + ' · ' + faixas(item.count)
  }
  return ''
}

// Same raw line. A sticker says where playback starts: the title is already beside it.
export function musicStickerLine (ref, item) {
  if (!ref || typeof ref !== 'object' || !item || typeof item !== 'object') return ''
  if (ref.kind === 'snippet') return item.artist + ' · ' + musicClock(ref.start)
  if (ref.kind === 'track') return item.artist + ' · Faixa inteira'
  if (ref.kind === 'playlist' && Number.isInteger(item.count) && item.count >= 1 && item.count <= MAX_PLAYLIST) {
    return 'Playlist · ' + faixas(item.count)
  }
  return ''
}

// 0 outside a real window, so a seek that has not landed does not fill the bar.
export function snippetProgress (ms, startMs, endMs) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 0
  if (typeof startMs !== 'number' || !Number.isFinite(startMs)) return 0
  if (typeof endMs !== 'number' || !Number.isFinite(endMs) || endMs <= startMs) return 0
  const ratio = (ms - startMs) / (endMs - startMs)
  if (ratio <= 0) return 0
  if (ratio >= 1) return 1
  return ratio
}

// The label follows the start that will actually play, so a finger past the
// end does not advertise a window the snippet cannot reach.
export function musicWindowText (start, duration) {
  const s = clampStart(start, duration)
  return 'De ' + musicClock(s) + ' a ' + musicClock(snippetEndMs(s, duration) / 1000)
}
