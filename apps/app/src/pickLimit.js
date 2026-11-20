// How many photos a picker may offer. A composer that keeps one photo (the
// Momento) asks the system for exactly one, so nothing is chosen and then
// dropped silently; the web picker ignores a numeric limit, so one means the
// single-file picker there.
export function pickPlan (max, limit) {
  const n = Number.isInteger(limit) && limit >= 1 && limit < max ? limit : max
  return { single: n === 1, count: n }
}
