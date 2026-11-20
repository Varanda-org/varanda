'use strict'

const test = require('brittle')
const rpc = require('..')
const poll = require('../lib/poll')

test('poll is exported from the package index', (t) => {
  t.is(rpc.poll, poll)
  t.is(rpc.isPoll, poll.isPoll)
  t.is(rpc.isPollOption, poll.isPollOption)
  t.is(rpc.isPick, poll.isPick)
  t.alike([rpc.POLL_MIN, rpc.POLL_MAX, rpc.MAX_POLL_OPTION], [2, 4, 60])
  t.alike([poll.POLL_MIN, poll.POLL_MAX, poll.MAX_POLL_OPTION], [2, 4, 60])
})

test('isPollOption: 1..60 code points on one line that show something', (t) => {
  t.is(poll.isPollOption('Sim'), true)
  t.is(poll.isPollOption('a'.repeat(60)), true, 'at the limit')
  t.is(poll.isPollOption('\u{1f600}'.repeat(60)), true, 'counts code points')
  t.is(poll.isPollOption('a'.repeat(61)), false, 'over the limit')
  t.is(poll.isPollOption('\u{1f600}'.repeat(61)), false)
  t.is(poll.isPollOption(''), false, 'empty')
  for (const blank of [' ', ' \t ', '\u200b', '\u00ad\u2060', '\u3164']) t.is(poll.isPollOption(blank), false, 'blank ' + JSON.stringify(blank))
  t.is(poll.isPollOption('a\u200b'), true, 'visible text with a zero-width char')
  for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u2028b', 'a\u202eb', 'a\u2066b', 'a\ud800b', 'a\udc00', '\ud800']) {
    t.is(poll.isPollOption(bad), false, JSON.stringify(bad))
  }
  for (const bad of [5, null, undefined, {}, ['a'], true]) t.is(poll.isPollOption(bad), false, String(bad))
})

test('isPoll: 2..4 valid options, distinct after trim', (t) => {
  t.is(poll.isPoll(['Sim', 'Não']), true)
  t.is(poll.isPoll(['a', 'b', 'c']), true)
  t.is(poll.isPoll(['a', 'b', 'c', 'd']), true)
  t.is(poll.isPoll(['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60), 'd'.repeat(60)]), true, 'four maximal options')
  t.is(poll.isPoll([]), false, 'no options')
  t.is(poll.isPoll(['a']), false, 'one option')
  t.is(poll.isPoll(['a', 'b', 'c', 'd', 'e']), false, 'five options')
  t.is(poll.isPoll(['a', 'a']), false, 'duplicate')
  t.is(poll.isPoll(['Sim', ' Sim ']), false, 'duplicate after trim')
  t.is(poll.isPoll(['Sim', 'Sim\t']), false, 'duplicate after trimming a tab')
  t.is(poll.isPoll(['Sim', 'sim']), true, 'case is kept')
  t.is(poll.isPoll(['a', '']), false, 'an empty option')
  t.is(poll.isPoll(['a', ' ']), false, 'a blank option')
  t.is(poll.isPoll(['a', 'b\nc']), false, 'a two-line option')
  t.is(poll.isPoll(['a', 'b'.repeat(61)]), false, 'an option over the limit')
  t.is(poll.isPoll(['a', 5]), false, 'a number')
  t.is(poll.isPoll(['a', null]), false, 'null')
  // eslint-disable-next-line no-sparse-arrays
  t.is(poll.isPoll(['a', , 'c']), false, 'sparse')
  for (const bad of [null, undefined, 'a,b', { 0: 'a', 1: 'b', length: 2 }, 2]) t.is(poll.isPoll(bad), false, JSON.stringify(bad))
  const hostile = ['a', 'b']
  Object.defineProperty(hostile, 1, { get () { throw new Error('boom') } })
  t.is(poll.isPoll(hostile), false, 'a throwing getter is no poll')
})

test('isPoll: options that look the same are one option twice', (t) => {
  t.is(poll.isPoll(['Sim', 'Sim\u200b']), false, 'a trailing zero-width space')
  t.is(poll.isPoll(['Sim', '\u200bSim']), false, 'a leading zero-width space')
  t.is(poll.isPoll(['Sim', 'S\u00adim']), false, 'a soft hyphen inside')
  t.is(poll.isPoll(['Sim', 'Sim\u2060']), false, 'a word joiner')
  t.is(poll.isPoll(['Sim', 'Sim\udb40\udc41']), false, 'a tag character')
  t.is(poll.isPoll(['Sim agora', 'Sim  agora']), false, 'a run of spaces inside')
  t.is(poll.isPoll(['Sim agora', 'Sim\u00a0agora']), false, 'a no-break space inside')
  t.is(poll.isPoll(['Sim', '\uff33\uff49\uff4d']), false, 'fullwidth letters')
  t.is(poll.isPoll(['Não', 'Na\u0303o']), false, 'a decomposed accent')
  t.is(poll.isPoll(['Sim', 'Sim!']), true, 'different text stays distinct')
  t.is(poll.isPoll(['Sim', 'Sim\u200b', 'Não']), false, 'with a third option')
  t.is(poll.pollKey(' S\u00adim\u200b  agora '), 'Sim agora')
})

test('isPick: null or an option index', (t) => {
  for (const v of [null, 0, 1, 2, 3]) t.is(poll.isPick(v), true, String(v))
  for (const v of [-1, 4, 1.5, '0', NaN, Infinity, undefined, true, [0], {}]) t.is(poll.isPick(v), false, String(v))
  t.is(poll.isPick(1, 2), true, 'within a two-option poll')
  t.is(poll.isPick(2, 2), false, 'outside a two-option poll')
  t.is(poll.isPick(null, 2), true)
  t.is(poll.isPick(3, 9), true, 'count is capped at POLL_MAX')
  t.is(poll.isPick(4, 9), false)
  t.is(poll.isPick(0, 'x'), true, 'a bad count means POLL_MAX')
  t.is(poll.isPick(3, 'x'), true)
  t.is(poll.isPick(4, 'x'), false)
})
