'use strict'

// apps/cli/lib/account/audius-provider.js: config parsing, request building
// and the mapping of provider answers, all pure. No network.

const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const {
  DEFAULT_API_URL,
  ID_RE,
  MAX_OFFSET,
  parseAudiusConfig,
  keyParams,
  requestFor,
  isAudiusPermalink,
  fromTrack,
  fromPlaylist,
  fromResolve,
  listOf,
  nextCursor
} = require('../lib/account/audius-provider')

const KEY = 'chave-sentinela-audius-42'

function config (extra = {}) {
  return parseAudiusConfig({ apiKey: KEY, ...extra })
}

function track (extra = {}) {
  return {
    id: 'D7KyD',
    title: 'Samba de Teste',
    duration: 215,
    permalink: '/artista/samba-de-teste',
    user: { name: 'Artista', id: 'u123' },
    artwork: { '150x150': 'https://creatornode.example/art.jpg' },
    is_streamable: true,
    is_delete: false,
    is_unlisted: false,
    is_available: true,
    is_stream_gated: false,
    stream_conditions: null,
    access: { stream: true, download: false },
    ...extra
  }
}

function camelTrack (extra = {}) {
  return {
    id: 'D7KyD',
    title: 'Samba de Teste',
    duration: 215,
    permalink: '/artista/samba-de-teste',
    user: { name: 'Artista' },
    isStreamable: true,
    isDelete: false,
    isUnlisted: false,
    isAvailable: true,
    isStreamGated: false,
    streamConditions: null,
    ...extra
  }
}

function playlist (extra = {}) {
  return {
    id: 'pL4yA',
    playlist_name: 'Roda de Choro',
    track_count: 12,
    permalink: '/artista/playlist/roda-de-choro',
    user: { name: 'Artista' },
    is_private: false,
    is_delete: false,
    artwork: { '150x150': 'https://creatornode.example/art.jpg' },
    ...extra
  }
}

const EXPECTED_TRACK = { id: 'D7KyD', title: 'Samba de Teste', artist: 'Artista', duration: 215, url: 'https://audius.co/artista/samba-de-teste' }

test('parseAudiusConfig: defaults and accepted values', (t) => {
  const c = config()
  t.alike(c, { base: 'https://api.audius.co/v1', apiHost: 'api.audius.co', apiKey: KEY, appName: 'varanda', moments: false, streams: 16 })
  t.is(DEFAULT_API_URL, 'https://api.audius.co/v1')
  const d = config({ apiUrl: 'https://Audius.Test:8443/api/v1/', appName: 'varanda-dev', moments: true, streams: 32 })
  t.is(d.base, 'https://audius.test:8443/api/v1')
  t.is(d.apiHost, 'audius.test')
  t.is(d.appName, 'varanda-dev')
  t.is(d.moments, true)
  t.is(d.streams, 32)
  t.ok(config({ streams: 1 }))
  t.ok(parseAudiusConfig({ apiKey: '!'.repeat(256) }))
})

test('parseAudiusConfig: refuses bad values and never throws', (t) => {
  const bad = [
    undefined,
    null,
    'texto',
    {},
    { apiKey: '' },
    { apiKey: 'a'.repeat(257) },
    { apiKey: 'com espaco' },
    { apiKey: 'tab\tkey' },
    { apiKey: 'chaveé' },
    { apiKey: 42 },
    { apiKey: KEY, apiUrl: 'http://api.audius.co/v1' },
    { apiKey: KEY, apiUrl: 'https://user:pass@api.audius.co/v1' },
    { apiKey: KEY, apiUrl: 'https://api.audius.co/v1?x=1' },
    { apiKey: KEY, apiUrl: 'https://api.audius.co/v1#x' },
    { apiKey: KEY, apiUrl: 'https://127.0.0.1/v1' },
    { apiKey: KEY, apiUrl: 'https://[::1]/v1' },
    { apiKey: KEY, apiUrl: 'https://0x7f.1/v1' },
    { apiKey: KEY, apiUrl: 'https://2130706433/v1' },
    { apiKey: KEY, apiUrl: 'https://' + 'a'.repeat(600) + '.test/' },
    { apiKey: KEY, apiUrl: 'nao e url' },
    { apiKey: KEY, apiUrl: 7 },
    { apiKey: KEY, appName: 'Varanda' },
    { apiKey: KEY, appName: '' },
    { apiKey: KEY, appName: 'a'.repeat(33) },
    { apiKey: KEY, appName: 'app_name' },
    { apiKey: KEY, moments: 'true' },
    { apiKey: KEY, moments: 1 },
    { apiKey: KEY, streams: 0 },
    { apiKey: KEY, streams: 33 },
    { apiKey: KEY, streams: 2.5 },
    { apiKey: KEY, streams: '16' }
  ]
  for (const b of bad) {
    let out
    try {
      out = parseAudiusConfig(b)
    } catch (err) {
      t.fail('threw: ' + err.message.includes(KEY))
      continue
    }
    t.is(out, null)
  }
})

