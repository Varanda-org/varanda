import rpc from '@varanda/rpc'
import { countChars } from './format.js'
import { charterHere } from './groups.js'

export const ABOUT_MAX = rpc.MAX_GROUP_ABOUT
export const GROUP_ROOT_TEXT = 'Nome, descrição, entrada e foto não podem ser mudados neste aparelho.'
export const GROUP_CHARTER_WAIT_TEXT = 'Este aparelho ainda não pode mudar nome, descrição, entrada e foto. Aguarde a sincronização.'
// A cut of the creating device's root ends sibling charter as well as a leave,
// so this sentence does not say who left.
export const GROUP_CHARTER_ENDED_TEXT = 'Nome, descrição, entrada e foto deste grupo não podem mais ser mudados.'

// The node refuses these as isGroupAbout does (@varanda/rpc link-card.js
// isCardForbiddenChar without line feeds), so the button never offers a
// save the node would answer with a usage error.
function forbiddenChar (ch) {
  const cp = ch.codePointAt(0)
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 ||
    (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
}

export function aboutReady (text, current) {
  const value = text.trim() || null
  const ok = value !== (current ?? null) && countChars(value ?? '') <= ABOUT_MAX && ![...text].some(forbiddenChar)
  return { value, ok }
}

export function editState (info, role) {
  if (role !== 'creator') return 'none'
  const charter = charterHere(info)
  if (charter === true) return 'edit'
  if (charter === null) return info?.rootHere === false ? 'other-device' : 'edit'
  return info?.rootAuthority === false ? 'ended' : 'wait'
}

export function joinOptions (info, { group, general } = {}) {
  if (info?.visibility !== 'public') return []
  if (typeof info.community === 'string' && (typeof general !== 'string' || general === '' || group === general)) return []
  return [
    { value: 'open', label: 'Aberta' },
    { value: 'approval', label: 'Com aprovação' }
  ]
}
