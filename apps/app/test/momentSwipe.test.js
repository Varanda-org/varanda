'use strict'

const test = require('brittle')

test('momentSwipe only dismisses a dominant downward movement past 12 points', async (t) => {
  const { momentSwipe } = await import('../src/momentSwipe.js')
  t.is(momentSwipe({ dx: 0, dy: 12 }), null)
  t.is(momentSwipe({ dx: 0, dy: 13 }), 'down')
  t.is(momentSwipe({ dx: 0, dy: -100 }), null)
  for (const dx of [-10, 10]) {
    t.is(momentSwipe({ dx, dy: 15 }), null, 'exact dominance boundary')
    t.is(momentSwipe({ dx, dy: 16 }), 'down')
  }
})

test('momentSwipe changes person only past 48 points and the horizontal dominance boundary', async (t) => {
  const { momentSwipe } = await import('../src/momentSwipe.js')
  for (const sign of [-1, 1]) {
    const direction = sign < 0 ? 'next' : 'prev'
    t.is(momentSwipe({ dx: sign * 48, dy: 0 }), null)
    t.is(momentSwipe({ dx: sign * 49, dy: 0 }), direction)
    for (const dy of [-40, 40]) {
      t.is(momentSwipe({ dx: sign * 60, dy }), null, 'exact dominance boundary')
      t.is(momentSwipe({ dx: sign * 61, dy }), direction)
    }
  }
})

test('momentSwipe ignores taps, small movements and ambiguous diagonals', async (t) => {
  const { momentSwipe } = await import('../src/momentSwipe.js')
  for (const [dx, dy] of [[0, 0], [10, 10], [-10, -10], [100, 100], [-100, 100], [100, -100], [-100, -100]]) {
    t.is(momentSwipe({ dx, dy }), null)
  }
})

test('swipeRelease keeps the claimed axis', async (t) => {
  const { swipeRelease } = await import('../src/momentSwipe.js')
  t.is(swipeRelease('down', { dx: 70, dy: 90, vy: 1 }, 100), 'close', 'a flick after sideways drift still closes')
  t.is(swipeRelease('down', { dx: 0, dy: 101, vy: 0 }, 100), 'close')
  t.is(swipeRelease('down', { dx: 0, dy: 100, vy: 0.8 }, 100), null, 'short and slow settles back')
  t.is(swipeRelease('down', { dx: -200, dy: 50, vy: 0 }, 100), null, 'a dismiss drag never changes person')
  t.is(swipeRelease('next', { dx: -200, dy: 150, vy: 2 }, 100), 'next', 'a sideways drag never closes')
  t.is(swipeRelease('next', { dx: -40, dy: 0, vy: 0 }, 100), null, 'pulled back under 48 points cancels')
  t.is(swipeRelease('next', { dx: 60, dy: 0, vy: 0 }, 100), 'prev', 'the release direction wins on the same axis')
  t.is(swipeRelease('prev', { dx: 49, dy: 0, vy: 0 }, 100), 'prev')
  t.is(swipeRelease(null, { dx: 300, dy: 300, vy: 3 }, 100), null, 'an unclaimed drag does nothing')
})

test('swipeTotal adds back the movement the capture saw', async (t) => {
  const { swipeRelease, swipeTotal } = await import('../src/momentSwipe.js')
  t.alike(swipeTotal({ dx: -50, dy: 4 }, { dx: -30, dy: 2, vy: 0.3 }), { dx: -80, dy: 6, vy: 0.3 })
  t.is(swipeRelease('next', swipeTotal({ dx: -50, dy: 0 }, { dx: -30, dy: 0, vy: 0 }), 100), 'next', 'claimed at 50, released at 80: changes person')
  t.is(swipeRelease('next', swipeTotal({ dx: -50, dy: 0 }, { dx: 50, dy: 0, vy: 0 }), 100), null, 'back to the start: no move, never the opposite person')
  t.is(swipeRelease('down', swipeTotal({ dx: 0, dy: 20 }, { dx: 0, dy: 85, vy: 0 }), 100), 'close', 'the whole drag counts toward closing')
})
