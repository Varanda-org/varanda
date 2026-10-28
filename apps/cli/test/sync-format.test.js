const test = require('brittle')
const { formatEvent } = require('../lib/commands/sync')

test('formatEvent escapes control characters in peer-derived strings', (t) => {
  const k = 'ab'.repeat(32)
  t.is(formatEvent({ event: 'rejected', key: k, reason: 'x\u001b[31m' }), 'rejected ' + k + ' x\\u{1b}[31m')
  t.is(formatEvent({ event: 'withdrawn', key: k, peerKey: k, reason: 'a\nadmitted' }), 'withdrawn ' + k + ' abababab a\\u{a}admitted')
  t.is(formatEvent({ event: 'peer', role: 'member\u2028x', peerKey: '\u007f' + k, verified: false }), 'peer member\\u{2028}x \\u{7f}abababa')
  t.is(formatEvent({ event: 'rejected', key: k, reason: 'bidi\u202e' }), 'rejected ' + k + ' bidi\\u{202e}')
})

test('formatEvent lines', (t) => {
  const k = 'ab'.repeat(32)
  t.is(formatEvent({ event: 'ready', topic: k }), 'sync ready')
  t.is(formatEvent({ event: 'peer', role: 'member', peerKey: k, verified: false }), 'peer member abababab')
  t.is(formatEvent({ event: 'peer', role: 'seeder', peerKey: k, verified: true }), 'peer seeder abababab')
  t.is(formatEvent({ event: 'peer', role: 'seeder', peerKey: k, verified: false }), 'peer seeder abababab não verificado')
  t.is(formatEvent({ event: 'admitted', key: k, length: 3 }), 'admitted ' + k + ' 3')
  t.is(formatEvent({ event: 'rejected', key: k, reason: 'timeout' }), 'rejected ' + k + ' timeout')
  t.is(formatEvent({ event: 'withdrawn', key: k, peerKey: k, reason: 'not-in-log' }), 'withdrawn ' + k + ' abababab not-in-log')
  t.is(formatEvent({ event: 'have', key: k, length: 2 }), 'have ' + k + ' 2')
  t.is(formatEvent({ event: 'downloaded', key: k, length: 2 }), 'downloaded ' + k + ' 2')
})
