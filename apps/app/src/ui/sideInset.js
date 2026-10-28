// The part of a side safe-area inset that a centred column of maxWidth
// `column` does not already clear (0 for no inset, NaN or a wide window).

export function sideInset (inset, width, column) {
  if (!(inset > 0)) return 0
  return Math.max(0, inset - Math.max(0, (width - column) / 2))
}
