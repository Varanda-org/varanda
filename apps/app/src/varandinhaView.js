// Varandinha: every pt-BR string the screens show, and the small pure
// formatters over them. The plant ids are the contract's (rpc.garden); the
// labels live here. No React, no platform module, no request.

import rpc from '@varanda/rpc'
import { dayLabel } from './visits.js'

export const TITLE = 'Varandinha'
export const STREET_TITLE = 'Varandas da rua'

export const PLANT_LABELS = Object.freeze({
  manjericao: 'Manjericão',
  tomate: 'Tomate-cereja',
  pimenta: 'Pimenta',
  alecrim: 'Alecrim',
  samambaia: 'Samambaia',
  espada: 'Espada-de-são-jorge'
})

export function plantLabel (id) {
  return Object.hasOwn(PLANT_LABELS, id) ? PLANT_LABELS[id] : ''
}

// The four edibles are harvested, the two foliage plants give a cutting.
export function harvestVerb (id) {
  return id === 'samambaia' || id === 'espada' ? 'Tirar muda' : 'Colher'
}

export const DECOR_TITLE = 'Enfeites'

export const DECOR_LABELS = Object.freeze({
  rede: 'Rede',
  varal: 'Varal',
  gato: 'Gato',
  pisca: 'Pisca-pisca'
})

export function decorLabel (id) {
  return Object.hasOwn(DECOR_LABELS, id) ? DECOR_LABELS[id] : ''
}

export function decorLine (ids) {
  if (!Array.isArray(ids) || ids.length === 0) return ''
  const labels = []
  for (const id of ids) {
    const label = decorLabel(id)
    if (label) labels.push(label)
  }
  return labels.length === 0 ? '' : DECOR_TITLE + ': ' + labels.join(', ')
}

export const GIFT_LABELS = Object.freeze({
  manjericao: 'Maço de manjericão',
  tomate: 'Tomates-cereja',
  pimenta: 'Pimentas',
  alecrim: 'Ramo de alecrim',
  samambaia: 'Muda de samambaia',
  espada: 'Muda de espada-de-são-jorge'
})

export function giftLabel (id) {
  return Object.hasOwn(GIFT_LABELS, id) ? GIFT_LABELS[id] : ''
}

export const STAGE_LABELS = Object.freeze(['semente', 'broto', 'crescendo', 'pronta'])
export const SOIL_LABELS = Object.freeze({ dry: 'seca', wet: 'molhada' })

const MIN_MS = 60000
const HOUR_MS = 3600000
const DAY_MS = 86400000

// 'pronta', 'pronta em 25 min', 'pronta em 3 h', 'pronta em 2 d': whole
// units, rounded up so the countdown never says ready early.
export function readyIn (ripeAt, now) {
  if (!Number.isFinite(ripeAt) || !Number.isFinite(now) || ripeAt <= now) return 'pronta'
  const left = ripeAt - now
  if (left < HOUR_MS) return 'pronta em ' + Math.max(1, Math.ceil(left / MIN_MS)) + ' min'
  if (left < DAY_MS) return 'pronta em ' + Math.ceil(left / HOUR_MS) + ' h'
  return 'pronta em ' + Math.ceil(left / DAY_MS) + ' d'
}

export const ACTIONS = Object.freeze({
  plant: 'Plantar',
  water: 'Regar',
  clear: 'Arrancar',
  save: 'Guardar',
  discard: 'Descartar'
})

// Kept apart from ACTIONS: the pot sheet still has exactly those five verbs.
export const STALL_TITLE = 'Barraquinha'
export const STALL_ACTIONS = Object.freeze({
  give: 'Dar de presente',
  take: 'Aceitar',
  untake: 'Tirar da prateleira',
  ungive: 'Desfazer'
})

export const PENDING_TITLE = 'Mimos para aceitar'
export const SHELF_TITLE = 'Na prateleira'
export const GAVE_TITLE = 'Você deu'
export const PENDING_EMPTY = 'Nenhum mimo para aceitar.'
export const SHELF_EMPTY = 'A prateleira está vazia.'
export const GAVE_EMPTY = 'Você não deu mimos nesta semana.'
export const PICK_EMPTY = 'Ninguém que você segue está na Varandinha.'

export function stallLine (open) {
  return open ? 'Hoje tem barraquinha.' : 'A barraquinha abre aos sábados.'
}

