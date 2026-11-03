'use strict'

const test = require('brittle')
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
