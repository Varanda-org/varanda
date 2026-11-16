// Hit slop that lifts a small target to the 44 pt minimum without moving
// anything. Pure, so tests load it alone.
export const HIT = 44

// The deficit is split evenly, then a side that has no free room (a
// neighbour's target starts there) gives what it cannot take to the opposite
// side, which keeps whatever room it has. A side with no room stays at 0.
function axis (size, before, after, min) {
  const need = Number.isFinite(size) ? Math.max(0, Math.ceil(min - size)) : 0
  const a = Math.min(Math.ceil(need / 2), before)
  const b = Math.min(need - a, after)
  const c = Math.min(need - b, before)
  return [c, b]
}

// size: {width, height} of the element as laid out. room: how far each side may
// reach before it would sit on another target; omitted sides are unlimited.
export function hitSlopFor (size, room = {}, min = HIT) {
  const open = (side) => Number.isFinite(room[side]) ? Math.max(0, room[side]) : Infinity
  const [top, bottom] = axis(size.height, open('top'), open('bottom'), min)
  const [left, right] = axis(size.width, open('left'), open('right'), min)
  return { top, bottom, left, right }
}
