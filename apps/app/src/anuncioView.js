import rpc from '@varanda/rpc'
import { catLabel, kindLabel, monthYear, trustLines } from './feira.js'

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

export function sellerSummary ({ name, since, trust } = {}) {
  const date = monthYear(since)
  const lines = trustLines(trust || {})
  if (date !== '') {
    const rest = lines.filter((line) => line.key !== 'memberSince')
    lines.splice(0, lines.length, { key: 'memberSince', text: 'Na Varanda desde ' + date }, ...rest)
  }
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
