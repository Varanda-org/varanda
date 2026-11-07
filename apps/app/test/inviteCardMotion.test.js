'use strict'

// The invite card open motion (src/inviteCardMotion.js), a pure ES module;
// import() loads it here through Node's module syntax detection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/inviteCardMotion.js')

test('inviteCardMotion: fades and grows in 420 ms on the splash curve', async (t) => {
  const { inviteCardMotion, INVITE_CARD_MS } = await load()
  const m = inviteCardMotion(false)
  t.is(INVITE_CARD_MS, 420)
  t.is(m.duration, 420)
  t.alike(m.from, { opacity: 0, scale: 0.96 })
  t.alike(m.to, { opacity: 1, scale: 1 })
  t.alike([...m.bezier], [0.22, 1, 0.36, 1])
  t.alike(inviteCardMotion(undefined), m, 'anything but true plays the motion')
})

test('inviteCardMotion: reduced motion settles at the end state', async (t) => {
  const { inviteCardMotion } = await load()
  const m = inviteCardMotion(true)
  t.is(m.duration, 0)
  t.alike(m.from, { opacity: 1, scale: 1 })
  t.alike(m.to, { opacity: 1, scale: 1 })
})

test('inviteCardMotion: each call is a fresh copy', async (t) => {
  const { inviteCardMotion } = await load()
  const a = inviteCardMotion(false)
  a.from.opacity = 1
  t.is(inviteCardMotion(false).from.opacity, 0)
})

test('InviteCard: plays the motion once, never in a loop', (t) => {
  const src = fs.readFileSync(path.join(__dirname, '../src/ui/InviteCard.js'), 'utf8')
  t.ok(src.includes('inviteCardMotion('), 'uses the pure motion')
  t.ok(src.includes('useReduceMotion'), 'follows reduced motion')
  t.ok(src.includes('Easing.bezier(...m.bezier)'), 'splash curve')
  t.absent(src.includes('Animated.loop'), 'no loop')
  t.absent(src.includes('Platform'), 'no Platform')
})
