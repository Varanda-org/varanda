'use strict'

// Pure Audius music rules (src/music.js) and the decorative strip
// (src/musicStrip.js). ES module loaded through import().
const test = require('brittle')

const load = () => import('../src/music.js')
const loadStrip = () => import('../src/musicStrip.js')

const PAGE = 'https://audius.co/artista/faixa-boa'
const LIST_PAGE = 'https://audius.co/artista/playlist/lista-boa'
const track = { id: 'T1abc', title: 'Faixa Boa', artist: 'Artista', duration: 200, url: PAGE }
const playlist = { id: 'P9xyz', title: 'Lista Boa', artist: 'Artista', count: 12, url: LIST_PAGE }
const TICKET = 'A'.repeat(21) + '_-' + 'b'.repeat(20)

test('constants', async (t) => {
  const m = await load()
  t.is(m.SNIPPET_S, 15)
  t.ok(m.MUSIC_ID_RE.test('abcXYZ019'))
  t.ok(m.MUSIC_ID_RE.test('a'.repeat(32)))
  for (const id of ['', 'a'.repeat(33), 'a-b', 'a_b', 'a b', 'á']) t.absent(m.MUSIC_ID_RE.test(id), id)
  t.is(m.MUSIC_DEBOUNCE_MS, 350)
  t.is(m.MUSIC_SOURCE, 'Audius')
  t.is(m.MUSIC_EMPTY_TEXT, 'Nenhuma música encontrada')
  t.is(m.MUSIC_UNAVAILABLE_TEXT, 'Música indisponível agora')
  t.is(m.MUSIC_LIMIT_TEXT, 'Limite de músicas por hoje')
  t.is(m.MUSIC_NEEDS_TEXT, 'Escreva algo para publicar com a música')
  t.is(m.MUSIC_SEEK_TEXT, 'Não foi possível começar nesse ponto')
})

test('musicRefOf: the three fragments, frozen', async (t) => {
  const { musicRefOf } = await load()
  t.alike(musicRefOf(PAGE + '#varanda-musica=t:T1abc'), { kind: 'track', id: 'T1abc', start: null })
  t.alike(musicRefOf(PAGE + '#varanda-musica=s:T1abc:0'), { kind: 'snippet', id: 'T1abc', start: 0 })
  t.alike(musicRefOf(PAGE + '#varanda-musica=s:T1abc:42'), { kind: 'snippet', id: 'T1abc', start: 42 })
  t.alike(musicRefOf(PAGE + '#varanda-musica=s:T1abc:7200'), { kind: 'snippet', id: 'T1abc', start: 7200 })
  t.alike(musicRefOf(LIST_PAGE + '#varanda-musica=p:P9xyz'), { kind: 'playlist', id: 'P9xyz', start: null })
  t.ok(Object.isFrozen(musicRefOf(PAGE + '#varanda-musica=t:T1abc')))
})

test('musicRefOf: hostile or malformed URLs are null', async (t) => {
  const { musicRefOf } = await load()
  const bad = [
    undefined, null, 5, {}, '',
    PAGE,
    PAGE + '#',
    PAGE + '#varanda-musica=',
    PAGE + '#varanda-musica=t:',
    PAGE + '#varanda-musica=x:T1abc',
    PAGE + '#varanda-musica=T:T1abc',
    PAGE + '#Varanda-musica=t:T1abc',
    PAGE + '#varanda-musica=t:T1abc&x=1',
    PAGE + '#varanda-musica=t:T1abc#t:other',
    PAGE + '#x#varanda-musica=t:T1abc',
    PAGE + '#x&varanda-musica=t:T1abc',
    PAGE + '#varanda-musica=t:' + 'a'.repeat(33),
    PAGE + '#varanda-musica=t:a-b',
    PAGE + '#varanda-musica=t:a%2Fb',
    PAGE + '#varanda-musica=t:../x',
    PAGE + '#varanda-musica=s:T1abc',
    PAGE + '#varanda-musica=s:T1abc:',
    PAGE + '#varanda-musica=s:T1abc:007',
    PAGE + '#varanda-musica=s:T1abc:01',
    PAGE + '#varanda-musica=s:T1abc:-1',
    PAGE + '#varanda-musica=s:T1abc:1.5',
    PAGE + '#varanda-musica=s:T1abc:7201',
    PAGE + '#varanda-musica=s:T1abc:9999',
    PAGE + '#varanda-musica=s:T1abc:12345',
    PAGE + '#varanda-musica=s:T1abc:1e3',
    PAGE + '#varanda-musica=p:P9xyz:1',
    PAGE + '#varanda-musica=t:T1abc:1',
    PAGE + '#varanda-musica=t:T1abc ',
    PAGE + '#varanda-musica%3Dt:T1abc',
    'https://evil.example/artista/faixa#varanda-musica=t:T1abc',
    'https://audius.co.evil.example/a/b#varanda-musica=t:T1abc',
    'https://evil.audius.co/a/b#varanda-musica=t:T1abc',
    'https://AUDIUS.co/a/b#varanda-musica=t:T1abc',
    'http://audius.co/a/b#varanda-musica=t:T1abc',
    'https://audius.co:8443/a/b#varanda-musica=t:T1abc',
    'https://user@audius.co/a/b#varanda-musica=t:T1abc',
    'https://audius.co#varanda-musica=t:T1abc',
    'https://audius.co/#varanda-musica=t:T1abc',
    'https://audius.co/a#varanda-musica=t:T1abc',
    'https://audius.co/a/b/c/d/e#varanda-musica=t:T1abc',
    'https://audius.co/a/../b#varanda-musica=t:T1abc',
    'https://audius.co/a/b?x=1#varanda-musica=t:T1abc',
    'https://audius.co/a\\b/c#varanda-musica=t:T1abc',
    'https://audius.co/a/b c#varanda-musica=t:T1abc',
    'javascript:alert(1)//audius.co/a/b#varanda-musica=t:T1abc'
  ]
  for (const url of bad) t.is(musicRefOf(url), null, String(url))
})

