'use strict'

const test = require('brittle')

const load = () => import('../src/profileBar.js')

test('profile bar leaves the top and pull-to-refresh unchanged', async (t) => {
  const { profileBarState } = await load()
  for (const inset of [0, 24, 47, 59]) {
    for (const reduce of [false, true]) {
      for (const y of [-80, 0]) {
        t.alike(profileBarState(y, inset + 96, reduce, inset + 42), { opacity: 0, interactive: false })
        t.alike(profileBarState(y, inset + 96, reduce, inset + 84), { opacity: 0, interactive: false })
      }
    }
  }
})

test('member back is opaque and interactive before the header back leaves', async (t) => {
  const { profileBarState } = await load()
  for (const inset of [0, 24, 47, 59]) {
    for (const reduce of [false, true]) {
      for (const y of [inset + 38, inset + 42, inset + 52]) {
        t.alike(profileBarState(y, inset + 96, reduce, inset + 42), { opacity: 1, interactive: true })
      }
      t.is(profileBarState(inset + 37, inset + 96, reduce, inset + 42).interactive, false)
    }
  }
})

test('diary controls use their own position near the band bottom', async (t) => {
  const { profileBarState } = await load()
  t.alike(profileBarState(80, 96, false, 84), { opacity: 1, interactive: true })
  t.is(profileBarState(79, 96, false, 84).interactive, false)
  t.is(profileBarState(42, 96, false, 84).interactive, false)
  for (const inset of [0, 24, 47, 59]) {
    for (const reduce of [false, true]) {
      t.alike(profileBarState(inset + 84, inset + 96, reduce, inset + 84), { opacity: 1, interactive: true })
    }
  }
})

test('fade is linear and reduced motion snaps at the same handoff', async (t) => {
  const { profileBarState } = await load()
  t.alike(profileBarState(19, 96, false, 42), { opacity: 0.5, interactive: false })
  t.alike(profileBarState(19, 96, true, 42), { opacity: 0, interactive: false })
  t.alike(profileBarState(37.99, 96, true, 42), { opacity: 0, interactive: false })
  t.alike(profileBarState(38, 96, true, 42), { opacity: 1, interactive: true })
  for (const y of [200, 38, 37, 19, 0, -10]) {
    const state = profileBarState(y, 96, false, 42)
    t.is(state.interactive, state.opacity === 1, 'scrolling back also hands controls back to the header')
    t.ok(state.opacity >= 0 && state.opacity <= 1)
  }
})

test('invalid metrics keep the bar hidden', async (t) => {
  const { profileBarState } = await load()
  for (const bad of [NaN, Infinity, undefined, '42']) {
    t.alike(profileBarState(bad, 96, false, 42), { opacity: 0, interactive: false })
    t.alike(profileBarState(100, bad, false, 42), { opacity: 0, interactive: false })
  }
  for (const bad of [NaN, Infinity, 0, -1, '42']) {
    t.alike(profileBarState(100, 96, false, bad), { opacity: 0, interactive: false })
  }
})
