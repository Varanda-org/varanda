// Pure logic for the 'citacoes' screen (the posts that quote a post). The
// seeder's post index only says where to look (its newest 50 quotes, one page,
// no cursor); a row exists only when diary.peek returned the author's signed
// post whose own `quote` is the focal post. The index can hide a quote but
// never add one. Never throws.

import { isValidUsername } from './who.js'
import { parseRef, target } from './thread.js'
import { avatarOf } from './media/avatar.js'

export const QUOTES_TITLE = 'Citações'
export const END_TEXT = 'Isso é tudo nesta lista.'
export const LOAD_FAILED = 'Não foi possível carregar as citações.'

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (n) => Number.isSafeInteger(n) && n >= 0

export function countLabel (n) {
  if (!isCount(n)) return ''
  return n === 1 ? '1 citação' : n + ' citações'
}

export function confirmQuotes (opts) {
  const { focal, items, peeked } = isPlain(opts) ? opts : {}
  const rows = []
  const target0 = parseRef(focal)
  const lookup = peeked instanceof Map ? peeked : new Map()
  const seen = new Set()
  let unconfirmed = 0
  for (const item of Array.isArray(items) ? items : []) {
    const ref = parseRef(item)
    if (ref === null || seen.has(item)) { if (ref === null) unconfirmed++; continue }
    seen.add(item)
    const peek = lookup.get(ref.author)
    const entry = isPlain(peek) && peek.key === ref.author && Array.isArray(peek.entries)
      ? peek.entries.find((e) => isPlain(e) && e.seq === ref.seq && isPlain(e.record))
      : null
    const record = entry ? entry.record : null
    const quoted = record ? target(record.quote) : null
    const ok = target0 !== null && record !== null && record.type === 'post' &&
      typeof record.text === 'string' && typeof record.at === 'string' &&
      (record.replyTo === null || record.replyTo === undefined) &&
      quoted !== null && quoted.author === target0.author && quoted.seq === target0.seq
    if (!ok) { unconfirmed++; continue }
    rows.push({
      author: ref.author,
      seq: ref.seq,
      ref: item,
      at: record.at,
      text: record.text,
      media: Array.isArray(record.media) && record.media.length > 0,
      name: isPlain(peek.profile) && typeof peek.profile.name === 'string' ? peek.profile.name : null,
      username: isValidUsername(peek.username) ? peek.username : null,
      avatar: isPlain(peek.profile) ? avatarOf(peek.profile.avatar) : null
    })
  }
  return { rows, unconfirmed }
}

// The seeder's total also counts quotes this list may legitimately omit (held,
// future-dated), so an empty list with total > 0 never claims nobody quoted.
export function listView (opts) {
  const { hosted, online, unsupported, phase, rows, unconfirmed, error, total, indexing, complete } = isPlain(opts) ? opts : {}
  const count = Array.isArray(rows) ? rows.length : 0
  if (hosted !== true) {
    return { view: 'web-only', title: 'Citações indisponíveis', body: 'As citações aparecem no site da associação ou no app ligado à instalação, com internet.' }
  }
  if (unsupported === true) {
    return { view: 'unavailable', title: 'Lista indisponível', body: 'As citações não estão disponíveis nesta conexão.' }
  }
  if (online === false && count === 0) {
    return { view: 'offline', title: 'Sem conexão', body: 'A lista precisa de internet.', action: 'tentar de novo' }
  }
  if (count > 0) return { view: 'ready' }
  if (phase === 'idle' || phase === 'loading') return { view: 'loading' }
  if (phase === 'error') return { view: 'error', message: typeof error === 'string' && error !== '' ? error : LOAD_FAILED }
  if (typeof unconfirmed === 'number' && unconfirmed > 0) {
    return { view: 'unchecked', title: 'Nenhuma citação pôde ser conferida agora', body: 'Tente de novo em instantes.', action: 'tentar de novo' }
  }
  if (total === 0 && indexing !== true && complete !== false) {
    return { view: 'empty', title: 'Ninguém citou ainda', body: 'Quando alguém citar esta publicação, aparece aqui.' }
  }
  return {
    view: 'hidden',
    title: 'Nenhuma citação para mostrar agora',
    body: indexing === true ? 'Ainda montando a lista completa…' : 'Algumas citações não aparecem nesta lista agora.',
    action: 'tentar de novo'
  }
}

export function notesOf (opts) {
  const { indexing, complete, unconfirmed, total, listed } = isPlain(opts) ? opts : {}
  const notes = []
  const unchecked = isCount(unconfirmed) ? unconfirmed : 0
  if (indexing === true) notes.push('Ainda montando a lista completa…')
  else if (complete === false) notes.push('Alguma citação pode faltar nesta lista.')
  // One page only: the index lists the newest quotes and has no way to go on.
  else if (isCount(total) && isCount(listed) && total > listed + unchecked) {
    notes.push('Esta lista mostra só as citações mais recentes.')
  }
  if (unchecked > 0) notes.push(unchecked === 1 ? '1 citação indisponível' : unchecked + ' citações indisponíveis')
  return notes
}