test('musicRefOf: the 300-character card cap', async (t) => {
  const { musicRefOf } = await load()
  const frag = '#varanda-musica=t:T1abc'
  const fit = 'https://audius.co/a/' + 'b'.repeat(300 - 'https://audius.co/a/'.length - frag.length)
  t.is((fit + frag).length, 300)
  // The page alone is over the service's 240 limit: a longer card is never built.
  t.is(musicRefOf(fit + frag), null, 'a page past 240 characters')
  const page = 'https://audius.co/a/' + 'b'.repeat(240 - 'https://audius.co/a/'.length)
  t.is(page.length, 240)
  t.ok(musicRefOf(page + frag))
  t.is(musicRefOf(page + 'b' + frag), null)
  t.is(musicRefOf('https://audius.co/a/' + 'b'.repeat(400) + frag), null, 'past 300')
})

test('isAudiusPage: the service permalink rule', async (t) => {
  const { isAudiusPage } = await load()
  for (const url of [PAGE, LIST_PAGE, 'https://audius.co/a/b/c/d', "https://audius.co/a/b-c_d.e~f%20@!$&'()*+,;=:"]) t.ok(isAudiusPage(url), url)
  for (const url of [
    'https://audius.co/a', 'https://audius.co/a/b/c/d/e', 'https://audius.co/a/', 'https://audius.co//b',
    'https://audius.co/a/.', 'https://audius.co/a/..', 'https://audius.co/a/b?x', 'https://audius.co/a/b#x',
    'https://audius.co:443/a/b', 'http://audius.co/a/b', 'https://x.audius.co/a/b', 'https://audius.co/a/<b>',
    'https://audius.co/' + 'a'.repeat(240), null, 5
  ]) t.absent(isAudiusPage(url), String(url))
})

test('musicCardUrl: builds the fragment, or null', async (t) => {
  const { musicCardUrl, musicRefOf } = await load()
  t.is(musicCardUrl(PAGE, { kind: 'track', id: 'T1abc', start: null }), PAGE + '#varanda-musica=t:T1abc')
  t.is(musicCardUrl(PAGE, { kind: 'track', id: 'T1abc' }), PAGE + '#varanda-musica=t:T1abc')
  t.is(musicCardUrl(PAGE, { kind: 'snippet', id: 'T1abc', start: 30 }), PAGE + '#varanda-musica=s:T1abc:30')
  t.is(musicCardUrl(LIST_PAGE, { kind: 'playlist', id: 'P9xyz', start: null }), LIST_PAGE + '#varanda-musica=p:P9xyz')
  const ref = musicRefOf(PAGE + '#varanda-musica=s:T1abc:5')
  t.is(musicCardUrl(PAGE, ref), PAGE + '#varanda-musica=s:T1abc:5', 'a parsed ref round-trips')
  t.is(musicCardUrl(PAGE + '#x', { kind: 'track', id: 'T1abc' }), null, 'already has a fragment')
  t.is(musicCardUrl('https://evil.example/a/b', { kind: 'track', id: 'T1abc' }), null)
  t.is(musicCardUrl('https://audius.co.evil.example/a/b', { kind: 'track', id: 'T1abc' }), null)
  t.is(musicCardUrl(PAGE, { kind: 'track', id: 'a/b' }), null)
  t.is(musicCardUrl(PAGE, { kind: 'snippet', id: 'T1abc' }), null)
  t.is(musicCardUrl(PAGE, { kind: 'snippet', id: 'T1abc', start: 7201 }), null)
  t.is(musicCardUrl(PAGE, { kind: 'snippet', id: 'T1abc', start: 1.5 }), null)
  t.is(musicCardUrl(PAGE, { kind: 'track', id: 'T1abc', start: 5 }), null, 'a start only on a snippet')
  t.is(musicCardUrl(PAGE, { kind: 'album', id: 'T1abc' }), null)
  t.is(musicCardUrl(PAGE, null), null)
  t.is(musicCardUrl(null, { kind: 'track', id: 'T1abc' }), null)
  // The longest page and the longest fragment still fit the 300 cap.
  const page = 'https://audius.co/a/' + 'b'.repeat(240 - 'https://audius.co/a/'.length)
  const url = musicCardUrl(page, { kind: 'snippet', id: 'z'.repeat(32), start: 7200 })
  t.ok(url !== null && url.length <= 300, 'fits')
  t.is(musicCardUrl(page + 'b', { kind: 'track', id: 'T1abc' }), null, 'a page past 240')
})

test('musicCardFields: title, artist, playlist count; checked against the ref', async (t) => {
  const { musicCardFields } = await load()
  t.alike(musicCardFields(track, { kind: 'track', id: 'T1abc', start: null }), {
    url: PAGE + '#varanda-musica=t:T1abc', host: 'audius.co', title: 'Faixa Boa', desc: 'Artista'
  })
  t.alike(musicCardFields(track, { kind: 'snippet', id: 'T1abc', start: 185 }), {
    url: PAGE + '#varanda-musica=s:T1abc:185', host: 'audius.co', title: 'Faixa Boa', desc: 'Artista'
  })
  t.alike(musicCardFields(playlist, { kind: 'playlist', id: 'P9xyz', start: null }), {
    url: LIST_PAGE + '#varanda-musica=p:P9xyz', host: 'audius.co', title: 'Lista Boa', desc: 'Artista · 12 faixas'
  })
  t.is(musicCardFields({ ...playlist, count: 1 }, { kind: 'playlist', id: 'P9xyz' }).desc, 'Artista · 1 faixa')
  const long = musicCardFields({ ...track, title: 'x'.repeat(200), artist: 'y'.repeat(200) }, { kind: 'track', id: 'T1abc' })
  t.is(Array.from(long.title).length, 80)
  t.is(Array.from(long.desc).length, 160)
  t.is(musicCardFields({ ...track, title: 'a‮b\u0000c  d' }, { kind: 'track', id: 'T1abc' }).title, 'abc d', 'cut with cardText')
  t.is(musicCardFields(track, { kind: 'snippet', id: 'T1abc', start: 186 }), null, 'past maxStart')
  t.is(musicCardFields(track, { kind: 'track', id: 'other' }), null, 'another id')
  t.is(musicCardFields(track, { kind: 'playlist', id: 'T1abc' }), null, 'a track is not a playlist')
  t.is(musicCardFields(playlist, { kind: 'track', id: 'P9xyz' }), null, 'a playlist is not a track')
  t.is(musicCardFields({ ...track, title: '   ' }, { kind: 'track', id: 'T1abc' }), null)
  t.is(musicCardFields({ ...track, artist: '' }, { kind: 'track', id: 'T1abc' }), null)
  t.is(musicCardFields({ ...track, url: 'https://evil.example/a/b' }, { kind: 'track', id: 'T1abc' }), null)
  t.is(musicCardFields(null, { kind: 'track', id: 'T1abc' }), null)
  t.is(musicCardFields(track, null), null)
})