test('keyParams: the key in a header, the app name in the query', (t) => {
  const kp = keyParams(config())
  t.alike(kp, { headers: { 'x-api-key': KEY }, query: { app_name: 'varanda' } })
})

test('requestFor: every kind, the key never in the URL', (t) => {
  const c = config()
  const cases = [
    ['searchTracks', { query: 'samba & choro', limit: 24, offset: 48 }, 'https://api.audius.co/v1/tracks/search?query=samba+%26+choro&limit=24&offset=48&app_name=varanda'],
    ['searchTracks', { query: 'samba' }, 'https://api.audius.co/v1/tracks/search?query=samba&limit=20&offset=0&app_name=varanda'],
    ['searchPlaylists', { query: 'roda', limit: 10, offset: 0 }, 'https://api.audius.co/v1/playlists/search?query=roda&limit=10&offset=0&app_name=varanda'],
    ['track', { id: 'D7KyD' }, 'https://api.audius.co/v1/tracks/D7KyD?app_name=varanda'],
    ['playlist', { id: 'pL4yA' }, 'https://api.audius.co/v1/playlists/pL4yA?app_name=varanda'],
    ['playlistTracks', { id: 'pL4yA' }, 'https://api.audius.co/v1/playlists/pL4yA/tracks?app_name=varanda'],
    ['stream', { id: 'D7KyD' }, 'https://api.audius.co/v1/tracks/D7KyD/stream?app_name=varanda'],
    ['resolve', { url: 'https://audius.co/artista/samba-de-teste' }, 'https://api.audius.co/v1/resolve?url=https%3A%2F%2Faudius.co%2Fartista%2Fsamba-de-teste&app_name=varanda']
  ]
  for (const [kind, params, href] of cases) {
    const r = requestFor(c, kind, params)
    t.is(r.href, href, kind)
    t.alike(r.firstHeaders, { 'x-api-key': KEY }, kind + ' headers')
    t.absent(r.href.includes(KEY), kind + ' key not in href')
    t.absent(decodeURIComponent(r.href).includes(KEY), kind + ' key not in decoded href')
  }
  const own = requestFor(config({ apiUrl: 'https://audius.test:8443/v1' }), 'track', { id: 'abc' })
  t.is(own.href, 'https://audius.test:8443/v1/tracks/abc?app_name=varanda')
})

test('requestFor: refuses unknown kinds and bad parameters', (t) => {
  const c = config()
  t.is(requestFor(c, 'user', { id: 'abc' }), null)
  t.is(requestFor(c, 'track', { id: '../users/abc' }), null)
  t.is(requestFor(c, 'track', { id: 'a'.repeat(33) }), null)
  t.is(requestFor(c, 'stream', { id: 'ab?c' }), null)
  t.is(requestFor(c, 'playlist', {}), null)
  t.is(requestFor(c, 'searchTracks', { query: '' }), null)
  t.is(requestFor(c, 'searchTracks', { query: 'x'.repeat(257) }), null)
  t.is(requestFor(c, 'searchTracks', { query: 7 }), null)
  t.is(requestFor(c, 'searchTracks', { query: 'x', limit: 0 }), null)
  t.is(requestFor(c, 'searchTracks', { query: 'x', limit: 51 }), null)
  t.is(requestFor(c, 'searchTracks', { query: 'x', offset: -1 }), null)
  t.is(requestFor(c, 'searchTracks', { query: 'x', offset: MAX_OFFSET + 1 }), null)
  t.is(requestFor(c, 'searchTracks', { query: 'x', offset: '0' }), null)
  t.is(requestFor(c, 'resolve', { url: 'https://evil.test/a/b' }), null)
  t.is(requestFor(c, 'resolve', { url: 'https://audius.co/a/b?x=1' }), null)
  t.is(requestFor(null, 'track', { id: 'abc' }), null)
  t.is(requestFor(c, 'track', null), null)
})

