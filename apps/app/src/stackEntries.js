// The pushed screens to render, in one flat list: the live stack plus the
// screen sliding out after a pop, under its old index. React matches keyed
// children only within the same array, so a departing screen rendered as a
// sibling of the mapped stack would remount (losing its state and replaying
// its loads) at the very moment it starts to slide out.

export function stackEntries (stack, leaving) {
  const live = Array.isArray(stack) ? stack : []
  const out = live.map((entry, index) => ({ entry, index }))
  // A leaving index inside the stack means a push already took its place.
  if (leaving && leaving.entry && Number.isInteger(leaving.index) && leaving.index >= live.length) {
    out.push({ entry: leaving.entry, index: leaving.index })
  }
  return out
}