test('snippet window: maxStart, clampStart, snippetEndMs', async (t) => {
  const { maxStart, clampStart, snippetEndMs } = await load()
  t.is(maxStart(200), 185)
  t.is(maxStart(15), 0)
  t.is(maxStart(10), 0)
  t.is(maxStart(7200), 7185)
  for (const d of [0, -1, 7201, 1.5, '200', null, undefined, NaN]) t.is(maxStart(d), 0, String(d))
  t.is(clampStart(30, 200), 30)
  t.is(clampStart(30.9, 200), 30)
  t.is(clampStart(-5, 200), 0)
  t.is(clampStart(999, 200), 185)
  t.is(clampStart(NaN, 200), 0)
  t.is(clampStart(Infinity, 200), 0)
  t.is(clampStart('30', 200), 0)
  t.is(clampStart(30, undefined), 0)
  t.is(snippetEndMs(30, 200), 45000)
  t.is(snippetEndMs(185, 200), 200000)
  t.is(snippetEndMs(0, 10), 10000, 'a short track ends with the track')
  t.is(snippetEndMs(500, 200), 200000, 'clamped first')
  t.is(snippetEndMs(0, null), 15000)
})

test('seekReached and snippetTick: never play outside the window', async (t) => {
  const { seekReached, snippetTick } = await load()
  t.ok(seekReached(30000, 30000))
  t.ok(seekReached(28000, 30000), 'within 2000 ms')
  t.absent(seekReached(27999, 30000))
  t.absent(seekReached(0, 30000), 'still at 0')
  t.ok(seekReached(90000, 30000), 'past it')
  t.ok(seekReached(0, 0))
  for (const v of [NaN, undefined, '30000', null]) t.absent(seekReached(v, 30000), String(v))
  t.absent(seekReached(30000, NaN))
  const w = { startMs: 30000, endMs: 45000 }
  t.is(snippetTick({ ...w, ms: 30000 }), 'play')
  t.is(snippetTick({ ...w, ms: 44999 }), 'play')
  t.is(snippetTick({ ...w, ms: 45000 }), 'stop')
  t.is(snippetTick({ ...w, ms: 50000 }), 'stop')
  t.is(snippetTick({ ...w, ms: 0 }), 'stop', 'the seek did not land: never from 0')
  t.is(snippetTick({ ...w, ms: NaN }), 'stop')
  t.is(snippetTick({ ms: 1000, startMs: 0, endMs: NaN }), 'stop')
  t.is(snippetTick(), 'stop')
})

test('searchBody: { q, kind } or with a canonical cursor', async (t) => {
  const { searchBody } = await load()
  t.alike(searchBody(' samba bom ', 'track'), { q: 'samba bom', kind: 'track' })
  t.alike(searchBody('a', 'playlist', '12'), { q: 'a', kind: 'playlist', cursor: '12' })
  t.alike(searchBody('a', 'track', '0'), { q: 'a', kind: 'track', cursor: '0' })
  t.alike(searchBody('a', 'track', '500'), { q: 'a', kind: 'track', cursor: '500' })
  t.alike(searchBody('a', 'track', null), { q: 'a', kind: 'track' })
  t.alike(searchBody('a', 'track', ''), { q: 'a', kind: 'track' })
  t.ok(searchBody('😀'.repeat(64), 'track'))
  for (const [q, kind, cursor] of [
    ['', 'track'], ['   ', 'track'], ['a'.repeat(65), 'track'], ['😀'.repeat(65), 'track'], [5, 'track'],
    ['a\u0000b', 'track'], ['a\nb', 'track'], ['a\u0085b', 'track'],
    ['a', 'album'], ['a', undefined], ['a', 'Track'],
    ['a', 'track', '501'], ['a', 'track', '012'], ['a', 'track', '1000'], ['a', 'track', '-1'],
    ['a', 'track', '1.5'], ['a', 'track', 12], ['a', 'track', 'c/1']
  ]) t.is(searchBody(q, kind, cursor), null, JSON.stringify([q, kind, cursor]))
})

