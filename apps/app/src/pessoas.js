// Pure logic for the public 'Seguindo' and 'Seguidores' lists. The seeder's
// list only says where to look: a row exists only when diary.peek returned
// the signed follow record behind it. A verified 'on' record does not prove
// that no later 'off' exists; that part stays a seeder claim. Never throws.

import { SEEDER_DOWN, MORE_FAILED, END_TEXT } from './engagers.js'

export { SEEDER_DOWN, MORE_FAILED, END_TEXT }

export const KINDS = Object.freeze(['seguindo', 'seguidores'])
export const PESSOAS_TITLE = Object.freeze({ seguindo: 'Seguindo', seguidores: 'Seguidores' })
export const COUNT_LABEL = Object.freeze({ seguindo: 'seguindo', seguidores: 'seguidores' })
export const NOT_HOSTED = 'Disponível no site da associação ou no app ligado à instalação.'
export const INCOMPLETE_NOTE = 'A lista pode estar incompleta.'
export const COUNTS_INCOMPLETE_NOTE = 'A contagem pode estar incompleta.'

const LOAD_FAILED = 'Não foi possível carregar a lista.'
const HEX64 = /^[0-9a-f]{64}$/

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isCount = (n) => Number.isSafeInteger(n) && n >= 0
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1
const isHex64 = (s) => typeof s === 'string' && HEX64.test(s)

export function isKind (k) {
  return k === 'seguindo' || k === 'seguidores'
}

export function countLabel (n) {
  if (!isCount(n)) return ''
  return n === 1 ? '1 pessoa' : n + ' pessoas'
}

// 'seguidores' items point at the follower's own block; 'seguindo' items at
// the author's block that follows item.key.
function diaryOf (kind, author, item) {
  if (kind === 'seguidores') return item.key
  if (kind === 'seguindo') return author
  return null
}

export function refOf (kind, author, item) {
  if (!isPlain(item) || !isHex64(item.key) || !isSeq(item.seq)) return null
  const diary = diaryOf(kind, author, item)
  return isHex64(diary) ? diary + ':' + item.seq : null
}

// `peeked`: Map of diary key -> diary.peek result, as in engagers.js. For
// 'seguindo' every item lives in the author's diary, so one peek of the
// author covers the page.
function proves (peek, diary, item, target) {
  if (!isPlain(peek) || peek.key !== diary || !Array.isArray(peek.entries)) return false
  const entry = peek.entries.find((e) => isPlain(e) && e.seq === item.seq && isPlain(e.record))
  if (!entry) return false
  const record = entry.record
  return record.type === 'follow' && record.on === true && record.at === item.at && record.key === target
}

export function confirmFollows (opts) {
  const { kind, author, items, peeked } = isPlain(opts) ? opts : {}
  const rows = []
  const list = Array.isArray(items) ? items : []
  const lookup = peeked instanceof Map ? peeked : new Map()
  const ok = isKind(kind) && isHex64(author)
  const shown = new Set()
  const missing = new Set()
  let malformed = 0
  for (const item of list) {
    if (refOf(kind, author, item) === null || typeof item.at !== 'string') { malformed++; continue }
    if (shown.has(item.key)) continue
    const diary = diaryOf(kind, author, item)
    const target = kind === 'seguidores' ? author : item.key
    if (!ok || item.key === author || !proves(lookup.get(diary), diary, item, target)) {
      missing.add(item.key)
      continue
    }
    missing.delete(item.key)
    shown.add(item.key)
    rows.push({ key: item.key, seq: item.seq, at: item.at })
  }
  return { rows, unavailable: malformed + missing.size }
}

// Returns `current` itself when nothing is added, so an empty page keeps the
// list's data identity.
export function mergeRows (current, rows) {
  const base = Array.isArray(current) ? current : []
  if (!Array.isArray(rows)) return base
  const seen = new Set(base.map((r) => r && r.key))
  const added = []
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || seen.has(row.key)) continue
    seen.add(row.key)
    added.push(row)
  }
  return added.length === 0 ? base : base.concat(added)
}

// A cursor equal to the one just used would page forever.
export function nextCursor (prev, next) {
  if (!isPlain(next) || !isCount(next.atMs) || !isHex64(next.key)) return null
  if (isPlain(prev) && prev.atMs === next.atMs && prev.key === next.key) return null
  return { atMs: next.atMs, key: next.key }
}

export function notesOf (opts) {
  const { indexing, complete, unavailable } = isPlain(opts) ? opts : {}
  const notes = []
  if (indexing === true) notes.push('Ainda montando a lista completa…')
  else if (complete === false) notes.push(INCOMPLETE_NOTE)
  if (isCount(unavailable) && unavailable > 0) {
    notes.push(unavailable === 1 ? '1 pessoa indisponível' : unavailable + ' pessoas indisponíveis')
  }
  return notes
}

export function errorFor (reason) {
  if (reason === 'network' || reason === 'timeout') return SEEDER_DOWN
  if (reason === 'not-found') return 'Esta lista não está disponível agora.'
  if (reason === 'rate-limited') return 'Muitas consultas ao semeador agora. Tente de novo em alguns segundos.'
  return LOAD_FAILED
}
