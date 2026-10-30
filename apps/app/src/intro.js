// This device record tracks presentation only, never legal acceptance.
export const STORAGE_KEY = 'varanda-intro'
export const FILE_NAME = 'varanda-intro.json'
export const INTRO_VERSION = 1

export const INTRO_CARDS = Object.freeze([
  Object.freeze({
    id: 'diario',
    title: 'Seu diário, perto de você',
    body: 'Seu diário mora no seu celular. O que você publica chega às pessoas que seguem você.',
    icon: 'casa'
  }),
  Object.freeze({
    id: 'seu',
    title: 'O que é seu continua seu',
    body: 'O que você publica continua sendo seu. Sem anúncios e sem um algoritmo vendendo sua atenção.',
    icon: 'coracao'
  }),
  Object.freeze({
    id: 'conversa',
    title: 'Puxe uma cadeira',
    body: 'Um lugar para gente de verdade, aqui no Brasil. Para contar do dia e conversar como numa varanda.',
    icon: 'gente'
  })
])

const RECORD_KEYS = ['v', 'seenVersion', 'at']

export function introRecordOf (value) {
  try {
    if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length !== RECORD_KEYS.length || !keys.every((key) => RECORD_KEYS.includes(key))) return null
    const { v, seenVersion, at } = value
    if (v !== 1 || !Number.isInteger(seenVersion) || seenVersion < 1 || seenVersion > 9999) return null
    if (typeof at !== 'string' || new Date(at).toISOString() !== at) return null
    return { v: 1, seenVersion, at }
  } catch {
    return null
  }
}

export function introDecision ({ status, record, version }) {
  if (status !== 'ready') return 'loading'
  if (record === null || record.seenVersion < version) return 'show'
  return 'done'
}

export function withSeen (version, at) {
  return { v: 1, seenVersion: version, at }
}