test('parseSearch: the exact shape for each kind, or null', async (t) => {
  const { parseSearch } = await load()
  t.alike(parseSearch({ items: [track], next: '12' }, 'track'), { items: [track], next: '12' })
  t.alike(parseSearch({ items: [], next: null }, 'track'), { items: [], next: null })
  t.alike(parseSearch({ items: [playlist], next: null }, 'playlist'), { items: [playlist], next: null })
  t.ok(parseSearch({ items: Array.from({ length: 50 }, () => track), next: null }, 'track'))
  t.is(parseSearch({ items: Array.from({ length: 51 }, () => track), next: null }, 'track'), null)
  t.is(parseSearch({ items: [track], next: null }, 'playlist'), null, 'a track on a playlist page')
  t.is(parseSearch({ items: [playlist], next: null }, 'track'), null)
  t.is(parseSearch({ items: [], next: null }), null, 'no kind')
  const bad = [
    null, [], 'x', {}, { items: [] }, { items: [], next: undefined }, { items: [], next: null, x: 1 },
    { items: {}, next: null }, { items: [], next: 12 }, { items: [], next: '' }, { items: [], next: '012' },
    { items: [], next: '501' }, { items: [], next: 'https://evil.example/x' },
    { items: [null], next: null },
    { items: [{ ...track, stream: 'https://evil.example/a.mp3' }], next: null },
    { items: [{ ...track, artwork: 'https://evil.example/a.jpg' }], next: null },
    { items: [{ id: track.id, title: track.title, artist: track.artist, duration: track.duration }], next: null },
    { items: [{ ...track, id: 'a/b' }], next: null },
    { items: [{ ...track, id: '' }], next: null },
    { items: [{ ...track, id: 'a'.repeat(33) }], next: null },
    { items: [{ ...track, title: '' }], next: null },
    { items: [{ ...track, title: ' x' }], next: null },
    { items: [{ ...track, title: 'a‮b' }], next: null },
    { items: [{ ...track, title: 'x'.repeat(81) }], next: null },
    { items: [{ ...track, artist: 5 }], next: null },
    { items: [{ ...track, duration: 0 }], next: null },
    { items: [{ ...track, duration: 7201 }], next: null },
    { items: [{ ...track, duration: 1.5 }], next: null },
    { items: [{ ...track, duration: '200' }], next: null },
    { items: [{ ...track, url: 'https://evil.example/a/b' }], next: null },
    { items: [{ ...track, url: 'https://audius.co.evil.example/a/b' }], next: null },
    { items: [{ ...track, url: PAGE + '#varanda-musica=t:x' }], next: null },
    { items: [{ ...track, url: PAGE + '?x=1' }], next: null },
    { items: [{ ...track, url: 'http://audius.co/a/b' }], next: null }
  ]
  for (const b of bad) t.is(parseSearch(b, 'track'), null, JSON.stringify(b))
  for (const b of [
    { items: [{ ...playlist, count: 0 }], next: null },
    { items: [{ ...playlist, count: 501 }], next: null },
    { items: [{ ...playlist, tracks: [] }], next: null },
    { items: [{ ...playlist, duration: 1 }], next: null }
  ]) t.is(parseSearch(b, 'playlist'), null, JSON.stringify(b))
  t.ok(parseSearch({ items: [{ ...playlist, count: 500 }], next: null }, 'playlist'))
  t.ok(parseSearch({ items: [{ ...track, duration: 7200, title: 'x'.repeat(80) }], next: null }, 'track'))
})

test('parseItem: a track, or a playlist with at most 50 tracks', async (t) => {
  const { parseItem } = await load()
  t.alike(parseItem(track, 'track'), track)
  const full = { ...playlist, tracks: [track, { ...track, id: 'T2' }] }
  t.alike(parseItem(full, 'playlist'), full)
  t.ok(parseItem({ ...playlist, tracks: Array.from({ length: 50 }, () => track) }, 'playlist'))
  t.ok(parseItem({ ...playlist, tracks: [] }, 'playlist'))
  t.is(parseItem({ ...playlist, tracks: Array.from({ length: 51 }, () => track) }, 'playlist'), null)
  t.is(parseItem(playlist, 'playlist'), null, 'tracks is required')
  t.is(parseItem({ ...playlist, tracks: [{ ...track, x: 1 }] }, 'playlist'), null)
  t.is(parseItem({ ...playlist, tracks: [null] }, 'playlist'), null)
  t.is(parseItem({ ...playlist, tracks: {} }, 'playlist'), null)
  t.is(parseItem({ ...playlist, tracks: [], x: 1 }, 'playlist'), null)
  t.is(parseItem({ ...track, x: 1 }, 'track'), null)
  t.is(parseItem(full, 'track'), null)
  t.is(parseItem(track, 'playlist'), null)
  t.is(parseItem(track, 'album'), null)
  t.is(parseItem(null, 'track'), null)
})

test('parseResolve: { kind, item } with no tracks', async (t) => {
  const { parseResolve } = await load()
  t.alike(parseResolve({ kind: 'track', item: track }), { kind: 'track', item: track })
  t.alike(parseResolve({ kind: 'playlist', item: playlist }), { kind: 'playlist', item: playlist })
  for (const b of [
    null, {}, { kind: 'track' }, { kind: 'track', item: track, x: 1 }, { kind: 'album', item: track },
    { kind: 'track', item: playlist }, { kind: 'playlist', item: track },
    { kind: 'playlist', item: { ...playlist, tracks: [] } }, { kind: 'track', item: { ...track, url: 'https://evil.example/a/b' } }
  ]) t.is(parseResolve(b), null, JSON.stringify(b))
})

