'use strict'

const test = require('brittle')
const load = () => import('../src/replyHandoff.js')
const saved = { reply: null, quote: { ref: 'q' } }

test('parked state returns only while the composer still holds that hand-off', async (t) => {
  const { restoresParked } = await load()
  t.ok(restoresParked({ accepted: false, saved, handoff: 4, reply: { handoff: 4 } }), 'same hand-off restores')
  t.absent(restoresParked({ accepted: false, saved, handoff: 4, reply: { handoff: 5 } }), 'a newer reply stays')
  t.absent(restoresParked({ accepted: false, saved, handoff: 4, reply: { ref: 'r' } }), 'a reply without a hand-off stays')
  t.absent(restoresParked({ accepted: false, saved, handoff: 4, reply: null }), 'a cleared reply is not brought back')
  t.absent(restoresParked({ accepted: true, saved, handoff: 4, reply: { handoff: 4 } }), 'accepted never restores')
  t.absent(restoresParked({ accepted: false, restore: false, saved, handoff: 4, reply: { handoff: 4 } }), 'a lock never restores')
  t.absent(restoresParked({ accepted: false, saved: null, handoff: 4, reply: { handoff: 4 } }), 'nothing parked')
})

test('settled hand-offs are one number: pending when new, settled after, older stay settled', async (t) => {
  const { handoffSettled, settledAfter } = await load()
  let last = 0
  t.absent(handoffSettled(last, 1), 'a new hand-off is pending')
  last = settledAfter(last, 1)
  t.ok(handoffSettled(last, 1), 'settled after the settle')
  t.absent(handoffSettled(last, 2), 'the next one is pending again')
  last = settledAfter(last, 3)
  t.ok(handoffSettled(last, 2), 'an older serial stays settled')
  t.is(settledAfter(last, 2), 3, 'an older settle never lowers it')
  t.is(typeof last, 'number', 'memory is one number')
  t.absent(handoffSettled(last, undefined), 'a reply without a serial is pending')
  t.is(settledAfter(last, undefined), 3)
})
