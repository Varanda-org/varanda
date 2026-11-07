// Chrome lets a container that scrolls take focus. react-native-web's Modal
// focus trap gives focus to the first (or, for Shift+Tab, the last) node that
// accepts it, so it stopped on a sheet's scrolling body or a long menu's row
// list and drew a ring around all of it. Blurring such a node in the same
// focus event makes the trap move on to the next real control.

// Form controls and editable text keep focus even when their text overflows:
// react-native-web renders TextInput with no role or tabindex.
const CONTROLS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'])

function isPlainScroller (node) {
  if (!node || typeof node.getAttribute !== 'function') return false
  if (CONTROLS.has(node.tagName) || node.isContentEditable === true) return false
  if (node.hasAttribute('role') || node.hasAttribute('tabindex')) return false
  return node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth
}

export const scrollerFocusProps = {
  onFocus (event) {
    const node = event && event.target
    if (isPlainScroller(node) && typeof node.blur === 'function') node.blur()
  }
}

export { isPlainScroller }
