'use strict'

const test = require('brittle')
const rpc = require('..')
const lc = require('../lib/link-card')

const { cardText, cardTextLength, cardUrlHost, isCardForbiddenChar } = lc

test('link-card rules: exported from the package index', (t) => {
  for (const k of Object.keys(lc)) t.is(rpc[k], lc[k], k)
  t.alike(rpc.DM_CARD_KEYS, ['url', 'host', 'title', 'desc', 'image'])
  t.is(rpc.MAX_CARD_URL, 300)
  t.is(rpc.MAX_CARD_TITLE, 80)
  t.is(rpc.MAX_CARD_DESC, 160)
  t.is(rpc.MAX_CARD_IMAGE_BYTES, 32768)
})

test('link-card rules: core uses the same functions', (t) => {
  const core = require('@varanda/core/lib/link-card')
  t.is(core.cardUrlHost, cardUrlHost)
  t.is(core.cardTextLength, cardTextLength)
  t.is(core.MAX_CARD_URL, rpc.MAX_CARD_URL)
  t.is(core.MAX_CARD_IMAGE_BYTES, rpc.MAX_CARD_IMAGE_BYTES)
})

test('link-card rules: hosts a card may name', (t) => {
  t.is(cardUrlHost('https://example.com/a?b=c#frag'), 'example.com', 'the fragment is kept')
  t.is(cardUrlHost('https://example.com:8443/'), 'example.com')
  for (const url of [
    'https://10.0.0.1/x', 'https://192.168.0.1/', 'https://[::1]/x', 'https://[fe80::1]/',
    'https://under_score.example.com/', 'https://localhost/', 'https://example.com/{a}',
    'https://example.com/a|b', 'https://example.com/?q={x}', 'https://example.com/\u202e',
    'https://user@example.com/', 'https://example.com./', 'http://example.com/'
  ]) t.is(cardUrlHost(url), null, url)
})

test('link-card rules: cardText always passes the card rule', (t) => {
  t.is(cardText('  a\n\tb  ', 10), 'a b')
  t.is(cardText('a\u202eb\u2066c\u0001d\u0085e', 80), 'abcde', 'bidi and controls dropped')
  t.is(cardText('a\u2028b\u2029c', 80), 'a b c', 'separators are whitespace')
  t.is(cardText('\ud800x\udc00', 80), '\ufffdx\ufffd', 'lone surrogates replaced')
  t.is(cardText('😀'.repeat(81), 80), '😀'.repeat(80), 'cut by code points')
  t.is(cardText('abc def', 4), 'abc', 'trimmed after the cut')
  t.is(cardText('   ', 10), '')
  t.is(cardText(null, 10), '')
  t.is(cardText('x', 0), '')
  let all = ''
  for (let cp = 0; cp < 0x2100; cp++) all += String.fromCodePoint(cp)
  const out = cardText(all + all, 160)
  t.ok(cardTextLength(out) >= 0 && cardTextLength(out) <= 160)
  for (const ch of out) t.absent(isCardForbiddenChar(ch.codePointAt(0), true))
})
