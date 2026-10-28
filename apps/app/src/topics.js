// The Espiadinha's "pesquisar por assunto" building blocks: the query path
// sent to the seeder's search index, whole-token matching, the assembly of the
// verified results and the fixed texts. Pure: no imports and no globals, so
// Node tests load it directly (the app cannot import @varanda/core).
//
// Trust model: the seeder index only says where to look (refs). A result is
// shown only after diary.peek returned the entry verified against the author's
// signed log AND the verified text itself contains every query token, so a
// seeder that lies about a post (or lists a stale one) can only make a ref
// count as "unavailable", never put words into an author's mouth.
//
// No Unicode property escapes anywhere in this module (apps/app/src/who.js).

// Duplicated from packages/core/lib/topic-index.js (the source of truth for
// the fold and the tokens; keep the two in step).
// A value whose string conversion throws folds to '' (as the core copy), so
// callers never see a throw from here.
function foldText (s) {
  try {
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  } catch {
    return ''
  }
}

export function tokensOf (s) {
  const out = []
  const seen = new Set()
  for (const t of foldText(s).split(/[^a-z0-9]+/)) {
    if (t.length < 2 || t.length > 32 || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

export { foldText }

export const SEARCH_PAGE = 30
export const MAX_QUERY_TOKENS = 8
// The field's maxLength, in UTF-16 units; a defensive bound only.
export const SEARCH_INPUT_MAX = 100
// Same value as packages/core/lib/feed.js MAX_FUTURE_MS.
export const MAX_FUTURE_MS = 86400000
export const QUERY_RE = /^[a-z0-9]{2,32}(?:\+[a-z0-9]{2,32}){0,7}$/

export const SEARCH_LABEL = 'pesquisar por assunto'
export const SEARCH_PLACEHOLDER = 'uma palavra ou frase'
export const SEARCH_BUTTON = 'pesquisar'
export const SEARCH_CLEAR = 'limpar'
export const SEARCH_HINT = 'Procura palavras inteiras nas publicações públicas guardadas pela associação, no histórico inteiro e também de quem você segue, da mais nova para a mais antiga, sem pesos escondidos. Maiúsculas e acentos não importam: "ceu" encontra "Céu" e "#Céu". Uma frase encontra as publicações que têm todas as palavras.'
export const SEARCH_INVALID = 'Escreva uma palavra com pelo menos 2 letras ou números.'
export const SEARCH_TRUNCATED = 'A pesquisa usou as 8 primeiras palavras.'
export const SEARCH_EMPTY_TITLE = 'Nada encontrado'
export const SEARCH_EMPTY_BODY = 'Nenhuma publicação com essas palavras por enquanto.'
export const SEARCH_CONTINUE = 'continuar busca'
export const SEARCH_CONTINUE_BODY = 'Nenhuma destas conferiu. Ainda há onde procurar.'
export const SEARCH_INDEXING_NOTE = 'Ainda preparando a pesquisa…'
export const SEARCH_INCOMPLETE_NOTE = 'Algumas publicações podem faltar.'
export const SEARCH_OFFLINE_MESSAGE = 'A pesquisa precisa de conexão.'
export const SEARCH_UNAVAILABLE = 'A pesquisa ainda não está disponível.'
export const SEARCH_ERROR = 'Não foi possível pesquisar.'
export const SEARCH_BUSY = 'Muitas pesquisas agora. Tente de novo em alguns segundos.'
export const SEARCH_END = 'Isso é tudo nesta pesquisa.'
export const SEARCH_MEMORY = 'Os resultados ficam só na memória do navegador enquanto a aba está aberta.'

// The wire query for the typed text, or null when it has no usable word. The
// path uses a literal '+' (never percent-encoded) and is idempotent.
export function searchPath (text) {
  if (typeof text !== 'string') return null
  const all = tokensOf(text)
  if (all.length === 0) return null
  const tokens = all.slice(0, MAX_QUERY_TOKENS)
  return { tokens, path: tokens.join('+'), truncated: all.length > MAX_QUERY_TOKENS }
}

// True iff every token is a whole token of the text (any order).
export function matchesAll (text, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return false
  const have = new Set(tokensOf(text))
  return tokens.every((t) => have.has(t))
}

const REF = /^([0-9a-f]{64}):([1-9][0-9]*)$/
const HEX64 = /^[0-9a-f]{64}$/

function parseRef (ref) {
  if (typeof ref !== 'string') return null
  const m = REF.exec(ref)
  if (!m) return null
  const seq = Number(m[2])
  if (!Number.isSafeInteger(seq) || String(seq) !== m[2]) return null
  return { author: m[1], seq }
}

const isObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o)

// Mirrors apps/app/src/thread.js target, peekOf, identity, recordAt and
// postItem (private there); keep the two in step.
function target (t) {
  if (!isObject(t) || typeof t.author !== 'string' || !HEX64.test(t.author) || !Number.isSafeInteger(t.seq) || t.seq < 0) return null
  return { author: t.author, seq: t.seq }
}

function peekOf (peeked, author) {
  if (!(peeked instanceof Map)) return null
  const peek = peeked.get(author)
  if (!isObject(peek) || (peek.key !== undefined && peek.key !== author)) return null
  return peek
}

function identity (peek) {
  const profile = peek && isObject(peek.profile) && typeof peek.profile.name === 'string'
    ? { name: peek.profile.name }
    : null
  const username = peek && typeof peek.username === 'string' ? peek.username : null
  return { profile, username }
}

function recordAt (peek, seq) {
  if (!peek || !Array.isArray(peek.entries)) return null
  for (const e of peek.entries) {
    if (isObject(e) && e.seq === seq && isObject(e.record)) return e.record
  }
  return null
}

function postItem (author, seq, record, peek) {
  if (record.type !== 'post' || typeof record.text !== 'string' || typeof record.at !== 'string') return null
  const replyTo = record.replyTo === null ? null : target(record.replyTo)
  if (record.replyTo !== null && replyTo === null) return null
  const hasQuote = record.quote !== undefined && record.quote !== null
  const quote = hasQuote ? target(record.quote) : null
  if (hasQuote && (quote === null || replyTo !== null)) return null
  if (record.media !== undefined && !Array.isArray(record.media)) return null
  const { profile, username } = identity(peek)
  return {
    kind: 'post',
    author,
    seq,
    at: record.at,
    text: record.text,
    replyTo,
    quote,
    media: Array.isArray(record.media) && record.media.length > 0 ? record.media.slice() : null,
    name: profile ? profile.name : null,
    username
  }
}

// Builds the shown results from the index refs and the peeked (verified)
// entries, in refs order. Anything that cannot be shown counts in
// `unavailable`; malformed and duplicate refs are skipped silently. No follow
// set is used: followed and own authors are kept. Never throws.
export function assembleSearch ({ refs, peeked, tokens, now } = {}) {
  const items = []
  let unavailable = 0
  try {
    const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    const seen = new Set()
    for (const ref of Array.isArray(refs) ? refs : []) {
      const r = parseRef(ref)
      if (r === null || seen.has(ref)) continue
      seen.add(ref)
      const peek = peekOf(peeked, r.author)
      const record = recordAt(peek, r.seq)
      const item = record === null ? null : postItem(r.author, r.seq, record, peek)
      if (item === null || !matchesAll(item.text, tokens)) {
        unavailable += 1
        continue
      }
      const at = Date.parse(item.at)
      if (!Number.isFinite(at) || at - clock > MAX_FUTURE_MS) {
        unavailable += 1
        continue
      }
      items.push(item)
    }
  } catch (err) {
    return { items, unavailable }
  }
  return { items, unavailable }
}

function refKey (ref) {
  return ref
}

// Appends the page's refs to the current ones in order, skipping duplicates;
// the inputs are never mutated.
export function mergeRefs (current, page) {
  const seen = new Set(current.map(refKey))
  const refs = current.slice()
  let added = 0
  for (const ref of page) {
    if (seen.has(ref)) continue
    seen.add(ref)
    refs.push(ref)
    added += 1
  }
  return { refs, added }
}

// Only a null cursor ends the search: unlike the Espiadinha, a search page can
// be empty (nothing verified yet) and still carry a next cursor.
export function isLastSearchPage (page) {
  return page.next === null
}

// The notice shown in place of the search, or null. Web-only wins over offline.
export function searchNotice ({ hosted, online, loadedAt }) {
  if (hosted !== true) return 'web-only'
  if (online === false && loadedAt === null) return 'offline'
  return null
}
