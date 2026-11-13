// Which links in a post may play in a provider's own player, and the player
// address for each. Pure: no React, React Native or Node built-ins. A link
// comes from a peer, so nothing from it reaches a player address unless it
// matched a strict pattern first: every path and query string here is
// rebuilt from validated ids, never copied. Path and query are read from the
// raw string (already limited to plain ASCII by cardUrlHost) rather than from
// URL getters, because React Native's URL neither normalizes ports nor
// decodes like a browser, and the result must be the same on every platform.
// Audius has no frame origin on purpose: its tracks play through the account
// service, never in a provider frame.

import rpc from '@varanda/rpc'

const { cardUrlHost } = rpc

export const EMBED_HOSTS = Object.freeze([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'soundcloud.com',
  'on.soundcloud.com',
  'open.spotify.com',
  'music.apple.com'
])

export const EMBED_FRAME_ORIGINS = Object.freeze([
  'https://www.youtube-nocookie.com',
  'https://w.soundcloud.com',
  'https://open.spotify.com',
  'https://embed.music.apple.com'
])

export const EMBED_PROVIDER_NAMES = Object.freeze({
  youtube: 'YouTube',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  apple: 'Apple Music'
})

// The page a native WebView loads the player document into. Not a real
// host: it only gives the document an https origin for the providers.
export const EMBED_BASE_URL = 'https://app.varanda'

// The provider frame's sandbox, the same on native and web. No popups, top
// navigation, forms, downloads or modals: on Android the WebView's top-frame
// guard fails open after 250 ms and never sees a POST, so only the sandbox
// keeps a player from replacing the wrapper or saving a file. The card's own
// "Abrir no ..." link is the way out to the provider.
export const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-presentation'

export const EMBED_PLAY = 'Tocar aqui'
export const EMBED_CLOSE = 'Fechar player'

// Printable ASCII a URL may hold, as rpc's cardUrlHost checks, without its
// length cap.
const EMBED_URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/
const YT_ID = /^[A-Za-z0-9_-]{11}$/
const YT_LIST = /^[A-Za-z0-9_-]{10,64}$/
const YT_START = /^(\d{1,5})s?$/
const YT_MAX_START = 86400
const YT_MIN_HEIGHT = 200
const YT_MIN_WIDTH = 200
const SC_SEGMENT = /^[A-Za-z0-9_-]{1,80}$/
const SC_CODE = /^[A-Za-z0-9]{1,32}$/
// Second path segments that name a profile page, not a track.
const SC_PROFILE_PAGES = new Set(['sets', 'tracks', 'albums', 'likes', 'reposts', 'followers', 'following', 'popular-tracks', 'playlists', 'comments', 'spotlight'])
const SPOTIFY_INTL = /^intl-[a-z]{2}$/
const SPOTIFY_TYPES = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist'])
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/
const APPLE_CC = /^[a-z]{2}$/
const APPLE_TYPES = new Set(['album', 'playlist', 'song'])
// Only escapes of non-ASCII UTF-8 bytes (accented titles): an escaped
// slash, backslash or dot could change the path the player receives.
const APPLE_SLUG = /^(?:[A-Za-z0-9_~-]|%[89A-Fa-f][0-9A-Fa-f]){1,200}$/
const APPLE_NUMBER = /^[0-9]{1,15}$/
const APPLE_PLAYLIST = /^pl\.(?:u-)?[A-Za-z0-9]{1,64}$/

function freeze (provider, kind, embedUrl, pageUrl, height, minWidth) {
  return Object.freeze({ provider, kind, embedUrl, pageUrl, height, minWidth })
}

// { host, segments, query } of a link that passes cardUrlHost, names an
// allowed host on the default port and parses as a URL; null otherwise.
function parts (url) {
  const host = cardUrlHost(url)
  if (host === null || !EMBED_HOSTS.includes(host)) return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== host) return null
  const rest = url.slice('https://'.length).split('#')[0]
  const end = rest.search(/[/?]/)
  const authority = end === -1 ? rest : rest.slice(0, end)
  if (authority !== host) return null
  const tail = end === -1 ? '' : rest.slice(end)
  const q = tail.indexOf('?')
  const path = q === -1 ? tail : tail.slice(0, q)
  const search = q === -1 ? '' : tail.slice(q + 1)
  const segments = path.split('/').slice(1)
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop()
  if (segments.length === 1 && segments[0] === '') segments.pop()
  if (segments.some((s) => s === '')) return null
  const query = new Map()
  for (const pair of search.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const key = eq === -1 ? pair : pair.slice(0, eq)
    if (!query.has(key)) query.set(key, eq === -1 ? '' : pair.slice(eq + 1))
  }
  return { host, segments, query }
}

