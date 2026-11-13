'use strict'

const test = require('brittle')
const fs = require('fs')
const path = require('path')
const { findMentions } = require('@varanda/rpc')
const load = () => import('../src/links.js')

const SAMPLES = []
const sample = (s) => { SAMPLES.push(s); return s }

function linksOf (findLinks, text) {
  return findLinks(text).map(({ start, end, href }) => ({ slice: text.slice(start, end), href }))
}

test('two links after an emoji keep UTF-16 offsets into the raw text', async (t) => {
  const { findLinks } = await load()
  const text = sample('😀 veja https://a.com/x e http://b.com.br')
  t.alike(findLinks(text), [
    { start: 8, end: 23, href: 'https://a.com/x' },
    { start: 26, end: 41, href: 'http://b.com.br' }
  ])
})

test('www and uppercase schemes', async (t) => {
  const { findLinks } = await load()
  t.alike(linksOf(findLinks, sample('site www.exemplo.com.br')), [
    { slice: 'www.exemplo.com.br', href: 'https://www.exemplo.com.br' }
  ])
  t.alike(linksOf(findLinks, sample('WWW.Exemplo.com')), [
    { slice: 'WWW.Exemplo.com', href: 'https://WWW.Exemplo.com' }
  ])
  t.alike(linksOf(findLinks, sample('Https://A.com/X')), [
    { slice: 'Https://A.com/X', href: 'https://A.com/X' }
  ])
  t.alike(linksOf(findLinks, sample('HTTPS://A.com/X')), [
    { slice: 'HTTPS://A.com/X', href: 'https://A.com/X' }
  ])
  t.alike(linksOf(findLinks, sample('http://a.com')), [
    { slice: 'http://a.com', href: 'http://a.com' }
  ], 'http is never upgraded')
})

test('non-http schemes and bare hosts produce no link', async (t) => {
  const { findLinks, hasLink } = await load()
  for (const s of [
    'exemplo.com.br', 'ahttp://a.com', 'foo.www.a.com', 'ftp://a.com',
    'javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.com', 'file:///x',
    'varanda:///g/x', 'intent://x', 'http://localhost', 'http://a', 'www.a',
    'veja:https://a.com', 'x@https://a.com', 'a1https://a.com', '_https://a.com'
  ]) {
    sample(s)
    t.alike(findLinks(s), [], s)
    t.is(hasLink(s), false, s)
  }
})

test('link starts only at token start, after an opener or after an emoji', async (t) => {
  const { findLinks } = await load()
  t.alike(linksOf(findLinks, sample('(https://a.com)')), [{ slice: 'https://a.com', href: 'https://a.com' }])
  t.alike(linksOf(findLinks, sample('«https://a.com»')), [{ slice: 'https://a.com', href: 'https://a.com' }])
  t.alike(linksOf(findLinks, sample('“https://a.com/x”')), [{ slice: 'https://a.com/x', href: 'https://a.com/x' }])
  t.alike(linksOf(findLinks, sample('😀https://a.com')), [{ slice: 'https://a.com', href: 'https://a.com' }])
  t.alike(linksOf(findLinks, sample('[www.a.com]')), [{ slice: 'www.a.com', href: 'https://www.a.com' }])
  t.alike(linksOf(findLinks, sample('¡https://a.com!')), [{ slice: 'https://a.com', href: 'https://a.com' }])
})

test('userinfo, backslash and nested schemes produce zero links', async (t) => {
  const { findLinks } = await load()
  for (const s of [
    'https://google.com@evil.com', 'http://user:pass@host.com',
    'http://u:p@https://evil.example/x', 'https://a.com\\@evil.com',
    'http://a@%https://evil.com', 'https://a.com/x\\y', 'https://@a.com'
  ]) {
    sample(s)
    t.alike(findLinks(s), [], s)
  }
})

