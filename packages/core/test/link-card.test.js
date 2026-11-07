'use strict'

const test = require('brittle')
const card = require('../lib/link-card')
const records = require('../lib/records')

const { cardUrlHost, validLinkCard, validCardImageBytes, copyLinkCard, MAX_CARD_URL, MAX_CARD_TITLE, MAX_CARD_DESC, MAX_CARD_IMAGE_BYTES } = card

const yes = () => true

function base (over = {}) {
  return { url: 'https://example.com.br/noticia?id=1#topo', host: 'example.com.br', title: 'Um título', desc: 'Uma descrição curta', image: null, ...over }
}

test('link-card: constants', (t) => {
  t.alike(card.CARD_KEYS, ['url', 'host', 'title', 'desc', 'image'])
  t.ok(Object.isFrozen(card.CARD_KEYS))
  t.is(MAX_CARD_URL, 300)
  t.is(MAX_CARD_TITLE, 80)
  t.is(MAX_CARD_DESC, 160)
  t.is(MAX_CARD_IMAGE_BYTES, 32768)
  t.is(card.CARD_IMAGE_MIME, 'image/jpeg')
})

test('link-card: url schemes and shapes', (t) => {
  t.is(cardUrlHost('https://example.com'), 'example.com')
  t.is(cardUrlHost('https://www.example.com/a/b?c=d&e=f#g'), 'www.example.com')
  t.is(cardUrlHost('https://example.com:8443/x'), 'example.com')
  t.is(cardUrlHost('https://xn--mxail5aa.xn--jxalpdlp/'), 'xn--mxail5aa.xn--jxalpdlp')
  t.is(cardUrlHost('https://a.co/p@q'), 'a.co', 'an @ in the path is not credentials')
  const refused = {
    http: 'http://example.com/',
    javascript: 'javascript:alert(1)',
    'javascript with slashes': 'javascript://example.com/%0aalert(1)',
    data: 'data:text/html;base64,PHNjcmlwdD4=',
    ftp: 'ftp://example.com/file',
    file: 'file:///etc/passwd',
    'upper scheme': 'HTTPS://example.com/',
    'no slashes': 'https:example.com',
    credentials: 'https://user:pass@example.com/',
    'user only': 'https://user@example.com/',
    'credentials before a path': 'https://evil.com@example.com/',
    'empty host': 'https:///path',
    'single label': 'https://localhost/',
    ipv4: 'https://127.0.0.1/',
    ipv6: 'https://[::1]/',
    'upper host': 'https://Example.com/',
    'trailing dot': 'https://example.com./',
    'leading hyphen': 'https://-a.example.com/',
    'bad port': 'https://example.com:0/',
    'big port': 'https://example.com:65536/',
    'empty port': 'https://example.com:/',
    space: 'https://example.com/a b',
    backslash: 'https://example.com\\@evil.com/',
    quote: 'https://example.com/"onmouseover',
    'angle bracket': 'https://example.com/<script>',
    newline: 'https://example.com/\n',
    tab: 'https://exam\tple.com/',
    'non ascii': 'https://exämple.com/',
    'too long': 'https://example.com/' + 'a'.repeat(MAX_CARD_URL - 19),
    'not a string': 42,
    empty: ''
  }
  for (const [name, url] of Object.entries(refused)) t.is(cardUrlHost(url), null, name)
  const longest = 'https://example.com/' + 'a'.repeat(MAX_CARD_URL - 20)
  t.is(longest.length, MAX_CARD_URL)
  t.is(cardUrlHost(longest), 'example.com')
})

