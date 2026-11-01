// Without clipboard access, selecting the element's text lets the system menu
// copy it. True when the selection was applied.
export function selectContents (node) {
  try {
    const doc = globalThis.document
    if (!node || !doc || typeof globalThis.Node !== 'function' || !(node instanceof globalThis.Node)) return false
    const range = doc.createRange()
    range.selectNodeContents(node)
    const sel = globalThis.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    return true
  } catch {
    return false
  }
}
