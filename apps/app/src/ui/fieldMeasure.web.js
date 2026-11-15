// Web only: react-native-web fires onContentSizeChange for a multiline field
// when text is typed, but never when the content shrinks (deleting text, a
// clear): the textarea keeps its size, so nothing observes the content. A
// growing field reads the textarea's scrollHeight instead. The height is set
// to 0 for the read, not auto: a textarea without rows is two rows tall by
// default, so auto would never report less than two lines. The height is put
// back before the browser paints, and the scroll position of every scrolling
// ancestor too: shrinking the field briefly shortens the sheet's content,
// which would clamp (and so move) the scroll. `extra` is what scrollHeight
// leaves out (a border on both sides). Null when `el` is not a textarea.
import { growHeight } from './fieldHeight.js'

function scrollOffsets (el) {
  const saved = []
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (typeof node.scrollTop === 'number' && node.scrollTop > 0) saved.push([node, node.scrollTop])
  }
  return saved
}

export function measureField (el, min, max, extra = 0) {
  if (!el || !el.style || typeof el.scrollHeight !== 'number') return null
  const was = el.style.height
  const offsets = scrollOffsets(el)
  try {
    el.style.height = '0px'
    return growHeight(el.scrollHeight + extra, min, max)
  } finally {
    el.style.height = was
    for (const [node, top] of offsets) node.scrollTop = top
  }
}
