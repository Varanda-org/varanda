// Pure view model for Visitas: copy, the row filter and what the screen shows.
// The model (consent sheet state, groups by day, notices) is in visits.js.
// No I/O, no clock of its own (callers pass `now`), no counts anywhere.

import { dailyLimitNotice, dmsOffNotice, groupByDay } from './visits.js'

const HEX64 = /^[0-9a-f]{64}$/

export const VISITAS_TITLE = 'Visitas'
export const VISITAS_ENTRY_LABEL = 'Visitas'
export const CONSENT_TITLE = 'Registrar visitas'
export const CONSENT_LINES = Object.freeze([
  'Quando você abre o perfil de alguém que também liga as visitas, essa pessoa vê o seu nome na lista dela.',
  'O que sai do seu aparelho é só o aviso de que você passou por lá, num canal à parte das mensagens e sem texto. Ele não acorda o celular de ninguém.',
  'Quem desliga as visitas não aparece nem vê a lista de ninguém. Você pode desligar quando quiser, e a lista é apagada.'
])
export const CONSENT_SWITCH_LABEL = 'Entendi e quero registrar visitas'
export const CONSENT_ON_LABEL = 'Ligar visitas'
export const OFF_LABEL = 'Desligar visitas'
export const OFF_CONFIRM_TITLE = 'Desligar visitas'
export const OFF_CONFIRM_TEXT = 'Ao desligar, a sua lista de visitantes é apagada e as pessoas deixam de ver quando você passa pelo perfil delas.'
export const OFF_CONFIRM_LABEL = 'Desligar e apagar a lista'
export const ROW_ON = 'Ligadas'
export const ROW_OFF = 'Desligadas'
export const EMPTY_TITLE = 'Nenhuma visita ainda'
export const EMPTY_BODY = 'Quando alguém que também liga as visitas passar pelo seu perfil, o nome aparece aqui, por dia.'
export const OFF_TITLE = 'Visitas desligadas'
export const OFF_BODY = 'Ligue em Ajustes, Visitas, para ver quem passou pelo seu perfil.'
export const LOAD_FAILED = 'Não deu para carregar as visitas agora.'
export const CLEARED_TOAST = 'Visitas desligadas e lista apagada.'
export const ON_TOAST = 'Visitas ligadas.'

// Hidden entirely when the node is not hosted or DMs are not available.
export function visitasAvailable ({ hosted, unlocked }) {
  return hosted === true && unlocked === true
}

export function stateOn (state) {
  return !!state && state.on === true
}

// The list the node returned, keeping only well-formed rows ({ key, at }).
export function rowsOf (list) {
  const rows = list && Array.isArray(list.visits) ? list.visits : []
  return rows.filter((r) => r && typeof r.key === 'string' && HEX64.test(r.key) && Number.isFinite(r.at))
}

// { groups, notices, empty, off } for the screen. `dmsOn` is false when the
// private messages are not available; `state` is { on, sentToday } or null
// until it is read.
export function viewOf ({ list, state, now, dmsOn }) {
  const off = state !== null && state !== undefined && !stateOn(state)
  const groups = groupByDay(rowsOf(list), now)
  const notices = [dmsOffNotice(dmsOn), dailyLimitNotice(state ? state.sentToday : 0)].filter((n) => typeof n === 'string')
  return { groups, notices, off, empty: !off && groups.length === 0 }
}
