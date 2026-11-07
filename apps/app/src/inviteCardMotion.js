// The invite card's open motion, kept pure so a test can pin it: a short
// fade and grow on the splash curve, played once (no loop). Reduced motion
// lands on the end state at once.

export const INVITE_CARD_MS = 420
// The splash entrance curve (src/ui/Splash.js).
export const INVITE_CARD_BEZIER = Object.freeze([0.22, 1, 0.36, 1])

const FROM = { opacity: 0, scale: 0.96 }
const TO = { opacity: 1, scale: 1 }

export function inviteCardMotion (reduced) {
  return reduced === true
    ? { duration: 0, bezier: INVITE_CARD_BEZIER, from: { ...TO }, to: { ...TO } }
    : { duration: INVITE_CARD_MS, bezier: INVITE_CARD_BEZIER, from: { ...FROM }, to: { ...TO } }
}
