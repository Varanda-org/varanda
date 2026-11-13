'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')

const load = () => import('../src/musicEmbed.js')

const YT = 'dQw4w9WgXcQ'
const YT_LIST = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'
const SP = '4uLU6hMCjMI75M1A2tKUQC'
const NOCOOKIE = 'https://www.youtube-nocookie.com/embed/'
const SC_TAIL = '&auto_play=true&visual=false&show_comments=false&show_teaser=false'

const ACCEPTED = [
  ['https://youtu.be/' + YT, NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://youtu.be/' + YT + '/', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://www.youtube.com/watch?v=' + YT, NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://youtube.com/watch?v=' + YT, NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://m.youtube.com/watch?v=' + YT, NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://music.youtube.com/watch?v=' + YT + '&si=abc', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://www.youtube.com/shorts/' + YT, NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://www.youtube.com/live/' + YT + '?feature=share', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://www.youtube.com/embed/' + YT, NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://www.youtube.com/watch?v=' + YT + '#comments', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://youtu.be/' + YT + '?t=42', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0&start=42'],
  ['https://youtu.be/' + YT + '?t=42s', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0&start=42'],
  ['https://www.youtube.com/watch?v=' + YT + '&start=86400', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0&start=86400'],
  ['https://www.youtube.com/watch?v=' + YT + '&t=86401', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://www.youtube.com/watch?v=' + YT + '&t=1m30s', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://www.youtube.com/watch?v=' + YT + '&t=0', NOCOOKIE + YT + '?playsinline=1&autoplay=1&rel=0'],
  ['https://www.youtube.com/playlist?list=' + YT_LIST, 'https://www.youtube-nocookie.com/embed?listType=playlist&list=' + YT_LIST + '&playsinline=1'],
  ['https://soundcloud.com/artist-1/song_name', 'https://w.soundcloud.com/player/?url=' + encodeURIComponent('https://soundcloud.com/artist-1/song_name') + SC_TAIL],
  ['https://soundcloud.com/artist-1/sets/album-2/', 'https://w.soundcloud.com/player/?url=' + encodeURIComponent('https://soundcloud.com/artist-1/sets/album-2') + SC_TAIL],
  ['https://on.soundcloud.com/AbC123', 'https://w.soundcloud.com/player/?url=' + encodeURIComponent('https://on.soundcloud.com/AbC123') + SC_TAIL],
  ['https://open.spotify.com/track/' + SP + '?si=xyz', 'https://open.spotify.com/embed/track/' + SP],
  ['https://open.spotify.com/intl-pt/track/' + SP, 'https://open.spotify.com/embed/track/' + SP],
  ['https://open.spotify.com/album/' + SP, 'https://open.spotify.com/embed/album/' + SP],
  ['https://open.spotify.com/playlist/' + SP, 'https://open.spotify.com/embed/playlist/' + SP],
  ['https://open.spotify.com/episode/' + SP, 'https://open.spotify.com/embed/episode/' + SP],
  ['https://open.spotify.com/show/' + SP, 'https://open.spotify.com/embed/show/' + SP],
  ['https://open.spotify.com/artist/' + SP, 'https://open.spotify.com/embed/artist/' + SP],
  ['https://music.apple.com/br/album/some-album/1440857781', 'https://embed.music.apple.com/br/album/some-album/1440857781'],
  ['https://music.apple.com/br/album/some-album/1440857781?i=1440857795&ls=1', 'https://embed.music.apple.com/br/album/some-album/1440857781?i=1440857795'],
  ['https://music.apple.com/us/song/a-song/1440857795', 'https://embed.music.apple.com/us/song/a-song/1440857795'],
  ['https://music.apple.com/us/song/1440857795', 'https://embed.music.apple.com/us/song/1440857795'],
  ['https://music.apple.com/br/album/a%C3%A7%C3%A3o/1440857781', 'https://embed.music.apple.com/br/album/a%C3%A7%C3%A3o/1440857781'],
  ['https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb', 'https://embed.music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb']
]

const long = 'https://www.youtube.com/watch?v=' + YT + '&x=' + 'a'.repeat(301 - ('https://www.youtube.com/watch?v=' + YT + '&x=').length)

const REJECTED = [
  'http://youtu.be/' + YT,
  'HTTPS://youtu.be/' + YT,
  'https://YOUTU.BE/' + YT,
  'https://user:pw@youtu.be/' + YT,
  'https://user@youtu.be/' + YT,
  'https://youtu.be:8443/' + YT,
  'https://youtu.be:443/' + YT,
  'https://142.250.0.1/watch?v=' + YT,
  'https://[::1]/watch?v=' + YT,
  'https://youtube.com.evil.example/watch?v=' + YT,
  'https://evil-youtube.com/watch?v=' + YT,
  'https://www.youtube-nocookie.com/embed/' + YT,
  'https://youtu.be/' + YT.slice(1),
  'https://youtu.be/' + YT + 'x',
  'https://www.youtube.com/watch?v=' + YT.slice(1),
  'https://www.youtube.com/watch?v=' + YT + '"',
  'https://www.youtube.com/watch?v=dQw4w9WgX%63Q',
  'https://www.youtube.com/watch',
  'https://www.youtube.com/shorts/' + YT + '/extra',
  'https://www.youtube.com//shorts/' + YT,
  'https://www.youtube.com/playlist?list=short',
  'https://www.youtube.com/playlist?list=' + 'a'.repeat(65),
  'https://www.youtube.com/channel/UCxyz',
  'https://www.youtube.com/',
  'https://soundcloud.com/artist',
  'https://soundcloud.com/artist/sets',
  'https://soundcloud.com/artist/likes',
  'https://soundcloud.com/artist/track/s-secret',
  'https://soundcloud.com/artist/' + 'a'.repeat(81),
  'https://soundcloud.com/artist/song.mp3',
  'https://on.soundcloud.com/abc-def',
  'https://on.soundcloud.com/' + 'a'.repeat(33),
  'https://m.soundcloud.com/artist/song',
  'https://w.soundcloud.com/player/?url=https://evil.example',
  'https://open.spotify.com/track/' + SP.slice(1),
  'https://open.spotify.com/track/' + SP + 'x',
  'https://open.spotify.com/user/' + SP,
  'https://open.spotify.com/intl-pt/intl-pt/track/' + SP,
  'https://open.spotify.com/embed/track/' + SP,
  'https://open.spotify.com/track/' + SP + '/extra',
  'https://music.apple.com/br/artist/name/123',
  'https://music.apple.com/BR/album/x/123',
  'https://music.apple.com/br/album/x/abc',
  'https://music.apple.com/br/album/%2e%2e/123',
  'https://music.apple.com/br/album/a%2Fb/123',
  'https://music.apple.com/br/playlist/x/123',
  'https://music.apple.com/br/album/a/b/123',
  'https://embed.music.apple.com/br/album/x/123',
  long,
  '',
  'youtu.be/' + YT,
  'javascript:alert(1)',
  null,
  undefined,
  42,
  {},
  { toString: () => 'https://youtu.be/' + YT }
]

const AUDIUS = [
  'https://audius.co/artist/track-name-123',
  'https://audius.co/artist/playlist/mix-456',
  'https://audius.co/',
  'https://audius.co',
  'https://audius.co/embed/track/abc?flavor=card'
]

test('musicEmbed: allowlists are frozen and exact, with no Audius origin', async (t) => {
  const { EMBED_HOSTS, EMBED_FRAME_ORIGINS, EMBED_PROVIDER_NAMES, EMBED_BASE_URL } = await load()
  t.ok(Object.isFrozen(EMBED_HOSTS))
  t.ok(Object.isFrozen(EMBED_FRAME_ORIGINS))
  t.ok(Object.isFrozen(EMBED_PROVIDER_NAMES))
  t.alike([...EMBED_HOSTS], ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'soundcloud.com', 'on.soundcloud.com', 'open.spotify.com', 'music.apple.com'])
  t.alike([...EMBED_FRAME_ORIGINS], ['https://www.youtube-nocookie.com', 'https://w.soundcloud.com', 'https://open.spotify.com', 'https://embed.music.apple.com'])
  t.absent(EMBED_FRAME_ORIGINS.some((o) => o.includes('audius')), 'no Audius frame origin')
  t.absent(EMBED_HOSTS.some((h) => h.includes('audius')), 'no Audius embed host')
  t.is(EMBED_BASE_URL, 'https://app.varanda')
})

test('musicEmbed: every accepted URL form gives the exact player address', async (t) => {
  const { embedOf, EMBED_FRAME_ORIGINS } = await load()
  for (const [url, embedUrl] of ACCEPTED) {
    const e = embedOf(url)
    t.ok(e, url)
    if (!e) continue
    t.is(e.embedUrl, embedUrl, url)
    t.ok(Object.isFrozen(e), url + ': frozen')
    t.ok(EMBED_FRAME_ORIGINS.includes(new URL(e.embedUrl).origin), url + ': frame origin allowed')
    t.ok(rpc.cardUrlHost(e.pageUrl) !== null, url + ': page URL is a card URL')
  }
})

test('musicEmbed: provider, kind, page URL and height', async (t) => {
  const { embedOf } = await load()
  const pick = (u) => { const e = embedOf(u); return e && { provider: e.provider, kind: e.kind, pageUrl: e.pageUrl, height: e.height, minWidth: e.minWidth } }
  t.alike(pick('https://youtu.be/' + YT + '?t=42s'), { provider: 'youtube', kind: 'video', pageUrl: 'https://www.youtube.com/watch?v=' + YT + '&t=42s', height: 200, minWidth: 200 })
  t.alike(pick('https://music.youtube.com/watch?v=' + YT), { provider: 'youtube', kind: 'video', pageUrl: 'https://music.youtube.com/watch?v=' + YT, height: 200, minWidth: 200 })
  t.alike(pick('https://www.youtube.com/playlist?list=' + YT_LIST), { provider: 'youtube', kind: 'playlist', pageUrl: 'https://www.youtube.com/playlist?list=' + YT_LIST, height: 200, minWidth: 200 })
  t.alike(pick('https://soundcloud.com/a/b?in=x'), { provider: 'soundcloud', kind: 'track', pageUrl: 'https://soundcloud.com/a/b', height: 166, minWidth: 0 })
  t.alike(pick('https://soundcloud.com/a/sets/b'), { provider: 'soundcloud', kind: 'set', pageUrl: 'https://soundcloud.com/a/sets/b', height: 352, minWidth: 0 })
  t.alike(pick('https://on.soundcloud.com/x1'), { provider: 'soundcloud', kind: 'short', pageUrl: 'https://on.soundcloud.com/x1', height: 166, minWidth: 0 })
  t.alike(pick('https://open.spotify.com/intl-de/track/' + SP), { provider: 'spotify', kind: 'track', pageUrl: 'https://open.spotify.com/track/' + SP, height: 152, minWidth: 0 })
  t.is(pick('https://open.spotify.com/episode/' + SP).height, 152)
  for (const type of ['album', 'playlist', 'show', 'artist']) t.is(pick('https://open.spotify.com/' + type + '/' + SP).height, 352, type)
  t.alike(pick('https://music.apple.com/br/album/x/123?i=456'), { provider: 'apple', kind: 'album', pageUrl: 'https://music.apple.com/br/album/x/123?i=456', height: 175, minWidth: 0 })
  t.is(pick('https://music.apple.com/br/album/x/123').height, 450)
  t.is(pick('https://music.apple.com/br/album/x/123?i=abc').height, 450, 'a non-numeric i is dropped')
  t.is(pick('https://music.apple.com/br/song/x/123').height, 175)
  t.is(pick('https://music.apple.com/br/playlist/x/pl.u-abc').height, 450)
})

test('musicEmbed: YouTube height keeps 16:9 above a floor', async (t) => {
  const { embedOf, embedHeight } = await load()
  const yt = embedOf('https://youtu.be/' + YT)
  t.is(embedHeight(yt, 640), 360)
  t.is(embedHeight(yt, 300), 200)
  t.is(embedHeight(yt, NaN), 200)
  t.is(embedHeight(yt, undefined), 200)
  t.is(embedHeight(embedOf('https://open.spotify.com/track/' + SP), 640), 152)
  t.is(embedHeight(null, 640), 200)
})

test('musicEmbed: hostile and malformed inputs answer null without throwing', async (t) => {
  const { embedOf, fallbackCard } = await load()
  t.is(long.length, 301)
  for (const url of REJECTED) {
    t.is(embedOf(url), null, String(url))
    t.is(fallbackCard(url), null, String(url) + ': no fallback card')
  }
})

test('musicEmbed: query strings are rebuilt, never copied', async (t) => {
  const { embedOf } = await load()
  const extras = '&utm_source=x&autoplay=0&origin=https://evil.example&enablejsapi=1&widget_referrer=evil'
  const urls = [
    'https://www.youtube.com/watch?v=' + YT + extras,
    'https://www.youtube.com/playlist?list=' + YT_LIST + extras,
    'https://soundcloud.com/a/b?x=1' + extras,
    'https://open.spotify.com/track/' + SP + '?si=1' + extras,
    'https://music.apple.com/br/album/x/123?i=456' + extras
  ]
  for (const url of urls) {
    const e = embedOf(url)
    t.ok(e, url)
    for (const s of [e.embedUrl, e.pageUrl]) {
      for (const bad of ['utm_source', 'evil', 'enablejsapi', 'autoplay=0', 'si=', 'x=1']) t.absent(s.includes(bad), url + ' -> ' + s + ' has no ' + bad)
    }
  }
  const first = embedOf('https://www.youtube.com/watch?v=' + YT + '&v=AAAAAAAAAAA')
  t.ok(first.embedUrl.includes(YT), 'the first v wins')
})

test('musicEmbed: every audius.co URL answers null, and isAudiusLink spots it', async (t) => {
  const { embedOf, isAudiusLink, fallbackCard } = await load()
  for (const url of AUDIUS) {
    t.is(embedOf(url), null, url)
    t.is(fallbackCard(url), null, url)
    t.ok(isAudiusLink(url), url)
  }
  t.absent(isAudiusLink('https://audius.co.evil.example/x'))
  t.absent(isAudiusLink('https://www.audius.co/x'))
  t.absent(isAudiusLink('http://audius.co/x'))
  t.absent(isAudiusLink('https://youtu.be/' + YT))
  t.absent(isAudiusLink(null))
})

test('musicEmbed: fallbackCard carries the provider name and a valid card URL', async (t) => {
  const { fallbackCard, EMBED_PROVIDER_NAMES } = await load()
  t.alike(fallbackCard('https://youtu.be/' + YT), { url: 'https://www.youtube.com/watch?v=' + YT, host: 'www.youtube.com', title: 'YouTube', desc: '' })
  t.alike(EMBED_PROVIDER_NAMES, { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify', apple: 'Apple Music' })
  for (const [url] of ACCEPTED) {
    const card = fallbackCard(url)
    t.ok(card && card.title.length > 0, url + ': title')
    t.is(rpc.cardUrlHost(card.url), card.host, url + ': host')
    t.is(card.desc, '')
  }
})

test('musicEmbed: embedHtml frames only the player origin and escapes the address', async (t) => {
  const { embedOf, embedHtml } = await load()
  const html = embedHtml(embedOf('https://open.spotify.com/track/' + SP))
  t.ok(html.startsWith('<!DOCTYPE html>'))
  t.ok(html.includes('<meta name="viewport"'))
  t.ok(html.includes('content="default-src &#39;none&#39;; frame-src https://open.spotify.com; style-src &#39;unsafe-inline&#39;"'))
  t.ok(html.includes('src="https://open.spotify.com/embed/track/' + SP + '"'))
  t.ok(html.includes('allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"'))
  t.ok(html.includes('referrerpolicy="strict-origin-when-cross-origin"'))
  t.ok(html.includes(' allowfullscreen'))
  t.ok(html.includes('margin:0'))
  t.is(html.match(/<iframe/g).length, 1)
  t.absent(html.includes('<script'))

  const yt = embedHtml(embedOf('https://youtu.be/' + YT + '?t=5'))
  t.ok(yt.includes('src="https://www.youtube-nocookie.com/embed/' + YT + '?playsinline=1&amp;autoplay=1&amp;rel=0&amp;start=5"'), 'ampersands escaped')
  t.ok(yt.includes('frame-src https://www.youtube-nocookie.com;'))

  const crafted = { provider: 'spotify', embedUrl: 'https://open.spotify.com/embed/track/x"><script>alert(1)</script>' }
  t.is(embedHtml(crafted), '', 'characters a card URL never holds are refused')
  const quoted = embedHtml({ provider: 'spotify', embedUrl: "https://open.spotify.com/embed/'onload='x" })
  t.absent(quoted.includes("'onload"), 'a single quote is escaped')
  t.ok(quoted.includes('&#39;onload=&#39;x'))
  t.is(embedHtml({ provider: 'spotify', embedUrl: 'https://evil.example/embed' }), '', 'origin outside the frame list')
  t.is(embedHtml({ provider: 'spotify', embedUrl: 'https://audius.co/embed/track/1' }), '', 'no Audius frame')
  t.is(embedHtml({ provider: 'spotify', embedUrl: 'http://open.spotify.com/embed' }), '')
  t.is(embedHtml({ provider: 'spotify', embedUrl: 'https://open.spotify.com.evil.example/embed' }), '')
  t.is(embedHtml(null), '')
  t.is(embedHtml({}), '')
})

test('musicEmbed: the card cap applies to the page link, not to the player address', async (t) => {
  const { embedOf, embedHtml, fallbackCard, embedFrameOrigin } = await load()
  const kanji = '%E9%9F%B3'
  const apple = 'https://music.apple.com/jp/album/' + kanji.repeat(28) + '/1234567890'
  const set = 'https://soundcloud.com/' + 'a'.repeat(80) + '/sets/' + 'b'.repeat(80)
  t.is(apple.length, 296)
  t.is(set.length, 189)
  for (const url of [apple, set]) {
    const e = embedOf(url)
    t.ok(e, url)
    if (!e) continue
    t.ok(e.embedUrl.length > rpc.MAX_CARD_URL, 'the player address is past the card cap')
    t.is(rpc.cardUrlHost(e.embedUrl), null, 'so cardUrlHost alone would refuse it')
    t.is(e.pageUrl, url)
    t.ok(embedHtml(e).includes('<iframe src="' + e.embedUrl.replace(/&/g, '&amp;') + '"'), url + ': embedHtml')
    t.is(embedFrameOrigin(e.embedUrl), new URL(e.embedUrl).origin)
    const card = fallbackCard(url)
    t.ok(card, url + ': fallback card')
    if (card) t.is(card.url, url)
  }
  const over = 'https://music.apple.com/jp/album/' + kanji.repeat(29) + '/1234567890'
  t.ok(over.length > rpc.MAX_CARD_URL)
  t.is(embedOf(over), null, 'a page link over the cap is still refused')
  t.is(fallbackCard(over), null)
})

test('musicEmbed: embedFrameOrigin answers only an exact listed origin', async (t) => {
  const { embedFrameOrigin, EMBED_FRAME_ORIGINS } = await load()
  for (const origin of EMBED_FRAME_ORIGINS) {
    t.is(embedFrameOrigin(origin), origin)
    t.is(embedFrameOrigin(origin + '/x?y=1#z'), origin)
    t.is(embedFrameOrigin(origin + '?y'), origin)
  }
  for (const url of [
    'http://open.spotify.com/embed/x',
    'HTTPS://open.spotify.com/embed/x',
    'https://OPEN.spotify.com/embed/x',
    'https://user@open.spotify.com/embed/x',
    'https://open.spotify.com@evil.example/x',
    'https://open.spotify.com:443/embed/x',
    'https://open.spotify.com.evil.example/x',
    'https://open.spotify.comx/x',
    'https://audius.co/embed/track/1',
    'https://open.spotify.com/embed/x"><script>',
    'https://open.spotify.com/embed/ x',
    '',
    null,
    undefined,
    42,
    { toString: () => 'https://open.spotify.com/x' }
  ]) t.is(embedFrameOrigin(url), null, String(url))
})

test('musicEmbed: the provider frame is sandboxed with no way out of the wrapper', async (t) => {
  const { embedOf, embedHtml, EMBED_SANDBOX } = await load()
  t.alike(EMBED_SANDBOX.split(' ').sort(), ['allow-presentation', 'allow-same-origin', 'allow-scripts'])
  const forbidden = ['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-top-navigation-to-custom-protocols', 'allow-forms', 'allow-downloads', 'allow-modals']
  const capture = ['microphone', 'camera', 'geolocation', 'display-capture', 'speaker-selection', 'screen-wake-lock', 'usb', 'serial', 'bluetooth', 'hid', 'midi']
  for (const url of ACCEPTED.map(([u]) => u)) {
    const html = embedHtml(embedOf(url))
    const sandboxes = html.match(/ sandbox="([^"]*)"/g) || []
    t.is(sandboxes.length, 1, url + ': one sandbox attribute')
    const iframe = html.slice(html.indexOf('<iframe'), html.indexOf('</iframe>'))
    const tokens = (/ sandbox="([^"]*)"/.exec(iframe) || [])[1]
    t.alike(String(tokens).split(' ').sort(), EMBED_SANDBOX.split(' ').sort(), url + ': exactly the EMBED_SANDBOX tokens')
    for (const bad of forbidden) t.absent(html.includes(bad), url + ': no ' + bad)
    const allow = (/ allow="([^"]*)"/.exec(iframe) || [])[1]
    t.ok(allow, url + ': allow attribute')
    for (const feature of capture) t.absent(String(allow).includes(feature), url + ': no ' + feature)
    t.absent(/<script/i.test(html), url + ': the wrapper runs no script')
    t.absent(/script-src/.test(html), url + ': the CSP grants no script')
  }
})

test('musicEmbed: top navigation stays on the player document', async (t) => {
  const { topNavigationAllowed } = await load()
  t.ok(topNavigationAllowed('https://app.varanda'))
  t.ok(topNavigationAllowed('https://app.varanda/'))
  t.ok(topNavigationAllowed('about:blank'))
  for (const url of ['https://app.varanda/x', 'https://app.varanda.evil', 'http://app.varanda', 'https://open.spotify.com/', 'about:blank#x', 'https://APP.varanda', '', null, undefined]) {
    t.absent(topNavigationAllowed(url), String(url))
  }
})

test('musicEmbed: pt-BR texts', async (t) => {
  const { EMBED_PLAY, EMBED_CLOSE, embedNotice } = await load()
  t.is(EMBED_PLAY, 'Tocar aqui')
  t.is(EMBED_CLOSE, 'Fechar player')
  t.is(embedNotice('spotify'), 'Ao tocar, o player do Spotify carrega aqui e o Spotify recebe o endereço de internet deste aparelho.')
  t.is(embedNotice('apple'), 'Ao tocar, o player do Apple Music carrega aqui e o Apple Music recebe o endereço de internet deste aparelho.')
  t.is(embedNotice('audius'), '')
  t.is(embedNotice('__proto__'), '')
})
