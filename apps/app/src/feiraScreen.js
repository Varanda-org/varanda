import rpc from '@varanda/rpc'
import { CAT_LABELS, listingView } from './feira.js'
import { search, byAuthor } from './feiraClient.js'
import { tokensOf, MAX_QUERY_TOKENS, SEARCH_INPUT_MAX } from './topics.js'

const { feira, displayText } = rpc
const HEX64 = /^[0-9a-f]{64}$/
const refOf = (row) => row.author + ':' + row.seq

export const KIND_OPTIONS = [
  { id: 'todos', label: 'Todos' },
  { id: 'produto', label: 'Produtos' },
  { id: 'servico', label: 'Serviços' },
  { id: 'procura', label: 'Procura-se' }
]
export const SEGMENT_OPTIONS = [
  { id: 'cidade', label: 'Na cidade' },
  { id: 'meus', label: 'Meus' },
  { id: 'salvos', label: 'Salvos' }
]
export const CATEGORY_OPTIONS = [{ id: 'todas', label: 'Todas as categorias' },
  ...Object.entries(CAT_LABELS).map(([id, label]) => ({ id, label }))]
export const UF_OPTIONS = feira.UFS.map((id) => ({ id, label: id }))
export const LOCATION_KEY = 'varanda-feira-location'
export const TEXTS = {
  off: 'A Feira não está aberta nesta instalação',
  offline: 'Conecte-se para consultar a Feira.',
  location: 'Escolha o estado e escreva a cidade.',
  words: 'Escreva uma palavra com pelo menos 2 letras ou números.',
  loading: 'Carregando anúncios…',
  empty: 'Nenhum anúncio por aqui ainda.',
  meus: 'Você ainda não tem anúncios.',
  salvos: 'Você ainda não tem anúncios salvos disponíveis.',
  autor: 'Nenhum anúncio por aqui.',
  incomplete: 'Alguns anúncios podem faltar. Puxe para atualizar.',
  error: 'Não foi possível carregar a Feira. Tente atualizar.',
  storage: 'Não foi possível lembrar a cidade neste aparelho.'
}

export function filterState (value = {}) {
  return {
    uf: feira.isUf(value.uf) ? value.uf : '',
    city: typeof value.city === 'string' ? displayText(value.city).slice(0, feira.MAX_PLACE) : '',
    kind: feira.isKind(value.kind) ? value.kind : 'todos',
    cat: feira.isCat(value.cat) ? value.cat : 'todas',
    words: typeof value.words === 'string' ? displayText(value.words).slice(0, SEARCH_INPUT_MAX) : ''
  }
}

export function searchQuery (filters) {
  const f = filterState(filters)
  const cityKey = feira.cityKey(f.city.trim())
  if (!f.uf || !cityKey) return null
  const tokens = tokensOf(f.words).slice(0, MAX_QUERY_TOKENS)
  if (f.words.trim() && !tokens.length) return null
  return { uf: f.uf, cityKey, kind: f.kind, cat: f.cat, tokens: tokens.length ? tokens.join('+') : null }
}

// PR4 can save this query without retaining any listing or peer text.
export function savedSearch (filters) {
  const query = searchQuery(filters)
  return query === null ? null : { ...query }
}

// Whether this installation has the Feira on: its seeder answers the Feira
// index routes (a 404 means off). The account service's /account/feira/policy
// only says whether a listing link may open a sign-up, so it never gates
// browsing or publishing. An 'on' answer is kept for the screen's life; an
// 'off' one is asked again on the next load (an operator may switch it on);
// an unreachable seeder answers null, never an empty Feira.
export function createFeiraProbe (readAuthor = byAuthor) {
  let on = false
  return async function probe (request, key) {
    if (on) return { enabled: true }
    if (typeof key !== 'string' || !HEX64.test(key)) return { enabled: true }
    let answer
    try { answer = await readAuthor(request, key, null) } catch { return null }
    if (answer && answer.off === true) return { enabled: false }
    if (!answer || answer.ok === false) return null
    on = true
    return { enabled: true }
  }
}

export function segmentSource ({ segment = 'cidade', acting, ownKey, author } = {}) {
  if (segment === 'autor') return { kind: 'author', author: HEX64.test(author) ? author : null }
  if (segment === 'meus') {
    if (acting && acting.kind === 'page') return { kind: 'author', author: acting.key }
    return { kind: 'mine', author: ownKey }
  }
  return { kind: segment === 'salvos' ? 'saved' : 'search' }
}

// Rows have already been verified by feiraClient or read from listing.mine.
// Check the signed content against the query again: the index is only a hint.
export function rowDecision (row, { segment = 'cidade', filters = {}, blocked = new Set(), acting, ownKey, author } = {}) {
  if (!row || !HEX64.test(row.author) || !Number.isSafeInteger(row.seq) || row.seq < 1) return null
  if (row.blocked === true || blocked.has(row.author) || ['blocked', 'revoked-issuer'].includes(row.reason)) return null
  if (!feira.isKind(row.kind) || (row.stale !== true && !feira.isStatus(row.status))) return null
  if (segment === 'meus') {
    if (row.author !== segmentSource({ segment, acting, ownKey }).author) return null
  } else if (segment === 'autor') {
    if (row.author !== segmentSource({ segment, author }).author) return null
  } else if (segment === 'cidade') {
    if (row.stale !== true && row.status === 'vendido') return null
    const query = searchQuery(filters)
    if (!query || !row.place || row.place.uf !== query.uf || feira.cityKey(row.place.city) !== query.cityKey) return null
    if (query.kind === 'todos' ? row.kind === 'procura' : row.kind !== query.kind) return null
    if (query.cat !== 'todas' && row.cat !== query.cat) return null
    const words = new Set(tokensOf(row.title + ' ' + row.text))
    if (query.tokens && !query.tokens.split('+').every((word) => words.has(word))) return null
  }
  return row
}

