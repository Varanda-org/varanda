'use strict'

// The DM wake event: exactly { v: 1, kind: 'dm-wake' }, nothing that names
// a member. No network.
const test = require('brittle')
const { DM_WAKE_COOLDOWN_MS, DM_WAKE_TEXT, validateDmWake } = require('../lib/dm-wake')
const { PUSH_KINDS, validatePushEvent } = require('../lib/push-events')

const A = 'a'.repeat(64)

test('dm-wake: constants', (t) => {
  t.is(DM_WAKE_COOLDOWN_MS, 900000)
  t.is(DM_WAKE_TEXT, 'Pode haver uma mensagem nova na Varanda')
  t.alike(PUSH_KINDS, ['follow', 'reply', 'like', 'repost'])
})

test('dm-wake: only the exact shape is valid', (t) => {
  t.ok(validateDmWake({ v: 1, kind: 'dm-wake' }))
  t.ok(validateDmWake(Object.assign(Object.create(null), { v: 1, kind: 'dm-wake' })))
  t.absent(validateDmWake({ v: 1, kind: 'dm-wake', actor: A }))
  t.absent(validateDmWake({ v: 1, kind: 'dm-wake', recipient: A }))
  t.absent(validateDmWake({ v: 1, kind: 'dm-wake', id: 'x' }))
  t.absent(validateDmWake({ v: 2, kind: 'dm-wake' }))
  t.absent(validateDmWake({ v: '1', kind: 'dm-wake' }))
  t.absent(validateDmWake({ v: 1, kind: 'follow' }))
  t.absent(validateDmWake({ v: 1 }))
  t.absent(validateDmWake({ kind: 'dm-wake' }))
  t.absent(validateDmWake(null))
  t.absent(validateDmWake(undefined))
  t.absent(validateDmWake('dm-wake'))
  t.absent(validateDmWake([1, 'dm-wake']))
  t.absent(validateDmWake(new (class X { constructor () { this.v = 1; this.kind = 'dm-wake' } })()))
})

test('dm-wake: is not a member push event', (t) => {
  t.absent(validatePushEvent({ v: 1, kind: 'dm-wake' }))
})
