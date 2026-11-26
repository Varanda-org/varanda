'use strict'

// apps/cli/lib/post-page.js: the public page of one shared diary post. Pure,
// no network.

const test = require('brittle')
const { createHash } = require('node:crypto')
const { renderPostPage, postPreviewData, postPhotos, MAX_PHOTOS } = require('../lib/post-page')
const { coverSize } = require('../lib/og-transcode')

const HEX = 'ab'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const BASE = '/p/' + HEX + '/7'
const APP = '/publicacao/' + HEX + '/7'
const FALLBACK_IMAGE = ORIGIN + '/og/convite.png'

function image (n, mime = 'image/jpeg') {
  return { core: 'cd'.repeat(32), mime, start: n + 1, blocks: 1, bytes: 1000, sha256: 'ef'.repeat(32), width: 800, height: 600 }
}

function videoItem () {
  return { core: 'cd'.repeat(32), mime: 'video/mp4', start: 20, blocks: 10, bytes: 300000, sha256: '12'.repeat(32), width: 720, height: 1280, ms: 12000 }
}

function post (over) {
  return { type: 'post', text: 'Bom dia, vizinhança.\nCafé pronto.', at: '2026-11-12T15:30:00.000Z', replyTo: null, ...over }
}

function page (over, recordOver) {
  return renderPostPage({ origin: ORIGIN, author: HEX, seq: 7, record: post(recordOver), name: 'Ana Souza', username: 'ana', ...over })
}

function meta (html, prop, attr = 'property') {
  const m = html.match(new RegExp('<meta ' + attr + '="' + prop + '" content="([^"]*)">'))
  return m ? m[1] : null
}

function metaCount (html, prop) {
  return (html.match(new RegExp('<meta property="' + prop + '" ', 'g')) || []).length
}

// An image tag other than the blurred backdrop of a letterboxed photo.
const PHOTO_IMG = /<img (?![^>]*class="bg")/g

function anchors (html) {
  return [...html.matchAll(/<a\s[^>]*>/gi)].map((m) => m[0])
}

// The invariants every output must keep, whatever went in.
function assertSafe (t, html, label) {
  t.is(typeof html, 'string', label + ': a string')
  t.absent(/<script/i.test(html), label + ': no script')
  t.absent(html.includes('\u2014'), label + ': no em dash')
  // Attribute names of real tags only: escaped peer text may spell
  // "onerror=" as text or inside a quoted value (where `"` is escaped).
  const tags = (html.match(/<[a-z][^>]*>/gi) || []).map((tag) => tag.replace(/"[^"]*"/g, '""'))
  t.absent(tags.some((tag) => /\son[a-z]+\s*=/i.test(tag)), label + ': no inline handler')
  t.absent(/javascript:/i.test(html), label + ': no javascript: url')
  t.absent(/<video|<iframe|<object|<embed|<link\s|@import|url\(/i.test(html), label + ': no external or active resource')
  t.absent(/src="(?!\/p\/[0-9a-f]{64}\/[1-9][0-9]*\/foto\/[1-4]")/.test(html), label + ': images only from /p/ photo paths')
  t.ok(anchors(html).length === 1, label + ': exactly one anchor')
}

test('name, username, date and text with line breaks', (t) => {
  const html = page()
  assertSafe(t, html, 'plain post')
  t.ok(html.startsWith('<!doctype html>\n<html lang="pt-BR">'))
  t.ok(html.includes('<h1>Ana Souza</h1>'))
  t.ok(html.includes('<p class="meta">@ana</p>'))
  t.ok(html.includes('<p class="meta">12/11/2026</p>'))
  t.ok(html.includes('<p class="text">Bom dia, vizinhança.\nCafé pronto.</p>'))
})

test('date is told in Brasília time', (t) => {
  t.ok(page({}, { at: '2026-11-13T02:00:00.000Z' }).includes('<p class="meta">12/11/2026</p>'))
  t.ok(page({}, { at: '2026-01-01T03:00:00.000Z' }).includes('<p class="meta">01/01/2026</p>'))
  for (const at of ['ontem', '2026-13-01T00:00:00.000Z', 12345, null, '2026-11-12']) {
    const html = page({}, { at })
    t.absent(/<p class="meta">\d\d\/\d\d\/\d{4}<\/p>/.test(html), 'no date for ' + String(at))
  }
})

test('hostile text, name, username and card title are escaped', (t) => {
  const html = page({
    name: '<b onmouseover="x">Eva</b></title>',
    username: 'eva"><script>'
  }, {
    text: '</p><script src=//x></script><img onerror=1 src=x>"\'&</title>',
    replyTo: null,
    preview: { url: 'https://x.example/', host: '<i>x.example</i>', title: '"><script>alert(1)</script>&', desc: '', image: null }
  })
  assertSafe(t, html, 'hostile')
  t.absent(html.includes('<b onmouseover'))
  t.absent(html.includes('<img onerror'))
  t.absent(html.includes('<i>'))
  t.ok(html.includes('&lt;/p&gt;&lt;script src=//x&gt;&lt;/script&gt;&lt;img onerror=1 src=x&gt;&quot;&#39;&amp;&lt;/title&gt;'))
  t.ok(html.includes('<h1>&lt;b onmouseover=&quot;x&quot;&gt;Eva&lt;/b&gt;&lt;/title&gt;</h1>'))
  t.ok(html.includes('@eva&quot;&gt;&lt;script&gt;'))
  t.ok(html.includes('<span class="card-title">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;</span>'))
  t.ok(html.includes('<span class="card-host">&lt;i&gt;x.example&lt;/i&gt;</span>'))
  t.is(meta(html, 'og:title'), 'Publicação de &lt;b onmouseover=&quot;x&quot;&gt;Eva&lt;/b&gt;&lt;/title&gt; na Varanda')
  t.ok(html.includes('<title>Publicação de &lt;b onmouseover=&quot;x&quot;&gt;Eva&lt;/b&gt;&lt;/title&gt; na Varanda</title>'))
  t.is((html.match(/<\/title>/g) || []).length, 1, 'a peer string never closes the title')
  const desc = '&lt;/p&gt;&lt;script src=//x&gt;&lt;/script&gt;&lt;img onerror=1 src=x&gt;&quot;&#39;&amp;&lt;/title&gt;'
  t.is(meta(html, 'description', 'name'), desc, 'the description meta is escaped')
  t.is(meta(html, 'og:description'), desc)
  t.is(meta(html, 'og:url'), ORIGIN + BASE)
  t.is(meta(html, 'og:image'), FALLBACK_IMAGE)
  t.is(meta(html, 'og:image:alt'), 'Varanda')
  const metas = html.match(/<meta [^>]*>/g)
  t.ok(metas.every((tag) => /^<meta (name|property|charset)="[^"]*"( content="[^"<>]*")?>$/.test(tag)), 'every meta tag keeps its shape')
})

