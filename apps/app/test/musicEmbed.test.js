'use strict'

const test = require('brittle')
const rpc = require('@varanda/rpc')

const load = () => import('../src/musicEmbed.js')

const YT = 'dQw4w9WgXcQ'
const YT_LIST = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'
const SP = '4uLU6hMCjMI75M1A2tKUQC'
const NOCOOKIE = 'https://www.youtube-nocookie.com/embed/'
const SC_TAIL = '&auto_play=false&visual=false&show_comments=false&show_teaser=false&buying=false&sharing=false&download=false'

const ACCEPTED = [
  ['https://youtu.be/' + YT, NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://youtu.be/' + YT + '/', NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://www.youtube.com/watch?v=' + YT, NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://youtube.com/watch?v=' + YT, NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://m.youtube.com/watch?v=' + YT, NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://music.youtube.com/watch?v=' + YT + '&si=abc', NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://www.youtube.com/shorts/' + YT, NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://www.youtube.com/live/' + YT + '?feature=share', NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://www.youtube.com/embed/' + YT, NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://www.youtube.com/watch?v=' + YT + '#comments', NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://youtu.be/' + YT + '?t=42', NOCOOKIE + YT + '?playsinline=1&rel=0&start=42'],
  ['https://youtu.be/' + YT + '?t=42s', NOCOOKIE + YT + '?playsinline=1&rel=0&start=42'],
  ['https://www.youtube.com/watch?v=' + YT + '&start=86400', NOCOOKIE + YT + '?playsinline=1&rel=0&start=86400'],
  ['https://www.youtube.com/watch?v=' + YT + '&t=86401', NOCOOKIE + YT + '?playsinline=1&rel=0'],
  ['https://www.youtube.com/watch?v=' + YT + '&t=1m30s', NOCOOKIE + YT + '?playsinline=1&rel=0&start=90'],
  ['https://www.youtube.com/watch?v=' + YT + '&t=0', NOCOOKIE + YT + '?playsinline=1&rel=0'],
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
  t.ok(html.includes('allow="clipboard-write; encrypted-media; fullscreen; picture-in-picture"'))
  t.ok(html.includes('referrerpolicy="strict-origin-when-cross-origin"'))
  t.ok(html.includes(' allowfullscreen'))
  t.ok(html.includes('margin:0'))
  t.is(html.match(/<iframe/g).length, 1)
  t.absent(html.includes('<script'))

  const yt = embedHtml(embedOf('https://youtu.be/' + YT + '?t=5'))
  t.ok(yt.includes('src="https://www.youtube-nocookie.com/embed/' + YT + '?playsinline=1&amp;rel=0&amp;start=5"'), 'ampersands escaped')
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
  t.alike(EMBED_SANDBOX.split(' ').sort(), ['allow-popups', 'allow-presentation', 'allow-same-origin', 'allow-scripts'])
  const forbidden = ['allow-popups-to-escape-sandbox', 'allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-top-navigation-to-custom-protocols', 'allow-forms', 'allow-downloads', 'allow-modals']
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

test('musicEmbed: embedExitUrl lets out only https pages on the same provider\'s hosts', async (t) => {
  const { embedExitUrl, EMBED_HOSTS, EMBED_PROVIDER_DOMAINS } = await load()
  const yt = { provider: 'youtube' }
  const sc = { provider: 'soundcloud' }
  const sp = { provider: 'spotify' }
  const ap = { provider: 'apple' }
  for (const [embed, url] of [
    [yt, 'https://www.youtube.com/watch?v=' + YT + '&t=42s#comments'],
    [sc, 'https://soundcloud.com/artist/track?in=x&si=1#t=0:10'],
    [sp, 'https://open.spotify.com/track/' + SP + '?si=abc#x'],
    [ap, 'https://music.apple.com/br/album/x/1?i=2&ls#top'],
    [yt, 'https://youtu.be/x'],
    [sc, 'https://on.soundcloud.com/x'],
    [sp, 'https://spotify.link/x'],
    [ap, 'https://geo.music.apple.com/x']
  ]) t.is(embedExitUrl(embed, url), url, embed.provider + ' ' + url)

  const refused = [
    [sp, 'https://www.youtube.com/watch?v=' + YT],
    [yt, 'https://open.spotify.com/x'],
    [sc, 'https://music.apple.com/x'],
    [ap, 'https://soundcloud.com/x'],
    [sp, 'https://open.spotify.com.evil.example/x'],
    [sp, 'https://evilspotify.com/x'],
    [sp, 'https://open.spotify.com./x'],
    [sp, 'https://.spotify.com/x'],
    [sp, 'https://a..spotify.com/x'],
    [sp, 'https://open.spotify.com@evil.example/x'],
    [sp, 'https://evil.example@open.spotify.com/x'],
    [sp, 'https://open.spotify.com:443/x'],
    [sp, 'http://open.spotify.com/x'],
    [sp, 'HTTPS://open.spotify.com/x'],
    [sp, 'https://OPEN.spotify.com/x'],
    [yt, 'https://www.youtube-nocookie.com/embed/x'],
    [sp, 'intent://x#Intent;scheme=https;end'],
    [sp, 'spotify:track:x'],
    [sp, 'javascript:alert(1)'],
    [sp, 'data:text/html,x'],
    [sp, 'about:blank'],
    [sp, 'https://open.spotify.com\\@evil.example/x'],
    [sp, 'https://open.spotify.com/x\ty'],
    [sp, 'https://open.spotify.com/' + 'a'.repeat(2049 - 'https://open.spotify.com/'.length)],
    [sp, ''],
    [sp, null],
    [sp, undefined],
    [sp, 42],
    [sp, { toString: () => 'https://open.spotify.com/x' }],
    [null, 'https://open.spotify.com/x'],
    [undefined, 'https://open.spotify.com/x'],
    ['spotify', 'https://open.spotify.com/x'],
    [{}, 'https://open.spotify.com/x'],
    [{ provider: '__proto__' }, 'https://open.spotify.com/x'],
    [{ provider: 'toString' }, 'https://open.spotify.com/x'],
    [{ provider: 'audius' }, 'https://audius.co/x']
  ]
  for (const [embed, url] of refused) {
    t.is(embedExitUrl(embed, url), null, JSON.stringify(embed) + ' ' + (typeof url === 'string' ? url.slice(0, 60) : String(url)))
  }
  t.is(('https://open.spotify.com/' + 'a'.repeat(2049 - 'https://open.spotify.com/'.length)).length, 2049, 'the long case is 2049 characters')
  const atCap = 'https://open.spotify.com/' + 'a'.repeat(2048 - 'https://open.spotify.com/'.length)
  t.is(embedExitUrl(sp, atCap), atCap, '2048 characters still pass')
  const hostile = { get provider () { throw new Error('x') } }
  t.is(embedExitUrl(hostile, 'https://open.spotify.com/x'), null, 'a throwing getter is refused')

  for (const host of EMBED_HOSTS) {
    const providers = Object.keys(EMBED_PROVIDER_DOMAINS).filter((provider) => embedExitUrl({ provider }, 'https://' + host + '/x') !== null)
    t.is(providers.length, 1, host + ' belongs to exactly one provider')
  }
  t.ok(Object.isFrozen(EMBED_PROVIDER_DOMAINS), 'domains frozen')
  for (const domains of Object.values(EMBED_PROVIDER_DOMAINS)) t.ok(Object.isFrozen(domains), 'inner list frozen')
})

test('musicEmbed: embedExitUrl never lets out YouTube\'s redirector', async (t) => {
  const { embedExitUrl } = await load()
  const yt = { provider: 'youtube' }
  const refused = []
  for (const host of ['www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube.com', 'youtu.be']) {
    for (const path of [
      '/redirect',
      '/redirect?q=https://evil.example/',
      '/redirect?event=video_description&q=https%3A%2F%2Fevil.example%2F',
      '/redirect#x',
      '/redirect/',
      '/redirect/x?q=https://evil.example/',
      '/Redirect?q=https://evil.example/',
      '/REDIRECT?q=https://evil.example/',
      '/redir%65ct?q=https://evil.example/',
      '/x/../redirect?q=https://evil.example/',
      '/./redirect?q=https://evil.example/',
      '/x/%2e%2e/redirect?q=https://evil.example/',
      '//redirect?q=https://evil.example/',
      '///redirect?q=https://evil.example/',
      '/redirect;x?q=https://evil.example/',
      '/redirect;?q=https://evil.example/',
      '/redirect%3Bx?q=https://evil.example/',
      '/.;/redirect?q=https://evil.example/',
      '/..;/redirect?q=https://evil.example/',
      '/a;/..;/redirect?q=https://evil.example/',
      '/%2e/redirect;a=b?q=https://evil.example/',
      '/%2Fredirect?q=https://evil.example/',
      '/attribution_link?u=%2Fredirect%3Fq%3Dhttps%253A%252F%252Fevil.example%252F',
      '/Attribution_Link;x?u=%2Fredirect',
      '//attribution_link?u=%2Fredirect'
    ]) refused.push('https://' + host + path)
  }
  for (const url of refused) t.is(embedExitUrl(yt, url), null, url)
  for (const url of [
    'https://www.youtube.com/watch?v=' + YT,
    'https://www.youtube.com/watch?v=' + YT + '&q=https://evil.example/',
    'https://www.youtube.com/redirection',
    'https://www.youtube.com/redirects?q=x',
    'https://www.youtube.com/channel/x/redirect',
    'https://m.youtube.com/channel/x/redirect?q=https://evil.example/',
    'https://music.youtube.com/watch?v=' + YT,
    'https://www.youtube.com/',
    'https://www.youtube.com',
    'https://www.youtube.com?q=x',
    'https://www.youtube.com/x/redirect/../watch?v=' + YT,
    'https://www.youtube.com/%E0',
    'https://www.youtube.com/watch;x?v=' + YT,
    'https://www.youtube.com//watch?v=' + YT,
    'https://www.youtube.com/attribution_links',
    'https://www.youtube.com/channel/x/attribution_link?u=%2Fredirect'
  ]) t.is(embedExitUrl(yt, url), url, url)
  t.is(embedExitUrl({ provider: 'soundcloud' }, 'https://soundcloud.com/redirect?q=x'), 'https://soundcloud.com/redirect?q=x', 'soundcloud is decided by its host')
  t.is(embedExitUrl({ provider: 'spotify' }, 'https://open.spotify.com/redirect?q=x'), 'https://open.spotify.com/redirect?q=x', 'spotify is decided by its host')
  t.is(embedExitUrl({ provider: 'spotify' }, 'https://www.youtube.com/redirect?q=x'), null, 'a YouTube address still needs the YouTube player')
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

test('musicEmbed: YouTube start accepts seconds and the 1h2m3s form', async (t) => {
  const { youtubeStartSeconds, embedOf } = await load()
  t.is(youtubeStartSeconds('1m30s'), 90)
  t.is(youtubeStartSeconds('1h2m3s'), 3723)
  t.is(youtubeStartSeconds('2m'), 120)
  t.is(youtubeStartSeconds('1h'), 3600)
  t.is(youtubeStartSeconds('90'), 90)
  t.is(youtubeStartSeconds('90s'), 90)
  t.is(youtubeStartSeconds('24h'), 86400, 'exactly the cap')
  for (const junk of ['1x', 'm', '', '1h2h', '1s2m', 'h', '1m30', '-1m', '1.5m', '123h', '12345m', ' 1m', null, undefined, 90]) {
    t.is(youtubeStartSeconds(junk), 0, String(junk) + ': no start')
  }
  for (const over of ['24h1s', '1440m1s', '86401', '99h']) t.is(youtubeStartSeconds(over), 0, over + ': over the cap')
  const e = embedOf('https://youtu.be/' + YT + '?t=1h2m3s')
  t.is(e.embedUrl, NOCOOKIE + YT + '?playsinline=1&rel=0&start=3723', 'the player starts there')
  t.is(e.pageUrl, 'https://www.youtube.com/watch?v=' + YT + '&t=3723s', 'the page link keeps the time in seconds')
})

test('musicEmbed: no tap-gate texts remain', async (t) => {
  const mod = await load()
  for (const name of ['EMBED_PLAY', 'EMBED_CLOSE', 'embedNotice']) t.absent(name in mod, 'no export ' + name)
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'musicEmbed.js'), 'utf8')
  for (const text of ['Tocar aqui', 'Fechar player', 'Ao tocar']) t.absent(src.includes(text), 'no ' + text)
})

test('musicEmbed: no player address asks to play by itself', async (t) => {
  const { embedOf, embedHtml } = await load()
  for (const [url] of ACCEPTED) {
    const e = embedOf(url)
    t.ok(e, url + ': accepted')
    if (!e) continue
    t.absent(e.embedUrl.includes('autoplay=1'), url + ': no autoplay=1')
    t.absent(e.embedUrl.includes('auto_play=true'), url + ': no auto_play=true')
    const q = e.embedUrl.indexOf('?')
    const keys = q === -1 ? [] : e.embedUrl.slice(q + 1).split('&').map((pair) => pair.split('=')[0])
    t.absent(keys.includes('autoplay'), url + ': no autoplay query key')
    t.absent(/autoplay/i.test(embedHtml(e)), url + ': embedHtml never names autoplay')
  }
})

test('musicEmbed: a SoundCloud player shows no buy, share or download button', async (t) => {
  const { embedOf } = await load()
  let seen = 0
  for (const [url] of ACCEPTED) {
    const e = embedOf(url)
    if (!e || e.provider !== 'soundcloud') continue
    seen++
    const q = e.embedUrl.indexOf('?')
    const pairs = e.embedUrl.slice(q + 1).split('&')
    for (const key of ['buying', 'sharing', 'download']) {
      t.alike(pairs.filter((pair) => pair.split('=')[0] === key), [key + '=false'], url + ': ' + key + '=false, once')
    }
  }
  t.is(seen, 3, 'every accepted SoundCloud link')
})

test('musicEmbed: sameMusicPage matches only the same item', async (t) => {
  const { sameMusicPage } = await load()
  const watch = 'https://www.youtube.com/watch?v=' + YT
  t.ok(sameMusicPage('https://youtu.be/' + YT, watch), 'youtu.be and watch')
  t.ok(sameMusicPage('https://www.youtube.com/shorts/' + YT, watch), 'shorts and watch')
  t.ok(sameMusicPage('https://open.spotify.com/track/' + SP + '?si=x', 'https://open.spotify.com/track/' + SP), 'Spotify share link and its page')
  t.absent(sameMusicPage('https://youtu.be/' + YT + '?t=42', 'https://youtu.be/' + YT), 'another start is another item')
  t.absent(sameMusicPage('https://youtu.be/' + YT, 'https://youtu.be/aaaaaaaaaaa'), 'another video')
  t.absent(sameMusicPage('https://open.spotify.com/track/' + SP, watch), 'Spotify track and YouTube video')
  for (const other of ['https://audius.co/artist/track', null, undefined, '', 'not a url']) {
    t.execution(() => sameMusicPage(other, watch), String(other) + ': no throw')
    t.is(sameMusicPage(other, watch), false, String(other) + ' first')
    t.is(sameMusicPage(watch, other), false, String(other) + ' second')
  }
  t.is(sameMusicPage(null, null), false, 'two nulls')
  t.is(sameMusicPage('https://audius.co/artist/track', 'https://audius.co/artist/track'), false, 'two Audius links')
})

test('musicEmbed: COVER_IMAGE_DOMAINS is deeply frozen and keyed by provider', async (t) => {
  const { COVER_IMAGE_DOMAINS, EMBED_PROVIDER_NAMES } = await load()
  t.ok(Object.isFrozen(COVER_IMAGE_DOMAINS), 'map frozen')
  t.alike(Object.keys(COVER_IMAGE_DOMAINS).sort(), Object.keys(EMBED_PROVIDER_NAMES).sort(), 'one entry per player provider')
  for (const [provider, list] of Object.entries(COVER_IMAGE_DOMAINS)) {
    t.ok(Object.isFrozen(list), provider + ' list frozen')
    t.absent(list.some((d) => d.includes('spotifycdn')), provider + ': no unmeasured spotifycdn.com')
  }
  t.alike(COVER_IMAGE_DOMAINS, { youtube: ['ytimg.com'], spotify: ['scdn.co'], soundcloud: ['sndcdn.com'], apple: ['mzstatic.com'] }, 'measured domains only')
})

test('musicEmbed: coverImageAllowed', async (t) => {
  const { coverImageAllowed } = await load()
  const yt = 'https://www.youtube.com/watch?v=' + YT
  const sp = 'https://open.spotify.com/track/' + SP
  const sc = 'https://soundcloud.com/artist-1/song_name'
  const ap = 'https://music.apple.com/br/album/nome/123456789?i=987654321'
  t.is(coverImageAllowed(yt, 'https://i.ytimg.com/vi/' + YT + '/hqdefault.jpg'), true, 'i.ytimg.com for YouTube')
  t.is(coverImageAllowed('https://youtu.be/' + YT, 'https://i9.ytimg.com/vi/' + YT + '/hq.jpg'), true, 'numbered sibling for youtu.be')
  t.is(coverImageAllowed(sp, 'https://i.scdn.co/image/ab67616d0000b273'), true, 'i.scdn.co for Spotify')
  t.is(coverImageAllowed(sc, 'https://i1.sndcdn.com/artworks-000-t500x500.jpg'), true, 'i1.sndcdn.com for SoundCloud')
  t.is(coverImageAllowed(ap, 'https://is1-ssl.mzstatic.com/image/thumb/a.jpg/600x600bb.jpg'), true, 'is1-ssl.mzstatic.com for Apple')
  t.is(coverImageAllowed(yt, 'https://i.ytimg.com:443/vi/x.jpg'), true, 'explicit default port')

  t.is(coverImageAllowed(yt, 'https://evil.com/x.jpg'), false, 'evil.com')
  t.is(coverImageAllowed(yt, 'https://ytimg.com.evil.com/x.jpg'), false, 'listed domain as a prefix')
  t.is(coverImageAllowed(yt, 'https://evilytimg.com/x.jpg'), false, 'listed domain as a suffix without a dot')
  t.is(coverImageAllowed(yt, 'https://ytimg.com/x.jpg'), false, 'bare apex')
  t.is(coverImageAllowed(yt, 'http://i.ytimg.com/vi/x.jpg'), false, 'http')
  t.is(coverImageAllowed(yt, 'https://user@i.ytimg.com/x.jpg'), false, 'credentials')
  t.is(coverImageAllowed(yt, 'https://i.scdn.co/image/x'), false, 'Spotify host for a YouTube page')
  t.is(coverImageAllowed(sp, 'https://i.ytimg.com/vi/x.jpg'), false, 'YouTube host for a Spotify page')
  t.is(coverImageAllowed(sc, 'https://is1-ssl.mzstatic.com/x.jpg'), false, 'Apple host for a SoundCloud page')
  for (const host of ['i.spotifycdn.com', 'image-cdn-ak.spotifycdn.com', 'spotifycdn.com']) {
    t.is(coverImageAllowed(sp, 'https://' + host + '/image/x'), false, host)
  }
  t.is(coverImageAllowed('https://example.com/page', 'https://i.ytimg.com/vi/x.jpg'), false, 'non-music page')
  t.is(coverImageAllowed('https://audius.co/artist/track', 'https://i.ytimg.com/vi/x.jpg'), false, 'Audius page')
  for (const bad of [null, undefined, 42, {}, ['https://i.ytimg.com/x.jpg'], '']) {
    t.execution(() => coverImageAllowed(bad, 'https://i.ytimg.com/x.jpg'), String(bad) + ' page: no throw')
    t.is(coverImageAllowed(bad, 'https://i.ytimg.com/x.jpg'), false, String(bad) + ' page')
    t.is(coverImageAllowed(yt, bad), false, String(bad) + ' image')
  }
})

test('musicEmbed: coverImageAllowed compares lowercase hosts', async (t) => {
  const { coverImageAllowed } = await load()
  const yt = 'https://www.youtube.com/watch?v=' + YT
  const img = 'https://I.YTIMG.COM/vi/x.jpg'
  t.is(coverImageAllowed(yt, img), rpc.cardUrlHost(img) !== null, 'upper case host follows cardUrlHost')
  t.is(coverImageAllowed(yt, 'https://I.YTIMG.COM.evil.com/x.jpg'), false, 'upper case prefix trick')
})

test('musicEmbed: coverTarget', async (t) => {
  const { coverTarget } = await load()
  const watch = 'https://www.youtube.com/watch?v=' + YT
  t.is(coverTarget('https://youtu.be/' + YT), watch, 'youtu.be')
  t.is(coverTarget('https://www.youtube.com/shorts/' + YT), watch, 'shorts')
  t.is(coverTarget('https://m.youtube.com/watch?v=' + YT + '&si=abc'), watch, 'mobile watch with tracking')
  t.is(coverTarget(watch), watch, 'watch')
  t.is(coverTarget('https://www.youtube.com/playlist?list=' + YT_LIST), null, 'playlist')
  t.is(coverTarget('https://open.spotify.com/track/' + SP), null, 'Spotify')
  t.is(coverTarget('https://soundcloud.com/artist-1/song_name'), null, 'SoundCloud')
  t.is(coverTarget('https://example.com/watch?v=' + YT), null, 'non-music link')
  for (const bad of [null, undefined, 42, {}, '', 'not a url']) {
    t.execution(() => coverTarget(bad), String(bad) + ': no throw')
    t.is(coverTarget(bad), null, String(bad))
  }
})
