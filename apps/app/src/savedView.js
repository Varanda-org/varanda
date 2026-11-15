// Pure view of the "Posts salvos" screen. The stored list holds refs only
// ({ author, seq, savedAt }, savedPosts.js); every post shown was just read
// again with diary.peek and came back verified, so nothing here trusts what a
// peer said earlier. A ref whose post is gone, invalid, hidden or from a
// blocked author becomes one neutral row with a way to take it off the list:
// never why, never a name. No React, no platform module.

import { SAVED_FULL_TEXT, SAVED_SCOPES_TEXT } from './savedPosts.js'
import { assembleMember, planPeeks } from './thread.js'

export const SAVED_TITLE = 'Posts salvos'
export const SAVED_ENTRY_LABEL = 'Posts salvos'
export const UNAVAILABLE_TEXT = 'Publicação indisponível'
export const UNCHECKED_TEXT = 'Não deu para conferir agora'
export const LOADING_TEXT = 'Carregando publicação'
export const UNSAVE_LABEL = 'Tirar dos salvos'
export const EMPTY_TITLE = 'Nada salvo por aqui ainda'
export const EMPTY_BODY = 'Quando uma publicação te interessar, toque nos três pontinhos dela e escolha Salvar. A lista fica só neste aparelho.'
export const OFFLINE_TITLE = 'Sem conexão no momento'
export const OFFLINE_BODY = 'Suas publicações salvas aparecem quando a internet voltar.'
export const ERROR_TEXT = 'Não foi possível abrir suas publicações salvas agora.'
export const FAILED_TEXT = 'Não deu para conferir algumas publicações agora. Puxe para atualizar e tente de novo.'
export const END_TEXT = 'Isso é tudo o que você salvou.'

// At most this many diary.peek calls at a time (the node answers a third
// with 'ocupado'; the app-wide peek slots may serialize them further).
export const MAX_IN_FLIGHT = 2

const HEX64 = /^[0-9a-f]{64}$/

export const refKey = (author, seq) => author + ':' + seq

// diary.peek params for the saved entries: refs grouped by author, seqs
// ascending in chunks of at most PEEK_SEQS_MAX (29). `hints` ({ [author]:
// { profileSeq, usernameSeq } }, from the seeder index) go on each author's
// first chunk so the peek returns the verified name, username and avatar.
export function planLoads (entries, isBlocked, hints) {
  const blocked = typeof isBlocked === 'function' ? isBlocked : () => false
  const refs = []
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && typeof e.author === 'string' && HEX64.test(e.author) && Number.isSafeInteger(e.seq) && e.seq >= 1 && !blocked(e.author)) refs.push(refKey(e.author, e.seq))
  }
  return planPeeks({ refs, authors: hints })
}

// The hosted node only, and only a post with a real author and seq: the same
// rule moreActions applies to the row.
export function canSavePost ({ hosted, author, seq }) {
  return hosted === true && typeof author === 'string' && HEX64.test(author) && Number.isSafeInteger(seq) && seq >= 1
}

// The note after Salvar: a full list says so, a failed write is not hidden.
export function saveNotice (result) {
  if (!result || typeof result !== 'object') return 'Não foi possível salvar agora.'
  if (result.ok === true) return result.persisted === false ? 'Salvo só até fechar o app: este aparelho não deixou guardar.' : 'Publicação salva.'
  if (result.reason === 'full') return SAVED_FULL_TEXT
  if (result.reason === 'scopes') return SAVED_SCOPES_TEXT
  return 'Não foi possível salvar agora.'
}

export function unsaveNotice (ok) {
  return ok === true ? 'Tirado dos salvos.' : 'Não foi possível tirar dos salvos agora.'
}

// One row per saved entry, in the stored order (newest saved first).
// -> { kind: 'post', key, ref, author, seq, post } for a verified post (a
// post item of thread.js assembleMember), or { kind: 'gone', key, ref,
// author, seq } for anything else, { kind: 'unchecked' } when the author's
// read failed and no earlier post is known, and { kind: 'loading' } for a ref
// no read has tried yet (never shown as gone). `isBlocked(author)` hides the author's
// posts the same way. A repost, a record of another type or a post under
// another key is not a saved post.
export function buildRows ({ entries, peeked, isBlocked, attempted, failedAuthors } = {}) {
  const blocked = typeof isBlocked === 'function' ? isBlocked : () => false
  const rows = []
  const seen = new Set()
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.author !== 'string' || !HEX64.test(e.author) || !Number.isSafeInteger(e.seq) || e.seq < 1) continue
    const key = refKey(e.author, e.seq)
    if (seen.has(key)) continue
    seen.add(key)
    const gone = { kind: 'gone', key, ref: key, author: e.author, seq: e.seq }
    if (blocked(e.author)) {
      rows.push(gone)
      continue
    }
    const { items } = assembleMember({ author: e.author, index: { posts: [e.seq] }, peeked })
    const post = items.find((item) => item.kind === 'post' && item.author === e.author && item.seq === e.seq)
    if (post) rows.push({ kind: 'post', key, ref: key, author: e.author, seq: e.seq, post })
    else if (failedAuthors && failedAuthors.has(e.author)) rows.push({ kind: 'unchecked', key, ref: key, author: e.author, seq: e.seq })
    else if (attempted && !attempted.has(key)) rows.push({ kind: 'loading', key, ref: key, author: e.author, seq: e.seq })
    else rows.push(gone)
  }
  return rows
}

// What the screen shows. `phase`: 'idle' | 'loading' | 'ready' | 'error'.
// 'off' where the node does not read on demand (not hosted): the entry is not
// offered there, so this is only a guard.
export function viewOf ({ hosted, online, phase, count }) {
  if (hosted !== true) return { view: 'off' }
  if (phase !== 'ready' && online === false) return { view: 'offline', title: OFFLINE_TITLE, body: OFFLINE_BODY }
  if (phase === 'error') return { view: 'error', message: ERROR_TEXT }
  if (phase === 'ready' && count === 0) return { view: 'empty', title: EMPTY_TITLE, body: EMPTY_BODY }
  if (phase === 'ready') return { view: 'ready' }
  return { view: 'loading' }
}