test('isAudiusPermalink', (t) => {
  for (const ok of [
    'https://audius.co/artista/faixa',
    'https://audius.co/artista/playlist/roda',
    'https://audius.co/artista/album/disco-1',
    'https://audius.co/a/b/c/d'
  ]) t.ok(isAudiusPermalink(ok), ok)
  for (const bad of [
    'https://audius.co/artista',
    'https://audius.co/a/b/c/d/e',
    'https://audius.co/a/b?x=1',
    'https://audius.co/a/b#t',
    'https://audius.co/a//b',
    'https://audius.co/a/b/',
    'https://audius.co/a/..',
    'https://audius.co:8443/a/b',
    'https://user@audius.co/a/b',
    'https://audius.co.evil.test/a/b',
    'https://evil.test/audius.co/a',
    'https://www.audius.co/a/b',
    'http://audius.co/a/b',
    'https://AUDIUS.co/a/b',
    'https://audius.co/a\\b/c',
    'https://audius.co/a b/c',
    'https://audius.co/‮ab/c',
    'https://audius.co/' + 'a'.repeat(240) + '/b',
    null,
    42
  ]) t.absent(isAudiusPermalink(bad), String(bad))
})

test('fromTrack: snake_case and camelCase', (t) => {
  t.alike(fromTrack(track()), EXPECTED_TRACK)
  t.alike(fromTrack(camelTrack()), EXPECTED_TRACK)
  t.alike(fromTrack(camelTrack({ access: { stream: true } })), EXPECTED_TRACK)
  // Absent flags keep the item; nothing but the five fields is copied.
  const minimal = fromTrack({ id: 'D7KyD', title: 'Samba de Teste', duration: 215, permalink: '/artista/samba-de-teste', user: { name: 'Artista' } })
  t.alike(minimal, EXPECTED_TRACK)
  t.alike(Object.keys(fromTrack(track())).sort(), ['artist', 'duration', 'id', 'title', 'url'])
})

test('fromTrack: each exclusion rule drops the item', (t) => {
  const drops = {
    'deleted snake': track({ is_delete: true }),
    'deleted camel': camelTrack({ isDelete: true }),
    'deleted alt': track({ is_deleted: true }),
    'unlisted snake': track({ is_unlisted: true }),
    'unlisted camel': camelTrack({ isUnlisted: true }),
    'not streamable snake': track({ is_streamable: false }),
    'not streamable camel': camelTrack({ isStreamable: false }),
    'unavailable snake': track({ is_available: false }),
    'unavailable camel': camelTrack({ isAvailable: false }),
    'stream gated snake': track({ is_stream_gated: true }),
    'stream gated camel': camelTrack({ isStreamGated: true }),
    'stream conditions snake': track({ stream_conditions: { usdc_purchase: { price: 100 } } }),
    'stream conditions camel': camelTrack({ streamConditions: { tipUserId: 1 } }),
    'stream conditions empty object': track({ stream_conditions: {} }),
    'access stream false': track({ access: { stream: false, download: false } }),
    'access stream truthy string': track({ access: { stream: 'true' } }),
    'access unknown shape': track({ access: { streamable: true } }),
    'access null': track({ access: null }),
    'access array': track({ access: [true] }),
    'access string': track({ access: 'public' }),
    'casings disagree': track({ isDelete: true }),
    'flag not boolean': track({ is_delete: 'false' }),
    'gated not boolean': track({ is_stream_gated: 1 }),
    'id bad chars': track({ id: 'ab-cd' }),
    'id too long': track({ id: 'a'.repeat(33) }),
    'id not string': track({ id: 42 }),
    'duration zero': track({ duration: 0 }),
    'duration too long': track({ duration: 7201 }),
    'duration fraction': track({ duration: 30.5 }),
    'duration string': track({ duration: '215' }),
    'no title': track({ title: '' }),
    'title only controls': track({ title: '\u0000‮⁦' }),
    'title not string': track({ title: { toString: () => 'x' } }),
    'title number': track({ title: 7 }),
    'no user': track({ user: undefined }),
    'user not object': track({ user: 'Artista' }),
    'artist not string': track({ user: { name: ['Artista'] } }),
    'artist blank': track({ user: { name: '   ' } }),
    'no permalink': track({ permalink: undefined }),
    'permalink with host': track({ permalink: 'evil.test/a/b' }),
    'permalink with scheme': track({ permalink: 'https://evil.test/a/b' }),
    'permalink protocol relative path': track({ permalink: '//evil.test/a' }),
    'permalink with fragment': track({ permalink: '/a/b#x' }),
    'permalink with query': track({ permalink: '/a/b?x=1' }),
    'permalink with backslash': track({ permalink: '/a\\b/c' }),
    'permalink with bidi': track({ permalink: '/a/‮b' }),
    'permalink with space': track({ permalink: '/a/b c' }),
    'permalink one segment': track({ permalink: '/a' }),
    'permalink over long': track({ permalink: '/a/' + 'b'.repeat(240) }),
    'not an object': 'D7KyD',
    'an array': [track()],
    'a null': null
  }
  for (const [name, item] of Object.entries(drops)) t.is(fromTrack(item), null, name)
})

