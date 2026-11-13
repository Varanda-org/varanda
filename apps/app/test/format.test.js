'use strict'

// The display helpers (src/format.js). It is an ES module bundled by Metro;
// import() loads it here through Node's module syntax detection.
const test = require('brittle')

const load = () => import('../src/format.js')
const NOW = new Date(2026, 9, 23, 12).getTime()

test('shortKey lowercases the key', async (t) => {
  const { shortKey } = await load()
  t.is(shortKey('E905A4FFFF'), 'e905a4ff')
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

test('formatCount speaks a pt-BR compact count', async (t) => {
  const { formatCount } = await load()
  t.is(formatCount(0), '0')
  t.is(formatCount(-0), '0')
  t.is(formatCount(1), '1')
  t.is(formatCount(999), '999')
  t.is(formatCount(1000), '1 mil')
  t.is(formatCount(1499), '1,5 mil')
  t.is(formatCount(1500), '1,5 mil')
  t.is(formatCount(1049), '1 mil')
  t.is(formatCount(1050), '1,1 mil')
  t.is(formatCount(999949), '999,9 mil')
  t.is(formatCount(999950), '1 mi')
  t.is(formatCount(1200000), '1,2 mi')
  t.is(formatCount(2000000), '2 mi')
  t.is(formatCount(1000000000), '1 bi')
  t.is(formatCount(1000000000000), '1 tri')
  t.is(formatCount(1.5), '1,5')
  t.is(formatCount(999.95), '1 mil')
  t.is(formatCount(null), null)
  t.is(formatCount(undefined), null)
  t.is(formatCount(-1), null)
  t.is(formatCount(Number.NaN), null)
  t.is(formatCount(Number.POSITIVE_INFINITY), null)
  t.is(formatCount(Number.NEGATIVE_INFINITY), null)
  t.is(formatCount('10'), null)
})

test('compactTime', async (t) => {
  const { compactTime } = await load()
  t.is(compactTime(NOW - 5 * 60000, NOW), '5min')
  t.is(compactTime(NOW - 3 * 3600000, NOW), '3h')
  t.is(compactTime(NOW - 2 * 86400000, NOW), '2d')
  t.is(compactTime(NOW - 59999, NOW), null)
  t.is(compactTime(NOW, NOW), null)
  t.is(compactTime(NOW - 60000, NOW), '1min')
  t.is(compactTime(NOW - 59 * 60000, NOW), '59min')
  t.is(compactTime(NOW - 60 * 60000, NOW), '1h')
  t.is(compactTime(NOW - 23 * 3600000, NOW), '23h')
  t.is(compactTime(NOW - 24 * 3600000, NOW), '1d')
  t.is(compactTime(new Date(NOW - 5 * 60000).toISOString(), NOW), '5min')
  t.is(compactTime(new Date(NOW - 3 * 3600000), NOW), '3h')
  t.is(compactTime(NOW + 60000, NOW), null)
  t.is(compactTime('not a date', NOW), null)
  t.is(compactTime(NOW, Number.NaN), null)
})

test('dayHeading names today, yesterday and older days', async (t) => {
  const { dayHeading } = await load()
  t.is(dayHeading(new Date(2026, 9, 23, 0, 5).toISOString(), NOW), 'hoje')
  t.is(dayHeading(new Date(2026, 9, 22, 23, 59).toISOString(), NOW), 'ontem')
  t.is(dayHeading(new Date(2026, 9, 3, 9).toISOString(), NOW), '3 out')
  t.is(dayHeading(new Date(2025, 9, 3, 9).toISOString(), NOW), '3 out 2025')
  t.is(dayHeading('nope', NOW), null)
})
