'use strict'

const test = require('brittle')
const load = () => import('../src/preview.js')
const URL = 'https://example.com/articles/page'

test('Open Graph wins over fallbacks regardless of attribute order, quoting and case', async (t) => {
  const { extractPreview } = await load()
  t.alike(extractPreview(`
    <TITLE>Fallback</TITLE>
    <meta name=description content='Fallback description'>
    <META CONTENT="A > B" PROPERTY='OG:TITLE'>
    <meta content='Description' property=og:description>
    <meta property=og:image content=../photo.png>
  `, 'HTTPS://EXAMPLE.COM/articles/page#section'), {
    url: URL + '#section', host: 'example.com', title: 'A > B', desc: 'Description', imageUrl: 'https://example.com/photo.png'
  })
  t.alike(extractPreview('<title> Fallback </title><meta content=" A   description " name="description">', URL), {
    url: URL, host: 'example.com', title: 'Fallback', desc: 'A description', imageUrl: null
  })
  t.is(extractPreview('<meta property=og:title content=Plain>', URL).title, 'Plain')
  t.is(extractPreview('<title>Only title</title>', URL).desc, '')
  t.is(extractPreview('<meta name=description content=Description>', URL), null)
  t.is(extractPreview('<title>   </title>', URL), null)
})

test('basic and numeric entities decode once, including supplementary code points', async (t) => {
  const { extractPreview } = await load()
  const entities = '&amp; &lt; &gt; &quot; &#39; &#65; &#x1F600;'
  const expected = '& < > " \' A 😀'
  t.is(extractPreview('<title>' + entities + '</title>', URL).title, expected)
  const card = extractPreview(`<meta property=og:title content='${entities}'>
    <meta property=og:description content='&amp;lt; &#xE9; &#233;'>
    <meta property=og:image content='/photo?a=1&amp;b=2'>`, URL)
  t.is(card.title, expected)
  t.is(card.desc, '&lt; é é')
  t.is(card.imageUrl, 'https://example.com/photo?a=1&b=2')
  t.is(extractPreview('<title>&#x110000; &#55296; &unknown;</title>', URL).title, '� � &unknown;')
})

test('comments and inert blocks cannot supply metadata or titles', async (t) => {
  const { extractPreview } = await load()
  const fake = '<meta property=og:title content=Fake><meta property=og:image content=/fake><title>Fake</title>'
  for (const tag of ['script', 'STYLE', 'noscript', 'template']) {
    const html = '<' + tag + ' data-x=">">' + fake + '</' + tag + '>'
    t.is(extractPreview(html, URL), null, tag)
    t.is(extractPreview(html + '<title>Real</title>', URL).title, 'Real', tag)
    t.is(extractPreview('<' + tag + '>' + fake, URL), null, 'unclosed ' + tag)
  }
  t.is(extractPreview('<!--' + fake + '--><title>Real</title>', URL).title, 'Real')
  t.is(extractPreview('<!--' + fake, URL), null)
  t.is(extractPreview('<template><template></template>' + fake + '</template><title>Real</title>', URL).title, 'Real')
  t.is(extractPreview('<script>const x = "<template>"</script><title>Real</title>', URL).title, 'Real')
  t.is(extractPreview('<div data-x="' + fake.replaceAll('"', "'") + '"></div>', URL), null)
  // <title> is RCDATA: a comment or a tag inside it is title text.
  t.is(extractPreview('<title>A<!-- hidden -->B</title>', URL).title, 'A<!-- hidden -->B')
  t.is(extractPreview('<title>Using the <script> tag</title><meta property=og:description content=D>', URL).desc, 'D')
})

test('input is capped at exactly 524288 characters', async (t) => {
  const { extractPreview } = await load()
  const title = '<title>Visible</title>'
  t.is(extractPreview(' '.repeat(524288) + title, URL), null)
  t.is(extractPreview(' '.repeat(524288 - title.length) + title, URL).title, 'Visible')
  t.is(extractPreview(' '.repeat(524288 - title.length + 1) + title, URL), null)
  t.is(extractPreview(title + ' '.repeat(524288) + '<meta property=og:title content=Hidden>', URL).title, 'Visible')
})

test('title and description caps count code points, preserving emoji', async (t) => {
  const { extractPreview } = await load()
  const title = '😀'.repeat(81)
  const desc = '🌿'.repeat(161)
  const card = extractPreview(`<meta property=og:title content="${title}"><meta property=og:description content="${desc}">`, URL)
  t.is(card.title, '😀'.repeat(80))
  t.is(card.desc, '🌿'.repeat(160))
  t.is(extractPreview('<title>' + title + '</title>', URL).title, '😀'.repeat(80))
})

test('controls are removed and remaining whitespace is collapsed and trimmed', async (t) => {
  const { extractPreview } = await load()
  const controls = Array.from({ length: 32 }, (_, i) => String.fromCodePoint(i)).join('') +
    Array.from({ length: 33 }, (_, i) => String.fromCodePoint(127 + i)).join('') +
    '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069'
  const text = '  A' + controls + 'B   C\u00a0\u2003D  '
  const card = extractPreview(`<meta property=og:title content="${text}"><meta name=description content="${text}">`, URL)
  // Tab, LF, VT, FF and CR are whitespace (one space); every other control goes.
  t.is(card.title, 'A B C D')
  t.is(card.desc, 'A B C D')
  // NUL by reference is U+FFFD, as HTML decodes it.
  t.is(extractPreview('<title>A&#0;&#31;&#127;&#159;&#x202e;&#x2066;&#x200B;B</title>', URL).title, 'A\ufffdB')
})

