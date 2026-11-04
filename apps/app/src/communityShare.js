// Share a community link: the system share sheet when there is one, else a
// copy. The link is never shown as text; the caller shows the returned note.

import { communityLink } from './groupLink'
import { installationOrigin } from './installation'
import { canShare, copyText, shareUrl } from './share'
import { shareNav } from './shareNav'

// Native has no document origin. The hosted site never stores an installation.
export function origin () {
  return installationOrigin() || globalThis.location?.origin || ''
}

export const shareCommunity = async ({ community, title }) => {
  const path = communityLink(community)
  if (path === null) return ''
  const base = origin()
  // An empty origin would hand the share sheet a relative path.
  if (base === '') {
    return 'Não foi possível copiar o link.'
  }
  const url = base + path
  const nav = shareNav()
  if (canShare(nav) && (await shareUrl(nav, { url, title: title === 'Comunidade' ? 'Varanda' : title })) !== 'failed') return ''
  return (await copyText(nav, url)) ? 'Link copiado.' : 'Não foi possível copiar o link.'
}