test('trailing punctuation is trimmed and balanced closers stay', async (t) => {
  const { findLinks } = await load()
  const one = (s, slice) => t.alike(linksOf(findLinks, sample(s)), [{ slice, href: slice }], s)
  one('https://a.com/x.', 'https://a.com/x')
  one('https://a.com/x,', 'https://a.com/x')
  one('https://a.com/x…', 'https://a.com/x')
  one('https://a.com…', 'https://a.com')
  one('https://a.com/x)', 'https://a.com/x')
  one('https://a.com).', 'https://a.com')
  one('https://a.com),', 'https://a.com')
  one('https://a.com.', 'https://a.com')
  one('https://a.com/x?!', 'https://a.com/x')
  one('https://pt.wikipedia.org/wiki/Brasil_(país)', 'https://pt.wikipedia.org/wiki/Brasil_(país)')
  one('(https://pt.wikipedia.org/wiki/Brasil_(país))', 'https://pt.wikipedia.org/wiki/Brasil_(país)')
  one('https://exemplo.com/@ana', 'https://exemplo.com/@ana')
  one('https://1.2.3.4:8080/x', 'https://1.2.3.4:8080/x')
  one('https://a.com:443', 'https://a.com:443')
  one('https://exemplo.com/café', 'https://exemplo.com/café')
  one('https://a.com/x😀', 'https://a.com/x')
  one('https://a.com/x»', 'https://a.com/x')
})

test('bad hosts and ports are plain', async (t) => {
  const { findLinks } = await load()
  for (const s of [
    'https://[::1]/', 'https://a.com:0/', 'https://a.com:99999/', 'https://a.com:/',
    'https://a.com:1:2/', 'https://999.999.999.999/', 'https://1.2.3/', 'https://010.1.1.1/',
    'https://a.0x7f/', 'https://аpple.com/', 'https://a..com/', 'https://.a.com/',
    'https://a.com./x', 'https://-a.com/', 'https://a-.com/', 'https:///a.com',
    'https://' + 'a'.repeat(64) + '.com/'
  ]) {
    sample(s)
    t.alike(findLinks(s), [], s)
  }
})

test('stopping inside the authority makes the whole token plain', async (t) => {
  const { findLinks } = await load()
  for (const s of [
    'https://banco.com．evil.example', 'https://banco.com⁄evil', 'https://a.com。b',
    'https://a.com｡b',
    'https://a.com>', '<https://a.com>', 'https://a.com"x', 'https://a.com`', 'https://a.com|x'
  ]) {
    sample(s)
    t.alike(findLinks(s), [], s)
  }
})

test('hidden or unsafe code points poison the whole token', async (t) => {
  const { findLinks } = await load()
  for (const s of [
    'https://evil.com​.banco.com', 'https://a.com‮evil', 'https://a.com/x​y',
    'https://a.com/﻿x', '﻿https://a.com', 'https://a.com/x\ud800', 'https://a.com/x­',
    'https://a.com/x⁠', 'https://a.com/\u0085', 'https://a.com/x‎', 'https://a.com/⁦x'
  ]) {
    sample(s)
    t.alike(findLinks(s), [], s)
  }
  t.alike(linksOf(findLinks, sample('ok https://b.com ​https://a.com')), [
    { slice: 'https://b.com', href: 'https://b.com' }
  ], 'only the poisoned token is plain')
})

test('U+FFFD breaks tokens', async (t) => {
  const { findLinks } = await load()
  t.alike(linksOf(findLinks, sample('olha�https://exemplo.com.br')), [
    { slice: 'https://exemplo.com.br', href: 'https://exemplo.com.br' }
  ])
  t.alike(linksOf(findLinks, sample('https://a.com�ok')), [
    { slice: 'https://a.com', href: 'https://a.com' }
  ])
})

test('LINK_MAX bounds the link without truncation', async (t) => {
  const { findLinks, LINK_MAX } = await load()
  t.is(LINK_MAX, 2048)
  const head = 'https://a.com/'
  const exact = sample(head + 'x'.repeat(LINK_MAX - head.length))
  t.alike(findLinks(exact), [{ start: 0, end: LINK_MAX, href: exact }])
  const long = sample(head + 'x'.repeat(3000 - head.length))
  t.alike(findLinks(long), [])
  t.alike(findLinks(sample(exact + '.')), [{ start: 0, end: LINK_MAX, href: exact }], 'trimmed length counts')
})

