// The height a growing text field takes for its content: the content height
// rounded up, kept between the field's own minimum and maximum. A value that
// is not a number answers the minimum.
export function growHeight (contentHeight, min, max) {
  if (typeof contentHeight !== 'number' || !Number.isFinite(contentHeight)) return min
  return Math.min(max, Math.max(min, Math.ceil(contentHeight)))
}

// A multiline form field is `lines` tall at the least and FIELD_MAX_LINES at
// the most; past that the text scrolls inside the box, so a pasted text never
// pushes the rest of a form out of reach.
export const FIELD_MAX_LINES = 6

export function fieldBounds (lines) {
  return { minHeight: lines * 22 + 20, maxHeight: Math.max(lines, FIELD_MAX_LINES) * 22 + 20 }
}

export function fieldFull (height, max) {
  return typeof height === 'number' && height >= max - 0.5
}
