import rpc from '@varanda/rpc'

export const { DESIGNS, REGIONS } = rpc

export const REGION_LABELS = Object.freeze({
  norte: 'Norte',
  nordeste: 'Nordeste',
  'centro-oeste': 'Centro-Oeste',
  sudeste: 'Sudeste',
  sul: 'Sul'
})

export const DESIGN_LABELS = Object.freeze({
  marajoara: 'Marajoara',
  aguas: 'Encontro das águas',
  vitoria: 'Vitória-régia',
  cordel: 'Cordel',
  bandeirinhas: 'Bandeirinhas',
  chita: 'Chita',
  ipe: 'Ipê-amarelo',
  pantanal: 'Pantanal',
  azulejo: 'Azulejo',
  copacabana: 'Copacabana',
  minas: 'Minas',
  araucaria: 'Araucária',
  chimarrao: 'Chimarrão'
})

export const SUGGESTIONS = Object.freeze({
  marajoara: 'Queria você aqui, perto, nessa conversa.',
  aguas: 'Vem comigo. A conversa fica melhor com você.',
  vitoria: 'Guardei um lugar pra você na varanda.',
  cordel: 'Tenho uma história pra contar, e ela pede você.',
  bandeirinhas: 'Vem festejar comigo, do seu jeito.',
  chita: 'A varanda fica mais colorida com você.',
  ipe: 'Quando o ipê abre, eu lembro de te chamar.',
  pantanal: 'Tem um canto quieto aqui. Ele é seu também.',
  azulejo: 'Um lugar à mesa, com o seu nome.',
  copacabana: 'A onda vai e volta. Você faz falta.',
  minas: 'Senta aqui um pouco. A conversa é sua.',
  araucaria: 'Debaixo da araucária, te chamo pra conversa.',
  chimarrao: 'A cuia está pronta. Falta você.'
})

export const ARRIVAL_DM = 'Oi! Cheguei.'
export const ARRIVAL_TITLE = 'Você chegou com o cartão de @'
export const FOLLOW_LABEL = 'Seguir @'
export const HI_LABEL = 'Mandar um oi'
export const LATER_LABEL = 'Agora não'
export const NO_DM_TEXT = 'Essa pessoa ainda não usa as Conversas.'
export const HOW_LABEL = 'Como funciona'
export const ENTER_LABEL = 'Entrar'
export const OPEN_WAIT_MS = 6000

const MONTHS = Object.freeze([
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'
])
const UTC_OFFSET_MS = 3 * 3600 * 1000
const DAY_MS = 24 * 3600 * 1000

export function expiryLine (expiresSec, nowMs) {
  if (!Number.isSafeInteger(expiresSec) || expiresSec <= 0 || !Number.isFinite(nowMs)) return ''
  const expiresMs = expiresSec * 1000
  // Fixed Brasília time avoids depending on Intl support in Hermes.
  const date = new Date(expiresMs - UTC_OFFSET_MS)
  const now = new Date(nowMs - UTC_OFFSET_MS)
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return ''
  if (expiresMs <= nowMs) return 'Este prazo já passou.'
  if (Math.floor(date.getTime() / DAY_MS) === Math.floor(now.getTime() / DAY_MS)) return 'Vale até hoje.'
  // pt-BR writes the first day of a month as an ordinal: 1º de janeiro.
  const day = date.getUTCDate() === 1 ? '1º' : String(date.getUTCDate())
  return 'Vale até ' + day + ' de ' + MONTHS[date.getUTCMonth()] + '.'
}

export function openingGate ({ introShow, linkReturn, ageReturn, card, verified, waitedMs, dismissed } = {}) {
  if (!introShow || linkReturn || ageReturn || !card || dismissed) return 'none'
  if (verified === true) return 'card'
  if (verified === null && waitedMs < OPEN_WAIT_MS) return 'wait'
  return 'none'
}

export function arrivalGate ({ step, verified, linked, dismissed, ownKey, member } = {}) {
  return step === 'pronto' && verified === true && linked === true && !dismissed && ownKey !== member
}