export function pendingGiftsLabel (n) {
  return n === 1 ? '1 mimo para aceitar' : n + ' mimos para aceitar'
}

// The giver's name is peer text, so it is cleaned here and not left to each
// screen. A missing or empty name is a visitor.
export function shelfLine (item, name) {
  const label = giftLabel(item)
  const from = typeof name === 'string' ? rpc.displayText(name) : ''
  if (from !== '') return label + ', presente de ' + from
  return label
}

export const GIVE_PUBLIC = 'O mimo fica público no seu diário, com a pessoa, o item e a data. O vaso fica vazio.'
export const TAKE_PUBLIC = 'Aceitar grava no seu diário, em público, de quem veio o mimo.'
export const UNGIVE_NOTE = 'O mimo sai da prateleira da pessoa. O vaso não volta.'
export const LEAVE_STALL_LINE = 'Os mimos que vizinhos deram a você ficam no diário deles.'

export function pendingLabel (n) {
  return n === 1 ? '1 ação por guardar' : n + ' ações por guardar'
}

export const WHO_WATERED = 'Quem regou'

// 'hoje', 'ontem' or '12 out', the same words as the visits list.
export function wateredDay (at, now) {
  const ms = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(ms) && Number.isFinite(now) ? dayLabel(ms, now) : ''
}

// Visitors see a count; only the owner sees the names.
export function visitorLine (n) {
  if (!(n >= 1)) return 'Ninguém regou ainda'
  return n === 1 ? '1 vizinho regou' : n + ' vizinhos regaram'
}

export const CONSENT_LINES = Object.freeze([
  'A Varandinha é opcional e começa desligada.',
  'Participar, o que você planta e as datas de plantio, rega e colheita ficam públicos no seu diário, assim como de quem você regou.',
  'Quem recebe a sua rega vê o seu nome.',
  'Não tem texto livre, compra, ranking nem prêmio.',
  'Sair da Varandinha marca os seus registros do jogo como apagados, mas cópias que outras pessoas já buscaram podem continuar. As regas que vizinhos fizeram na sua varanda ficam no diário deles.',
  'Os enfeites que você escolhe e os mimos que você dá ou aceita, com a pessoa, o item e a data, também ficam públicos no seu diário.'
])
export const CONSENT_SWITCH_LABEL = 'Entendi e quero participar'

const REFUSALS = Object.freeze({
  off: 'ligue a Varandinha para jogar',
  saves: 'você já cuidou da varanda o máximo de vezes por hoje',
  invalid: 'jogada inválida',
  self: 'não dá para regar a própria varanda',
  blocked: 'você bloqueou esta pessoa',
  helpOff: 'ligue a Varandinha para regar',
  notFollowing: 'você só rega a varanda de quem você segue',
  sameDay: 'você já regou esta varanda hoje',
  helpsDaily: 'você já regou o máximo de varandas por hoje',
  notPlaying: 'esta pessoa não está na Varandinha',
  page: 'páginas não têm Varandinha',
  noPlant: 'este vaso não tem planta para regar',
  stallClosed: 'a barraquinha só abre aos sábados',
  giftSelf: 'não dá para dar um mimo para si',
  giftNotFollowing: 'você só dá mimos para quem você segue',
  giftSameDay: 'você já deu um mimo para esta pessoa hoje',
  giftsDaily: 'você já deu o máximo de mimos por hoje',
  notRipe: 'este vaso ainda não está pronto',
  giftGone: 'este mimo não está mais disponível',
  takesDaily: 'você já aceitou o máximo de mimos por hoje',
  notGift: 'este registro não é um mimo seu'
})

export const NOTICES = Object.freeze({
  ...REFUSALS,
  unreachable: 'Não deu para falar com o semeador agora. Tente de novo daqui a pouco.',
  indexing: 'A varanda ainda está sendo montada. Volte daqui a pouco.',
  incomplete: 'Algumas informações ainda não chegaram, então a varanda pode estar incompleta.',
  notHosted: 'A Varandinha precisa da conta no Varanda para funcionar. Entre na sua conta para jogar.',
  uncertain: 'Não sabemos se a jogada foi guardada. Confira a varanda antes de tentar de novo.'
})

// The message itself when the node refused with one of its own sentences,
// else null (the screen shows a generic error).
export function refusalNotice (message) {
  return typeof message === 'string' && Object.values(REFUSALS).includes(message) ? message : null
}