function youtubeStart (query) {
  for (const key of ['t', 'start']) {
    const m = YT_START.exec(query.get(key) || '')
    if (m) {
      const n = Number(m[1])
      if (n <= YT_MAX_START) return n
    }
  }
  return 0
}

function youtube ({ host, segments, query }) {
  const page = host === 'music.youtube.com' ? 'https://music.youtube.com' : 'https://www.youtube.com'
  let id = null
  if (host === 'youtu.be') {
    if (segments.length === 1) id = segments[0]
  } else if (segments.length === 1 && segments[0] === 'watch') {
    id = query.get('v') || null
  } else if (segments.length === 2 && ['shorts', 'live', 'embed'].includes(segments[0])) {
    id = segments[1]
  } else if (segments.length === 1 && segments[0] === 'playlist') {
    const list = query.get('list') || ''
    if (!YT_LIST.test(list)) return null
    return freeze('youtube', 'playlist',
      'https://www.youtube-nocookie.com/embed?listType=playlist&list=' + list + '&playsinline=1',
      page + '/playlist?list=' + list, YT_MIN_HEIGHT, YT_MIN_WIDTH)
  }
  if (id === null || !YT_ID.test(id)) return null
  const start = youtubeStart(query)
  return freeze('youtube', 'video',
    'https://www.youtube-nocookie.com/embed/' + id + '?playsinline=1&autoplay=1&rel=0' + (start > 0 ? '&start=' + start : ''),
    page + '/watch?v=' + id + (start > 0 ? '&t=' + start + 's' : ''), YT_MIN_HEIGHT, YT_MIN_WIDTH)
}

function soundcloud ({ host, segments }) {
  let page
  let kind
  if (host === 'on.soundcloud.com') {
    if (segments.length !== 1 || !SC_CODE.test(segments[0])) return null
    page = 'https://on.soundcloud.com/' + segments[0]
    // A short code may point at a track or a set; the compact player fits both.
    kind = 'short'
  } else if (segments.length === 2 && segments.every((s) => SC_SEGMENT.test(s)) && !SC_PROFILE_PAGES.has(segments[1])) {
    page = 'https://soundcloud.com/' + segments[0] + '/' + segments[1]
    kind = 'track'
  } else if (segments.length === 3 && segments[1] === 'sets' && SC_SEGMENT.test(segments[0]) && SC_SEGMENT.test(segments[2])) {
    page = 'https://soundcloud.com/' + segments[0] + '/sets/' + segments[2]
    kind = 'set'
  } else {
    return null
  }
  return freeze('soundcloud', kind,
    'https://w.soundcloud.com/player/?url=' + encodeURIComponent(page) + '&auto_play=true&visual=false&show_comments=false&show_teaser=false',
    page, kind === 'set' ? 352 : 166, 0)
}

function spotify ({ segments }) {
  const rest = segments.length > 0 && SPOTIFY_INTL.test(segments[0]) ? segments.slice(1) : segments
  if (rest.length !== 2) return null
  const [type, id] = rest
  if (!SPOTIFY_TYPES.has(type) || !SPOTIFY_ID.test(id)) return null
  return freeze('spotify', type,
    'https://open.spotify.com/embed/' + type + '/' + id,
    'https://open.spotify.com/' + type + '/' + id,
    type === 'track' || type === 'episode' ? 152 : 352, 0)
}

function apple ({ segments, query }) {
  if (segments.length !== 3 && segments.length !== 4) return null
  const [cc, type] = segments
  const id = segments[segments.length - 1]
  const slug = segments.length === 4 ? segments[2] : null
  if (!APPLE_CC.test(cc) || !APPLE_TYPES.has(type)) return null
  if (slug !== null && !APPLE_SLUG.test(slug)) return null
  if (!(type === 'playlist' ? APPLE_PLAYLIST : APPLE_NUMBER).test(id)) return null
  const i = type === 'album' && APPLE_NUMBER.test(query.get('i') || '') ? query.get('i') : null
  const path = '/' + cc + '/' + type + '/' + (slug === null ? '' : slug + '/') + id + (i === null ? '' : '?i=' + i)
  return freeze('apple', type,
    'https://embed.music.apple.com' + path,
    'https://music.apple.com' + path,
    type === 'song' || i !== null ? 175 : 450, 0)
}