export function screenState ({ node, filters = {}, segment = 'cidade', result, loading = false } = {}) {
  if (!node || node.hosted !== true || (result && result.off)) return { kind: 'off', text: TEXTS.off, canAnnounce: false }
  if (node.online === false) return { kind: 'offline', text: TEXTS.offline, canAnnounce: false }
  const canAnnounce = !loading && (!result || result.ok !== false)
  if (loading) return { kind: 'loading', text: TEXTS.loading, canAnnounce }
  if (result && result.ok === false) return { kind: 'error', text: TEXTS.error, canAnnounce }
  if (segment === 'cidade' && !searchQuery(filters)) {
    const f = filterState(filters)
    const kind = f.uf && feira.cityKey(f.city.trim()) ? 'words' : 'location'
    return { kind, text: TEXTS[kind], canAnnounce }
  }
  if (result && (result.complete === false || result.indexing || result.unavailable > 0)) return { kind: 'incomplete', text: TEXTS.incomplete, canAnnounce }
  if (!result || !result.items.length) return { kind: 'empty', text: TEXTS[segment] || TEXTS.empty, canAnnounce }
  return { kind: 'ready', text: '', canAnnounce }
}

// A listing.mine item as the same verified view the index rows become.
export function mineView (author, item) {
  const { kind, title, text, price, unit, cat, place, at, media } = item
  const root = { type: 'listing', kind, title, text, price, unit, cat, place, at }
  if (Array.isArray(media) && media.length) root.media = media
  const view = listingView({ author, seq: item.seq, root, status: item.status })
  return view && { ...view, ref: refOf(view), editSeq: item.editSeq, editedAt: item.editedAt }
}

export async function loadFeiraPage (options, deps = {}) {
  const { node, filters, ownKey, cursor = null, saved = [] } = options
  const gate = screenState(options)
  if (['off', 'offline'].includes(gate.kind)) return { ok: true, items: [], next: null, off: gate.kind === 'off' }
  const source = segmentSource(options)
  const request = (...args) => node.request(...args)
  const readAuthor = deps.byAuthor || byAuthor
  let result
  try {
    if (deps.policy) {
      const policy = await deps.policy()
      if (!policy) return { ok: false, items: [], next: null }
      if (!policy.enabled) return { off: true, items: [], next: null }
    }
    if (['location', 'words'].includes(gate.kind)) return { ok: true, items: [], next: null }
    if (source.kind === 'mine') {
      if (!HEX64.test(ownKey)) return { ok: false, items: [], next: null }
      const answer = await request('listing.mine', cursor === null ? {} : { before: cursor })
      result = { ok: true, items: answer.items.map((item) => mineView(ownKey, item)).filter(Boolean), next: answer.next }
    } else if (source.kind === 'author') {
      if (!HEX64.test(source.author)) return { ok: false, items: [], next: null }
      result = await readAuthor(request, source.author, cursor)
    } else if (source.kind === 'saved') {
      // Read current author hints so saved roots never resurrect deleted edits
      // or display an old status. Bound continuation if an index misbehaves.
      const found = new Map()
      let complete = true
      for (const author of new Set(saved.map((ref) => ref.author))) {
        if (!HEX64.test(author) || (options.blocked && options.blocked.has(author))) continue
        let next = null
        const seen = new Set()
        for (let page = 0; page < 10; page++) {
          const answer = await readAuthor(request, author, next)
          if (answer.off) return { ...answer, items: [], next: null }
          if (!answer.ok) { complete = false; break }
          for (const row of answer.items) found.set(refOf(row), row)
          if (answer.complete === false || answer.indexing || answer.unavailable > 0) complete = false
          next = answer.next
          if (next === null) break
          if (seen.has(next) || page === 9) { complete = false; break }
          seen.add(next)
        }
      }
      result = { ok: true, items: saved.map((ref) => found.get(refOf(ref))).filter(Boolean), next: null, complete }
    } else {
      result = await (deps.search || search)(request, { ...searchQuery(filters), cursor })
    }
  } catch {
    return { ok: false, items: [], next: null }
  }
  return { ...result, items: (result.items || []).map((row) => rowDecision(row, options)).filter(Boolean), next: result.next ?? null }
}

export function mergeRows (before, after) {
  const rows = new Map(before.map((row) => [refOf(row), row]))
  for (const row of after) rows.set(refOf(row), row)
  return [...rows.values()]
}

// The integration supplies device storage; only UF and city are persisted.
export function createLocationStore ({ read, write }) {
  let writes = Promise.resolve()
  return {
    async load () {
      try {
        const value = JSON.parse(await read(LOCATION_KEY))
        return filterState(value && value.v === 1 ? { uf: value.uf, city: value.city } : {})
      } catch { return filterState() }
    },
    save (filters) {
      const { uf, city } = filterState(filters)
      const raw = JSON.stringify({ v: 1, uf, city })
      writes = writes.then(() => write(LOCATION_KEY, raw)).then(() => true, () => false)
      return writes
    }
  }
}
