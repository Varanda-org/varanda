// The one-time note before a member's first message to a Página: the
// conversation is sealed between the member and the page's owner and admins
// (docs/rpc.md 5.114). Shown once per page key: per device, and per account
// where the seen document syncs (onceMarks.js wraps the device store). From
// the page's profile (Membro), from "Conversar" on one of its listings
// (Anuncio) and from a page's post (App). Pure: the device store comes from
// pageNoticeStore.web.js / .native.js.

export const PAGE_DM_NOTICE = 'As mensagens desta conversa são cifradas entre você e quem administra a página. A associação não lê.'
export const PAGE_DM_NOT_ACTIVE = 'Esta página ainda não ativou as Conversas privadas. Sua mensagem chega quando ela ativar.'

// Whether the page's published dm-key (dm.lookup of the page) is none or the
// gen 1 key every page had before its owner activated device-held keys.
export function pageNotActivated (lookup) {
  if (lookup === null || typeof lookup !== 'object') return false
  // A gen 1 key may be a legacy service-held box or the first box of a new
  // page, so only a page with no key at all reads as not activated.
  return lookup.box === null
}

export const PAGE_NOTICE_PREFIX = 'varanda-page-dm-notice-'
// The opaque device flag onceMarks.js writes with the account's key.
export const ONCE_DEVICE_PREFIX = 'varanda-once-'

export function pageNoticeKey (page) {
  return typeof page === 'string' && /^[0-9a-f]{64}$/.test(page) ? PAGE_NOTICE_PREFIX + page : null
}

// The device flags among `names` (storage keys or file names), both kinds:
// the local-cache wipe (lock, Sair, Recomeçar, another account) erases them.
export function pageNoticeFlags (names) {
  const out = []
  for (const name of names) {
    if (typeof name === 'string' && (name.startsWith(PAGE_NOTICE_PREFIX) || name.startsWith(ONCE_DEVICE_PREFIX))) out.push(name)
  }
  return out
}

// Only the page-named flags among `names`: removed once the member's key is
// known (onceMarks.js writes the opaque kind from then on), never converted,
// as one may be another member's on a shared device.
export function legacyPageNoticeFlags (names) {
  const out = []
  for (const name of names) {
    if (typeof name === 'string' && name.startsWith(PAGE_NOTICE_PREFIX)) out.push(name)
  }
  return out
}

// Whether the notice for `page` was already shown, as the store tells (this
// device, or the synced marks). A store that fails reads as not shown: the
// notice comes again, never silently skipped.
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

// Whether `r` (a profile read) says the author `key` is a Pagina, a person,
// or nothing usable yet. screens/Membro.js shares this rule.
export function pageReadKind (r, key) {
  if (r === null || typeof r !== 'object' || r.page !== key) return 'unknown'
  if (r.gen !== null || r.owner !== null || r.closed === true || (r.movedTo !== null && r.movedTo !== undefined)) return 'page'
  return r.complete === true ? 'person' : 'unknown'
}

// What a DM entry point does for `author`. `hint` is the seeder member-index
// hint ({ page, closed, moved } or null) and `read` is pageReadKind's result.
// Only a page the member's own node confirmed is refused: the hint is
// untrusted, so a seeder could otherwise silence a person's private messages.
// A page known only from the hint still gets the notice (harmless for a
// person, and the disclosure a real page needs) and no private context.
export function pageDmPlan ({ hint, read, seen, canConverse }) {
  if (read === 'page') {
    if (canConverse !== true) return 'refuse'
    return seen === true ? 'direct' : 'notice'
  }
  const hinted = read !== 'person' && hint !== null && hint !== undefined && hint.page === true
  if (!hinted) return 'open'
  return seen === true ? 'direct' : 'notice'
}