test('parsers accept today\'s item or one more boolean cover and nothing else', async (t) => {
  const { parseSearch, parseItem, parseResolve, musicCardFields } = await load()
  const lit = { ...track, cover: true }
  const dark = { ...track, id: 'T2abc', cover: false }
  const list = { ...playlist, cover: true }
  t.alike(parseSearch({ items: [lit, dark, track], next: null }, 'track'), { items: [lit, dark, track], next: null })
  t.alike(parseSearch({ items: [list, playlist], next: null }, 'playlist'), { items: [list, playlist], next: null })
  t.alike(parseItem(lit, 'track'), lit)
  t.alike(parseItem({ ...list, tracks: [lit, dark, track] }, 'playlist'), { ...list, tracks: [lit, dark, track] })
  t.alike(parseItem({ ...playlist, tracks: [lit] }, 'playlist'), { ...playlist, tracks: [lit] })
  t.alike(parseResolve({ kind: 'track', item: dark }), { kind: 'track', item: dark })
  t.alike(parseResolve({ kind: 'playlist', item: list }), { kind: 'playlist', item: list })
  t.absent(Object.hasOwn(parseItem(track, 'track'), 'cover'), 'no key, no cover field')
  t.absent(Object.hasOwn(parseResolve({ kind: 'playlist', item: playlist }).item, 'cover'))
  t.absent(Object.hasOwn(parseSearch({ items: [track], next: null }, 'track').items[0], 'cover'))
  const inherited = Object.assign(Object.create({ cover: true }), track)
  t.absent(Object.hasOwn(parseItem(inherited, 'track'), 'cover'), 'only an own cover counts')
  for (const [item, why] of [
    [{ ...track, cover: 'true' }, 'a string cover'],
    [{ ...track, cover: 1 }, 'a number cover'],
    [{ ...track, cover: null }, 'a null cover'],
    [{ ...track, cover: { url: 'https://evil.example/a.jpg' } }, 'an object cover'],
    [{ ...track, cover: true, artwork: 'https://evil.example/a.jpg' }, 'a cover and an artwork'],
    [{ ...track, artwork: 'https://evil.example/a.jpg' }, 'an artwork string'],
    [{ ...track, cover: true, x: 1 }, 'a cover and another key']
  ]) {
    t.is(parseSearch({ items: [track, item], next: null }, 'track'), null, 'search: ' + why)
    t.is(parseItem(item, 'track'), null, 'item: ' + why)
    t.is(parseItem({ ...playlist, tracks: [track, item] }, 'playlist'), null, 'nested track: ' + why)
    t.is(parseResolve({ kind: 'track', item }), null, 'resolve: ' + why)
  }
  for (const [extra, why] of [[{ cover: 'yes' }, 'a string cover'], [{ artwork: 'https://evil.example/a.jpg' }, 'an artwork'], [{ cover: false, x: 1 }, 'a cover and another key']]) {
    t.is(parseSearch({ items: [{ ...playlist, ...extra }], next: null }, 'playlist'), null, 'playlist search: ' + why)
    t.is(parseItem({ ...playlist, ...extra, tracks: [] }, 'playlist'), null, 'playlist item: ' + why)
    t.is(parseResolve({ kind: 'playlist', item: { ...playlist, ...extra } }), null, 'playlist resolve: ' + why)
  }
  t.is(parseSearch({ items: [], next: null, cover: true }, 'track'), null, 'a page has no cover')
  t.is(parseResolve({ kind: 'track', item: track, cover: true }), null, 'a resolve answer has no cover of its own')
  const card = musicCardFields(lit, { kind: 'track', id: lit.id, start: null })
  t.alike(Object.keys(card).sort(), ['desc', 'host', 'title', 'url'], 'a cover never reaches a card')
})