// The player for a link, or null. Never throws.
export function embedOf (url) {
  try {
    const p = parts(url)
    if (p === null) return null
    let embed
    if (p.host === 'open.spotify.com') embed = spotify(p)
    else if (p.host === 'music.apple.com') embed = apple(p)
    else if (p.host === 'soundcloud.com' || p.host === 'on.soundcloud.com') embed = soundcloud(p)
    else embed = youtube(p)
    if (embed === null) return null
    if (cardUrlHost(embed.pageUrl) === null) return null
    if (!EMBED_FRAME_ORIGINS.includes(originOf(embed.embedUrl))) return null
    return embed
  } catch {
    return null
  }
}

// The frame origin of a player address, or null. Not held to the card URL
// cap: a valid page link near that cap grows past it as a player address
// (the embed. prefix, an encoded SoundCloud URL). The authority must equal
// one listed origin exactly, so credentials, a port or another host fail.
function originOf (url) {
  if (typeof url !== 'string' || !EMBED_URL_CHARS.test(url) || !url.startsWith('https://')) return null
  const end = url.slice('https://'.length).search(/[/?#]/)
  const origin = end === -1 ? url : url.slice(0, 'https://'.length + end)
  return EMBED_FRAME_ORIGINS.includes(origin) ? origin : null
}

// The listed frame origin of a player address, or null. Exported so tests can
// hold the rule embedHtml relies on against hostile addresses.
export function embedFrameOrigin (embedUrl) {
  return originOf(embedUrl)
}

// The frame height for a card `width` wide: YouTube keeps 16:9 with a floor,
// the other players have a fixed height.
export function embedHeight (embed, width) {
  if (!embed || typeof embed !== 'object') return YT_MIN_HEIGHT
  if (embed.provider !== 'youtube') return embed.height
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return YT_MIN_HEIGHT
  return Math.max(YT_MIN_HEIGHT, Math.round(width * 9 / 16))
}

export function isAudiusLink (url) {
  return cardUrlHost(url) === 'audius.co'
}

// A link card for when the ordinary preview yields nothing (on native that
// preview fetches the provider page from the sender's device first). This
// one makes no request: the provider's name stands in as the title.
export function fallbackCard (url) {
  const embed = embedOf(url)
  if (embed === null) return null
  const host = cardUrlHost(embed.pageUrl)
  if (host === null) return null
  return { url: embed.pageUrl, host, title: EMBED_PROVIDER_NAMES[embed.provider], desc: '' }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c])

// The document a native WebView loads: only the sandboxed player frame, and
// a CSP that allows no other frame, script or connection. The frame's allow
// list names no capture feature (microphone, camera, geolocation, display
// capture), so Permissions Policy blocks getUserMedia before the WebView,
// which grants the microphone silently on Android, is ever asked. '' for
// anything that is not a player address from embedOf.
export function embedHtml (embed) {
  try {
    if (!embed || typeof embed.embedUrl !== 'string') return ''
    const origin = originOf(embed.embedUrl)
    if (!EMBED_FRAME_ORIGINS.includes(origin)) return ''
    const title = Object.prototype.hasOwnProperty.call(EMBED_PROVIDER_NAMES, embed.provider) ? EMBED_PROVIDER_NAMES[embed.provider] : 'Player'
    const csp = "default-src 'none'; frame-src " + origin + "; style-src 'unsafe-inline'"
    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta http-equiv="Content-Security-Policy" content="' + escapeAttr(csp) + '">' +
      '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:100%}</style>' +
      '</head><body>' +
      '<iframe src="' + escapeAttr(embed.embedUrl) + '" title="' + escapeAttr(title) + '" width="100%" height="100%"' +
      ' allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"' +
      ' referrerpolicy="strict-origin-when-cross-origin" sandbox="' + EMBED_SANDBOX + '" allowfullscreen></iframe>' +
      '</body></html>'
  } catch {
    return ''
  }
}

// Whether the WebView's top frame may load `url`: only the player document
// itself. Anything else would replace the player with a provider page.
export function topNavigationAllowed (url) {
  return url === EMBED_BASE_URL || url === EMBED_BASE_URL + '/' || url === 'about:blank'
}

export function embedNotice (provider) {
  if (!Object.prototype.hasOwnProperty.call(EMBED_PROVIDER_NAMES, provider)) return ''
  const name = EMBED_PROVIDER_NAMES[provider]
  return 'Ao tocar, o player do ' + name + ' carrega aqui e o ' + name + ' recebe o endereço de internet deste aparelho.'
}
