// Web: a link preview through the account service's proxy
// (previewService.js), since the page cannot read other sites and the site
// then sees the service's address, never the member's. Hosted only (the
// service is the page's own origin) and only while the service's policy is
// on.
// Shared code imports './previewBuild'; previewBuild.native.js has the same
// export. Only called while "Prévia de links" is on (previewPref.js).
// -> { url, host, title, desc, imageBytes, imageMime } or null; never rejects.

export { previewViaService as buildPreview } from './previewService.js'

// "Prévia de links" (previewPref.js) in the browser: localStorage.
export function previewPrefStore () {
  try {
    return globalThis.localStorage || { getItem: () => null, setItem () {} }
  } catch {
    return { getItem: () => null, setItem () {} }
  }
}
