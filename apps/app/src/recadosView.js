// Recados screen: the pure helpers around src/scraps.js (what each viewer can
// do with a row, the labels and which notice a page shows). No React and no
// request. Peer text is not handled here: the screen applies displayText.
// The word for the photo grid is never used for this feature.

import { NOTICES, SCRAP_TEXT_MAX, WALLS, replyDraft } from './scraps.js'

export const RECADOS_TITLE = 'Recados'
export const RECADOS_ENTRY_LABEL = 'Recados'
export const COMPOSE_LABEL = 'Deixar um recado'
export const COMPOSE_PLACEHOLDER = 'Escreva o recado'
export const SEND_LABEL = 'Enviar recado'
export const CHECKED_LABEL = 'Já conferi a página'
export const REPLY_TITLE = 'Responder recado'
export const MORE_LABEL = 'Ver mais'
export const HIDE_TITLE = 'Tirar da sua página?'
export const HIDE_BODY = 'O recado deixa de aparecer na sua página. Quem escreveu continua com ele no diário. Tirar um recado fica registrado publicamente no seu diário.'
export const HIDE_CONFIRM = 'Tirar'
export const DELETE_TITLE = 'Apagar o recado?'
export const DELETE_BODY = 'O recado deixa de valer e some da página da pessoa.'
export const DELETE_CONFIRM = 'Apagar'
export const SENT_TOAST = 'Recado enviado.'
export const EMPTY_TITLE = 'Nenhum recado ainda'
export const HOSTED_ONLY = 'Recados disponíveis na versão web, com internet.'
export const WALL_TITLE = 'Quem pode deixar recado'
export const WALL_NOTE = 'Vale para a sua página. Com "Quem eu sigo", quem recebeu um recado seu pode responder a ele, mesmo sem você seguir essa pessoa.'
export const WALL_PUBLIC = 'Mudar essa escolha fica registrado publicamente no seu diário.'
export const BLOCKED_ROW = 'recado de pessoa bloqueada'
export const WALL_UNREAD = 'Não deu para ler a sua escolha agora. Tente de novo daqui a pouco.'

const WALL_OPTIONS = Object.freeze([
  Object.freeze({ id: 'following', label: 'Quem eu sigo' }),
  Object.freeze({ id: 'everyone', label: 'Todos' }),
  Object.freeze({ id: 'nobody', label: 'Ninguém' })
])

// The three choices of Ajustes, in display order.
export function wallOptions () {
  return WALL_OPTIONS
}

export function wallLabel (who) {
  const hit = WALL_OPTIONS.find((o) => o.id === who)
  return hit ? hit.label : null
}

// The note under the wall choices: the reply rule only exists under
// 'following', so the other two choices do not show it.
export function wallNote (who) {
  return who === 'following' ? WALL_NOTE : null
}

export function validWall (who) {
  return WALLS.includes(who)
}

// A line under the composer on someone else's page: who may write there.
// `wall` null means it could not be read: no claim is made.
export function wallLine (wall, ownPage = false) {
  if (wall === 'everyone') return ownPage ? 'Qualquer pessoa pode deixar recado na sua página.' : 'Qualquer pessoa pode deixar recado aqui.'
  if (wall === 'nobody') return ownPage ? 'Ninguém pode deixar recado na sua página.' : 'Esta pessoa não está recebendo recados.'
  if (wall === 'following') return ownPage ? 'Só quem você segue pode deixar recado na sua página.' : 'Só quem esta pessoa segue pode deixar recado aqui.'
  return null
}

export function isOwnPage (owner, self) {
  return typeof owner === 'string' && typeof self === 'string' && owner === self
}

// What the viewer can do with one row. Every entry is { id, label, danger? }
// in display order: reply, hide, delete, report.
//   reply   my page, a recado someone else left me (replyDraft agrees)
//   hide    my page, a recado someone else left ('Tirar da minha página')
//   delete  a recado I wrote, on any page ('Apagar recado')
//   report  the writer's account, never my own
export function rowActions (row, { owner, self, isBlocked } = {}) {
  if (!row || typeof row !== 'object' || typeof self !== 'string') return []
  const mine = row.author === self
  const own = isOwnPage(owner, self)
  const out = []
  if (replyDraft(row, { owner, self, isBlocked }) !== null) out.push({ id: 'reply', label: 'Responder' })
  if (own && !mine) out.push({ id: 'hide', label: 'Tirar da minha página', danger: true })
  if (mine) out.push({ id: 'delete', label: 'Apagar recado', danger: true })
  if (!mine) out.push({ id: 'report', label: 'Denunciar a conta', danger: true })
  return out
}

// Whether the composer shows: not on my own page, and not when the gate
// refused (the refusal notice shows in its place).
export function composerShown (gate, owner, self) {
  return !isOwnPage(owner, self) && !!gate && gate.ok === true
}

// The one notice above the list. The page's own notice wins (blocked,
// unreachable, wall unreadable, still indexing, incomplete); a failed read
// the page could not turn into a notice falls back to the unreachable text.
// null when nothing needs saying.
export function pageNotice (page, readError = null) {
  if (readError) return readError
  if (page && typeof page.notice === 'string' && page.notice !== '') return page.notice
  return null
}

// The empty state of a loaded page. A blocked or refused page has its notice
// instead of an empty message.
export function emptyKind (page, own) {
  if (!page) return 'none'
  if (page.blocked) return 'blocked'
  if (page.wall === 'nobody') return 'nobody'
  if (page.wall === null) return 'unread'
  return own ? 'own' : 'other'
}

export function emptyBody (kind) {
  if (kind === 'blocked') return NOTICES.blocked
  if (kind === 'nobody') return NOTICES.nobody
  if (kind === 'unread') return NOTICES.wallUnread
  if (kind === 'own') return 'Quando alguém deixar um recado na sua página, ele aparece aqui.'
  return 'Os recados deixados nesta página aparecem aqui.'
}

export function counterA11y (count) {
  return count + ' de ' + SCRAP_TEXT_MAX + ' caracteres'
}

// The index with the hide pointers the owner's held peeks already cover left
// out, so "Ver mais" does not read the same hide blocks again. `peeks` is the
// Map of reads kept across pages (key -> list of diary.peek results).
export function withoutReadHides (index, peeks, owner) {
  if (!index || !Array.isArray(index.hides) || !(peeks instanceof Map)) return index
  const known = new Set()
  for (const p of peeks.get(owner) || []) {
    for (const e of Array.isArray(p.entries) ? p.entries : []) if (e && Number.isSafeInteger(e.seq)) known.add(e.seq)
    for (const s of Array.isArray(p.invalid) ? p.invalid : []) known.add(s)
  }
  const seqOf = (h) => (h && typeof h === 'object' ? h.seq : h)
  return { ...index, hides: index.hides.filter((h) => !known.has(seqOf(h))) }
}

// Merge a next index page into the accumulated one: rows appended (a ref
// already held is skipped), hide pointers joined, the wall and the flags of
// the first page kept, `next` and `complete` taken from the newest page.
export function mergeIndex (base, page) {
  if (!base) return page
  const seen = new Set(base.rows.map((r) => r.author + ':' + r.seq))
  const rows = base.rows.concat(page.rows.filter((r) => !seen.has(r.author + ':' + r.seq)))
  const hides = [...new Set(base.hides.concat(page.hides))]
  return {
    rows,
    hides,
    wall: base.wall,
    next: page.next,
    indexing: base.indexing || page.indexing,
    complete: base.complete && page.complete
  }
}
