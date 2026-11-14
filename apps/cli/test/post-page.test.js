'use strict'

// apps/cli/lib/post-page.js: the public page of one shared diary post. Pure,
// no network.

const test = require('brittle')
const { renderPostPage, postPreviewData, postPhotos, MAX_PHOTOS } = require('../lib/post-page')

const HEX = 'ab'.repeat(32)
const ORIGIN = 'https://bora.varanda.app'
const BASE = '/p/' + HEX + '/7'
const APP = '/publicacao/' + HEX + '/7'

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

function meta (html, prop) {
  const m = html.match(new RegExp('<meta property="' + prop + '" content="([^"]*)">'))
  return m ? m[1] : null
}

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
  t.is((html.match(/<img /g) || []).length, 1)
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
  t.is((html.match(/<img /g) || []).length, 1, 'the card image is never rendered')
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

test('og:image: absent without photos, absolute with one, only on an https origin', (t) => {
  t.is(meta(page(), 'og:image'), null)
  t.is(meta(page({}, { media: [image(0)] }), 'og:image'), ORIGIN + BASE + '/foto/1')
  t.is(meta(page({ origin: ORIGIN + '/' }, { media: [image(0)] }), 'og:image'), ORIGIN + BASE + '/foto/1')
  for (const origin of ['http://bora.varanda.app', 'javascript:alert(1)', '//evil.example', 'https://u:p@evil.example', 'https://bora.varanda.app/x', 'https://a.example?q', '', null, 42]) {
    const html = page({ origin }, { media: [image(0)] })
    t.is(meta(html, 'og:image'), null, 'no og:image for ' + String(origin))
    t.ok(html.includes('<img src="' + BASE + '/foto/1"'), 'the relative image stays')
    assertSafe(t, html, String(origin))
  }
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
    t.is((html.match(/<img /g) || []).length, data.photoCount, label + ': photo count')
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
