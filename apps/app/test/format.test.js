'use strict'

// The display helpers (src/format.js). It is an ES module bundled by Metro;
// import() loads it here through Node's module syntax detection.
const test = require('brittle')

const load = () => import('../src/format.js')
const NOW = new Date(2026, 9, 23, 12).getTime()

test('handleOf and shortKey lowercase the key', async (t) => {
  const { handleOf, shortKey } = await load()
  t.is(handleOf('E905A4FFFF'), '@e905a4')
  t.is(handleOf(''), '@')
  t.is(handleOf(null), '@')
  t.is(shortKey('E905A4FFFF'), 'e905a4ff')
})

test('atHandle shows a username or falls back to the six-hex key', async (t) => {
  const { atHandle } = await load()
  for (const username of ['ana', 'ana_123', 'u'.repeat(20), 'abcdefg', 'abc12_']) {
    t.is(atHandle(username, 'E905A4FFFF'), '@' + username)
  }
  for (const username of [null, undefined, '', 'an', 'a'.repeat(21), 'Ana', '1ana', 'ana-maria', 'ana maria', '@ana', 'abc123', 'abcdef', '123456', 'josé', '\u001b[31m', 123, {}, ['ana']]) {
    t.is(atHandle(username, 'E905A4FFFF'), '@e905a4')
  }
  t.is(atHandle(null, null), '@')
})

test('initialsOf', async (t) => {
  const { initialsOf } = await load()
  t.is(initialsOf('Marília Prado', 'e9'), 'MP')
  t.is(initialsOf('Seu Nelson', '0f'), 'SN')
  t.is(initialsOf('Bia Carvalho', '16'), 'BC')
  t.is(initialsOf('Helena Dias', 'eb'), 'HD')
  t.is(initialsOf('Bia', '16'), 'BI')
  t.is(initialsOf('ana maria de souza', 'ab'), 'AS')
  t.is(initialsOf('', 'e905a4'), 'E9')
  t.is(initialsOf('   ', 'e905a4'), 'E9')
  t.is(initialsOf(null, 'e905a4'), 'E9')
  t.is(initialsOf('', ''), '?')
})

test('initialsOf keeps an astral first character whole', async (t) => {
  const { initialsOf } = await load()
  const a = initialsOf('\u{1D49C}na Souza', 'ab')
  t.is(a, '\u{1D49C}S')
  t.is(Array.from(a).length, 2)
  // A cased astral letter (Deseret) is upper-cased as one code point.
  t.is(initialsOf('\u{10428}na souza', 'ab'), '\u{10400}S')
})

test('avatarColorOf', async (t) => {
  const { avatarColorOf } = await load()
  t.is(avatarColorOf('e905a4'), 3)
  t.is(avatarColorOf('16aa'), 2)
  t.is(avatarColorOf('0f11'), 0)
  t.is(avatarColorOf('eb22'), 0)
  t.is(avatarColorOf('zz'), 0)
})

test('relativeTime', async (t) => {
  const { relativeTime } = await load()
  t.is(relativeTime(new Date(NOW - 30000).toISOString(), NOW), 'agora')
  t.is(relativeTime(new Date(NOW + 30000).toISOString(), NOW), 'agora')
  t.is(relativeTime(new Date(NOW - 5 * 60000).toISOString(), NOW), '5 min')
  t.is(relativeTime(new Date(NOW - 3600000).toISOString(), NOW), '1 h')
  t.is(relativeTime(new Date(NOW - 23 * 3600000).toISOString(), NOW), '23 h')
  t.is(relativeTime(new Date(2026, 9, 22, 10).toISOString(), NOW), 'ontem')
  t.is(relativeTime(new Date(2026, 9, 12, 9).toISOString(), NOW), '12 out')
  t.is(relativeTime(new Date(2025, 11, 25).toISOString(), NOW), '25 dez 2025')
  t.is(relativeTime('not a date', NOW), null)
  // More than 60 s in the future: the short date, never a negative age.
  t.is(relativeTime(new Date(NOW + 120000).toISOString(), NOW), '23 out')
})

test('sinceText', async (t) => {
  const { sinceText } = await load()
  t.is(sinceText(NOW - 10000, NOW), 'agora')
  t.is(sinceText(NOW - 5 * 60000, NOW), 'há 5 min')
  t.is(sinceText(NOW - 3 * 3600000, NOW), 'há 3 h')
  t.is(sinceText(NOW - 30 * 3600000, NOW), 'há 1 dia')
  t.is(sinceText(NOW - 3 * 86400000, NOW), 'há 3 dias')
})

test('countChars counts code points', async (t) => {
  const { countChars } = await load()
  t.is(countChars('ação'), 4)
  t.is(countChars('\u{1F600}'), 1)
})

test('interpolateStops', async (t) => {
  const { interpolateStops } = await load()
  const stops = [['#f7b267', 0], ['#e8805a', 0.42], ['#8a4e7a', 0.78], ['#2b2a4a', 1]]
  t.alike(interpolateStops(stops, 2), ['#f7b267', '#2b2a4a'])
  t.is(interpolateStops(stops, 7).length, 7)
  // n = 3: the middle sample is t = 0.5, between the stops at 0.42 and 0.78.
  const f = (0.5 - 0.42) / (0.78 - 0.42)
  const mix = (a, b) => Math.round(a + (b - a) * f).toString(16).padStart(2, '0')
  const middle = '#' + mix(0xe8, 0x8a) + mix(0x80, 0x4e) + mix(0x5a, 0x7a)
  t.is(middle, '#d37561')
  t.alike(interpolateStops(stops, 3), ['#f7b267', middle, '#2b2a4a'])
})