test('link-card: the card shape', (t) => {
  t.ok(validLinkCard(base()))
  t.ok(validLinkCard(base({ title: '', desc: '' })), 'title and desc may be empty')
  t.ok(validLinkCard(base({ title: '\u{1F600}'.repeat(MAX_CARD_TITLE), desc: '\u{1F600}'.repeat(MAX_CARD_DESC) })))
  t.ok(validLinkCard(base({ desc: 'duas\nlinhas' })), 'LF as in post text')
  t.absent(validLinkCard(base({ title: 'x'.repeat(MAX_CARD_TITLE + 1) })), 'title too long')
  t.absent(validLinkCard(base({ desc: '\u{1F600}'.repeat(MAX_CARD_DESC + 1) })), 'desc too long')
  t.absent(validLinkCard(base({ host: 'other.com' })), 'host is not the url host')
  t.absent(validLinkCard(base({ host: 'EXAMPLE.com.br' })), 'host must be lowercase')
  t.absent(validLinkCard(base({ url: 'http://example.com.br/', host: 'example.com.br' })), 'http')
  t.absent(validLinkCard(base({ url: 'javascript:alert(1)', host: 'example.com.br' })), 'javascript')
  t.absent(validLinkCard(base({ url: 'data:text/html,x', host: 'example.com.br' })), 'data')
  t.absent(validLinkCard(base({ url: 'ftp://example.com.br/', host: 'example.com.br' })), 'ftp')
  t.absent(validLinkCard(base({ url: 'https://u:p@example.com.br/', host: 'example.com.br' })), 'credentials')
  for (const cp of [0x00, 0x09, 0x0d, 0x1b, 0x7f, 0x85, 0x2028, 0x2029, 0x202e, 0x2066]) {
    const ch = String.fromCodePoint(cp)
    t.absent(validLinkCard(base({ title: 'a' + ch })), 'title U+' + cp.toString(16))
    t.absent(validLinkCard(base({ desc: 'a' + ch })), 'desc U+' + cp.toString(16))
  }
  t.absent(validLinkCard(base({ title: '\ud800' })), 'lone surrogate')
  t.absent(validLinkCard(base({ desc: 'a\udc00' })), 'lone low surrogate')
  t.absent(validLinkCard(base({ title: null })))
  t.absent(validLinkCard({ ...base(), extra: 1 }), 'extra key')
  const missing = base()
  delete missing.desc
  t.absent(validLinkCard(missing), 'missing key')
  t.absent(validLinkCard(null))
  t.absent(validLinkCard([]))
  t.absent(validLinkCard(base({ image: { bytes: 1 } })), 'an image needs a validator')
  t.ok(validLinkCard(base({ image: { bytes: 1 } }), yes))
  t.absent(validLinkCard(base({ image: { bytes: 1 } }), () => 1), 'only true passes')
})

test('link-card: hostile input never throws', (t) => {
  const hostile = new Proxy({}, { ownKeys () { throw new Error('x') } })
  t.absent(validLinkCard(hostile))
  const getter = base()
  Object.defineProperty(getter, 'url', { get () { throw new Error('x') }, enumerable: true })
  t.absent(validLinkCard(getter))
  t.absent(validLinkCard(base({ image: {} }), () => { throw new Error('x') }))
  t.is(cardUrlHost({ toString () { return 'https://a.co' } }), null)
})

test('link-card: image byte bound', (t) => {
  t.ok(validCardImageBytes(1))
  t.ok(validCardImageBytes(MAX_CARD_IMAGE_BYTES))
  t.absent(validCardImageBytes(MAX_CARD_IMAGE_BYTES + 1))
  t.absent(validCardImageBytes(0))
  t.absent(validCardImageBytes(1.5))
  t.absent(validCardImageBytes('1'))
})

test('link-card: copy keeps exactly the card keys', (t) => {
  const c = copyLinkCard({ ...base({ image: { a: 1, b: 2 } }), extra: 1 }, (d) => ({ a: d.a }))
  t.alike(Object.keys(c), ['url', 'host', 'title', 'desc', 'image'])
  t.alike(c.image, { a: 1 })
  t.is(copyLinkCard(null), null)
})

test('link-card: character rule matches records.js', (t) => {
  let mismatches = 0
  for (let cp = 0; cp <= 0x30000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const s = String.fromCodePoint(cp)
    if ((card.cardTextLength(s) === -1) !== records.hasControlChars(s, true)) mismatches++
  }
  t.is(mismatches, 0)
})
