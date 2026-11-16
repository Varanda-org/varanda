// Pure rules for the reply draft hand-off between the quick bar and the full
// editor. Serials only grow and one hand-off is active at a time.

// Whether the settle of a hand-off puts the parked composer state back: never
// after an accepted hand-off, and only while the composer still holds that
// very hand-off, so a reply opened meanwhile is not replaced by an older one.
export function restoresParked ({ accepted, restore = true, saved, handoff, reply }) {
  if (!saved || accepted === true || !restore) return false
  return !!reply && reply.handoff === handoff
}

// The highest settled serial stands for every older one.
export function handoffSettled (lastSettled, handoff) {
  return typeof handoff === 'number' && handoff <= lastSettled
}

export function settledAfter (lastSettled, handoff) {
  return typeof handoff === 'number' && handoff > lastSettled ? handoff : lastSettled
}
