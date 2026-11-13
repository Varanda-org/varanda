'use strict'

// Pure Audius music rules (src/music.js). ES module loaded through import().
const test = require('brittle')

const load = () => import('../src/music.js')

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
