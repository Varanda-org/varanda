'use strict'

const test = require('brittle')
const { MUTE_MAX } = require('@varanda/rpc')
const { normalizeMutes, mutedKeys, applyMute, mergeMutes } = require('../lib/member-mute')

const key = (i) => i.toString(16).padStart(64, '0')

test('mute list: apply, the same state again, unmute, merge', (t) => {
  let r = applyMute([], key(1), true, 100)
  t.ok(r.changed)
  t.alike([...mutedKeys(r.entries)], [key(1)])
  t.is(applyMute(r.entries, key(1), true, 200).changed, false, 'the same state again')
  t.is(applyMute([], key(2), false, 100).changed, false, 'never muted')
  r = applyMute(r.entries, key(1), false, 50)
  t.ok(r.changed)
  t.is(r.entries[0].t, 101, 'an unmute on a clock behind still ranks above the mute')
  t.is(mutedKeys(r.entries).size, 0)
  t.alike(mergeMutes([{ key: key(1), on: true, t: 100 }], r.entries), r.entries, 'the newer unmute wins the merge')
  t.alike(normalizeMutes([{ key: 'x', on: true, t: 1 }, null]), [], 'invalid entries are left out')
})

test('mute list: its own cap, MUTE_MAX', (t) => {
  t.is(MUTE_MAX, 500)
  let list = []
  for (let i = 0; i < MUTE_MAX; i++) list.push({ key: key(i + 1), on: true, t: i })
  list = normalizeMutes(list)
  t.is(mutedKeys(list).size, MUTE_MAX)
  t.ok(applyMute(list, key(MUTE_MAX + 1), true, 1000).full, 'a new mute past the cap is full')
})
