// The composer's height floor from its text alone: one line per line break.
// Android reports a new content size when the text is typed, not when code
// sets it (a code block from the format row), so without the floor the field
// stays one line tall and hides the fences. Wrapped lines are not counted:
// the measured height covers those. Pure, so tests load it alone.
export function heightFloor (text, { line, pad, maxLines }) {
  const lines = typeof text === 'string' ? text.split('\n').length : 1
  return Math.min(maxLines, lines) * line + pad * 2
}
