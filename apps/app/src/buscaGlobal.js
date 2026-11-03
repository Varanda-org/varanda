// The model behind the global Busca tab: its two categories, the fixed texts,
// the query plan for each category and the notice shown when the search cannot
// run. Pure: only the app's own pure modules are imported, so Node tests load
// it directly.

import { searchPath, SEARCH_LABEL, SEARCH_PLACEHOLDER } from './topics.js'
import { classifyFollowInput } from './followInput.js'

export const CATEGORIES = Object.freeze(['contas', 'publicacoes'])

export const CATEGORY_LABEL = Object.freeze({
  contas: 'Contas',
  publicacoes: 'Publicações'
})

export const BUSCA_TITLE = 'Busca'

export const BUSCA_LABEL = Object.freeze({
  contas: 'Encontrar pessoas',
  publicacoes: SEARCH_LABEL
})

export const BUSCA_PLACEHOLDER = Object.freeze({
  contas: 'nome, @nome ou código',
  publicacoes: SEARCH_PLACEHOLDER
})

export const BUSCA_NOT_HOSTED_TITLE = 'Só na versão web'
export const BUSCA_NOT_HOSTED = 'Nesta versão, a pesquisa de publicações só funciona no site da associação ou no app ligado à instalação.'
export const BUSCA_UNAVAILABLE_TITLE = 'Busca indisponível'
export const BUSCA_UNAVAILABLE = 'A pesquisa não está disponível nesta conexão.'

export const BUSCA_EMPTY = Object.freeze({
  contas: 'Procure pessoas pelo nome ou @nome, ou cole o código de alguém.',
  publicacoes: 'Procure palavras nas publicações públicas.'
})

// Contas on a node that is not hosted only follows by code.
export const BUSCA_EMPTY_CODE = 'Cole o código de 64 letras e números de alguém para seguir.'

export const CODE_FIELD_LABEL = 'Cole o código da pessoa (64 letras e números).'

// Contas reuses the follow input's classification; publicações reuses the
// topic search's wire query, so both stay in step with their own modules.
// The posts query is the shape Busca.js reads (tokens and path).
export function plan (category, text) {
  if (category === 'publicacoes') {
    const found = searchPath(text)
    return found === null
      ? { kind: 'posts', query: null, truncated: false }
      : { kind: 'posts', query: { tokens: found.tokens, path: found.path }, truncated: found.truncated === true }
  }
  if (category === 'contas') {
    const c = classifyFollowInput(text)
    if (c.kind === 'key') return { kind: 'key', value: c.key }
    if (c.kind === 'handle') return { kind: 'handle', value: c.handle }
    if (c.kind === 'name') return { kind: 'name', value: text.trim() }
    if (c.kind === 'partial-key') return { kind: 'partial-key', value: null }
    return { kind: 'empty', value: null }
  }
  return { kind: 'empty', value: null }
}

// Gates the Publicações category only: Contas works on every node through the
// code field. Offline is left to Busca.js (searchNotice in topics.js), which
// knows whether results already loaded and keeps them on screen. Any
// non-object argument reads as not hosted rather than throwing.
export function buscaNotice (opts) {
  const hosted = opts !== null && typeof opts === 'object' ? opts.hosted : undefined
  return hosted === true ? null : 'not-hosted'
}
