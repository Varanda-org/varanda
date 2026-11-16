// Pure screen stack for the screens that open above the tabs: 'conversa'
// (a post and its replies, keyed by the post ref '<author hex64>:<seq>'),
// 'membro' (a member's profile), 'mensagem' (a private conversation) and
// 'seguindo' (the list of people someone follows) and 'seguidores' (the people
// who follow someone), keyed by a lowercase hex64 key (the key of the person whose
// list it is, own or another member's), 'curtidas' (who liked or reposted a
// post, keyed by the post ref, params { kind } with kind 'likes' or
// 'reposts'), 'citacoes' (the posts that quote a post, keyed by the post ref,
// no params), 'grupo' (a group), 'comunidade' (a community) and
// 'comunidade-info' (its information page), all keyed by the lowercase
// hex64 root key. 'conversa' stays the post thread.
// 'paginas' (the member's pages) and 'novapagina' (create one) take no key;
// 'paginaajustes' (one page's settings) is keyed by the page's hex64 key.
// 'anuncio', 'editar-anuncio' and 'avaliar' use a listing ref; 'avaliar'
// also requires params.offer (hex32). 'anunciar' takes no key and
// optionally params.page (hex64) to publish as a page.
// 'anuncios' (one author's listings, from the profile) is keyed by the
// author's lowercase hex64 key and takes no params.
// 'comunidades' (browse and create communities, stacked over the Conversas
// inbox), 'pedidos' (the message request folder) and 'salvos' (Posts salvos,
// the saved post refs of this device) take no key either.
// 'depoimentos' (a profile's depoimentos; for the own key also the ones
// waiting for approval and the sent ones) is keyed by the owner's hex64.
// 'momentos' (the full-screen Momentos viewer, starting at one author's
// ring) is keyed by that author's hex64.
// 'assunto' (the posts under one hashtag) is keyed by the folded tag, 2 to 32
// of [a-z0-9], so a tap from one Assunto page to another is a distinct entry.
// 'recados' (the notes left on one page) is keyed by the page owner's hex64.
// 'fas' (the fan list of a profile) is keyed by the owner's hex64; the own one
// opens as the Fãs segment of 'seguindo' (params.segment 'fas'), another
// person's as this screen. 'melhores-amigos' (the own top friends editor)
// takes no key. 'visitas' (who passed by the own profile) takes no key either.
// 'topico' (one topic of a public group) is keyed by the root ref
// '<writer hex64>:<seq>' and requires params.group (the group's hex64 key).
// 'eventos' (a member's events, keyed by the member's hex64; with params.groups,
// a list of up to 12 group keys, the Agenda of a community keyed by its root).
// The stack is an immutable (frozen) array, oldest first. Invalid entries are
// refused by returning the stack unchanged (never throws); pushing the
// screen that is already on top is a no-op, whatever its params; past
// MAX_DEPTH the oldest entry is dropped.

export const MAX_DEPTH = 20
export const SCREENS = Object.freeze(['conversa', 'membro', 'curtidas', 'citacoes', 'grupo', 'comunidade', 'comunidade-info', 'mensagem', 'seguindo', 'seguidores', 'paginas', 'novapagina', 'paginaajustes', 'comunidades', 'pedidos', 'anuncio', 'anunciar', 'editar-anuncio', 'avaliar', 'anuncios', 'depoimentos', 'momentos', 'salvos', 'assunto', 'recados', 'fas', 'melhores-amigos', 'topico', 'eventos', 'visitas'])

const HEX32 = /^[0-9a-f]{32}$/
const HEX64 = /^[0-9a-f]{64}$/
const REF = /^([0-9a-f]{64}):([1-9][0-9]*)$/
// Same pattern as TAG_RE in hashtags.js and TOKEN in topicPage.js; keep the three in step.
const TAG = /^[a-z0-9]{2,32}$/

export const EMPTY = Object.freeze([])

// A canonical lowercase ref with seq >= 1 (records.js formatRef output).
export function isRef (s) {
  if (typeof s !== 'string') return false
  const m = REF.exec(s)
  if (!m) return false
  const seq = Number(m[2])
  return Number.isSafeInteger(seq) && String(seq) === m[2]
}

export function isAuthorKey (s) {
  return typeof s === 'string' && HEX64.test(s)
}