test('artMime knows JPEG, PNG and WebP and nothing else', async (t) => {
  const { artMime, MUSIC_ART_MAX_BYTES } = await load()
  t.is(MUSIC_ART_MAX_BYTES, 131072)
  const u = (bytes) => Uint8Array.from(bytes)
  t.is(artMime(u([0xff, 0xd8, 0xff])), 'image/jpeg')
  t.is(artMime(u([0xff, 0xd8, 0xff, 0xe0, 0, 16])), 'image/jpeg')
  t.is(artMime(u([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png')
  t.is(artMime(u([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])), 'image/webp')
  t.is(artMime(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'image/webp', 'a Buffer is a Uint8Array')
  for (const [bytes, why] of [
    [u([]), 'empty'],
    [u([0xff, 0xd8]), 'a cut JPEG mark'],
    [u([0xff, 0xd8, 0xfe]), 'not a JPEG'],
    [u([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a]), 'a cut PNG mark'],
    [u([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]), 'a wrong PNG mark'],
    [u([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]), 'a RIFF WAVE'],
    [u([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42]), 'a cut WebP'],
    [u([0, 0, 0, 0, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]), 'WEBP without RIFF'],
    [Buffer.from('GIF89a\u0001\u0000'), 'GIF89a'],
    [Buffer.from('GIF87a\u0001\u0000'), 'GIF87a'],
    [Buffer.from('<svg xmlns="x"/>'), 'SVG'],
    [Buffer.from('BM\u0000\u0000'), 'BMP']
  ]) t.is(artMime(bytes), null, why)
  for (const v of [null, undefined, 'ÿØÿ', [0xff, 0xd8, 0xff], { 0: 0xff, 1: 0xd8, 2: 0xff, length: 3 }, new ArrayBuffer(3)]) {
    t.is(artMime(v), null, 'not bytes: ' + Object.prototype.toString.call(v))
  }
})

test('parsePlay: a 43-character base64url ticket and an ISO expiry', async (t) => {
  const { parsePlay } = await load()
  const at = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  t.alike(parsePlay({ ticket: TICKET, expiresAt: at }), { ticket: TICKET, expiresAt: at })
  t.ok(parsePlay({ ticket: TICKET, expiresAt: '2026-11-12T10:00:00Z' }))
  for (const b of [
    null, {}, { ticket: TICKET }, { ticket: TICKET, expiresAt: at, x: 1 },
    { ticket: 'a'.repeat(42), expiresAt: at }, { ticket: 'a'.repeat(44), expiresAt: at },
    { ticket: 'a'.repeat(42) + '=', expiresAt: at }, { ticket: 'a'.repeat(42) + '/', expiresAt: at },
    { ticket: 'a'.repeat(42) + '+', expiresAt: at }, { ticket: 5, expiresAt: at },
    { ticket: TICKET, expiresAt: 'amanhã' }, { ticket: TICKET, expiresAt: 5 },
    { ticket: TICKET, expiresAt: '2026-13-45T99:99:99Z' }, { ticket: TICKET, expiresAt: '2026-11-12' }
  ]) t.is(parsePlay(b), null, JSON.stringify(b))
})

test('audioPath: only a valid ticket', async (t) => {
  const { audioPath } = await load()
  t.is(audioPath(TICKET), '/account/audius/audio/' + TICKET)
  for (const v of ['', 'a'.repeat(42), '../' + 'a'.repeat(40), 'a'.repeat(42) + '?', null, 5]) t.is(audioPath(v), null, String(v))
})

test('musicOriginOf: music only on a hosted node, by capability', async (t) => {
  const { musicOriginOf } = await load()
  t.is(musicOriginOf({ hosted: true }), undefined)
  t.is(musicOriginOf({ hosted: true, accountOrigin: 'https://conta.example.org' }), undefined)
  t.is(musicOriginOf({ hosted: false, accountOrigin: 'https://conta.example.org' }), null)
  t.is(musicOriginOf({ hosted: 'true' }), null)
  t.is(musicOriginOf({}), null)
  t.is(musicOriginOf(null), null)
  t.is(musicOriginOf(undefined), null)
})

test('queueStep: load, select, next, prev, ended', async (t) => {
  const { queueIdle, queueStep } = await load()
  const a = { ...track, id: 'A' }
  const b = { ...track, id: 'B' }
  const c = { ...track, id: 'C' }
  t.alike(queueIdle, { tracks: [], index: -1, done: false })
  t.ok(Object.isFrozen(queueIdle))
  let s = queueStep(queueIdle, { type: 'load', tracks: [a, b, c] })
  t.alike(s, { tracks: [a, b, c], index: 0, done: false })
  t.alike(queueStep(queueIdle, { type: 'load', tracks: [a, b, c], index: 2 }).index, 2)
  t.alike(queueStep(queueIdle, { type: 'load', tracks: [a, b, c], index: 3 }).index, 0)
  t.is(queueStep(queueIdle, { type: 'load', tracks: [] }), queueIdle)
  t.is(queueStep(queueIdle, { type: 'load' }), queueIdle)
  t.alike(queueStep(queueIdle, { type: 'load', tracks: [null, { id: 'a/b', duration: 1 }, a] }).tracks, [a], 'bad entries dropped')
  t.is(queueStep(queueIdle, { type: 'load', tracks: Array.from({ length: 60 }, () => a) }).tracks.length, 50)
  s = queueStep(s, { type: 'next' })
  t.is(s.index, 1)
  s = queueStep(s, { type: 'prev' })
  t.is(s.index, 0)
  t.is(queueStep(s, { type: 'prev' }), s, 'no track before the first')
  s = queueStep(s, { type: 'select', index: 2 })
  t.is(s.index, 2)
  t.is(queueStep(s, { type: 'next' }), s, 'no track after the last')
  t.is(queueStep(s, { type: 'select', index: 3 }), s)
  t.is(queueStep(s, { type: 'select', index: -1 }), s)
  t.is(queueStep(s, { type: 'select', index: '1' }), s)
  s = queueStep(s, { type: 'ended' })
  t.alike(s, { tracks: [a, b, c], index: 2, done: true }, 'the last one ended')
  s = queueStep(s, { type: 'select', index: 0 })
  t.alike(s, { tracks: [a, b, c], index: 0, done: false })
  s = queueStep(s, { type: 'ended' })
  t.is(s.index, 1, 'ended moves on')
  t.is(queueStep(s, { type: 'nope' }), s)
  t.is(queueStep(s, null), s)
  t.is(queueStep(queueIdle, { type: 'ended' }), queueIdle)
  t.is(queueStep(undefined, { type: 'next' }), queueIdle)
})

test('musicQuery, musicErrorText, musicPartialText', async (t) => {
  const { musicQuery, musicErrorText, musicPartialText, MUSIC_LIMIT_TEXT, MUSIC_UNAVAILABLE_TEXT } = await load()
  t.is(musicQuery('  samba  '), 'samba')
  t.is(musicQuery(''), '')
  t.is(musicQuery('a'.repeat(65)), '')
  t.is(musicQuery('a\u0000b'), '')
  t.is(musicQuery(null), '')
  t.is(musicErrorText({ code: 'limite-musica' }), MUSIC_LIMIT_TEXT)
  for (const code of ['indisponivel', 'nao-autorizado', 'pedido-invalido', 'limite-gif', undefined]) t.is(musicErrorText({ code }), MUSIC_UNAVAILABLE_TEXT, String(code))
  t.is(musicErrorText(null), MUSIC_UNAVAILABLE_TEXT)
  const tracks = Array.from({ length: 50 }, () => track)
  t.is(musicPartialText({ ...playlist, count: 120, tracks }), 'Tocando 50 de 120 faixas')
  t.is(musicPartialText({ ...playlist, count: 50, tracks }), '')
  t.is(musicPartialText({ ...playlist, count: 12, tracks: tracks.slice(0, 12) }), '')
  t.is(musicPartialText(playlist), '')
  t.is(musicPartialText(null), '')
})

test('musicClock formats seconds', async (t) => {
  const { musicClock } = await load()
  t.is(musicClock(0), '0:00')
  t.is(musicClock(5), '0:05')
  t.is(musicClock(9), '0:09')
  t.is(musicClock(59), '0:59')
  t.is(musicClock(60), '1:00')
  t.is(musicClock(72), '1:12')
  t.is(musicClock(125), '2:05')
  t.is(musicClock(200), '3:20')
  t.is(musicClock(7200), '120:00')
  t.is(musicClock(61.9), '1:01')
  t.is(musicClock(-4), '0:00')
  t.is(musicClock(-0.2), '0:00')
  for (const v of [NaN, Infinity, -Infinity, undefined, null, '72', {}, true]) t.is(musicClock(v), '0:00', String(v))
})

test('row and sticker lines for snippet, track and playlist', async (t) => {
  const { musicRowLine, musicStickerLine, musicWindowText, SNIPPET_BADGE } = await load()
  t.is(SNIPPET_BADGE, '15 s')
  t.is(musicRowLine(track), 'Artista · 3:20')
  t.is(musicRowLine({ ...track, duration: 1 }), 'Artista · 0:01')
  t.is(musicRowLine({ ...track, duration: 90.9 }), 'Artista · 1:30', 'a finite duration, floored by the clock')
  t.is(musicRowLine({ artist: 'A\u0000B', duration: 61 }), 'A\u0000B · 1:01', 'raw provider text')
  t.is(musicRowLine(playlist), 'Artista · 12 faixas')
  t.is(musicRowLine({ ...playlist, count: 1 }), 'Artista · 1 faixa')
  t.is(musicRowLine({ ...playlist, count: 500 }), 'Artista · 500 faixas')
  t.is(musicRowLine({ ...playlist, count: 501 }), '')
  t.is(musicRowLine({ ...playlist, count: 0 }), '')
  t.is(musicRowLine({ ...playlist, count: 1.5 }), '')
  t.is(musicRowLine({ artist: 'Artista', duration: 0, count: 4 }), 'Artista · 4 faixas')
  t.is(musicRowLine({ artist: 'Artista', duration: 90, count: 4 }), 'Artista · 1:30', 'a duration wins')
  t.is(musicRowLine({ artist: 'Artista' }), '')
  t.is(musicRowLine({ artist: 'Artista', duration: Infinity }), '')
  t.is(musicRowLine(null), '')
  t.is(musicRowLine('track'), '')
  t.is(musicStickerLine({ kind: 'snippet', id: 'a', start: 72 }, { artist: 'RIXX' }), 'RIXX · 1:12')
  t.is(musicStickerLine({ kind: 'snippet', id: 'T1abc', start: 0 }, track), 'Artista · 0:00')
  t.is(musicStickerLine({ kind: 'snippet', id: 'T1abc', start: 200 }, { artist: 'A\u0000B' }), 'A\u0000B · 3:20', 'raw provider text')
  t.is(musicStickerLine({ kind: 'track', id: 'T1abc', start: null }, track), 'Artista · Faixa inteira')
  t.is(musicStickerLine({ kind: 'playlist', id: 'P9xyz', start: null }, playlist), 'Playlist · 12 faixas')
  t.is(musicStickerLine({ kind: 'playlist', id: 'P9xyz' }, { count: 1 }), 'Playlist · 1 faixa')
  t.is(musicStickerLine({ kind: 'playlist', id: 'P9xyz' }, { count: 500 }), 'Playlist · 500 faixas')
  t.is(musicStickerLine({ kind: 'playlist', id: 'P9xyz' }, { count: 501 }), '')
  t.is(musicStickerLine({ kind: 'playlist', id: 'P9xyz' }, { artist: 'Artista' }), '')
  t.is(musicStickerLine({ kind: 'album', id: 'T1abc' }, track), '')
  t.is(musicStickerLine(null, track), '')
  t.is(musicStickerLine({ kind: 'track' }, null), '')
  t.is(musicStickerLine(null, null), '')
  t.is(musicStickerLine('snippet', track), '')
  t.is(musicStickerLine({ kind: 'track' }, 'x'), '')
  t.is(musicWindowText(30, 200), 'De 0:30 a 0:45')
  t.is(musicWindowText(185, 200), 'De 3:05 a 3:20')
  t.is(musicWindowText(0, 10), 'De 0:00 a 0:10')
  t.is(musicWindowText(999, 200), 'De 3:05 a 3:20', 'clamped to the window that can play')
  t.is(musicWindowText(30.9, 200), 'De 0:30 a 0:45')
  t.is(musicWindowText(NaN, 200), 'De 0:00 a 0:15')
  t.is(musicWindowText(30, null), 'De 0:00 a 0:15')
})

test('snippetProgress clamps to the window', async (t) => {
  const { snippetProgress } = await load()
  t.is(snippetProgress(30000, 30000, 45000), 0)
  t.is(snippetProgress(37500, 30000, 45000), 0.5)
  t.is(snippetProgress(45000, 30000, 45000), 1)
  t.is(snippetProgress(0, 0, 15000), 0)
  t.is(snippetProgress(15000, 0, 15000), 1)
  t.is(snippetProgress(7500, 0, 15000), 0.5)
  t.is(snippetProgress(20000, 30000, 45000), 0, 'before the window')
  t.is(snippetProgress(60000, 30000, 45000), 1, 'after the window')
  t.is(snippetProgress(1, 0, 0), 0, 'zero length')
  t.is(snippetProgress(30000, 45000, 30000), 0, 'end before start')
  for (const v of [NaN, Infinity, -Infinity, undefined, '1', null]) {
    t.is(snippetProgress(v, 0, 15000), 0, 'ms ' + String(v))
    t.is(snippetProgress(1000, v, 15000), 0, 'start ' + String(v))
    t.is(snippetProgress(1000, 0, v), 0, 'end ' + String(v))
  }
})

test('the strip keeps eight points per second and a bounded bar count for a 7200 s track', async (t) => {
  const strip = await loadStrip()
  const { SNIPPET_S } = await load()
  t.is(strip.PX_PER_S, 8)
  t.is(strip.BAR_PITCH, 4)
  t.is(strip.BAR_WIDTH, 3)
  t.is(strip.MAX_BARS, 200)
  t.is(strip.windowPx(7200), SNIPPET_S * 8)
  t.is(strip.windowPx(200), SNIPPET_S * 8)
  t.is(strip.windowPx(16), 120)
  t.is(strip.windowPx(15), 120)
  t.is(strip.windowPx(10), 80, 'a short track: the window is the track')
  t.is(strip.windowPx(1), 8)
  t.is(strip.windowPx(null), 120)
  t.is(strip.windowPx(0), 120)
  t.is(strip.windowPx(7201), 120)
  t.is(strip.windowPx(1.5), 120)
  t.is(strip.windowPx('200'), 120)
  t.is(strip.stripPx(7200), 7200 * 8)
  t.is(strip.stripPx(7200) / 7200, 8)
  t.is(strip.stripPx(200), 1600)
  t.is(strip.stripPx(10), 80)
  t.is(strip.stripPx(1), 8)
  for (const d of [null, undefined, 0, -5, 7201, 1.5, Infinity, '200']) t.is(strip.stripPx(d), 0, String(d))
  const offset = strip.stripOffset(3000, 400, 7200)
  t.is(offset, (400 - 120) / 2 - 3000 * 8)
  const bars = strip.visibleBars(offset, 400, 7200)
  t.ok(bars.count <= 200)
  t.ok(bars.count > 0)
  t.alike(bars, { first: 5955, count: 121 })
  t.alike(strip.visibleBars(0, 100000, 7200), { first: 12400, count: 200 }, 'a wide viewport still mounts at most MAX_BARS')
  t.alike(strip.visibleBars(10, 100, 10), { first: 0, count: 20 }, 'no bar past the strip')
  t.alike(strip.visibleBars(NaN, 400, 7200), { first: 0, count: 0 })
  t.alike(strip.visibleBars(0, 0, 7200), { first: 0, count: 0 })
  t.alike(strip.visibleBars(0, -20, 200), { first: 0, count: 0 })
  t.alike(strip.visibleBars(Infinity, 400, 200), { first: 0, count: 0 })
  t.alike(strip.visibleBars(0, NaN, 200), { first: 0, count: 0 })
  t.alike(strip.visibleBars('0', 400, 200), { first: 0, count: 0 })
  t.alike(strip.visibleBars(0, 400, null), { first: 0, count: 0 })
  t.is(strip.stripOffset(0, 400, 200), 140)
  t.is(strip.stripOffset(30, 400, 200), 140 - 240)
  t.is(strip.stripOffset(0, 401, 200), (401 - 120) / 2)
  t.is(strip.stripOffset(10, 0, 200), 0)
  t.is(strip.stripOffset(10, -4, 200), 0)
  t.is(strip.stripOffset(10, NaN, 200), 0)
  t.is(strip.stripOffset(10, Infinity, 200), 0)
  t.is(strip.stripOffset(10, '400', 200), 0)
})

test('a wide viewport keeps bars under the centred window', async (t) => {
  const { stripOffset, windowPx, stripPx, visibleBars, BAR_PITCH, MAX_BARS } = await loadStrip()
  const duration = 7200
  const viewport = 2000
  const offset = stripOffset(3000, viewport, duration)
  const { first, count } = visibleBars(offset, viewport, duration)
  const windowFirst = Math.max(0, Math.floor((-offset + (viewport - windowPx(duration)) / 2) / BAR_PITCH))
  const windowLast = Math.min(Math.ceil(stripPx(duration) / BAR_PITCH) - 1, Math.ceil((-offset + (viewport + windowPx(duration)) / 2) / BAR_PITCH))
  t.is(count, MAX_BARS)
  for (let index = windowFirst; index <= windowLast; index++) {
    t.ok(index >= first && index < first + count, 'window bar ' + index + ' is mounted')
  }
})

test('barHeight is deterministic per id and index and stays in range', async (t) => {
  const { barHeight } = await loadStrip()
  const base = barHeight('T1abc', 0)
  t.is(typeof base, 'number')
  t.is(barHeight('T1abc', 0), base)
  t.is(barHeight('T1abc', 0), barHeight('T1abc', 0))
  let differed = false
  for (let i = 0; i < 32; i++) {
    const h = barHeight('T1abc', i)
    t.ok(h >= 0.25 && h <= 1, String(i) + ' ' + h)
    t.is(barHeight('T1abc', i), h)
    if (h !== base) differed = true
  }
  t.ok(differed, 'the index changes the height')
  t.ok(barHeight('T1abc', 0) !== barHeight('other', 0), 'the id changes the height')
  t.is(barHeight('a', 4), barHeight('a', 4))
  t.ok(barHeight('a', 4) !== barHeight('b', 4))
  t.is(barHeight(null, 4), barHeight('', 4))
  t.is(barHeight(undefined, 4), barHeight('', 4))
  t.is(barHeight(5, 4), barHeight('', 4))
  t.is(barHeight({}, 4), barHeight('', 4))
  for (const index of [-1, -0.5, 1.5, NaN, Infinity, '0', null, undefined]) {
    t.is(barHeight('T1abc', index), 0.25, String(index))
    t.is(barHeight('other', index), 0.25, String(index))
  }
  t.is(barHeight('T1abc', 0), barHeight('T1abc', -0))
})

test('a drag to the left starts later and clamps at both ends', async (t) => {
  const { startFromDrag } = await loadStrip()
  const { maxStart } = await load()
  t.is(startFromDrag(10, -8, 200), 11)
  t.is(startFromDrag(10, -24, 200), 13)
  t.is(startFromDrag(10, 8, 200), 9, 'a drag to the right starts earlier')
  t.is(startFromDrag(2, 24, 200), 0, 'clamps at the beginning')
  t.is(startFromDrag(0, 8, 200), 0)
  t.is(startFromDrag(180, -80, 200), maxStart(200), 'clamps at the latest snippet start')
  t.is(startFromDrag(maxStart(200), -8, 200), maxStart(200))
  t.is(startFromDrag(10, -8, 10), 0, 'a short track has no room to move')
  t.is(startFromDrag(10, 0, 200), 10)
  t.is(startFromDrag(30.2, 0, 200), 30)
  t.is(startFromDrag(10, NaN, 200), 10)
  t.is(startFromDrag(10, Infinity, 200), 10)
  t.is(startFromDrag(10, -Infinity, 200), 10)
  t.is(startFromDrag(10, undefined, 200), 10)
  t.is(startFromDrag(10, '-8', 200), 10)
  t.is(startFromDrag(999, NaN, 200), maxStart(200), 'a non-finite dx still clamps the origin')
  t.is(startFromDrag(-4, undefined, 200), 0)
})
