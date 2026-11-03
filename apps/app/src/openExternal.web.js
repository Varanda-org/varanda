// Opens a page outside the app. Called straight from the tap, before any
// await, so the browser counts it as the person's own action.
export function openExternal (url) {
  try { globalThis.open(url, '_blank', 'noopener') } catch {}
}

export function linkProps (url) {
  return { href: url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } }
}