test('fromTrack: hostile text is cleaned and cut', (t) => {
  const out = fromTrack(track({ title: '  Samba‮  de\u0007\nTeste⁦ ', user: { name: 'Art\u0000ista' + 'x'.repeat(200) } }))
  t.is(out.title, 'Samba de Teste')
  t.is(Array.from(out.artist).length, 80)
  t.ok(out.artist.startsWith('Artistax'))
  // The longest kept URL leaves room for the card fragment.
  const long = '/a/' + 'b'.repeat(240 - 'https://audius.co/a/'.length)
  t.is(fromTrack(track({ permalink: long })).url.length, 240)
})

test('fromPlaylist: both casings and each exclusion rule', (t) => {
  const expected = { id: 'pL4yA', title: 'Roda de Choro', artist: 'Artista', count: 12, url: 'https://audius.co/artista/playlist/roda-de-choro' }
  t.alike(fromPlaylist(playlist()), expected)
  t.alike(fromPlaylist({ id: 'pL4yA', playlistName: 'Roda de Choro', trackCount: 12, permalink: '/artista/playlist/roda-de-choro', user: { name: 'Artista' }, isPrivate: false, isDelete: false }), expected)
  t.alike(fromPlaylist(playlist({ track_count: 500 })).count, 500)
  const drops = {
    'private snake': playlist({ is_private: true }),
    'private camel': playlist({ isPrivate: true }),
    'deleted snake': playlist({ is_delete: true }),
    'deleted camel': playlist({ isDelete: true }),
    'stream gated': playlist({ is_stream_gated: true }),
    'stream conditions': playlist({ stream_conditions: { usdc_purchase: {} } }),
    'access unknown shape': playlist({ access: { stream: 'yes' } }),
    'count zero': playlist({ track_count: 0 }),
    'count too big': playlist({ track_count: 501 }),
    'count missing': playlist({ track_count: undefined }),
    'count string': playlist({ track_count: '12' }),
    'name missing': playlist({ playlist_name: undefined }),
    'name not string': playlist({ playlist_name: 12 }),
    'casings disagree': playlist({ playlistName: 'Outra' }),
    'artist missing': playlist({ user: null }),
    'id bad': playlist({ id: 'p/1' }),
    'permalink with host': playlist({ permalink: 'evil.test/a/b' }),
    'permalink with fragment': playlist({ permalink: '/a/playlist/b#x' }),
    'not an object': 7
  }
  for (const [name, item] of Object.entries(drops)) t.is(fromPlaylist(item), null, name)
})

test('fromResolve: track, playlist, anything else', (t) => {
  t.alike(fromResolve({ data: track() }), { kind: 'track', item: EXPECTED_TRACK })
  t.alike(fromResolve({ data: [playlist()] }), { kind: 'playlist', item: fromPlaylist(playlist()) })
  t.alike(fromResolve({ data: playlist() }).kind, 'playlist')
  t.is(fromResolve({ data: [playlist(), playlist()] }), null)
  t.is(fromResolve({ data: [] }), null)
  t.is(fromResolve({ data: track({ is_unlisted: true }) }), null)
  t.is(fromResolve({ data: playlist({ is_private: true }) }), null)
  t.is(fromResolve({ data: { handle: 'artista', name: 'Artista' } }), null)
  t.is(fromResolve({ data: null }), null)
  t.is(fromResolve(null), null)
  t.is(fromResolve('x'), null)
})

test('listOf and nextCursor', (t) => {
  const many = Array.from({ length: 80 }, (_, i) => ({ i }))
  t.is(listOf({ data: many }).length, 50)
  t.alike(listOf({ data: [] }), [])
  t.is(listOf({ data: 'x' }), null)
  t.is(listOf({}), null)
  t.is(listOf(null), null)
  t.is(listOf([1, 2]), null)
  t.is(nextCursor(0, 20, 20), '20')
  t.is(nextCursor(40, 25, 20), '60')
  t.is(nextCursor(0, 19, 20), null)
  t.is(nextCursor(MAX_OFFSET - 10, 20, 20), null)
  t.is(nextCursor(MAX_OFFSET - 20, 20, 20), String(MAX_OFFSET))
  t.is(nextCursor('0', 20, 20), null)
  t.is(nextCursor(0, 20, 0), null)
  t.is(nextCursor(-20, 20, 20), null)
})

test('ID_RE', (t) => {
  t.ok(ID_RE.test('D7KyD'))
  t.absent(ID_RE.test(''))
  t.absent(ID_RE.test('a-b'))
  t.absent(ID_RE.test('a'.repeat(33)))
})

test('the module does no I/O of its own', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'account', 'audius-provider.js'), 'utf8')
  const required = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort()
  t.alike(required, ['./safe-fetch', '@varanda/rpc'])
})
