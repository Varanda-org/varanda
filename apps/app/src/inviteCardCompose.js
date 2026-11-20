import rpc from '@varanda/rpc'
import { REGIONS, SUGGESTIONS } from './inviteCardCopy.js'
import { refusalOf } from './wordCheck.js'

const { canonicalInviteCardText, messageRoom, utf8ByteLength } = rpc
const CODE = 'a'.repeat(43)
const EXPIRES = 2 ** 32 - 1

export const CARD_FAILED_TEXT = 'O convite foi criado. O cartão não entrou no link.'
export const TOO_LONG_TEXT = 'Encurte a mensagem: o link ficou longo demais.'
export const PROBLEM_TEXT = Object.freeze({
  nome: 'Escreva para quem é o cartão.',
  'nome-longo': 'Use um nome com até 40 letras.',
  'mensagem-vazia': 'Escreva uma mensagem curta.',
  'mensagem-simbolos': 'Tire da mensagem os símbolos que não aparecem na tela.',
  'mensagem-longa': TOO_LONG_TEXT
})

export function initialCompose () {
  const design = REGIONS[0].designs[0]
  return { phase: 'idle', enabled: false, region: REGIONS[0].id, design, name: '', message: SUGGESTIONS[design], typed: false }
}

export function composeTransition (state, event) {
  if (event.type === 'reset') return initialCompose()
  if (['plain', 'card', 'card-failed'].includes(event.type)) return { ...state, phase: event.type }
  if (event.type === 'error') return { ...state, phase: state.enabled ? 'writing' : 'idle' }
  if (event.type === 'sign') return state.phase === 'creating' ? { ...state, phase: 'signing' } : state
  if (event.type === 'create') return { ...state, phase: 'creating' }
  if (state.phase === 'creating' || state.phase === 'signing') return state
  if (event.type === 'toggle') return { ...state, enabled: !state.enabled, phase: state.enabled ? 'idle' : 'writing' }
  if (event.type === 'name') return { ...state, name: event.value, phase: 'writing' }
  if (event.type === 'message') return { ...state, message: event.value, typed: true, phase: 'writing' }
  if (event.type === 'region' || event.type === 'design') {
    const region = REGIONS.find((r) => event.type === 'region' ? r.id === event.value : r.designs.includes(event.value))
    if (!region) return state
    const design = event.type === 'region' ? region.designs[0] : event.value
    return { ...state, phase: 'writing', region: region.id, design, message: state.typed ? state.message : SUGGESTIONS[design] }
  }
  return state
}

const canonicalName = (name) => canonicalInviteCardText(name, 40)
const canonicalMessage = (message) => canonicalInviteCardText(message, 200, { multiline: true })

// A 1-byte placeholder keeps the counter meaningful before a valid name is
// typed; it only tightens as the real name grows.
export function room ({ origin, name, design }) {
  return messageRoom({ origin, code: CODE, expires: EXPIRES, design, name: canonicalName(name) ?? 'a' })
}

export function fits ({ origin, name, message, design }) {
  const text = canonicalMessage(message)
  return canonicalName(name) !== null && text !== null && utf8ByteLength(text) <= room({ origin, name, design })
}

export function problem (state, origin) {
  const name = typeof state.name === 'string' ? state.name.trim().normalize('NFC') : ''
  if (name === '') return 'nome'
  if ([...name].length > 40) return 'nome-longo'
  if (canonicalName(state.name) === null) return 'nome'
  const message = typeof state.message === 'string' ? state.message : ''
  if (message.trim() === '') return 'mensagem-vazia'
  const text = canonicalMessage(message)
  // canonicalMessage also refuses more than 200 code points: that is a length
  // problem, not a symbol one.
  if (text === null) return [...message.trim().normalize('NFC')].length > 200 ? 'mensagem-longa' : 'mensagem-simbolos'
  if (utf8ByteLength(text) > room({ ...state, origin })) return 'mensagem-longa'
  return null
}

// The refusal for a listed term in what the card shows, or ''.
export const cardRefusal = (state) => refusalOf(state.name, state.message)

export function cardFields (state, origin) {
  if (!state.enabled || !fits({ ...state, origin }) || cardRefusal(state) !== '') return null
  return {
    design: state.design,
    name: canonicalName(state.name),
    message: canonicalMessage(state.message)
  }
}

export function counterText ({ origin, name, message, design }) {
  return utf8ByteLength(message.trim().normalize('NFC')) + ' de ' + room({ origin, name, design }) + ' bytes'
}

export function createLabel (state, origin) {
  if (state.phase === 'signing') return 'Assinando cartão'
  return state.enabled ? 'Criar link com cartão' : 'Criar link de convite'
}
