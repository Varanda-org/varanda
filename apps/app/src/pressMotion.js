export const PRESSED_OPACITY = 0.7

export function pressScale ({ pressed, reduceMotion }) {
  return pressed && !reduceMotion ? 0.97 : 1
}

export function pressTiming (reduceMotion, ms) {
  return reduceMotion ? 0 : ms
}