test('line feed and no-break space separate links', async (t) => {
  const { findLinks } = await load()
  t.alike(linksOf(findLinks, sample('https://a.com\nhttps://b.com www.c.com')), [
    { slice: 'https://a.com', href: 'https://a.com' },
    { slice: 'https://b.com', href: 'https://b.com' },
    { slice: 'www.c.com', href: 'https://www.c.com' }
  ])
})

test('textSegments merges mentions and links', async (t) => {
  const { textSegments } = await load()
  const text = sample('@ana https://a.com/@bob @cid')
  t.alike(textSegments(text, { mentions: true }), [
    { text: '@ana', username: 'ana', href: null },
    { text: ' ', username: null, href: null },
    { text: 'https://a.com/@bob', username: null, href: 'https://a.com/@bob' },
    { text: ' ', username: null, href: null },
    { text: '@cid', username: 'cid', href: null }
  ])
  t.alike(textSegments(text), [
    { text: '@ana ', username: null, href: null },
    { text: 'https://a.com/@bob', username: null, href: 'https://a.com/@bob' },
    { text: ' @cid', username: null, href: null }
  ])
  t.alike(textSegments('@ANA', { mentions: true }), [{ text: '@ANA', username: 'ana', href: null }])
  t.alike(textSegments(''), [])
  t.alike(textSegments('www.a.com'), [{ text: 'www.a.com', username: null, href: 'https://www.a.com' }])
})

test('non-string input never throws', async (t) => {
  const { findLinks, hasLink, textSegments, isHttpUrl } = await load()
  for (const v of [null, undefined, 1, {}, [], Symbol('x')]) {
    t.alike(findLinks(v), [])
    t.is(hasLink(v), false)
    t.alike(textSegments(v), [])
    t.alike(textSegments(v, { mentions: true }), [])
    t.is(isHttpUrl(v), false)
  }
  t.is(hasLink('veja https://a.com'), true)
})

test('isHttpUrl accepts only http and https', async (t) => {
  const { isHttpUrl } = await load()
  t.ok(isHttpUrl('https://a.com'))
  t.ok(isHttpUrl('http://a.com:80/x'))
  t.absent(isHttpUrl('javascript:alert(1)'))
  t.absent(isHttpUrl('https://a.com\\@b.com'))
  t.absent(isHttpUrl('https://u@a.com'))
  t.absent(isHttpUrl('HTTPS://a.com'))
})

test('narrow spaces poison instead of breaking', async (t) => {
  const { findLinks } = await load()
  for (const sp of ['\u2006', '\u2008', '\u2009', '\u200a', '\u202f', '\u205f']) {
    for (const s of ['https://evil.com' + sp + '.banco.com.br', 'www.evil.com' + sp + '.banco.com']) {
      sample(s)
      t.alike(findLinks(s), [], JSON.stringify(s))
    }
  }
  t.alike(linksOf(findLinks, sample('a\u2003https://a.com')), [
    { slice: 'https://a.com', href: 'https://a.com' }
  ], 'em space still breaks')
})

test('shorthand format controls poison the token', async (t) => {
  const { findLinks } = await load()
  for (const cp of [0x1bca0, 0x1bca1, 0x1bca2, 0x1bca3]) {
    const s = sample('https://banco.com/' + String.fromCodePoint(cp) + '.phishing.com')
    t.alike(findLinks(s), [], JSON.stringify(s))
  }
})

test('more emoji count as openers', async (t) => {
  const { findLinks } = await load()
  for (const e of ['\u231a', '\u23f0', '\u2b50', '\u3030', '\u303d', '\u3297', '\u3299']) {
    t.alike(linksOf(findLinks, sample(e + 'https://a.com')), [
      { slice: 'https://a.com', href: 'https://a.com' }
    ], JSON.stringify(e))
  }
})

test('isHttpUrl repeats the host and port rules', async (t) => {
  const { isHttpUrl } = await load()
  for (const s of [
    'https://127.1', 'https://1.2.3', 'https://2130706433', 'https://0x7f000001',
    'https://a.com:99999', 'https://a.com:0', 'https://localhost/', 'https://[::1]/',
    'https://a.com/x y', 'https://a.com/x\u0007', 'https://a.com/x\u200by',
    'https://a.com/\u{1bca0}', 'https://a.com\u2009.b.com', 'https://a.com/x<y',
    'https://a.com/x\ud800', 'https://аpple.com/', 'https://a.com\u00e9/',
    'https://a..com', ' https://a.com', 'https://a.com/' + 'x'.repeat(2048)
  ]) {
    t.absent(isHttpUrl(s), JSON.stringify(s))
  }
  t.ok(isHttpUrl('https://exemplo.com/café'))
  t.ok(isHttpUrl('https://1.2.3.4:8080/x'))
})

