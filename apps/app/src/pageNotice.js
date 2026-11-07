// The one-time notice before a member's first message to a Página: the
// account service keeps a page's inbox and can read it (Termos 26, docs/
// design.md LGPD). Shown once per device and page key, from the page's
// profile (Membro) and from "Conversar" on one of its listings (Anuncio).
// Pure: the device store comes from pageNoticeStore.web.js / .native.js.

export const PAGE_DM_NOTICE = 'O serviço de conta pode ler as mensagens desta conversa'

export function pageNoticeKey (page) {
  return typeof page === 'string' && /^[0-9a-f]{64}$/.test(page) ? 'varanda-page-dm-notice-' + page : null
}

// Whether this device already showed the notice for `page`. A store that
// fails reads as not shown: the notice comes again, never silently skipped.
export function pageNoticeSeen (store, page) {
  const key = pageNoticeKey(page)
  if (key === null) return false
  try { return store.getItem(key) === '1' } catch { return false }
}

export function notePageNotice (store, page) {
  const key = pageNoticeKey(page)
  if (key === null) return
  try { store.setItem(key, '1') } catch {}
}
