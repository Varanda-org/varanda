'use strict'

const test = require('brittle')
const rpc = require('..')
const { parseOg, ogText, ogImageUrl, decodeEntities, MAX_OG_HTML } = require('../lib/og-parse')

const PAGE = 'https://example.com/a/page'

test('og-parse: exported from @varanda/rpc', (t) => {
  t.is(rpc.parseOg, parseOg)
  t.is(rpc.ogText, ogText)
  t.is(rpc.ogImageUrl, ogImageUrl)
  t.is(rpc.MAX_OG_HTML, 524288)
})

test('og-parse: og:title then <title>, og:description then meta description', (t) => {
  t.alike(parseOg('<title>T</title><meta name=description content=D><meta property=og:title content=OT><meta property=og:description content=OD>', PAGE), { title: 'OT', desc: 'OD', imageUrl: null })
  t.alike(parseOg('<title>T</title><meta name=description content=D>', PAGE), { title: 'T', desc: 'D', imageUrl: null })
  t.alike(parseOg('', PAGE), { title: '', desc: '', imageUrl: null })
})

test('og-parse: tags are scanned quote-aware, attributes as HTML reads them', (t) => {
  t.is(parseOg('<meta content="A > B" property="og:title">', PAGE).title, 'A > B')
  t.is(parseOg("<meta content='x\">y' property=og:title>", PAGE).title, 'x">y')
  t.is(parseOg('<div data-x="<meta property=og:title content=Fake>"></div><title>Real</title>', PAGE).title, 'Real')
  t.is(parseOg('<metax property=og:title content=Fake><title>Real</title>', PAGE).title, 'Real', 'another element name')
  t.is(parseOg('<!x <meta property=og:title content=Fake>><title>Real</title>', PAGE).title, 'Real', 'a bogus comment ends at its >')
  t.is(parseOg('<meta property="og:title" content="unclosed', PAGE).title, '', 'an unclosed quote ends the scan')
})

test('og-parse: <title> is RCDATA', (t) => {
  t.is(parseOg('<title>Using the <script> tag</title><meta property=og:description content=D>', PAGE).title, 'Using the <script> tag')
  t.is(parseOg('<title>Using the <script> tag</title><meta property=og:description content=D>', PAGE).desc, 'D', 'the scan goes on past the title')
  t.is(parseOg('<title>A <!-- c --> <meta property=og:title content=X></title>', PAGE).title, 'A <!-- c --> <meta property=og:title content=X>')
  t.is(parseOg('<title>unclosed', PAGE).title, '')
})

test('og-parse: script, style, noscript, textarea and template are skipped', (t) => {
  const fake = '<meta property=og:title content=Fake><title>Fake</title><meta property=og:image content=/fake.png>'
  for (const tag of ['script', 'STYLE', 'noscript', 'textarea', 'template']) {
    t.alike(parseOg('<' + tag + ' a=">">' + fake + '</' + tag + '><title>Real</title>', PAGE), { title: 'Real', desc: '', imageUrl: null }, tag)
    t.alike(parseOg('<' + tag + '>' + fake, PAGE), { title: '', desc: '', imageUrl: null }, 'unclosed ' + tag + ' skips to the end')
  }
  t.is(parseOg('<template><template></template>' + fake + '</template><title>Real</title>', PAGE).title, 'Real', 'nested templates counted')
  t.is(parseOg('<template><template>' + fake + '</template>' + fake, PAGE).title, '', 'an unclosed outer template skips to the end')
  t.is(parseOg('<template><script>"</template>"</script>' + fake + '</template><title>Real</title>', PAGE).title, 'Real', 'raw text inside a template')
  t.is(parseOg('<script>x = "</scriptx>"</script><title>Real</title>', PAGE).title, 'Real')
  t.is(parseOg('<!--' + fake + '--><title>Real</title>', PAGE).title, 'Real')
  t.is(parseOg('<!--' + fake, PAGE).title, '')
})

test('og-parse: entities are decoded once, every numeric form and case variants', (t) => {
  t.is(decodeEntities('&amp;lt;'), '&lt;')
  t.is(decodeEntities('&AMP; &Lt; &GT; &QUOT; &apos; &#39; &nbsp;'), '& < > " \' \'  ')
  t.is(decodeEntities('&#65;&#x41;&#X41;&#0065;&#x00000041;&#000000000065;'), 'AAAAAA')
  t.is(decodeEntities('&#0;&#xD800;&#x110000;&#99999999999;'), '����')
  t.is(decodeEntities('&unknown; &amp'), '&unknown; &amp')
  t.is(parseOg('<meta property=og:title content="Uma &AMP; outra &nbsp; fim">', PAGE).title, 'Uma & outra fim')
})