test('emoji with selectors, keycaps and joiners sit flush against a link', async (t) => {
  const { findLinks } = await load()
  const one = (s, slice) => t.alike(linksOf(findLinks, sample(s)), [{ slice, href: slice }], JSON.stringify(s))
  one('❤️https://exemplo.com', 'https://exemplo.com')
  one('https://exemplo.com❤️', 'https://exemplo.com')
  one('https://exemplo.com/promo☀️', 'https://exemplo.com/promo')
  one('https://exemplo.com\u{1f600}', 'https://exemplo.com')
  one('https://a.com\u{1f600}', 'https://a.com')
  one('\u{1f469}‍⚕️https://a.com', 'https://a.com')
  one('\u{1f3f3}️‍\u{1f308}https://a.com', 'https://a.com')
  one('1️⃣https://a.com', 'https://a.com')
  one('#️⃣https://a.com', 'https://a.com')
  one('☀︎https://a.com', 'https://a.com')
  one('\u{1f44d}\u{1f3fd}https://a.com', 'https://a.com')
  one('\u{1f1e7}\u{1f1f7}https://a.com', 'https://a.com')
  one('https://a.com/x\u{1f469}‍\u{1f4bb}', 'https://a.com/x')
  one('https://a.com\u{1f3f3}️‍\u{1f308}', 'https://a.com')
})

test('joiners outside an emoji sequence still poison the token', async (t) => {
  const { findLinks } = await load()
  for (const s of [
    'https://banco.com．evil.example', 'https://a.com️.evil.com',
    'https://a.com‍.evil.com', 'a‍https://a.com', 'https://a.com/x️',
    'https://a.com/x‍\u{1f600}', '\u{1f600}‍https://a.com', 'x️https://a.com',
    'https://a.com⃣', 'https://a.com/x⃣', '1⃣https://a.com',
    'https://a.com/1️⃣', 'https://a.com/#️⃣', 'https://a.com1️⃣',
    '️https://a.com', '\u{1f600}️️https://a.com', 'https://a.com︎',
    'https://a.com\u{1f600}​', 'https://a.com>\u{1f600}', 'https://a.com⁄\u{1f600}'
  ]) {
    sample(s)
    t.alike(findLinks(s), [], JSON.stringify(s))
  }
})

