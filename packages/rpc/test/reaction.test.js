'use strict'

const test = require('brittle')
const { isReaction, REACTION_MAX_POINTS, REACTION_MAX_BYTES } = require('@varanda/rpc')

test('isReaction: one emoji of every shape', (t) => {
  t.is(REACTION_MAX_POINTS, 8)
  t.is(REACTION_MAX_BYTES, 40)
  const good = [
    '\u{1f600}', // grinning face
    '❤️', // red heart with VS16
    '❤', // red heart, text default
    '\u{1f44d}\u{1f3fd}', // thumbs up, skin tone
    '\u{1f44d}\u{1f3fd}️',
    '\u{1f1e7}\u{1f1f7}', // flag BR
    '1️⃣', // keycap 1
    '#⃣',
    '*️⃣',
    '\u{1f3f3}️‍\u{1f308}', // rainbow flag
    '\u{1f469}\u{1f3fd}‍\u{1f4bb}', // woman technologist, skin tone
    '\u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466}', // family, 7 code points
    '\u{1f9d1}\u{1f3fb}‍\u{1f91d}‍\u{1f9d1}\u{1f3ff}', // people holding hands, 7
    '\u{1f525}', '\u{1f602}', '\u{1f62e}', '\u{1f622}', '\u{1f64f}', '\u{1fae0}'
  ]
  for (const s of good) t.ok(isReaction(s), JSON.stringify(s))
})

test('isReaction: rejects text, whitespace, controls and more than one emoji', (t) => {
  const bad = [
    undefined, null, 0, 1, true, {}, [], ['\u{1f600}'], new String('\u{1f600}'), // eslint-disable-line no-new-wrappers
    '', ' ', 'a', 'ok', '1', '#', '\u{1f600} ', ' \u{1f600}', '\u{1f600}\n', '\u{1f600}\u0000',
    '\u{1f600}\u{1f600}', // two emojis
    '\u{1f1e7}', // lone regional indicator
    '\u{1f1e7}\u{1f1f7}\u{1f1e7}\u{1f1f7}', // two flags
    '\u{1f1e7}\u{1f600}',
    '\u{1f3fd}', // lone skin tone
    '️', '‍', '⃣',
    '\u{1f600}‍', // dangling joiner
    '‍\u{1f600}',
    '\u{1f600}‍‍\u{1f600}',
    '1️', '1⃣⃣', 'a⃣',
    '\u{1f600}️\u{1f3fd}', // skin tone after VS16
    '\u{1f600}a', 'a\u{1f600}',
    '\u{1f600}‮', // bidi override
    '\u{1f600}\u{e0067}', // tag character
    '\ud83d', '\ude00', '\ud83d\u{1f600}', // lone surrogates
    'é', '́', '一', // letters and marks
    '\u{1f468}‍\u{1f469}‍\u{1f467}‍\u{1f466}‍\u{1f466}', // 9 code points
    '\u{1f9d1}\u{1f3fb}‍\u{1f91d}‍\u{1f9d1}\u{1f3ff}‍\u{1f600}' // 9 code points
  ]
  for (const s of bad) t.absent(isReaction(s), JSON.stringify(String(s)))
})

test('isReaction: byte bound holds even within the code point bound', (t) => {
  // 8 code points: 4 pictographs (4 bytes each) and 3 joiners (3 bytes) plus
  // one skin tone (4 bytes) = 16 + 9 + 4 = 29 bytes, under 40.
  const s = '\u{1f469}\u{1f3fd}‍\u{1f469}‍\u{1f467}‍\u{1f466}'
  t.ok(isReaction(s))
  t.ok(Buffer.byteLength(s) <= REACTION_MAX_BYTES)
  t.absent(isReaction('\u{1f600}'.repeat(30)))
  t.absent(isReaction('x'.repeat(1e6)))
})

test('isReaction: never throws on hostile input', (t) => {
  const hostile = { toString () { throw new Error('boom') } }
  t.absent(isReaction(hostile))
  t.absent(isReaction(Symbol('x')))
})

test('isReaction: no single code point it accepts is a letter, number, separator, control, format or private use', (t) => {
  const banned = /[\p{L}\p{N}\p{Z}\p{Cc}\p{Cf}\p{Co}]/u
  let accepted = 0
  const bad = []
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue
    const s = String.fromCodePoint(cp)
    if (!isReaction(s)) continue
    accepted++
    if (banned.test(s)) bad.push(cp.toString(16))
  }
  t.ok(accepted > 3000, accepted + ' single code points accepted')
  // U+2139 INFORMATION SOURCE is an emoji (Extended_Pictographic) that
  // Unicode classes as a lowercase letter.
  t.alike(bad, ['2139'], 'only U+2139')
})