test('og-parse: forbidden and zero-width characters go even from references', (t) => {
  t.is(ogText('a&#x202E;b&#8238;c&#x2066;d&#x200B;e&#x200F;f&#x200e;g‍h&#x2028;i&#x85;j', 80), 'abcdefgh ij', 'bidi, zero-width, separators')
  t.is(parseOg('<title>A&#1;&#x9F;&#x202d;&#xfeff;B</title>', PAGE).title, 'AB')
  t.is(ogText('&#xD83D;&#xDE00;', 10), '��', 'a surrogate by reference is never joined')
})

test('og-parse: the first usable value per key wins', (t) => {
  const html = `
    <meta property=og:title content="">
    <meta property=og:title content="   ">
    <meta property=og:title content="&#x1;&#x200B;&#x202E;">
    <meta property=og:title content="Second">
    <meta property=og:title content="Third">
    <meta property=og:description content="&#9;&#10;">
    <meta property=og:description content="Real">
    <meta property=og:image content="">
    <meta property=og:image content="http://example.com/a.png">
    <meta property=og:image content="https://10.0.0.1/a.png">
    <meta property=og:image content="javascript:alert(1)">
    <meta property=og:image content="/ok.png">
    <meta property=og:image content="/later.png">`
  t.alike(parseOg(html, PAGE), { title: 'Second', desc: 'Real', imageUrl: 'https://example.com/ok.png' })
  t.is(parseOg('<title> </title><title>Second</title>', PAGE).title, 'Second')
  t.is(parseOg('<meta property=og:description content=" "><meta name=description content=Fallback>', PAGE).desc, 'Fallback')
})

test('og-parse: og:image is decoded, then resolved against the page, then checked by cardUrlHost', (t) => {
  t.is(ogImageUrl('/p.png?a=1&amp;b=2', PAGE), 'https://example.com/p.png?a=1&b=2')
  t.is(ogImageUrl('../p.png#frag', PAGE), 'https://example.com/p.png', 'resolved, fragment dropped')
  t.is(ogImageUrl('//img.example.org/p.png', PAGE), 'https://img.example.org/p.png')
  t.is(ogImageUrl('&#x2F;&#x2F;img.example.org/p.png', PAGE), 'https://img.example.org/p.png', 'decoded before resolving')
  for (const bad of ['https://user:pw@example.com/a', 'https://localhost/a', 'https://a_b.example.com/a', 'https://[::1]/a', 'https://example.com/a|b', 'x'.repeat(301), '']) {
    t.is(ogImageUrl(bad, PAGE), null, bad.slice(0, 40))
  }
  t.is(ogImageUrl('/p.png', 'not a url'), null)
  t.is(parseOg('<meta property=og:image content=/p.png>', null).imageUrl, null, 'no page URL, no relative image')
})

test('og-parse: input is capped at 512 KiB and caps count code points', (t) => {
  const title = '<title>Visible</title>'
  t.is(parseOg(' '.repeat(MAX_OG_HTML - title.length) + title, PAGE).title, 'Visible')
  t.is(parseOg(' '.repeat(MAX_OG_HTML - title.length + 1) + title, PAGE).title, '')
  t.is(parseOg('<meta property=og:title content="' + '😀'.repeat(90) + '">', PAGE).title, '😀'.repeat(80))
  t.is(parseOg('<meta property=og:description content="' + 'd'.repeat(400) + '">', PAGE).desc, 'd'.repeat(160))
})

test('og-parse: never throws, never coerces, stays linear on hostile input', (t) => {
  const garbage = [null, undefined, 42, {}, [], { toString () { throw new Error('no coercion') } }]
  for (const value of garbage) {
    t.alike(parseOg(value, PAGE), { title: '', desc: '', imageUrl: null })
    t.alike(parseOg('<title>T</title><meta property=og:image content=/a.png>', value), { title: 'T', desc: '', imageUrl: null })
  }
  const started = Date.now()
  for (const html of ['<a "'.repeat(130000), '<a '.repeat(170000), '<!-'.repeat(170000), '<'.repeat(600000), '<meta '.repeat(90000), '<script>'.repeat(60000), '<title>'.repeat(60000), '<template>'.repeat(60000), '<a x=\'"'.repeat(80000)]) {
    t.is(parseOg(html, PAGE).title, '')
  }
  t.ok(Date.now() - started < 5000, 'bounded time')
})
