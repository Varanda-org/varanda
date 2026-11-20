import { liveAuthors, liveItems, ringSeen } from './momentSeen.js'
import { SAVED_ENTRY_LABEL } from './savedView.js'
import { VISITAS_ENTRY_LABEL } from './visitasView.js'

export const ABOUT_LABEL_OWN = 'Sobre mim'
export const ABOUT_LABEL = 'Sobre'

const ABOUT_FIELDS = ['city', 'work', 'studies', 'birthday']
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== ''

export function aboutHint (about, extras = [], max = 2) {
  const rows = about?.rows || []
  const values = ABOUT_FIELDS.map((key) => rows.find((row) => row.key === key)?.value)
    .filter(nonEmpty).slice(0, max)
  return values.concat(extras.filter(nonEmpty)).join(' · ')
}

export function aboutEntry (flags) {
  return Object.values(flags).some(Boolean)
}

export const SHORTCUTS = {
  salvos: { icon: 'salvar', label: SAVED_ENTRY_LABEL },
  eventos: { icon: 'evento', label: 'Eventos' },
  visitas: { icon: 'olho', label: VISITAS_ENTRY_LABEL },
  recados: { icon: 'recado', label: 'Recados' },
  varandinha: { icon: 'droplet', label: 'Varandinha' },
  anuncios: { icon: 'feira', label: 'Anúncios' }
}

export const OWN_SHORTCUTS = ['salvos', 'eventos', 'visitas', 'recados', 'varandinha']
export const MEMBER_SHORTCUTS = ['anuncios', 'recados', 'varandinha', 'eventos']

export function shortcutList (order, shown) {
  return order.filter((id) => shown[id] === true).map((id) => ({ id, ...SHORTCUTS[id] }))
}

export function avatarMoments ({ data, author, ownKey, seen, now }) {
  if (data?.phase !== 'ready' || typeof author !== 'string' || !/^[0-9a-f]{64}$/.test(author)) return null
  const items = author === ownKey
    ? liveItems(data.own, now)
    : liveAuthors(data.authors, now).find((entry) => entry.author === author)?.items
  if (!items || items.length === 0) return null
  return { count: items.length, unseen: !ringSeen(items, seen) }
}