export function validEntry (entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.screen === 'conversa' || entry.screen === 'anuncio' || entry.screen === 'editar-anuncio') return isRef(entry.key)
  if (entry.screen === 'anunciar') {
    if (entry.key !== undefined && entry.key !== null && entry.key !== '') return false
    const params = entry.params
    if (params === undefined) return true
    if (!params || typeof params !== 'object' || Array.isArray(params)) return false
    return params.page === undefined || isAuthorKey(params.page)
  }
  if (entry.screen === 'topico') {
    const params = entry.params
    if (!params || typeof params !== 'object' || Array.isArray(params)) return false
    return isRef(entry.key) && isAuthorKey(params.group)
  }
  if (entry.screen === 'eventos') {
    const params = entry.params
    if (!isAuthorKey(entry.key)) return false
    if (params === undefined || params === null) return true
    if (typeof params !== 'object' || Array.isArray(params)) return false
    return params.groups === undefined || (Array.isArray(params.groups) && params.groups.length <= 12 && params.groups.every(isAuthorKey))
  }
  if (entry.screen === 'avaliar') {
    const params = entry.params
    if (!params || typeof params !== 'object' || Array.isArray(params)) return false
    return isRef(entry.key) && typeof params.offer === 'string' && HEX32.test(params.offer)
  }
  if (entry.screen === 'mensagem') {
    // oldPage: the thread belongs to a key the acting Página moved away from.
    if (!isAuthorKey(entry.key)) return false
    const params = entry.params
    if (params === undefined || params === null) return true
    if (typeof params !== 'object' || Array.isArray(params)) return false
    return params.oldPage === undefined || isAuthorKey(params.oldPage)
  }
  if (entry.screen === 'pedidos') {
    if (entry.key !== undefined && entry.key !== null && entry.key !== '') return false
    const params = entry.params
    if (params === undefined || params === null) return true
    if (typeof params !== 'object' || Array.isArray(params)) return false
    return params.oldPage === undefined || isAuthorKey(params.oldPage)
  }
  if (entry.screen === 'membro' || entry.screen === 'grupo' || entry.screen === 'comunidade' || entry.screen === 'comunidade-info') return isAuthorKey(entry.key)
  if (entry.screen === 'seguindo' || entry.screen === 'seguidores' || entry.screen === 'paginaajustes' || entry.screen === 'anuncios' || entry.screen === 'momentos' || entry.screen === 'recados' || entry.screen === 'fas') return isAuthorKey(entry.key)
  if (entry.screen === 'depoimentos') {
    const params = entry.params
    if (!isAuthorKey(entry.key)) return false
    if (params === undefined || params === null) return true
    if (typeof params !== 'object' || Array.isArray(params)) return false
    return params.section === undefined || params.section === 'sent'
  }
  if (entry.screen === 'paginas' || entry.screen === 'novapagina' || entry.screen === 'comunidades' || entry.screen === 'salvos' || entry.screen === 'melhores-amigos' || entry.screen === 'visitas') return entry.key === undefined || entry.key === null || entry.key === ''
  if (entry.screen === 'citacoes') return isRef(entry.key)
  if (entry.screen === 'assunto') return typeof entry.key === 'string' && TAG.test(entry.key)
  if (entry.screen === 'curtidas') {
    const params = entry.params
    if (!params || typeof params !== 'object' || Array.isArray(params)) return false
    return isRef(entry.key) && (params.kind === 'likes' || params.kind === 'reposts')
  }
  return false
}

function copyEntry (entry) {
  const params = entry.params && typeof entry.params === 'object' ? { ...entry.params } : {}
  return Object.freeze({ screen: entry.screen, key: entry.key, params: Object.freeze(params) })
}

export function top (stack) {
  return Array.isArray(stack) && stack.length > 0 ? stack[stack.length - 1] : null
}

export function depth (stack) {
  return Array.isArray(stack) ? stack.length : 0
}

export function push (stack, entry) {
  const base = Array.isArray(stack) ? stack : EMPTY
  if (!validEntry(entry)) return base
  const current = top(base)
  const oldOf = (e) => (e.params && typeof e.params === 'object' ? e.params.oldPage : undefined)
  if (current && current.screen === entry.screen && current.key === entry.key && oldOf(current) === oldOf(entry)) return base
  const next = base.concat([copyEntry(entry)])
  return Object.freeze(next.length > MAX_DEPTH ? next.slice(next.length - MAX_DEPTH) : next)
}

export function pop (stack) {
  if (!Array.isArray(stack) || stack.length <= 1) return EMPTY
  return Object.freeze(stack.slice(0, -1))
}

// One step back to the screen at index. Popping one entry at a time would
// show every screen above it; a gesture or a header that returns to a chosen
// screen needs that tail gone together. An index that is not a position in
// this stack is refused, same as an invalid push.
export function popTo (stack, index) {
  if (!Array.isArray(stack)) return EMPTY
  if (!Number.isSafeInteger(index) || index < 0 || index >= stack.length) return stack
  if (index === stack.length - 1) return stack
  return Object.freeze(stack.slice(0, index + 1))
}

export function reset () {
  return EMPTY
}