test('round trip and href invariants over every sample', async (t) => {
  const { findLinks, textSegments, isHttpUrl } = await load()
  const all = SAMPLES.concat(['', null, 'plain\n\ud800', 'a https://a.com b @ana c'])
  for (const s of all) {
    for (const mentions of [false, true]) {
      const joined = textSegments(s, { mentions }).map((seg) => seg.text).join('')
      t.is(joined, typeof s === 'string' ? s : '', 'round trip: ' + JSON.stringify(s))
    }
    if (typeof s !== 'string') continue
    let last = 0
    for (const { start, end, href } of findLinks(s)) {
      t.ok(start >= last && end > start, 'ordered, non-overlapping')
      last = end
      t.ok(/^https?:\/\//.test(href), href)
      t.absent(/[\s\\<>"]/.test(href) || [...href].some((c) => c.codePointAt(0) < 0x20 || (c.codePointAt(0) >= 0x7f && c.codePointAt(0) <= 0x9f)), href)
      const authority = href.replace(/^https?:\/\//, '').split(/[/?#]/)[0]
      t.absent(authority.includes('@'), href)
      t.ok(isHttpUrl(href), 'isHttpUrl accepts every found href: ' + href)
    }
  }
})

test('a right-to-left letter ends the link, so the path cannot reorder it', async (t) => {
  const { findLinks, isHttpUrl } = await load()
  t.alike(linksOf(findLinks, 'א https://evil.example/ב/banco.com.br'),
    [{ slice: 'https://evil.example/', href: 'https://evil.example/' }])
  t.alike(linksOf(findLinks, 'https://a.com/xاy'), [{ slice: 'https://a.com/x', href: 'https://a.com/x' }])
  t.alike(linksOf(findLinks, 'https://a.com/x؀y'), [{ slice: 'https://a.com/x', href: 'https://a.com/x' }])
  t.absent(isHttpUrl('https://a.com/ב'))
  t.absent(isHttpUrl('https://a.com/؀'))
  t.alike(linksOf(findLinks, 'https://a.com/καλά'),
    [{ slice: 'https://a.com/καλά', href: 'https://a.com/καλά' }])
})

test('a long run of trailing closers is trimmed in full', async (t) => {
  const { findLinks } = await load()
  t.alike(linksOf(findLinks, 'https://a.com/' + ')'.repeat(986)), [{ slice: 'https://a.com/', href: 'https://a.com/' }])
  t.alike(linksOf(findLinks, 'https://a.com/(x))' + '.'.repeat(500)), [{ slice: 'https://a.com/(x)', href: 'https://a.com/(x)' }])
})

test('an emoji ideograph after a path ends the link', async (t) => {
  const { findLinks } = await load()
  for (const e of ['㊗️', '㊙️']) {
    t.alike(linksOf(findLinks, 'https://exemplo.com/promo' + e),
      [{ slice: 'https://exemplo.com/promo', href: 'https://exemplo.com/promo' }], e)
  }
})

test('every emoji of the composer picker can touch a link', async (t) => {
  const { findLinks } = await load()
  const { EMOJI } = await import('../src/emoji.js')
  for (const { e } of EMOJI) {
    t.is(findLinks(e + 'https://a.com').length, 1, 'before: ' + e)
    t.is(findLinks('https://a.com/x' + e).length, 1, 'after: ' + e)
  }
})

test('textWithoutHrefs removes only the chosen links', async (t) => {
  const { textWithoutHrefs } = await load()
  const U = 'https://youtu.be/dQw4w9WgXcQ'
  const omit = (h) => h === U
  const line = 'ouça ' + U + ' agora'
  t.is(textWithoutHrefs(line, omit), 'ouça agora')
  t.is(textWithoutHrefs(U, omit), '')
  t.is(textWithoutHrefs('veja ' + U + ' e https://example.com', omit), 'veja e https://example.com')
  t.is(textWithoutHrefs('@ana ' + U, omit), '@ana')
  t.is(textWithoutHrefs('linha um\n' + U + '\nlinha três', omit), 'linha um\nlinha três')
  t.is(textWithoutHrefs('(' + U + ').', omit), '.')
  t.is(textWithoutHrefs('Olha ' + U + ', que legal', omit), 'Olha, que legal')
  t.is(textWithoutHrefs('ouça ' + U + '!', omit), 'ouça!')
  t.is(textWithoutHrefs('(' + U + ')', omit), '')
  t.is(textWithoutHrefs('veja (' + U + ').', omit), 'veja.')
  t.is(textWithoutHrefs('veja [' + U + '] agora', omit), 'veja agora')
  t.is(textWithoutHrefs('veja: ' + U + '.', omit), 'veja: .')
  t.is(textWithoutHrefs('(nota ' + U + ')', omit), '(nota)')
  for (const punctuation of [',', '.', ';', ':', '!', '?']) {
    t.is(textWithoutHrefs('maçã \t' + U + '\t ' + punctuation, omit), 'maçã' + punctuation)
    t.is(textWithoutHrefs('123 ' + U + ' ' + punctuation, omit), '123' + punctuation)
  }
  t.is(textWithoutHrefs('字 ' + U + '.', omit), '字.')
  t.is(textWithoutHrefs('😀 ' + U + '.', omit), '😀 .')
  t.is(textWithoutHrefs(U + ' , texto', omit), ', texto')
  t.is(textWithoutHrefs('veja { \t' + U + '\t } agora', omit), 'veja agora')
  t.is(textWithoutHrefs('veja ([' + U + ']) agora', omit), 'veja agora')
  t.is(textWithoutHrefs('veja (' + U + ' ' + U + ').', omit), 'veja.')
  t.is(textWithoutHrefs('veja (' + U + '] agora', omit), 'veja (] agora')
  t.is(textWithoutHrefs('nota  , ()\nveja (' + U + ')\nfim  .', omit), 'nota  , ()\nveja\nfim  .')
  t.is(textWithoutHrefs('um\r\n[ ' + U + ' ]\r\ndois', omit), 'um\r\ndois')
  t.is(textWithoutHrefs('a  b ' + U, omit), 'a  b')
  const plain = 'a  b https://example.com'
  t.is(textWithoutHrefs(plain, omit), plain, 'no chosen link returns the same string')
  t.is(textWithoutHrefs('um ' + U + ' e ' + U, omit), 'um e')
  t.is(textWithoutHrefs(line, () => 'yes'), line, 'only strict true drops')
  t.is(textWithoutHrefs(line, () => { throw new Error('keep') }), line, 'a throw keeps the link')
  t.is(textWithoutHrefs(null, omit), '')
  t.is(textWithoutHrefs(line), line, 'missing omit returns the text')
})

test('removed links attach only complete punctuation runs after words', async (t) => {
  const { textWithoutHrefs } = await load()
  const U = 'https://youtu.be/dQw4w9WgXcQ'
  const omit = (h) => h === U
  t.is(textWithoutHrefs('https://good.com ' + U + ' .evil.com', omit), 'https://good.com .evil.com', 'removing a link cannot extend another domain')
  t.is(textWithoutHrefs('olá ' + U + ', tudo', omit), 'olá, tudo')
  t.is(textWithoutHrefs('nota 2 ' + U + '.', omit), 'nota 2.')
  for (const word of ['é', 'ã', 'ç', 'Ω', 'я', '𐐀']) {
    t.is(textWithoutHrefs(word + ' ' + U + '!', omit), word + '!', 'a full letter code point: ' + word)
  }
  t.is(textWithoutHrefs('nota ' + U + '.)]}!?;:, fim', omit), 'nota.)]}!?;:, fim')
  t.is(textWithoutHrefs('nota ' + U + '!?\nfim', omit), 'nota!?\nfim')
  t.is(textWithoutHrefs('nota ' + U + ' !?fim', omit), 'nota !?fim')
})

test('links stays parseable without Unicode property escapes on Hermes', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/links.js'), 'utf8')
  t.absent(src.includes('\\p{'), 'no Unicode property escape in the module')
})

test('removed links never join text outside brackets', async (t) => {
  const { textWithoutHrefs, findLinks } = await load()
  const U = 'https://youtu.be/dQw4w9WgXcQ'
  const omit = (h) => h === U
  const word = textWithoutHrefs('pala( ' + U + ' )vra', omit)
  t.is(word, 'pala( )vra')
  t.absent(word.includes('palavra'), 'hiding a link cannot create a word')
  const mention = textWithoutHrefs('@al( ' + U + ' )ice', omit)
  t.is(mention, '@al( )ice')
  t.alike(findMentions(mention), [], 'hiding a link cannot create @alice')
  const address = textWithoutHrefs('https://evil.exa( ' + U + ' )mple.com/login', omit)
  t.is(address, 'https://evil.exa( )mple.com/login')
  t.alike(findLinks(address), [], 'hiding a link cannot create https://evil.example.com/login')
  const bank = textWithoutHrefs('https://bank.example ' + U + ' .evil.example/login', omit)
  t.alike(findLinks(bank).map((link) => link.href), ['https://bank.example'])
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}'], ['([', '])']]) {
    t.is(textWithoutHrefs('a' + open + ' ' + U + ' ' + close + ' b', omit), 'a' + open + ' ' + close + ' b', 'attached on the left: ' + open)
    t.is(textWithoutHrefs('a ' + open + ' ' + U + ' ' + close + 'b', omit), 'a ' + open + ' ' + close + 'b', 'attached on the right: ' + close)
  }
  t.is(textWithoutHrefs('veja ( ' + U + ' ).evil', omit), 'veja ( ).evil', 'punctuation followed by text is not a boundary')
})

test('removed links join only at the module separators, not at zero-width or narrow spaces', async (t) => {
  const { textWithoutHrefs } = await load()
  const U = 'https://youtu.be/dQw4w9WgXcQ'
  const omit = (h) => h === U
  const zw = textWithoutHrefs('www.evil ' + U + ' .\ufeffcom', omit)
  t.is(zw, 'www.evil .\ufeffcom')
  t.not(zw, 'www.evil.\ufeffcom', 'U+FEFF after the punctuation is not a separator')
  for (const narrow of ['\u2006', '\u2008', '\u2009', '\u200a', '\u202f', '\u205f']) {
    const label = 'U+' + narrow.charCodeAt(0).toString(16)
    t.is(textWithoutHrefs('www.evil ' + U + ' .' + narrow + 'com', omit), 'www.evil .' + narrow + 'com', 'after the punctuation: ' + label)
    t.is(textWithoutHrefs('abc' + narrow + '( ' + U + ' )' + narrow + 'def', omit), 'abc' + narrow + '( )' + narrow + 'def', 'around a bracket pair: ' + label)
  }
  const pair = textWithoutHrefs('abc\ufeff( ' + U + ' )\ufeffdef', omit)
  t.is(pair, 'abc\ufeff( )\ufeffdef')
  t.not(pair, 'abc\ufeff\ufeffdef', 'U+FEFF around brackets is not a separator')
  t.is(textWithoutHrefs('abc\ufeff( ' + U + ' ) def', omit), 'abc\ufeff( ) def', 'zero-width before the pair')
  t.is(textWithoutHrefs('abc ( ' + U + ' )\ufeffdef', omit), 'abc ( )\ufeffdef', 'zero-width after the pair')
  t.is(textWithoutHrefs('abc ( ' + U + ' ),\ufeffdef', omit), 'abc ( ),\ufeffdef', 'zero-width after the punctuation run')
  t.is(textWithoutHrefs('Olha ' + U + ', que legal', omit), 'Olha, que legal')
  t.is(textWithoutHrefs('veja ( ' + U + ' )\u00a0agora', omit), 'veja \u00a0agora', 'a no-break space still separates')
  t.is(textWithoutHrefs('veja ( ' + U + ' ).\u3000agora', omit), 'veja.\u3000agora', 'an ideographic space still separates')
})

test('tidyLine tests separators with the module ranges, not a regex whitespace class', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/links.js'), 'utf8')
  const start = src.indexOf('function tidyLine (')
  const end = src.indexOf('\nfunction ', start + 1)
  t.ok(start >= 0 && end > start, 'tidyLine found')
  t.absent(src.slice(start, end).includes('\\s'), 'no \\s in tidyLine')
})

