import rpc from '@varanda/rpc'
import { catLabel, kindLabel, trustLines } from './feira.js'

const { displayText } = rpc
const peer = (value) => displayText(typeof value === 'string' ? value : '')

export function stickyActions (listing, { owner = false, canTalk = false, canOffer = false } = {}) {
  if (!listing) return []
  if (owner) return [{ id: 'editar', label: 'Editar', primary: true }]
  const actions = []
  if (canTalk) actions.push({ id: 'conversar', label: 'Conversar', primary: true })
  if (canOffer && (listing.kind === 'produto' || listing.kind === 'servico') && Number.isSafeInteger(listing.price) && listing.price > 0) {
    actions.push({ id: 'oferta', label: 'Fazer oferta', primary: false })
  }
  return actions
}

// A Page's block 0 is the certificate the account service issued for the
// page diary, so its date is when the page was made or moved, not when a
// person joined: a Page listing gets no member-since line.
export function sellerSummary ({ name, since, page = false } = {}) {
  const lines = page === true ? [] : trustLines({ certDate: since })
  const avatarName = peer(name)
  return { name: avatarName || 'Quem anunciou', avatarName, lines }
}

export function detailChips (listing) {
  if (!listing) return []
  const place = listing.place || {}
  const city = [peer(place.city), peer(place.uf)].filter(Boolean).join('/')
  return [
    { id: 'category', label: catLabel(listing.cat) || peer(listing.catLabel) },
    { id: 'city', label: city },
    { id: 'kind', label: kindLabel(listing.kind) }
  ].filter((chip) => chip.label !== '')
}
