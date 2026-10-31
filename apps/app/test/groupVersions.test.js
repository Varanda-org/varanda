'use strict'

const test = require('brittle')
const load = () => import('../src/groupVersions.js')
const GROUP = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

test('group versions start at zero and grow independently without mutating snapshots', async (t) => {
  const { EMPTY_GROUP_VERSIONS, bumpGroupVersion, readGroupVersion } = await load()
  t.ok(Object.isFrozen(EMPTY_GROUP_VERSIONS))
  t.is(readGroupVersion(EMPTY_GROUP_VERSIONS, GROUP), 0)
  t.is(readGroupVersion(EMPTY_GROUP_VERSIONS, 'constructor'), 0)
  const first = Object.freeze(bumpGroupVersion(EMPTY_GROUP_VERSIONS, GROUP))
  const second = Object.freeze(bumpGroupVersion(first, OTHER))
  const third = bumpGroupVersion(second, GROUP)
  t.alike(EMPTY_GROUP_VERSIONS, {})
  t.alike(first, { [GROUP]: 1 })
  t.alike(second, { [GROUP]: 1, [OTHER]: 1 })
  t.alike(third, { [GROUP]: 2, [OTHER]: 1 })
  t.is(readGroupVersion(third, GROUP), 2)
  t.is(readGroupVersion(third, OTHER), 1)
})

test('a burst batched into one render keeps one increment per event', async (t) => {
  const { EMPTY_GROUP_VERSIONS, bumpGroupVersion, readGroupVersion } = await load()
  const before = Object.freeze(bumpGroupVersion(EMPTY_GROUP_VERSIONS, GROUP))
  // React applies queued functional updates to the preceding update's result.
  const updates = [GROUP, OTHER, GROUP, GROUP, OTHER].map((group) => (versions) => bumpGroupVersion(versions, group))
  const rendered = updates.reduce((versions, update) => Object.freeze(update(versions)), before)
  t.alike(rendered, { [GROUP]: 4, [OTHER]: 2 })
  t.is(readGroupVersion(rendered, GROUP) > readGroupVersion(before, GROUP), true)
  t.alike(before, { [GROUP]: 1 })
})

test('sign-out or identity change clears every group, including queued growth', async (t) => {
  const { EMPTY_GROUP_VERSIONS, bumpGroupVersion, clearGroupVersions, readGroupVersion } = await load()
  const previous = Object.freeze(bumpGroupVersion(bumpGroupVersion(EMPTY_GROUP_VERSIONS, GROUP), OTHER))
  const updates = [(versions) => bumpGroupVersion(versions, GROUP), clearGroupVersions]
  const cleared = updates.reduce((versions, update) => update(versions), previous)
  t.is(cleared, EMPTY_GROUP_VERSIONS)
  t.is(readGroupVersion(cleared, GROUP), 0)
  t.is(readGroupVersion(cleared, OTHER), 0)
  t.is(clearGroupVersions(cleared), cleared)
  t.alike(bumpGroupVersion(cleared, OTHER), { [OTHER]: 1 })
  t.alike(previous, { [GROUP]: 1, [OTHER]: 1 })
})

test('missing or malformed groups leave the version map unchanged', async (t) => {
  const { EMPTY_GROUP_VERSIONS, bumpGroupVersion } = await load()
  const state = Object.freeze(bumpGroupVersion(EMPTY_GROUP_VERSIONS, GROUP))
  for (const group of [undefined, null, {}, 1, '', 'a'.repeat(8), 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), '__proto__', 'constructor']) {
    t.is(bumpGroupVersion(state, group), state)
  }
})
