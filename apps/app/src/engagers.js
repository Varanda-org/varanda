// Pure logic for the 'curtidas' screen (who liked or reposted a post).
// The seeder's list only says where to look: a row exists only when
// diary.peek returned the engager's signed record proving it. Even then, a
// verified 'on' record does not prove that no later 'off' exists; that part
// stays a seeder claim. Never throws.

import { isValidUsername } from './who.js'
import { isRef } from './nav.js'

export const KINDS = Object.freeze(['likes', 'reposts'])

export const ENGAGERS_TITLE = 'Curtidas e republicações'
export const TAB_LABEL = Object.freeze({ likes: 'Curtidas', reposts: 'Republicações' })
export const SEEDER_DOWN = 'Sem conexão com o servidor agora.'
export const MORE_FAILED = 'Não foi possível carregar mais pessoas.'
export const END_TEXT = 'Isso é tudo nesta lista.'

const LOAD_FAILED = 'Não foi possível carregar a lista.'

export function isKind (k) {
  return k === 'likes' || k === 'reposts'
}

export function recordType (kind) {
  if (kind === 'likes') return 'like'
  if (kind === 'reposts') return 'repost'
  return null
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (n) => Number.isSafeInteger(n) && n >= 0

export function countLabel (kind, n) {
  if (!isKind(kind) || !isCount(n)) return ''
  if (kind === 'likes') return n === 1 ? '1 curtida' : n + ' curtidas'
  return n === 1 ? '1 republicação' : n + ' republicações'
}

function parseRef (ref) {
  if (!isRef(ref)) return null
  const i = ref.indexOf(':')
  return { author: ref.slice(0, i), seq: Number(ref.slice(i + 1)) }
}

function proves (peek, author, seq, type, focal) {
  if (!isPlain(peek) || peek.key !== author || !Array.isArray(peek.entries)) return false
  const entry = peek.entries.find((e) => isPlain(e) && e.seq === seq && isPlain(e.record))
  if (!entry) return false
  const record = entry.record
  if (record.type !== type || record.on !== true || !isPlain(record.to)) return false
  return record.to.author === focal.author && record.to.seq === focal.seq
}

export function confirmEngagers (opts) {
  const { kind, focal, items, peeked } = isPlain(opts) ? opts : {}
  const rows = []
  const list = Array.isArray(items) ? items : []
  const type = recordType(kind)
  const target = parseRef(focal)
  const lookup = peeked instanceof Map ? peeked : new Map()
  const shown = new Set()
  const missing = new Set()
  let malformed = 0
  for (const item of list) {
    const ref = parseRef(item)
    if (!ref) { malformed++; continue }
    if (shown.has(ref.author)) continue
    const peek = lookup.get(ref.author)
    if (!type || !target || !proves(peek, ref.author, ref.seq, type, target)) {
      missing.add(ref.author)
      continue
    }
    missing.delete(ref.author)
    shown.add(ref.author)
    rows.push({
      author: ref.author,
      seq: ref.seq,
      name: isPlain(peek.profile) && typeof peek.profile.name === 'string' ? peek.profile.name : null,
      username: isValidUsername(peek.username) ? peek.username : null
    })
  }
  return { rows, unconfirmed: malformed + missing.size }
}

// Returns `current` itself when nothing is added, so an empty page keeps the
// list's data identity.
export function mergeRows (current, rows) {
  const base = Array.isArray(current) ? current : []
  if (!Array.isArray(rows)) return base
  const seen = new Set(base.map((r) => r && r.author))
  const added = []
  for (const row of rows) {
    if (!row || typeof row.author !== 'string' || seen.has(row.author)) continue
    seen.add(row.author)
    added.push(row)
  }
  return added.length === 0 ? base : base.concat(added)
}

export function nextCursor (prev, next) {
  if (typeof next !== 'string' || next === '' || next === prev) return null
  return next
}

// The seeder's total also counts engagers this list may legitimately omit
// (future-dated, held), so an empty list with total > 0 never claims that
// nobody engaged.
export function listView (opts) {
  const { hosted, online, unsupported, phase, rows, next, unconfirmed, error, kind, total, indexing, complete } = isPlain(opts) ? opts : {}
  const count = Array.isArray(rows) ? rows.length : 0
  if (hosted !== true || unsupported === true) {
    return { view: 'web-only', title: 'Só na versão web', body: 'Quem curtiu e quem republicou aparece na versão web, com internet.' }
  }
  if (online === false && count === 0) {
    return { view: 'offline', title: 'Sem conexão', body: 'A lista precisa de internet.', action: 'tentar de novo' }
  }
  if (count > 0) return { view: 'ready' }
  if (phase === 'idle' || phase === 'loading') return { view: 'loading' }
  if (phase === 'error') {
    return { view: 'error', message: typeof error === 'string' && error !== '' ? error : LOAD_FAILED }
  }
  if (next !== null && next !== undefined) {
    return { view: 'more', title: 'Ninguém conferido até aqui', body: 'A lista continua.', action: 'mostrar mais' }
  }
  if (typeof unconfirmed === 'number' && unconfirmed > 0) {
    return { view: 'unchecked', title: 'Ninguém pôde ser conferido agora', body: 'Tente de novo em instantes.', action: 'tentar de novo' }
  }
  if (total === 0 && indexing !== true && complete !== false) {
    return kind === 'reposts'
      ? { view: 'empty', title: 'Ninguém republicou ainda', body: 'Quando alguém republicar, aparece aqui.' }
      : { view: 'empty', title: 'Ninguém curtiu ainda', body: 'Quando alguém curtir, aparece aqui.' }
  }
  return {
    view: 'hidden',
    title: 'Ninguém para mostrar agora',
    body: indexing === true ? 'Ainda montando a lista completa…' : 'Algumas pessoas não aparecem nesta lista agora.',
    action: 'tentar de novo'
  }
}

export function errorFor (reason) {
  if (reason === 'not-found') return 'Esta lista não está disponível agora.'
  if (reason === 'rate-limited') return 'Muitas consultas ao semeador agora. Tente de novo em alguns segundos.'
  return LOAD_FAILED
}

export function notesOf (opts) {
  const { indexing, complete, unconfirmed, total, listed, atEnd } = isPlain(opts) ? opts : {}
  const notes = []
  const unchecked = isCount(unconfirmed) ? unconfirmed : 0
  if (indexing === true) notes.push('Ainda montando a lista completa…')
  else if (complete === false) notes.push('Alguém pode faltar nesta lista.')
  // The seeder's total also counts people the list may never return (a date
  // more than 24 h ahead), so a finished list can still be short.
  else if (atEnd === true && isCount(total) && isCount(listed) && total > listed + unchecked) {
    notes.push('Algumas pessoas não aparecem nesta lista agora.')
  }
  if (isCount(unconfirmed) && unconfirmed > 0) {
    notes.push(unconfirmed === 1 ? '1 pessoa indisponível' : unconfirmed + ' pessoas indisponíveis')
  }
  return notes
}
