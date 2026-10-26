// The Espiadinha screen's building blocks: row keys, page merging, the round
// separators, the notice shown in place of the list and the fixed texts. Pure:
// no imports and no globals, so Node tests load it directly. The rule text
// mirrors PEEK_RULE in packages/core/lib/peek.js (the app cannot import it).

export const PEEK_WEB_ONLY_MESSAGE = 'Nesta versão, a Espiadinha só funciona na versão web no site da associação.'
export const PEEK_OFFLINE_MESSAGE = 'A Espiadinha precisa de conexão com o semeador.'
export const PEEK_RULE_TEXT = 'A Espiadinha mostra a publicação mais recente de cada diário que você não segue, da mais nova para a mais antiga; depois a segunda e, por fim, a terceira mais recente de cada um, do mesmo jeito: sem curtidas, sem sugestões e sem pesos escondidos.'
export const PEEK_SHORT_TEXT = 'Até três publicações de cada diário que você não segue, uma rodada por vez, da mais nova para a mais antiga.'

const WEB_ONLY_MESSAGES = ['método desconhecido', 'Espiadinha disponível só no navegador']

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
  if (round === 1) return '2ª publicação de cada diário'
  if (round === 2) return '3ª publicação de cada diário'
  return null
}

export function isWebOnlyError (err) {
  return Boolean(err && err.code === 'USAGE' && WEB_ONLY_MESSAGES.includes(err.message))
}
