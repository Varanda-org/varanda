// apps/app/scripts/pre-splash.js generates the overlay CSS in
// apps/app/public/index.html from this module so it matches before the bundle runs.

export const SPLASH_WORD = 'Varanda'
export const SPLASH_LABEL = 'Varanda, carregando'
// The progress bar under the name (it replaced the 'conectando…' hint).
export const BAR_WIDTH = 120
export const BAR_MS = 400
export const PULSE_MS = 1200
export const ENTRANCE_MS = 1280
export const SLIDES = { near: { tile: 96, ms: 4800 }, far: { tile: 128, ms: 20800 } }

const GROUND_FROM = { opacity: 0, translateY: 24 }
const GROUND_TO = { opacity: 1, translateY: 0 }
const VARANDA_FROM = { opacity: 0, translateY: 12 }
const VARANDA_TO = { opacity: 1, translateY: 0 }
const CHAIR_FROM = { opacity: 0, translateY: 28, scale: 0.92, rotate: -6 }
const CHAIR_TO = { opacity: 1, translateY: 0, scale: 1, rotate: 0 }
const LETTER_FROM = { opacity: 0, translateY: 8 }
const LETTER_TO = { opacity: 1, translateY: 0 }
const HINT_FROM = { opacity: 0 }
const HINT_TO = { opacity: 1 }

export function splashMotion (reduced) {
  const step = (delay, duration, from, to) => reduced === true
    ? { delay: 0, duration: 0, from: { ...to }, to: { ...to } }
    : { delay, duration, from: { ...from }, to: { ...to } }
  return {
    ground: step(0, 360, GROUND_FROM, GROUND_TO),
    varanda: step(120, 420, VARANDA_FROM, VARANDA_TO),
    chair: step(260, 700, CHAIR_FROM, CHAIR_TO),
    letters: Array.from(SPLASH_WORD, (_, i) => step(520 + i * 40, 280, LETTER_FROM, LETTER_TO)),
    hint: step(960, 320, HINT_FROM, HINT_TO)
  }
}

export function slideMotion (reduced) {
  return reduced === true ? null : SLIDES
}

// The sky's flyers. Each bird crosses the whole width once per `ms`, starts
// `phase` of the way across (so the three are spread out from the first
// frame) and bobs `bobs` whole times per crossing, which keeps the bob
// seamless when the crossing loops. The butterfly flaps (scaleX 1 to `fold`)
// once per `flapMs` while it drifts a figure of eight, `dx` by `dy`, per
// `driftMs`.
export const FLYERS = {
  birds: [
    { ms: 34000, phase: 0.12, bobs: 10, bob: 3 },
    { ms: 29000, phase: 0.48, bobs: 8, bob: 3 },
    { ms: 38000, phase: 0.8, bobs: 12, bob: 3 }
  ],
  butterfly: { flapMs: 240, fold: 0.35, driftMs: 6000, dx: 24, dy: 10 }
}

export function flyerMotion (reduced) {
  return reduced === true ? null : FLYERS
}

// Samples of a sine over one loop (0..1), so a linear interpolation through
// them (Animated.interpolate, CSS keyframes) traces a smooth enough curve.
function wave (n, cycles, amp) {
  const input = []
  const output = []
  for (let i = 0; i <= n; i++) {
    input.push(i / n)
    const v = Math.round(amp * Math.sin(2 * Math.PI * cycles * i / n) * 100) / 100
    output.push(v === 0 ? 0 : v)
  }
  return { input, output }
}

// A bird's vertical bob over one crossing, rest (0) at both ends.
export function birdBob (bird) {
  return wave(bird.bobs * 8, bird.bobs, -bird.bob)
}

// The butterfly's drift over one loop: x one sine, y two, so it traces a
// figure of eight through its rest point.
export function butterflyDrift (b) {
  const x = wave(16, 1, b.dx)
  const y = wave(16, 2, -b.dy)
  return { input: x.input, x: x.output, y: y.output }
}
