'use strict'

const test = require('brittle')
const { feedWidth } = require('../lib/commands/member')

test('feedWidth: TTY columns, 80 when not a TTY, floor of 20', async (t) => {
  t.is(feedWidth({ isTTY: true, columns: 120 }), 120)
  t.is(feedWidth({ isTTY: false, columns: 120 }), 80)
  t.is(feedWidth({}), 80)
  t.is(feedWidth({ isTTY: true }), 80)
  t.is(feedWidth({ isTTY: true, columns: 5 }), 20)
})
