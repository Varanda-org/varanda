// The height a growing text field takes for its content: the content height
// rounded up, kept between the field's own minimum and maximum. A value that
// is not a number answers the minimum.
export function growHeight (contentHeight, min, max) {
  if (typeof contentHeight !== 'number' || !Number.isFinite(contentHeight)) return min
  return Math.min(max, Math.max(min, Math.ceil(contentHeight)))
}
