export function minEditText (post) {
  return Array.isArray(post?.media) && post.media.length > 0 && !post.quote ? 0 : 1
}

export function canSaveEdit (text, post, current) {
  if (typeof text !== 'string' || text === current) return false
  const chars = Array.from(text)
  if (chars.length < minEditText(post) || chars.length > 1000) return false
  return !chars.some((ch) => {
    const cp = ch.codePointAt(0)
    return (cp < 0x20 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f) ||
      cp === 0x2028 || cp === 0x2029 || (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069)
  })
}

// The row patched right after a save must read like the node's copy
// (packages/core/lib/post-edit.js withText): a link card whose URL left the
// text is dropped there, so it must not linger here until the next read.
export function editedRecord (record, text) {
  const next = { ...record, text }
  if (next.preview && typeof next.preview.url === 'string' && !text.includes(next.preview.url)) delete next.preview
  return next
}