test('page URLs must be HTTPS, bounded, without credentials and pass core; fragments are kept', async (t) => {
  const { extractPreview } = await load()
  const html = '<title>Title</title>'
  for (const url of ['http://example.com', 'javascript:alert(1)', 'data:text/html,x', '/relative',
    'https://user:pass@example.com', 'https://user@example.com', 'https://:pass@example.com', 'https://', '',
    'https://example.com/' + 'x'.repeat(281)]) {
    t.is(extractPreview(html, url), null, url.slice(0, 60))
  }
  const boundary = 'https://example.com/' + 'x'.repeat(280)
  t.is(extractPreview(html, boundary).url, boundary)
  t.is(extractPreview(html, URL + '#fragment').url, URL + '#fragment')
  for (const url of ['https://10.0.0.1/x', 'https://192.168.1.1/', 'https://[::1]/x', 'https://[fd00::1]/',
    'https://under_score.example.com/', 'https://localhost/', 'https://example.com/a|b', 'https://example.com/?q={x}']) {
    t.is(extractPreview(html, url), null, url)
  }
  t.is(extractPreview(html, 'https://EXAMPLE.COM:8443/path').host, 'example.com')
})

test('images resolve against the page and must be HTTPS and bounded', async (t) => {
  const { extractPreview } = await load()
  const card = (image) => extractPreview('<title>Title</title><meta property=og:image content="' + image + '">', URL)
  for (const image of ['http://example.com/a', 'javascript:alert(1)', 'data:image/png,x',
    'https://user:pass@example.com/a', 'https://', 'https://example.com/' + 'x'.repeat(281), '']) {
    t.is(card(image).imageUrl, null, image.slice(0, 60))
  }
  t.is(card('../photo.png').imageUrl, 'https://example.com/photo.png')
  t.is(card('//images.example.com/photo.png').imageUrl, 'https://images.example.com/photo.png')
  t.is(card('/photo.png?a=1&amp;b=2').imageUrl, 'https://example.com/photo.png?a=1&b=2')
  const boundary = 'https://example.com/' + 'x'.repeat(280)
  t.is(card(boundary).imageUrl, boundary)
  t.is(card('x'.repeat(290)).imageUrl, null, 'resolved URL exceeds cap')
  for (const image of ['https://10.0.0.1/a.png', 'https://[::1]/a.png', 'https://intranet/a.png', 'https://a_b.example.com/a.png']) {
    t.is(card(image).imageUrl, null, 'never a LAN or IP image: ' + image)
  }
  t.is(card('/photo.png#x').imageUrl, 'https://example.com/photo.png', 'an image drops its fragment')
})

test('garbage and unfinished tags never throw or coerce objects', async (t) => {
  const { extractPreview } = await load()
  const garbage = [null, undefined, 42, {}, [], Symbol('html'), { toString () { throw new Error('no coercion') } }]
  for (const value of garbage) {
    t.is(extractPreview(value, URL), null)
    t.is(extractPreview('<title>Title</title>', value), null)
  }
  for (const html of ['', '<title>unfinished', '<meta property="og:title" content="unfinished',
    '<'.repeat(600000), '<meta '.repeat(90000), 'x'.repeat(1048576)]) {
    t.is(extractPreview(html, URL), null)
  }
})

test('previewTarget uses the first HTTPS result from fail-closed findLinks', async (t) => {
  const { previewTarget } = await load()
  t.is(previewTarget('http://old.example.com then https://first.example.com/x and https://second.example.com'), 'https://first.example.com/x')
  t.is(previewTarget('Veja (HTTPS://Example.com/path).'), 'https://Example.com/path')
  t.is(previewTarget('www.example.com'), 'https://www.example.com')
  for (const text of [null, 42, {}, '', 'http://example.com', 'javascript:alert(1)', 'data:text/html,x',
    'javascript:https://example.com', 'data:https://example.com', 'https://user:pass@example.com',
    'https://example.com\\@evil.com', 'https://example.com/\u202eevil', 'https://example.com\u200b',
    'https://example.com/' + 'a'.repeat(2048)]) {
    t.is(previewTarget(text), null)
  }
  t.is(previewTarget('https://bad.example.com\u200b https://good.example.com'), 'https://good.example.com')
})

test('every card from a hostile page passes core validLinkCard', async (t) => {
  const { extractPreview } = await load()
  const { validLinkCard } = require('@varanda/core/lib/link-card')
  const pages = [
    '<meta property=og:title content="a\u202eb\u2066c&#x202D;d\u2028e"><meta property=og:description content="x&#x2069;y\u0085z">',
    '<title>' + '\u0001\u202e\u{1F600}'.repeat(200) + '</title><meta name=description content="' + 'ab\u2029'.repeat(200) + '">',
    '<meta property=og:title content="A > B"><title>Fallback</title>',
    '<meta property=og:title content=""><title>&#xD800;&#x110000;</title>',
    '<title>' + '\t\n x'.repeat(300) + '</title>'
  ]
  for (const url of [URL, URL + '#frag', 'HTTPS://Example.COM:8443/a?b=c']) {
    for (const html of pages) {
      const c = extractPreview(html, url)
      t.ok(c, 'a card')
      t.ok(validLinkCard({ url: c.url, host: c.host, title: c.title, desc: c.desc, image: null }), html.slice(0, 40))
    }
  }
})

test('a blank first value never blocks a later usable one', async (t) => {
  const { extractPreview } = await load()
  const card = extractPreview(`<meta property=og:title content="&#x200B; &#9;">
    <meta property=og:title content="Second">
    <meta property=og:description content="&#x202E;">
    <meta property=og:description content="Real desc">
    <meta property=og:image content="http://example.com/a.png">
    <meta property=og:image content="/b.png">`, URL)
  t.is(card.title, 'Second')
  t.is(card.desc, 'Real desc')
  t.is(card.imageUrl, 'https://example.com/b.png')
})