test('textWithoutHrefs falls back when tidying exposes a link', async (t) => {
  const { textWithoutHrefs, findLinks } = await load()
  const U = 'https://youtu.be/dQw4w9WgXcQ'
  const omit = (h) => h === U
  const hidden = '\ufeffhttps://evil.example ' + U
  t.alike(findLinks(hidden).map((link) => link.href), [U])
  t.is(textWithoutHrefs(hidden, omit), hidden, 'trimming must not expose a previously poisoned link')
  const changed = 'https://a.com/(x ' + U + ' )'
  t.is(textWithoutHrefs(changed, omit), changed, 'attaching a closer must not change a remaining href')
  const mention = '@ana ' + U + ' ,@bob'
  t.alike(findMentions(mention).map((m) => m.username), ['ana', 'bob'])
  t.is(textWithoutHrefs(mention, omit), '@ana ,@bob', 'existing mentions remain')
  const linkedMention = '@ANA ' + U + ' https://a.com/@bob'
  t.is(textWithoutHrefs(linkedMention, omit), '@ANA https://a.com/@bob', 'kept links and handle text remain intact')
  t.is(textWithoutHrefs('ouça https://a.com/@bob', () => true), 'ouça', 'mentions within a dropped link go with it')
  t.is(textWithoutHrefs('https://a.com ' + U + ' https://a.com', omit), 'https://a.com https://a.com', 'repeated targets remain')
  let calls = 0
  t.is(textWithoutHrefs(U + ' ' + U, () => ++calls === 1), U, 'a kept occurrence of a dropped href remains')
  const raw = 'https://a.com ' + U
  t.is(textWithoutHrefs(raw, (href) => {
    if (href === U) throw new Error('keep')
    return true
  }), raw, 'a throw after choosing another link returns all the original text')
})