test('control and direction characters are stripped', (t) => {
  const html = page({ name: 'A‏na\u0085', username: 'a‮na' }, {
    text: 'Bi\u0000ci‮cle\u0007ta\nok⁦',
    preview: { url: 'https://x.example/', host: 'x.exa‎mple', title: 'Tí\u0001tulo', desc: '', image: null }
  })
  t.ok(html.includes('<h1>Ana</h1>'))
  t.ok(html.includes('@ana</p>'))
  t.ok(html.includes('<p class="text">Bicicleta\nok</p>'))
  t.ok(html.includes('<span class="card-title">Título</span>'))
  t.ok(html.includes('<span class="card-host">x.example</span>'))
  const bad = Array.from(html).filter((ch) => {
    const cp = ch.codePointAt(0)
    return (cp < 0x20 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f || cp === 0xfffd
  })
  t.is(bad.length, 0)
})

test('photo descriptions are aligned, escaped, cleaned and capped at 140 code points', (t) => {
  const media = [image(0), { mime: 'text/html' }, image(1), image(2), image(3)]
  const hostile = '  "\'<script>&\u202E\u0000\u0007  '
  const alt = [hostile, 'Not a photo', '🦋'.repeat(5000), null, ' \u202E\u0001 ']
  const html = page({ alt }, { media })
  assertSafe(t, html, 'photo descriptions')
  t.ok(html.includes('alt="&quot;&#39;&lt;script&gt;&amp;"'), 'quotes and markup stay inside the attribute')
  t.absent(['\u202E', '\u0000', '\u0007', '\u0001'].some((ch) => html.includes(ch)), 'direction and control characters removed')
  t.ok(html.includes('/foto/2" alt="' + '🦋'.repeat(140) + '"'), 'original media index and code point cap')
  t.absent(html.includes('🦋'.repeat(141)), 'long input is bounded')
  t.absent(html.includes('Not a photo'), 'ignored media does not shift descriptions')
  t.ok(html.includes('/foto/3" alt="Foto 3"'), 'null falls back')
  t.ok(html.includes('/foto/4" alt="Foto 4"'), 'empty cleaned text falls back')
  t.is(meta(html, 'og:image:alt'), 'Foto da publicação', 'OG remains unchanged')
  const args = { record: post({ media }), name: 'Ana' }
  t.alike(postPreviewData({ ...args, alt }), postPreviewData(args), 'preview remains unchanged')
})

test('invalid description lists render exactly like an absent list', (t) => {
  const media = [image(0), image(1)]
  const baseline = page({}, { media })
  for (const alt of [null, 'text', {}, { 0: 'one', 1: 'two', length: 2 }, ['one'], ['one', null, 'three'], ['one', 42], ['one', {}], ['one', undefined], new Array(2)]) {
    t.is(page({ alt }, { media }), baseline, 'invalid list ignored entirely')
  }
  t.ok(baseline.includes('alt="Foto 1"'))
  t.ok(baseline.includes('alt="Foto 2"'))
})

test('video descriptions prefer the video then its poster, keeping the backdrop decorative', (t) => {
  const media = [image(0), videoItem()]
  for (const [alt, expected] of [
    [['Poster', '  Vídeo <script> & "\u202E\u0001  '], 'Capa do vídeo: Vídeo &lt;script&gt; &amp; &quot;'],
    [['Poster', null], 'Capa do vídeo: Poster'],
    [['Poster', ' \u202E\u0001 '], 'Capa do vídeo: Poster'],
    [[null, null], 'Capa do vídeo'],
    [['Poster'], 'Capa do vídeo'],
    [[null, 'x'.repeat(5000)], 'Capa do vídeo: ' + 'x'.repeat(140)]
  ]) {
    const html = page({ alt }, { media })
    assertSafe(t, html, 'video description')
    t.ok(html.includes('alt="' + expected + '" loading="lazy"></span>'), 'foreground description')
    t.ok(html.includes('alt="" aria-hidden="true" loading="lazy" class="bg"'), 'backdrop stays decorative')
    t.is(meta(html, 'og:image:alt'), 'Capa do vídeo', 'OG remains unchanged')
  }
  const reordered = page({ alt: ['Vídeo', 'ignored', 'Poster'] }, { media: [videoItem(), null, image(0)] })
  t.ok(reordered.includes('alt="Capa do vídeo: Vídeo"'), 'video index comes from the original media list')
  const single = page({ alt: ['Uma foto'] }, { media: [image(0)] })
  t.ok(single.includes('alt="Uma foto"'), 'single photo uses its description too')
})

test('ten photos give four images and "Mais 6 fotos na Varanda"', (t) => {
  const media = []
  for (let i = 0; i < 10; i++) media.push(image(i))
  const html = page({}, { media })
  assertSafe(t, html, 'ten photos')
  t.is((html.match(/<img /g) || []).length, 4)
  for (let i = 1; i <= 4; i++) t.ok(html.includes('<img src="' + BASE + '/foto/' + i + '"'))
  t.absent(html.includes('/foto/5'))
  t.ok(html.includes('Mais 6 fotos na Varanda'))
  t.is(MAX_PHOTOS, 4)
})

test('four or fewer photos add no "Mais" line', (t) => {
  const html = page({}, { media: [image(0), image(1, 'image/png')] })
  t.is((html.match(/<img /g) || []).length, 2)
  t.absent(html.includes('Mais '))
  const five = page({}, { media: [image(0), image(1), image(2), image(3), image(4)] })
  t.ok(five.includes('Mais 1 foto na Varanda'), 'singular for one more')
})

test('a video shows only its cover and "Vídeo disponível na Varanda"', (t) => {
  const html = page({}, { media: [image(0), videoItem()] })
  assertSafe(t, html, 'video')
  // The decorative blurred copy behind a letterboxed cover is not a photo.
  t.is((html.match(PHOTO_IMG) || []).length, 1)
  t.ok(html.includes('<img src="' + BASE + '/foto/1"'))
  t.ok(html.includes('Vídeo disponível na Varanda'))
  t.absent(html.includes('Mais '))
  t.absent(/<video|<source/i.test(html))
  t.is(meta(html, 'og:image'), ORIGIN + BASE + '/foto/1')
})

test('postPhotos: image items in media order, never the video item', (t) => {
  const items = [image(0), image(1, 'image/webp'), { mime: 'text/html' }, 'x', null, image(2, 'image/gif')]
  const p = postPhotos(post({ media: items }))
  t.is(p.items.length, 3)
  t.is(p.items[0], items[0])
  t.is(p.items[1], items[1])
  t.is(p.items[2], items[5])
  t.is(p.more, 0)
  t.is(p.video, false)
  const v = postPhotos(post({ media: [image(0), videoItem()] }))
  t.is(v.items.length, 1)
  t.is(v.video, true)
  t.alike(postPhotos(post({ media: new Array(11).fill(image(0)) })), { items: [], more: 0, video: false }, 'more than records allow is no media')
  t.alike(postPhotos(null), { items: [], more: 0, video: false })
  t.alike(postPhotos(post({ media: 'x' })), { items: [], more: 0, video: false })
})

test('reply and quote show a label and never the other record', (t) => {
  const other = { author: 'cd'.repeat(32), seq: 3, text: 'SEGREDO DO OUTRO' }
  const reply = page({}, { replyTo: other })
  assertSafe(t, reply, 'reply')
  t.ok(reply.includes('Em resposta a outra publicação'))
  t.absent(reply.includes('Cita outra publicação'))
  t.absent(reply.includes('SEGREDO'))
  t.absent(reply.includes('cd'.repeat(32)))
  const quote = page({}, { quote: other })
  assertSafe(t, quote, 'quote')
  t.ok(quote.includes('Cita outra publicação'))
  t.absent(quote.includes('Em resposta'))
  t.absent(quote.includes('SEGREDO'))
  t.absent(quote.includes('cd'.repeat(32)))
  const plain = page()
  t.absent(plain.includes('Em resposta'))
  t.absent(plain.includes('Cita outra'))
  t.absent(page({}, { replyTo: 'cd'.repeat(32) }).includes('Em resposta'), 'a malformed replyTo is absent')
})

test('exactly one anchor, "Ver na Varanda" to the app path, then the note', (t) => {
  const html = page({}, { media: [image(0)], preview: { url: 'https://x.example/a', host: 'x.example', title: 'Um site', desc: 'd', image: image(9) } })
  const as = anchors(html)
  t.is(as.length, 1)
  t.is(as[0], '<a class="enter" href="' + APP + '">')
  t.ok(html.includes('<a class="enter" href="' + APP + '">Ver na Varanda</a></p>\n<p class="note">Para ver mais, entre ou crie sua conta. Pode ser preciso um convite.</p>'))
  t.absent(html.includes('https://x.example/a'), 'the card url is never rendered')
  // The decorative blurred copy behind a letterboxed photo is not a photo.
  t.is((html.match(PHOTO_IMG) || []).length, 1, 'the card image is never rendered')
})

test('a URL in the text stays plain text', (t) => {
  const html = page({}, { text: 'Veja https://evil.example/x?a=1&b=2 e www.site.com' })
  assertSafe(t, html, 'url text')
  t.ok(html.includes('<p class="text">Veja https://evil.example/x?a=1&amp;b=2 e www.site.com</p>'))
  t.absent(/href="https?:/i.test(html))
})

test('head: noindex meta, viewport, og:title and og:description', (t) => {
  const html = page({}, { text: 'é'.repeat(400) })
  t.ok(html.includes('<meta name="robots" content="noindex, nofollow, noarchive">'))
  t.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'))
  t.is(meta(html, 'og:title'), 'Publicação de Ana Souza na Varanda')
  t.ok(html.includes('<title>Publicação de Ana Souza na Varanda</title>'))
  t.is(Array.from(meta(html, 'og:description')).length, 200)
  const lines = page({}, { text: 'um\ndois  três' })
  t.is(meta(lines, 'og:description'), 'um dois três')
  const astral = page({}, { text: '😀'.repeat(300) })
  t.is(meta(astral, 'og:description'), '😀'.repeat(200), 'cut on a code point boundary')
  const anon = renderPostPage({ origin: ORIGIN, author: HEX, seq: 7, record: post() })
  t.is(meta(anon, 'og:title'), 'Publicação na Varanda')
  t.ok(anon.includes('<title>Publicação na Varanda</title>'))
})

test('head: the full link preview tag set for a photo post', (t) => {
  const html = page({}, { media: [image(0), image(1)] })
  t.is(meta(html, 'description', 'name'), 'Bom dia, vizinhança. Café pronto.')
  t.is(meta(html, 'og:type'), 'website')
  t.is(meta(html, 'og:site_name'), 'Varanda')
  t.is(meta(html, 'og:locale'), 'pt_BR')
  t.is(meta(html, 'og:url'), ORIGIN + BASE)
  t.is(meta(html, 'og:image'), ORIGIN + BASE + '/foto/1')
  t.is(meta(html, 'og:image:type'), 'image/jpeg')
  t.is(meta(html, 'og:image:width'), '800')
  t.is(meta(html, 'og:image:height'), '600')
  t.is(meta(html, 'og:image:alt'), 'Foto da publicação')
  t.is(meta(html, 'twitter:card', 'name'), 'summary_large_image')
  t.is(metaCount(html, 'og:image'), 1, 'exactly one og:image')
  t.is((html.match(/<img /g) || []).length, 2, 'the body images stay')
  t.absent(html.includes('<img src="/og/'), 'the body never shows the brand card')
  const video = page({}, { media: [image(0), videoItem()] })
  t.is(meta(video, 'og:image:alt'), 'Capa do vídeo')
})

test('og:image: the brand card when the post has no photo', (t) => {
  const html = page()
  assertSafe(t, html, 'text only')
  t.is(meta(html, 'og:image'), FALLBACK_IMAGE)
  t.is(meta(html, 'og:image:type'), 'image/png')
  t.is(meta(html, 'og:image:width'), '1200')
  t.is(meta(html, 'og:image:height'), '630')
  t.is(meta(html, 'og:image:alt'), 'Varanda')
  t.is(meta(html, 'og:url'), ORIGIN + BASE)
  t.is(metaCount(html, 'og:image'), 1, 'exactly one og:image')
  t.absent(/<img /.test(html), 'the body shows no image')
  t.is(meta(page({}, { text: '' }), 'og:image'), FALLBACK_IMAGE, 'an empty post too')
})

test('og:image sizes only when both are believable', (t) => {
  const sized = (width, height) => page({}, { media: [{ ...image(0), width, height }] })
  const big = sized(16384, 1)
  t.is(meta(big, 'og:image:width'), '16384')
  t.is(meta(big, 'og:image:height'), '1')
  const square = sized(4096, 4096)
  t.is(meta(square, 'og:image:width'), '4096', 'exactly the area cap keeps the size')
  t.is(meta(square, 'og:image:height'), '4096')
  for (const [w, h] of [[8192, 8192], [16384, 16384], [4097, 4096], [0, 600], [800, 16385], [800.5, 600], ['800', 600], [800, null], [-1, 600], [Number.MAX_SAFE_INTEGER + 1, 600], [800, undefined]]) {
    const html = sized(w, h)
    t.is(meta(html, 'og:image'), ORIGIN + BASE + '/foto/1', 'the photo stays for ' + w + 'x' + h)
    t.is(meta(html, 'og:image:width'), null, 'no width for ' + w + 'x' + h)
    t.is(meta(html, 'og:image:height'), null, 'no height for ' + w + 'x' + h)
    t.is(meta(html, 'og:image:alt'), 'Foto da publicação')
    assertSafe(t, html, w + 'x' + h)
  }
})

test('og:url and og:image only on an https origin', (t) => {
  t.is(meta(page({ origin: ORIGIN + '/' }, { media: [image(0)] }), 'og:image'), ORIGIN + BASE + '/foto/1')
  t.is(meta(page({ origin: ORIGIN + '/' }), 'og:url'), ORIGIN + BASE)
  for (const origin of ['http://bora.varanda.app', 'javascript:alert(1)', '//evil.example', 'https://u:p@evil.example', 'https://bora.varanda.app/x', 'https://a.example?q', 'https://a.example/"><script>', '', null, 42]) {
    for (const media of [[image(0)], undefined]) {
      const html = page({ origin }, { media })
      t.is(meta(html, 'og:image'), null, 'no og:image for ' + String(origin))
      t.is(meta(html, 'og:url'), null, 'no og:url for ' + String(origin))
      t.absent(html.includes('og:image'), 'no og:image tag of any kind for ' + String(origin))
      t.absent(html.includes('twitter:card'), 'no large card without an image for ' + String(origin))
      t.is(meta(html, 'og:site_name'), 'Varanda', 'the origin-free tags stay')
      if (media) t.ok(html.includes('<img src="' + BASE + '/foto/1"'), 'the relative image stays')
      assertSafe(t, html, String(origin))
    }
  }
})

test('an AVIF item is a photo; og:image skips AVIF and names its type', (t) => {
  const avif = image(0, 'image/avif')
  t.is(postPhotos(post({ media: [avif] })).items[0], avif, 'an AVIF item counts as a photo')
  const only = page({}, { media: [avif] })
  assertSafe(t, only, 'avif only')
  t.ok(only.includes('<img src="' + BASE + '/foto/1"'), 'the AVIF photo is shown')
  t.is(meta(only, 'og:image'), FALLBACK_IMAGE, 'the brand card when every photo is AVIF')
  t.is(meta(only, 'og:image:type'), 'image/png')
  t.is(meta(only, 'og:image:width'), '1200')
  t.is(meta(only, 'og:image:height'), '630')
  t.is(metaCount(only, 'og:image'), 1)
  const mixed = page({}, { media: [avif, image(1, 'image/webp'), image(2)] })
  assertSafe(t, mixed, 'avif first')
  t.is((mixed.match(/<img /g) || []).length, 3)
  t.is(meta(mixed, 'og:image'), ORIGIN + BASE + '/foto/2', 'the first photo that is not AVIF')
  t.is(meta(mixed, 'og:image:type'), 'image/webp')
  t.is(meta(mixed, 'og:image:width'), '800')
  t.is(meta(mixed, 'og:image:height'), '600')
  t.is(metaCount(mixed, 'og:image'), 1)
  t.is(meta(page({}, { media: [image(0), avif] }), 'og:image:type'), 'image/jpeg', 'the type of a JPEG first photo')
  t.is(meta(page({ origin: 'http://bora.varanda.app' }, { media: [image(0)] }), 'og:image:type'), null, 'no type without og:image')
  t.is(postPreviewData({ record: post({ media: [avif, image(1)] }) }).photoCount, 2, 'the preview counts the AVIF photo')
})

test('og:image: automatic covers follow device covers and leave the body and preview intact', (t) => {
  for (const mime of ['image/avif', 'image/jpeg']) {
    const first = { ...image(0, mime), bytes: 300000, width: 2048, height: 1536 }
    const record = { media: [first, image(1)] }
    const autoCover = { width: first.width, height: first.height }
    const html = page({ autoCover }, record)
    const size = coverSize(first.width, first.height)
    t.is(meta(html, 'og:image'), ORIGIN + BASE + '/capa', mime)
    t.is(meta(html, 'og:image:type'), 'image/jpeg')
    t.is(meta(html, 'og:image:width'), String(size.width))
    t.is(meta(html, 'og:image:height'), String(size.height))
    t.is(metaCount(html, 'og:image'), 1)
    t.is(html.slice(html.indexOf('<body>')), page({}, record).slice(page({}, record).indexOf('<body>')), 'same body')
    const device = page({ autoCover, cover: { width: 120, height: 80 } }, record)
    t.is(meta(device, 'og:image:width'), '120', 'device width wins')
    t.is(meta(device, 'og:image:height'), '80', 'device height wins')
    t.is(metaCount(device, 'og:image'), 1)
    t.alike(postPreviewData({ record: post(record), autoCover }), postPreviewData({ record: post(record) }), 'same JSON twin')
    assertSafe(t, html, mime)
  }
  t.is(renderPostPage({ autoCover: { width: 2048, height: 1536 } }), renderPostPage({}), 'same fallback page')
})

test('without autoCover the pre-transcoder HTML stays byte identical', (t) => {
  // Re-pinned when a lone photo moved into its snapped frame (new markup and
  // style); still the page with no autoCover, so autoCover must not change it.
  const before = {
    'image/avif': 'beab9add62b4c3ad36f3e29ce3efbda51f1590f50f4b9599571b3a1243d38448',
    'image/jpeg': '668edec62541c0f2e9ba5f0f45578500d92491ced0a5a4bce48c6f02bda8e7f4'
  }
  for (const [mime, hash] of Object.entries(before)) {
    t.is(createHash('sha256').update(page({}, { media: [image(0, mime)] })).digest('hex'), hash, mime)
  }
})

test('og:image: the share cover comes first, as /capa with image/jpeg and its sizes', (t) => {
  const avif = image(0, 'image/avif')
  const cover = { width: 1200, height: 900 }
  const withCover = page({ cover }, { media: [avif] })
  const without = page({}, { media: [avif] })
  assertSafe(t, withCover, 'avif with cover')
  t.is(meta(withCover, 'og:image'), ORIGIN + BASE + '/capa', 'the cover route')
  t.is(meta(withCover, 'og:image:type'), 'image/jpeg')
  t.is(meta(withCover, 'og:image:width'), '1200')
  t.is(meta(withCover, 'og:image:height'), '900')
  t.is(meta(withCover, 'og:image:alt'), 'Foto da publicação')
  t.is(metaCount(withCover, 'og:image'), 1, 'exactly one og:image')
  t.is(meta(without, 'og:image'), FALLBACK_IMAGE, 'without the cover, the brand card as before')
  const body = (html) => html.slice(html.indexOf('<body>'))
  t.is(body(withCover), body(without), 'the body does not change')
  t.absent(withCover.includes('src="' + BASE + '/capa"'), 'the body never shows the cover')

  t.is(meta(page({ cover }, { media: [image(0)] }), 'og:image'), ORIGIN + BASE + '/capa', 'ahead of a JPEG photo too')
  t.is(meta(page({ cover }, { text: 'só texto' }), 'og:image'), ORIGIN + BASE + '/capa', 'and ahead of the brand card')
  t.is(meta(page({ cover }, { media: [image(0), videoItem()] }), 'og:image:alt'), 'Capa do vídeo')
  t.is(meta(page({ cover, origin: 'http://bora.varanda.app' }, { media: [avif] }), 'og:image'), null, 'no og:image without an https origin')

  // A cover the page cannot name with believable sizes is left out, and the
  // order before the cover applies.
  for (const bad of [null, 'capa', [], { width: 0, height: 900 }, { width: 1200 }, { width: 1.5, height: 900 }, { width: 16385, height: 1 }, { width: 8192, height: 4096 }]) {
    const html = page({ cover: bad }, { media: [image(0)] })
    t.is(meta(html, 'og:image'), ORIGIN + BASE + '/foto/1', 'the first photo for cover ' + JSON.stringify(bad))
    t.is(meta(html, 'og:image:width'), '800')
  }
  t.alike(postPreviewData({ record: post({ media: [avif] }), cover }), postPreviewData({ record: post({ media: [avif] }) }), 'the preview ignores the cover')
})

test('bad author or seq gives the fallback page pointing at /', (t) => {
  const cases = [
    { author: HEX.toUpperCase(), seq: 7 },
    { author: 'ab', seq: 7 },
    { author: HEX + '"><script>', seq: 7 },
    { author: HEX, seq: 0 },
    { author: HEX, seq: -1 },
    { author: HEX, seq: 1.5 },
    { author: HEX, seq: '7' },
    { author: HEX, seq: Number.MAX_SAFE_INTEGER + 1 },
    { author: null, seq: 7 }
  ]
  for (const c of cases) {
    const html = renderPostPage({ origin: ORIGIN, record: post(), name: 'Ana', username: 'ana', ...c })
    assertSafe(t, html, JSON.stringify(c))
    t.is(anchors(html)[0], '<a class="enter" href="/">')
    t.ok(html.includes('noindex, nofollow, noarchive'))
    t.absent(html.includes('Ana'), 'no post data')
    t.absent(html.includes('/p/'))
    t.absent(html.includes('og:'))
  }
  t.ok(renderPostPage().includes('href="/"'))
  t.ok(renderPostPage(null).includes('href="/"'))
})

test('malformed record fields do not throw and render as absent', (t) => {
  const huge = 'x'.repeat(5 * 1024 * 1024)
  const records = [
    null,
    'post',
    42,
    [],
    { text: 42, at: {}, replyTo: 7, quote: 'x', media: { length: 3 }, preview: 'card' },
    { text: huge, media: [huge, { mime: huge }], preview: { title: huge, host: huge } },
    { text: ['a'], media: [null, undefined, 1], preview: { title: 1, host: {} } },
    { media: new Array(1e6) },
    { get text () { throw new Error('boom') } },
    Object.create(null)
  ]
  for (const record of records) {
    const html = renderPostPage({ origin: ORIGIN, author: HEX, seq: 7, record, name: huge, username: { x: 1 } })
    assertSafe(t, html, 'record ' + Object.prototype.toString.call(record))
    t.ok(html.length < 64 * 1024, 'bounded size')
  }
  const trap = { get author () { throw new Error('boom') } }
  t.ok(renderPostPage(trap).includes('href="/"'))
})

const PREVIEW_KEYS = ['v', 'name', 'username', 'date', 'text', 'photoCount', 'morePhotos', 'video', 'relation', 'card']

function preview (over, recordOver) {
  return postPreviewData({ record: post(recordOver), name: 'Ana Souza', username: 'ana', ...over })
}

function escHtml (value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Nothing in a preview may be a link, a key, a timestamp or a descriptor.
function assertPreviewSafe (t, data, label) {
  const json = JSON.stringify(data)
  t.absent(/https?:|www\.|\/p\/|\/foto\/|\/publicacao\//i.test(json), label + ': no URL')
  t.absent(/\d{4}-\d{2}-\d{2}T/.test(json), label + ': no ISO timestamp')
  t.absent(/"(core|mime|start|blocks|bytes|sha256|width|height|ms|url|image|desc|at|seq|shareSeq|author|key|replyTo|quote|preview|media)":/.test(json), label + ': no descriptor or record field')
  t.absent(json.includes('\ufffd') || json.includes('\uFFFD'), label + ': no U+FFFD')
  t.absent(json.includes('\u2014'), label + ': no em dash')
}

test('postPreviewData: exactly the listed fields of a plain post', (t) => {
  const data = preview()
  t.alike(Object.keys(data), PREVIEW_KEYS)
  t.alike(data, {
    v: 1,
    name: 'Ana Souza',
    username: 'ana',
    date: '12/11/2026',
    text: 'Bom dia, vizinhança.\nCafé pronto.',
    photoCount: 0,
    morePhotos: 0,
    video: false,
    relation: null,
    card: null
  })
  assertPreviewSafe(t, data, 'plain')
  t.is(preview({ name: '  ', username: '' }).name, null, 'a blank name is null')
  t.is(preview({ name: undefined, username: 7 }).username, null, 'a non-string username is null')
  t.is(preview({}, { at: '2026-11-13T02:00:00.000Z' }).date, '12/11/2026', 'the date in Brasília time')
  t.is(preview({}, { at: 'ontem' }).date, '')
  t.is(preview({}, { text: 42 }).text, '')
})

test('postPreviewData: photos are only counted, as the page shows them', (t) => {
  const ten = []
  for (let i = 0; i < 10; i++) ten.push(image(i))
  const many = preview({}, { media: ten })
  t.is(many.photoCount, 4)
  t.is(many.morePhotos, 6)
  t.is(many.video, false)
  const video = preview({}, { media: [image(0), videoItem()] })
  t.is(video.photoCount, 1, 'a video post shows only its cover')
  t.is(video.morePhotos, 0)
  t.is(video.video, true)
  const onlyVideo = preview({}, { media: [videoItem()] })
  t.is(onlyVideo.photoCount, 0)
  t.is(onlyVideo.video, true)
  t.is(preview({}, { media: new Array(11).fill(image(0)) }).photoCount, 0, 'more than records allow is no media')
  for (const d of [many, video, onlyVideo]) assertPreviewSafe(t, d, 'photos')
})

test('postPreviewData: relation by the page precedence, card by the page rule', (t) => {
  const other = { author: 'cd'.repeat(32), seq: 3, text: 'SEGREDO DO OUTRO' }
  t.is(preview({}, { replyTo: other }).relation, 'reply')
  t.is(preview({}, { quote: other }).relation, 'quote')
  t.is(preview({}, { quote: other, replyTo: other }).relation, 'quote', 'quote wins, as on the page')
  t.is(preview({}, { replyTo: 'cd'.repeat(32) }).relation, null, 'a malformed replyTo is absent')
  const quoted = preview({}, { quote: other })
  t.absent(JSON.stringify(quoted).includes('SEGREDO'))
  t.absent(JSON.stringify(quoted).includes('cd'.repeat(32)))
  const card = preview({}, { preview: { url: 'https://x.example/a', host: 'x.example', title: 'Um site', desc: 'd', image: image(9) } })
  t.alike(card.card, { title: 'Um site', host: 'x.example' })
  assertPreviewSafe(t, card, 'card')
  t.alike(preview({}, { preview: { title: '', host: 'x.example' } }).card, { title: '', host: 'x.example' })
  t.is(preview({}, { preview: { title: ' ', host: '' } }).card, null, 'an empty card is absent')
  t.is(preview({}, { preview: 'card' }).card, null)
})

test('postPreviewData: every projected string is on the page, escaped, and the date is the page date', (t) => {
  const inputs = [
    [{}, {}],
    [{ name: '<b onmouseover="x">Eva</b></title>', username: 'eva"><script>' }, {
      text: '</p><script src=//x></script><img onerror=1 src=x>"\'&</title>',
      preview: { url: 'https://x.example/', host: '<i>x.example</i>', title: '"><script>alert(1)</script>&', desc: '', image: null }
    }],
    [{ name: 'A\u200fna\u0085', username: 'a\u202ena' }, {
      text: 'Bi\u0000ci\u202ecle\u0007ta\nok\u2066',
      preview: { url: 'https://x.example/', host: 'x.exa\u200emple', title: 'T\u00ed\u0001tulo', desc: '', image: null }
    }],
    [{ name: '', username: 'so_nome' }, { text: '\u00e9'.repeat(1500), media: [image(0), image(1), image(2), image(3), image(4)] }],
    [{ name: 'x'.repeat(500), username: 'y'.repeat(500) }, { media: [image(0), videoItem()], preview: { title: 'z'.repeat(900), host: '' } }],
    [{}, { at: '2026-01-01T03:00:00.000Z', quote: { author: 'cd'.repeat(32), seq: 1 } }]
  ]
  for (const [over, recordOver] of inputs) {
    const html = page(over, recordOver)
    const data = preview(over, recordOver)
    const label = JSON.stringify(over).slice(0, 40)
    assertPreviewSafe(t, data, label)
    if (data.name !== null) t.ok(html.includes('<h1>' + escHtml(data.name) + '</h1>'), label + ': name')
    if (data.username !== null) t.ok(html.includes('@' + escHtml(data.username) + '<'), label + ': username')
    if (data.name === null && data.username === null) t.ok(html.includes('<h1>Publicação na Varanda</h1>'))
    if (data.text !== '') t.ok(html.includes('<p class="text">' + escHtml(data.text) + '</p>'), label + ': text')
    else t.absent(html.includes('<p class="text">'))
    const pageDate = (html.match(/<p class="meta">(\d\d\/\d\d\/\d{4})<\/p>/) || [null, ''])[1]
    t.is(data.date, pageDate, label + ': the page date')
    // The decorative blurred copy behind a letterboxed photo is not a photo.
    t.is((html.match(PHOTO_IMG) || []).length, data.photoCount, label + ': photo count')
    t.is(html.includes('Vídeo disponível na Varanda'), data.video, label + ': video')
    if (data.morePhotos > 0) t.ok(html.includes('Mais ' + data.morePhotos + ' foto'), label + ': more photos')
    else t.absent(html.includes('Mais '))
    t.is(html.includes('Cita outra publicação'), data.relation === 'quote')
    t.is(html.includes('Em resposta a outra publicação'), data.relation === 'reply')
    if (data.card !== null) {
      if (data.card.title !== '') t.ok(html.includes('<span class="card-title">' + escHtml(data.card.title) + '</span>'), label + ': card title')
      if (data.card.host !== '') t.ok(html.includes('<span class="card-host">' + escHtml(data.card.host) + '</span>'), label + ': card host')
    } else {
      t.absent(html.includes('<p class="card">'))
    }
  }
})

test('postPreviewData: hostile input never throws and stays bounded', (t) => {
  const huge = 'x'.repeat(5 * 1024 * 1024)
  const records = [
    null,
    'post',
    42,
    [],
    { text: 42, at: {}, replyTo: 7, quote: 'x', media: { length: 3 }, preview: 'card' },
    { text: huge, media: [huge, { mime: huge }], preview: { title: huge, host: huge } },
    { text: ['a'], media: [null, undefined, 1], preview: { title: 1, host: {} } },
    { media: new Array(1e6) },
    { text: '\ud800\udc00\ud800 ok \ufffd', at: '2026-11-12T15:30:00.000Z' },
    Object.create(null)
  ]
  for (const record of records) {
    const data = postPreviewData({ record, name: huge, username: { x: 1 } })
    t.alike(Object.keys(data), PREVIEW_KEYS, 'record ' + Object.prototype.toString.call(record))
    assertPreviewSafe(t, data, 'record ' + Object.prototype.toString.call(record))
    t.ok(Buffer.byteLength(JSON.stringify(data)) < 16 * 1024, 'bounded size')
    t.is(Array.from(data.name).length <= 80, true)
  }
  t.is(postPreviewData({ record: { get text () { throw new Error('boom') } } }), null, 'a throwing record is null')
  t.is(postPreviewData({ get record () { throw new Error('boom') } }), null, 'throwing args are null')
  for (const args of [undefined, null, 'x', 7, [], [{ record: post() }]]) {
    t.is(postPreviewData(args), null, 'no args object: ' + String(args))
  }
})

const SVG_CHILDREN = ['svg', 'path', 'circle', 'polyline', 'polygon', 'line']

// What the row drawing may contain, read tag by tag: escaped peer text can
// spell any of these words as text, never as a tag or an attribute.
function assertInert (t, html, label) {
  const tags = (html.match(/<\/?[a-z][^>]*>/gi) || []).map((raw) => ({
    raw,
    bare: raw.replace(/"[^"]*"/g, '""'),
    name: raw.match(/^<\/?([a-z][a-z0-9]*)/i)[1].toLowerCase(),
    closing: raw.startsWith('</')
  }))
  const banned = ['use', 'image', 'foreignobject', 'form', 'button', 'input']
  t.absent(tags.some((tag) => banned.includes(tag.name)), label + ': no use, image, foreignObject, form, button or input')
  t.absent(tags.some((tag) => /\sstyle\s*=/i.test(tag.bare)), label + ': no style attribute')
  t.absent(tags.some((tag) => /\sxlink:/i.test(tag.bare)), label + ': no xlink attribute')
  const hrefs = tags.filter((tag) => /\shref\s*=/i.test(tag.bare))
  t.is(hrefs.length, 1, label + ': one href')
  t.ok(hrefs.length === 1 && hrefs[0].name === 'a', label + ': the href is on the anchor')
  t.is((html.match(/<\/title>/g) || []).length, 1, label + ': one </title>')
  const svgs = tags.filter((tag) => tag.name === 'svg' && !tag.closing)
  t.ok(svgs.every((tag) => tag.raw.includes(' aria-hidden="true"')), label + ': every svg aria-hidden')
  let depth = 0
  let stray = false
  for (const tag of tags) {
    if (tag.name === 'svg') depth += tag.closing ? -1 : 1
    else if (depth > 0 && !SVG_CHILDREN.includes(tag.name)) stray = true
  }
  t.is(depth, 0, label + ': every svg closes')
  t.absent(stray, label + ': only drawing elements inside an svg')
}

function between (html, from, to) {
  const start = html.indexOf(from)
  const end = html.indexOf(to, start)
  return start >= 0 && end > start ? html.slice(start, end) : null
}

function avatarOf (html) {
  const m = html.match(/<div class="avatar (a[0-4])" aria-hidden="true">([\s\S]*?)<\/div>/)
  return m ? { stripe: m[1], inner: m[2] } : { stripe: null, inner: '' }
}

test('the page is one timeline row: bar, row, button and note, then two dimmed rows', (t) => {
  const media = [image(0), image(1), image(2), image(3), image(4)]
  const html = page({}, { replyTo: { author: 'cd'.repeat(32), seq: 3 }, media, preview: { url: 'https://x.example/', host: 'x.example', title: 'Um site', desc: '', image: null } })
  assertSafe(t, html, 'full row')
  const order = [
    '<meta name="color-scheme" content="light dark">',
    '<header class="bar">',
    '<main>',
    '<article class="row">',
    '<div class="avatar a1" aria-hidden="true">AS</div>',
    '<div class="body">',
    '<div class="head">',
    '<h1>Ana Souza</h1>',
    '<p class="meta">@ana</p>',
    '<span class="dot" aria-hidden="true">',
    '<p class="meta">12/11/2026</p>',
    '</div>',
    '<span class="more" aria-hidden="true">',
    '<p class="label">Em resposta a outra publicação</p>',
    '<p class="text">',
    '<div class="photos n4">',
    '<p class="label">Mais 1 foto na Varanda</p>',
    '<p class="card">',
    '<span class="card-title">Um site</span>',
    '<span class="card-host">x.example</span>',
    '<div class="actions" aria-hidden="true">',
    '</article>',
    '<div class="join">',
    '<a class="enter" href="' + APP + '">Ver na Varanda</a>',
    '<p class="note">',
    '<div class="sk" aria-hidden="true">',
    '</main>'
  ]
  let at = -1
  for (const piece of order) {
    const next = html.indexOf(piece, at + 1)
    t.ok(next > at, 'in order: ' + piece)
    if (next > at) at = next
  }
  t.is((html.match(/<div class="sk" aria-hidden="true">/g) || []).length, 2, 'two dimmed rows')
  t.is((html.match(/<article/g) || []).length, 1, 'one post')
  t.absent(html.includes('class="kicker"'), 'the bar replaces the kicker')
  const card = between(html, '<p class="card">', '</p>')
  t.ok(card !== null && card.indexOf('<svg') < card.indexOf('<span class="card-host">'), 'the link icon comes before the host')
  const actions = between(html, '<div class="actions" aria-hidden="true">', '</div>')
  t.is(((actions || '').match(/<svg/g) || []).length, 3, 'reply, repost and like')
})

test('initials come from the name, else the username, else the person glyph', (t) => {
  const cases = [
    [{ name: 'Ana Maria Souza' }, 'AS', 'multi-word'],
    [{ name: 'Ana' }, 'AN', 'single word'],
    [{ name: 'Zé' }, 'ZÉ', 'single short word'],
    [{ name: 'érica lima' }, 'ÉL', 'accent'],
    [{ name: '😀 Lua' }, '😀L', 'astral'],
    [{ name: '𝒜b' }, '𝒜B', 'astral single word'],
    [{ name: '@ana souza' }, 'AS', 'a leading @'],
    [{ name: '@@ \uff20\ufe6b bia' }, 'BI', 'a leading run of at-signs and spaces'],
    [{ name: 'ana@casa' }, 'AN', 'an inner @ stays'],
    [{ name: '', username: 'joao' }, 'JO', 'username fallback'],
    [{ name: '@ ', username: 'joao' }, 'JO', 'a name of only at-signs falls back'],
    [{ name: 'A\u200fna\u0085 S\u0000ouza' }, 'AS', 'control characters dropped'],
    [{ name: '\u202e\u0007Bia' }, 'BI', 'control characters never lead'],
    [{ name: '<b onmouseover="x">Eva</b></title>' }, '&lt;O', 'hostile name'],
    [{ name: '\u200b@ana' }, 'AN', 'a leading zero-width space before the @'],
    [{ name: '\u200b\u200b', username: 'bia' }, 'BI', 'an invisible name falls back'],
    [{ name: '\u3164', username: 'bia' }, 'BI', 'a Hangul filler name falls back'],
    [{ name: '\u00adAna Souza' }, 'AS', 'a leading soft hyphen'],
    [{ name: 'Ana \u200bSouza' }, 'AS', 'an invisible at the start of the last word']
  ]
  for (const [over, want, label] of cases) {
    const html = page({ username: 'ana', ...over })
    const avatar = avatarOf(html)
    t.ok(avatar.stripe !== null, label + ': an avatar')
    t.is(avatar.inner, want, label)
    assertSafe(t, html, label)
  }
  for (const over of [{ name: '', username: '' }, { name: '@@', username: '' }, { name: undefined, username: 7 }]) {
    const avatar = avatarOf(page(over))
    t.ok(avatar.inner.startsWith('<svg') && avatar.inner.includes('<circle cx="12" cy="7" r="4"/>'), 'glyph for ' + JSON.stringify(over))
  }
  const odd = Array.from(avatarOf(page({ name: 'A\u0001\u0085\u200e\u2066 B' })).inner)
  t.absent(odd.some((ch) => { const cp = ch.codePointAt(0); return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e }), 'no control character in the initials')
})

test('the avatar stripe follows the first key byte mod 5', (t) => {
  const want = { '00': 'a0', '01': 'a1', '04': 'a4', ab: 'a1', ff: 'a0' }
  for (const [prefix, stripe] of Object.entries(want)) {
    const html = renderPostPage({ origin: ORIGIN, author: prefix + 'ab'.repeat(31), seq: 7, record: post(), name: 'Ana Souza', username: 'ana' })
    t.is(avatarOf(html).stripe, stripe, prefix)
    for (let i = 0; i < 5; i++) t.ok(html.includes('.a' + i + '{'), prefix + ': stripe a' + i + ' styled')
  }
})

test('drawings stay inert on every kind of page, with no counts', (t) => {
  const ten = []
  for (let i = 0; i < 10; i++) ten.push(image(i))
  const pages = {
    plain: page(),
    hostile: page({ name: '<svg onload=1><use href="#x"/></svg>', username: 'eva"><style>' }, {
      text: '<svg><image href="data:x"/><foreignObject><form><button>1</button></form></foreignObject></svg> style="x" xlink:href="y"',
      preview: { url: 'https://x.example/', host: '<title>x</title>', title: '<input value=1>', desc: '', image: null }
    }),
    'four photos': page({}, { media: [image(0), image(1), image(2), image(3)] }),
    'ten photos': page({}, { media: ten }),
    video: page({}, { media: [image(0), videoItem()] }),
    fallback: renderPostPage({ origin: ORIGIN, author: 'x', seq: 7, record: post() })
  }
  for (const [label, html] of Object.entries(pages)) {
    assertSafe(t, html, label)
    assertInert(t, html, label)
    if (label === 'fallback') continue
    const actions = between(html, '<div class="actions" aria-hidden="true">', '</div>')
    t.ok(actions !== null, label + ': actions')
    t.absent(/\d/.test((actions || '').replace(/<[^>]*>/g, '')), label + ': no count in the actions')
    const dimmed = between(html, '<div class="sk" aria-hidden="true">', '</main>')
    t.ok(dimmed !== null, label + ': dimmed rows')
    t.absent(/\d/.test((dimmed || '').replace(/<[^>]*>/g, '')), label + ': no text in the dimmed rows')
    t.absent(/<(?!\/?div[\s>])[a-z/]/i.test(dimmed || ''), label + ': dimmed rows are only divs')
  }
})

test('one style block for every page, light and dark', (t) => {
  const styleOf = (html) => (html.match(/<style>([\s\S]*?)<\/style>/) || [null, null])[1]
  const plain = styleOf(page())
  const hostile = styleOf(page({ name: '</style><b>', username: 'x' }, { text: '</style>' }))
  const fallback = styleOf(renderPostPage(null))
  t.ok(plain !== null && plain.length > 0)
  t.is(hostile, plain, 'hostile page: same style')
  t.is(fallback, plain, 'fallback: same style')
  t.is((page().match(/<style>/g) || []).length, 1, 'one style block')
  t.ok(renderPostPage(null).includes('<meta name="color-scheme" content="light dark">'))
  t.ok(page().includes('<meta name="color-scheme" content="light dark">'))
  t.is((plain.match(/prefers-color-scheme/g) || []).length, 1, 'one dark block')
  t.ok(plain.includes('@media (prefers-color-scheme: dark)'))
  t.ok(plain.includes('scroll-padding-top'), 'the focused button never hides under the bar')
  t.ok(renderPostPage(null).includes('<header class="bar">'), 'the fallback shares the bar')
  t.absent(renderPostPage(null).includes('class="sk"'), 'the fallback has no dimmed rows')
})

test('dot, play disc and photo grid class follow the content', (t) => {
  t.ok(page().includes('<span class="dot" aria-hidden="true">'), 'dot with a date')
  t.absent(page({}, { at: 'ontem' }).includes('class="dot"'), 'no dot without a date')
  t.ok(page({ name: '', username: 'ana' }).includes('<span class="dot" aria-hidden="true">'), 'dot with a date and no handle line')
  const video = page({}, { media: [image(0), videoItem()] })
  t.is((video.match(/<span class="play" aria-hidden="true">/g) || []).length, 1, 'one play disc on a video cover')
  const grid = between(video, '<div class="photos n1">', '</div>')
  t.ok(grid !== null && grid.indexOf('<img ') < grid.indexOf('<span class="play"'), 'the disc sits over the cover')
  t.absent(page({}, { media: [image(0)] }).includes('class="play"'), 'no play disc on a photo')
  for (let n = 1; n <= 4; n++) {
    const media = []
    for (let i = 0; i < n; i++) media.push(image(i))
    t.ok(page({}, { media }).includes('<div class="photos n' + n + '">'), n + ' photos')
  }
  const ten = []
  for (let i = 0; i < 10; i++) ten.push(image(i))
  t.ok(page({}, { media: ten }).includes('<div class="photos n4">'), 'ten photos show four')
  t.absent(page().includes('class="photos'), 'no grid without photos')
})

test('one photo sits in the frame nearest its shape', (t) => {
  const sized = (width, height) => ({ ...image(0), width, height })
  const grid = (html) => between(html, '<div class="photos n1">', '</div>')
  const cover = (cls) => '<div class="photos n1">\n<img src="' + BASE + '/foto/1" alt="Foto 1" loading="lazy" class="' + cls + '">\n</div>'
  const fit = (cls, alt = 'Foto 1') => '<span class="fit ' + cls + '"><img src="' + BASE + '/foto/1" alt="" aria-hidden="true" loading="lazy" class="bg">' +
    '<img src="' + BASE + '/foto/1" alt="' + alt + '" loading="lazy"></span>\n'
  const covers = [[600, 800, 'f45', '3:4'], [1000, 1000, 'f11', '1:1'], [1920, 1080, 'f169', '16:9'], [1500, 1000, 'f169', '3:2 is close enough to 16:9']]
  for (const [w, h, cls, label] of covers) {
    const html = page({}, { media: [sized(w, h)] })
    assertSafe(t, html, label)
    assertInert(t, html, label)
    t.ok(html.includes(cover(cls)), label + ': one cropped img in ' + cls)
    t.is((html.match(/<img /g) || []).length, 1, label + ': one img')
    t.absent(html.includes('class="fit'), label + ': no letterbox')
  }
  const fits = [[800, 600, 'f11', '4:3'], [1080, 1920, 'f45', '9:16']]
  for (const [w, h, cls, label] of fits) {
    const html = page({}, { media: [sized(w, h)] })
    assertSafe(t, html, label)
    assertInert(t, html, label)
    t.ok(html.includes('<div class="photos n1">\n' + fit(cls) + '</div>'), label + ': letterboxed in ' + cls + ' over a blurred copy')
    t.is((html.match(/<img /g) || []).length, 2, label + ': photo and backdrop')
    t.is((html.match(PHOTO_IMG) || []).length, 1, label + ': one photo')
  }
  const hostile = [
    [0, 600], [800, 0], [-1, 600], [800, -1], [1e9, 600], [800, 1e9], [16385, 1000], ['800', '600'], [NaN, 600], [800, NaN],
    [Infinity, 1], [1.5, 1], [undefined, undefined], [null, null], [{ valueOf: () => 600 }, 800], ['<b>', '" onload="x']
  ]
  for (const [w, h] of hostile) {
    const html = page({}, { media: [sized(w, h)] })
    const label = 'size ' + String(w) + 'x' + String(h)
    assertSafe(t, html, label)
    assertInert(t, html, label)
    t.ok(html.includes(cover('f11')), label + ': cropped square')
  }
  const missing = { ...image(0) }
  delete missing.width
  delete missing.height
  t.ok(page({}, { media: [missing] }).includes(cover('f11')), 'missing sizes: cropped square')
  t.ok(page({}, { media: [sized(16384, 16384)] }).includes(cover('f11')), 'the largest believable side counts')
  const throwing = { ...image(0) }
  Object.defineProperty(throwing, 'width', { enumerable: true, get () { throw new Error('boom') } })
  // Without an origin there is no og:image, so only the frame reads the size.
  t.ok(page({ origin: '' }, { media: [throwing] }).includes(cover('f11')), 'a throwing size: cropped square')

  const tall = { ...image(0), width: 720, height: 1280 }
  const video = page({}, { media: [tall, videoItem()] })
  assertSafe(t, video, 'video cover')
  assertInert(t, video, 'video cover')
  t.ok((grid(video) || '').startsWith('<div class="photos n1">\n' + fit('f45', 'Capa do vídeo') + '<span class="play" aria-hidden="true">'), 'the poster frame, then one play disc')
  t.is((video.match(/<span class="play" aria-hidden="true">/g) || []).length, 1, 'one play disc')
  const squareVideo = page({}, { media: [sized(1000, 1000), videoItem()] })
  t.ok(squareVideo.includes('<img src="' + BASE + '/foto/1" alt="Capa do vídeo" loading="lazy" class="f11">\n<span class="play"'), 'a cropped cover keeps the disc after it')

  for (let n = 2; n <= 4; n++) {
    const media = []
    for (let i = 0; i < n; i++) media.push(sized(600 + i * 700, 800))
    const html = page({}, { media })
    const photos = between(html, '<div class="photos n' + n + '">', '</div>')
    t.ok(photos !== null, n + ' photos: grid')
    t.absent(/class="(f45|f11|f169|fit|bg)/.test(photos || 'x'), n + ' photos: no frame class')
    t.absent((photos || '').includes('<span'), n + ' photos: no letterbox')
    t.is(((photos || '').match(/<img /g) || []).length, n, n + ' photos: one img each')
  }

  const style = (page().match(/<style>([\s\S]*?)<\/style>/) || [null, ''])[1]
  t.ok(style.includes('.photos .f45{aspect-ratio:4/5}'), 'the 4:5 frame')
  t.ok(style.includes('.photos .f11{aspect-ratio:1}'), 'the square frame')
  t.ok(style.includes('.photos .f169{aspect-ratio:16/9}'), 'the 16:9 frame')
  t.ok(style.includes('.photos .fit{') && style.includes('.photos .fit .bg{'), 'the letterbox and its backdrop')
  t.absent(style.includes('.photos.n1 img{aspect-ratio:4/3}'), 'no fixed 4:3 lone photo')
})

test('the blurred backdrop is always inert and decorative', (t) => {
  const pages = [
    page({}, { media: [image(0)] }),
    page({}, { media: [{ ...image(0), width: 1080, height: 1920 }] }),
    page({}, { media: [image(0), videoItem()] }),
    page({}, { media: [{ ...image(0), width: 3000, height: 1000 }] })
  ]
  let seen = 0
  for (const html of pages) {
    for (const tag of html.match(/<img [^>]*class="bg"[^>]*>/g) || []) {
      seen++
      t.ok(tag.includes(' alt=""') && tag.includes(' aria-hidden="true"'), 'backdrop: empty alt and aria-hidden')
    }
  }
  t.ok(seen >= 3, 'backdrops were rendered: ' + seen)
})

test('the worst capped input stays under the 64 KiB frame', (t) => {
  const ten = []
  for (let i = 0; i < 10; i++) ten.push(image(i))
  const q = '"'.repeat(5000)
  const html = renderPostPage({
    origin: ORIGIN,
    author: HEX,
    seq: Number.MAX_SAFE_INTEGER,
    record: post({ text: q, media: ten, quote: { author: HEX, seq: 1 }, replyTo: { author: HEX, seq: 2 }, preview: { url: 'https://x.example/', host: q, title: q, desc: q, image: null } }),
    name: q,
    username: q
  })
  assertSafe(t, html, 'worst case')
  t.ok(html.includes('<p class="text">' + '&quot;'.repeat(1000) + '</p>'), 'the text is at its cap')
  t.ok(Buffer.byteLength(html) < 65536, 'under 65536 bytes: ' + Buffer.byteLength(html))
})
