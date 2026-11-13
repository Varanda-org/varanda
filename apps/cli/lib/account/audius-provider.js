'use strict'

const { isHostname } = require('./safe-fetch')
const { cardText, cardUrlHost } = require('@varanda/rpc')

// The one place that knows the Audius API shapes: the operator's config, the
// request of each kind, and the mapping of an answer to the few fields a
// member ever sees. Pure: no I/O, never throws on provider data.
//
// Every answer is untrusted. An item is kept only when every rule passes and
// dropped otherwise, one by one: a gated, unlisted, deleted, private or
// unavailable item, or one with an access shape this file does not know, is
// never offered, so the member never meets a track the proxy cannot play.
// No user id or provider stream URL is copied: those would make the member's
// device fetch from Audius directly. The artwork URLs are kept as `art` and
// `artLarge` for the service alone: the routes strip them from every answer,
// and a member reaches a cover only as bytes the service fetched and checked.

const DEFAULT_API_URL = 'https://api.audius.co/v1'
const ID_RE = /^[A-Za-z0-9]{1,32}$/
const KEY_RE = /^[\x21-\x7e]{1,256}$/
const APP_RE = /^[a-z0-9-]{1,32}$/
const SEGMENT_RE = /^[A-Za-z0-9\-._~%@!$&'()*+,;=:]+$/
const PAGE_ORIGIN = 'https://audius.co'
const PAGE_HOST = 'audius.co'
const MAX_TITLE = 80
const MAX_PAGE_URL = 240
const MAX_DURATION = 7200
const MAX_PLAYLIST = 500
const MAX_LIST = 50
const MAX_QUERY = 256
const MAX_OFFSET = 4999
const MAX_ART_URL = 512
const MAX_GENRE = 40
const RELEASE_RE = /^\d{4}-\d{2}-\d{2}/
const CURSOR_RE = /^(0|[1-9][0-9]{0,3})$/

// -> { base, apiHost, apiKey, appName, moments, covers, streams } or null. Returns
// null on any bad value and never throws, so no caller can put a value (the
// key above all) into an error message or a log line.
function parseAudiusConfig (options) {
  if (!isObject(options)) return null
  const { apiKey, apiUrl = DEFAULT_API_URL, appName = 'varanda', moments = false, covers = false, streams = 16 } = options
  if (typeof apiKey !== 'string' || !KEY_RE.test(apiKey)) return null
  if (typeof appName !== 'string' || !APP_RE.test(appName)) return null
  if (typeof moments !== 'boolean') return null
  if (typeof covers !== 'boolean') return null
  if (!Number.isInteger(streams) || streams < 1 || streams > 32) return null
  if (typeof apiUrl !== 'string' || apiUrl.length > 512) return null
  let url
  try {
    url = new URL(apiUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  // `new URL` already folded a numeric host such as 0x7f.1 into a dotted
  // literal, which isHostname refuses like any other IP literal.
  const apiHost = url.hostname.toLowerCase()
  if (!isHostname(apiHost)) return null
  return { base: url.origin + url.pathname.replace(/\/+$/, ''), apiHost, apiKey, appName, moments, covers, streams }
}

// Where the key travels: a header, never the URL, because URLs reach logs
// (ours, Caddy's, any proxy's) and redirect targets. The app name is public
// and rides in the query as Audius asks.
function keyParams (config) {
  return { headers: { 'x-api-key': config.apiKey }, query: { app_name: config.appName } }
}

// An https audius.co page URL of 2 to 4 path segments, with no query,
// fragment, port or credentials: the shape of a track, playlist or album
// page, and nothing the resolve request could carry elsewhere.
function isAudiusPermalink (url) {
  if (typeof url !== 'string' || url.length > MAX_PAGE_URL) return false
  if (!url.startsWith(PAGE_ORIGIN + '/') || cardUrlHost(url) !== PAGE_HOST) return false
  if (url.includes('?') || url.includes('#')) return false
  const segments = url.slice(PAGE_ORIGIN.length + 1).split('/')
  if (segments.length < 2 || segments.length > 4) return false
  return segments.every((s) => SEGMENT_RE.test(s) && s !== '.' && s !== '..')
}

function paging (params) {
  const { limit = 20, offset = 0 } = params
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) return null
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) return null
  return { limit: String(limit), offset: String(offset) }
}

function searchQuery (params) {
  const { query } = params
  if (typeof query !== 'string' || query.length < 1 || query.length > MAX_QUERY) return null
  const page = paging(params)
  return page && { query, ...page }
}

// -> { href, firstHeaders } or null for an unknown kind or a bad parameter.
// `firstHeaders` belong to the first hop only: a redirect (the stream answers
// with one) must not carry the key to another host.
function requestFor (config, kind, params = {}) {
  if (config === null || typeof config !== 'object' || params === null || typeof params !== 'object') return null
  const { id } = params
  let path
  let query = {}
  if (kind === 'searchTracks' || kind === 'searchPlaylists') {
    query = searchQuery(params)
    if (query === null) return null
    path = kind === 'searchTracks' ? '/tracks/search' : '/playlists/search'
  } else if (kind === 'resolve') {
    if (!isAudiusPermalink(params.url)) return null
    path = '/resolve'
    query = { url: params.url }
  } else {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null
    if (kind === 'track') path = '/tracks/' + id
    else if (kind === 'playlist') path = '/playlists/' + id
    else if (kind === 'playlistTracks') path = '/playlists/' + id + '/tracks'
    else if (kind === 'stream') path = '/tracks/' + id + '/stream'
    else return null
  }
  const key = keyParams(config)
  const search = new URLSearchParams({ ...query, ...key.query }).toString()
  return { href: config.base + path + '?' + search, firstHeaders: { ...key.headers } }
}

function isObject (v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

// The value under either spelling. Both present and different counts as
// unreadable: the answer is not trusted to mean one of them.
const UNREADABLE = Symbol('unreadable')
function field (json, snake, camel) {
  const a = json[snake]
  const b = json[camel]
  if (a !== undefined && b !== undefined && a !== b) return UNREADABLE
  return a !== undefined ? a : b
}

// A flag that drops the item when set: only absent, null or false keeps it.
function flagClear (json, snake, camel) {
  const v = field(json, snake, camel)
  return v === undefined || v === null || v === false
}

// A flag that drops the item only when false: absent, null or true keeps it.
function flagNotFalse (json, snake, camel) {
  const v = field(json, snake, camel)
  return v === undefined || v === null || v === true
}

// Free to stream with no condition: no gate, no stream conditions, and an
// access object, when there is one, of exactly the known open shape.
function openAccess (json) {
  if (!flagClear(json, 'is_stream_gated', 'isStreamGated')) return false
  const conditions = field(json, 'stream_conditions', 'streamConditions')
  if (conditions !== undefined && conditions !== null) return false
  const access = json.access
  if (access === undefined) return true
  return isObject(access) && access.stream === true
}

function artistOf (json) {
  return isObject(json.user) ? cardText(json.user.name, MAX_TITLE) : ''
}

// The audius.co page of an item, or null. isAudiusPermalink holds the host,
// length and fragment rules, so a pasted link and a provider item pass the
// same test.
function pageUrl (permalink) {
  if (typeof permalink !== 'string' || !permalink.startsWith('/')) return null
  const url = PAGE_ORIGIN + permalink
  return isAudiusPermalink(url) ? url : null
}

// The artwork URL of an item at `size` ('150x150' or '480x480'), or null.
// Only a plain https URL on a named public host: no credentials, port or
// fragment, so the art fetch has nothing to carry and the host passes the same
// rule as the API host. A bad value never drops the item, it only leaves it
// without a cover.
function artOf (json, size = '150x150') {
  try {
    if (size !== '150x150' && size !== '480x480') return null
    if (!isObject(json) || !isObject(json.artwork)) return null
    const raw = json.artwork[size]
    if (typeof raw !== 'string' || raw.length > MAX_ART_URL) return null
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') return null
    if (raw.includes('#')) return null
    const host = url.hostname.toLowerCase()
    if (!host.includes('.') || !isHostname(host)) return null
    return url.href
  } catch {
    return null
  }
}

// The song info a track may carry: each key only when the provider value is
// usable, so a missing one never drops the track. The genre goes through
// cardText like the title, as it reaches the screen.
function infoOf (json) {
  const out = {}
  const genre = cardText(json.genre, MAX_GENRE)
  if (genre !== '') out.genre = genre
  const date = json.release_date
  if (typeof date === 'string' && RELEASE_RE.test(date)) {
    const year = Number(date.slice(0, 4))
    if (year >= 1900 && year <= 2100) out.year = year
  }
  return out
}

function fromTrack (json) {
  if (!isObject(json)) return null
  const { id, duration } = json
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  if (!flagClear(json, 'is_delete', 'isDelete') || !flagClear(json, 'is_deleted', 'isDeleted')) return null
  if (!flagClear(json, 'is_unlisted', 'isUnlisted')) return null
  if (!flagNotFalse(json, 'is_streamable', 'isStreamable')) return null
  if (!flagNotFalse(json, 'is_available', 'isAvailable')) return null
  if (!openAccess(json)) return null
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_DURATION) return null
  const title = cardText(json.title, MAX_TITLE)
  const artist = artistOf(json)
  if (title === '' || artist === '') return null
  const url = pageUrl(json.permalink)
  if (url === null) return null
  return { id, title, artist, duration, url, art: artOf(json), artLarge: artOf(json, '480x480'), ...infoOf(json) }
}

function fromPlaylist (json) {
  if (!isObject(json)) return null
  const { id } = json
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  if (!flagClear(json, 'is_delete', 'isDelete') || !flagClear(json, 'is_deleted', 'isDeleted')) return null
  if (!flagClear(json, 'is_private', 'isPrivate')) return null
  if (!openAccess(json)) return null
  const count = field(json, 'track_count', 'trackCount')
  if (!Number.isInteger(count) || count < 1 || count > MAX_PLAYLIST) return null
  const name = field(json, 'playlist_name', 'playlistName')
  const title = cardText(name === UNREADABLE ? null : name, MAX_TITLE)
  const artist = artistOf(json)
  if (title === '' || artist === '') return null
  const url = pageUrl(json.permalink)
  if (url === null) return null
  return { id, title, artist, count, url, art: artOf(json), artLarge: artOf(json, '480x480') }
}

// The answer of a resolve request, which ends at the track endpoint (data
// an object) or the playlist endpoint (data an array of one).
function fromResolve (json) {
  if (!isObject(json)) return null
  let item = json.data
  if (Array.isArray(item)) {
    if (item.length !== 1) return null
    item = item[0]
  }
  if (!isObject(item)) return null
  if (item.playlist_name !== undefined || item.playlistName !== undefined) {
    const playlist = fromPlaylist(item)
    return playlist && { kind: 'playlist', item: playlist }
  }
  const track = fromTrack(item)
  return track && { kind: 'track', item: track }
}

// The items of a list answer, at most MAX_LIST, or null when the answer has
// no data array: an unreadable answer is a provider failure, never an empty
// result.
function listOf (json) {
  if (!isObject(json) || !Array.isArray(json.data)) return null
  return json.data.slice(0, MAX_LIST)
}

// The next page's offset as a cursor string, or null at the end. `count` is
// the number of items the provider sent, before any was dropped here: a short
// page is the last one.
function nextCursor (offset, count, pageSize) {
  if (!Number.isInteger(offset) || !Number.isInteger(count) || !Number.isInteger(pageSize)) return null
  if (offset < 0 || pageSize < 1 || count < pageSize) return null
  const next = offset + pageSize
  return next > MAX_OFFSET ? null : String(next)
}

module.exports = {
  DEFAULT_API_URL,
  ID_RE,
  CURSOR_RE,
  MAX_OFFSET,
  MAX_LIST,
  parseAudiusConfig,
  keyParams,
  requestFor,
  isAudiusPermalink,
  artOf,
  fromTrack,
  fromPlaylist,
  fromResolve,
  listOf,
  nextCursor
}
