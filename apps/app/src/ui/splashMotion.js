// Timings of the splash choreography, kept pure so a test can pin them.
// apps/app/public/index.html repeats these numbers in CSS because the static
// shell paints before the bundle runs, so change both together.

export const SPLASH_WORD = 'Varanda'
export const SPLASH_HINT = 'conectando…'
export const SPLASH_LABEL = 'Varanda, conectando'
export const PULSE_MS = 1200
export const ENTRANCE_MS = 1180

const CHAIR_FROM = { opacity: 0, translateY: 16, scale: 0.92, rotate: -6 }
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
    chair: step(0, 700, CHAIR_FROM, CHAIR_TO),
    letters: Array.from(SPLASH_WORD, (_, i) => step(420 + i * 40, 280, LETTER_FROM, LETTER_TO)),
    hint: step(860, 320, HINT_FROM, HINT_TO)
  }
}
