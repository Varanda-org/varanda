'use strict'

const test = require('brittle')
const { safe, jsonLine, isUnsafe, cpWidth } = require('../lib/safe')

const UNSAFE = { test: (s) => Array.from(s).some((ch) => isUnsafe(ch.codePointAt(0))) }
const JSON_UNSAFE = /[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
const CASES = ['\u007f', '\u0080', '\u009b', '\u009c', '\u009d', '\u009f', '\u2028', '\u2029', '\u202a', '\u202e', '\u2066', '\u2069']

test('safe escapes every unsafe code point', async (t) => {
  t.is(safe('ok ação ✓'), 'ok ação ✓')
  t.is(safe('a\nb\u009b\u202e'), 'a\\u{a}b\\u{9b}\\u{202e}')
  t.absent(UNSAFE.test(safe(CASES.join('') + '\u0000\u001b')))
})

test('jsonLine escapes DEL, C1, line separators and bidi controls', async (t) => {
  for (const ch of CASES) {
    const value = { k: 'x' + ch + 'y', list: [ch, 'ação'], [ch]: 1 }
    const line = jsonLine(value)
    t.absent(JSON_UNSAFE.test(line), 'no raw U+' + ch.charCodeAt(0).toString(16))
    t.absent(line.includes('\n'))
    t.alike(JSON.parse(line), value, 'parses back to the same value')
  }
  const all = CASES.join('')
  t.alike(JSON.parse(jsonLine(all)), all)
  t.is(jsonLine({ a: 1, b: 'x"\\' }), JSON.stringify({ a: 1, b: 'x"\\' }), 'ordinary values are unchanged')
})

test('cpWidth over-estimates: narrow allowlist, everything else >= U+1100 is wide', async (t) => {
  t.is(cpWidth(0x61), 1)
  t.is(cpWidth(0xe7), 1, 'c cedilla')
  t.is(cpWidth(0x2014), 1, 'em dash')
  t.is(cpWidth(0x20ac), 1, 'euro sign')
  t.is(cpWidth(0x1b000), 2)
  t.is(cpWidth(0x17000), 2)
  t.is(cpWidth(0x25fd), 2)
  t.is(cpWidth(0x1f600), 2)
  t.is(cpWidth(0x754c), 2)
})
