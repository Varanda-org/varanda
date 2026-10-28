// The Espiadinha screen's building blocks: row keys, page merging, the round
// separators, the notice shown in place of the list, useSocial's needs for a
// page, the error tests and the fixed texts. Pure:
// no imports and no globals, so Node tests load it directly. The rule text
// mirrors PEEK_RULE in packages/core/lib/peek.js (the app cannot import it).

export const PEEK_WEB_ONLY_MESSAGE = 'Nesta versão, a Espiadinha só funciona na versão web no site da associação.'
export const PEEK_OFFLINE_MESSAGE = 'Confira sua internet.'
export const PEEK_RULE_TEXT = 'A Espiadinha mostra a publicação mais recente de cada diário que você não segue, da mais nova para a mais antiga; depois a segunda e, por fim, a terceira mais recente de cada um, do mesmo jeito: sem curtidas, sem sugestões e sem pesos escondidos.'
export const PEEK_SHORT_TEXT = 'Até três publicações de cada diário que você não segue.'

const WEB_ONLY_MESSAGES = ['método desconhecido', 'Espiadinha disponível só no navegador']
// The browser node's answer to a continuation whose snapshot expired or is
// gone (packages/web-member/lib/peek.js): the rows shown stay valid, only the
// cursor is dead, so the list asks for a refresh instead of ending.
const EXPIRED_MESSAGE = 'A lista expirou; atualize para continuar.'

export function peekKey (item) {
  return item.author + ':' + item.seq
}

// Appends the page's items to the current ones in the page's own order,
// skipping any key already present (including repeats inside the page). The
// inputs are never mutated.
export function mergePage (currentItems, pageItems) {
  const seen = new Set(currentItems.map(peekKey))
  const items = currentItems.slice()
  let added = 0
  for (const item of pageItems) {
    const key = peekKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
    added += 1
  }
  return { items, added }
}

export function isLastPeekPage (page) {
  return page.next === null || page.items.length === 0
}

export function withoutAuthor (items, author) {
  return items.filter((item) => item.author !== author)
}

// Indexes where the round changes. The first item always starts a round, so a
// non-empty list begins with a separator.
export function roundStarts (items) {
  const starts = new Set()
  items.forEach((item, index) => {
    if (index === 0 || item.round !== items[index - 1].round) starts.add(index)
  })
  return starts
}

// The notice shown in place of the list, or null. Web-only wins over offline.
export function peekNotice ({ supported, hosted, online, loadedAt }) {
  if (hosted !== true || supported === false) return 'web-only'
  if (online === false && loadedAt === null) return 'offline'
  return null
}

export function roundLabel (round) {
  if (round === 0) return '1ª publicação de cada diário'
  if (round === 1) return '2ª publicação de cada diário'
  if (round === 2) return '3ª publicação de cada diário'
  return null
}

export function isWebOnlyError (err) {
  return Boolean(err && err.code === 'USAGE' && WEB_ONLY_MESSAGES.includes(err.message))
}

export function isExpiredPeekError (err) {
  return Boolean(err && err.code === 'USAGE' && err.message === EXPIRED_MESSAGE)
}

// The note under the list for the diaries a page left out, or null. The
// reasons are in the help sheet 'ausentes' (src/help.js).
export function skippedText (n) {
  if (!Number.isSafeInteger(n) || n < 1) return null
  return n === 1 ? '1 diário não aparece.' : String(n) + ' diários não aparecem.'
}

// Same as ARua's refOf (a lowercase author:seq, or null), kept here so this
// file stays import-free.
function refOf (t) {
  if (!t || typeof t.author !== 'string' || !Number.isSafeInteger(t.seq) || t.seq < 1) return null
  return t.author.toLowerCase() + ':' + t.seq
}

// useSocial's ingest arguments for a page: the posts are originals at hand
// (a quote or a reply of a post on the list resolves locally); the posts
// they quote or answer and the originals of reposts are resolved; no author
// is followed. A repost's list key (peekKey) is the reposter's author:seq,
// but what it shows and needs is the original's (`to`).
export function pageNeeds (items) {
  const local = new Map()
  const shown = []
  const need = []
  for (const item of items) {
    if (item.kind === 'repost') {
      const ref = refOf(item.to)
      if (ref !== null) {
        shown.push(ref)
        need.push(ref)
      }
      continue
    }
    const ref = peekKey(item)
    local.set(ref, item)
    shown.push(ref)
    for (const r of [refOf(item.quote), refOf(item.replyTo)]) if (r !== null) need.push(r)
  }
  return { local, shown, need, authors: [] }
}
