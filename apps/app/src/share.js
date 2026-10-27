// Sharing helpers receive the browser navigator so they stay usable in tests
// and in runtimes where browser APIs are absent.

export function canShare (nav) {
  return !!nav && typeof nav.share === 'function'
}

export async function copyText (nav, text) {
  if (!nav || !nav.clipboard || typeof nav.clipboard.writeText !== 'function') return false
  try {
    await nav.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export async function shareUrl (nav, { url, title }) {
  if (!canShare(nav)) return 'failed'
  let result
  try {
    // Call before the first await so the browser still sees the click gesture.
    result = nav.share({ title, url })
  } catch {
    return 'failed'
  }
  try {
    await result
    return 'shared'
  } catch (err) {
    return err && err.name === 'AbortError' ? 'cancelled' : 'failed'
  }
}

export function visibleUrl (url) {
  if (typeof url !== 'string') return null
  try {
    return new URL(url).pathname.startsWith('/@') ? url : null
  } catch {
    return null
  }
}
