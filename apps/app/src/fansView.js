// Fãs and Melhores amigos: what the screens show and say. Pure: no React, no
// request, no platform module. The model that judges what the seeder points at
// is fans.js; this file holds the words, the read of the own diary (what the
// person did themselves: fan marks and the own top list) and the small rules
// the buttons follow.
//
// The own marks come from the own diary (a log.read walk, newest first), never
// from the seeder: a seeder could name an older record, and a button that
// started from it would write the opposite of what the person sees. A walk
// that stops short settles nothing it did not find: an unknown mark is
// unknown, never 'not a fan' (the button offers only the idempotent 'Sou fã').
//
// Nothing here is a peer's text: rows carry keys, seqs and dates only.

import { OWN_LOG_PAGES, TEXTS as EXTRA_TEXTS } from './profileExtraView.js'
import { NOTICES, editorRows, editorState, maxTopFriends } from './fans.js'
import { filterPeople } from './peopleFilter.js'

export { OWN_LOG_PAGES }

const HEX64 = /^[0-9a-f]{64}$/
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isHex64 = (s) => typeof s === 'string' && HEX64.test(s)
const isSeq = (n) => Number.isSafeInteger(n) && n >= 1

export const TEXTS = Object.freeze({
  fan: 'Sou fã',
  unfan: 'Deixar de ser fã',
  fanning: 'Sou fã…',
  unfanning: 'Deixando de ser fã…',
  fanDone: 'Agora você é fã.',
  unfanDone: 'Você deixou de ser fã.',
  fanNote: 'Ser fã é público e não é o mesmo que seguir.',
  retry: 'Tentar de novo',
  check: EXTRA_TEXTS.check,
  uncertain: EXTRA_TEXTS.uncertain,
  checking: 'Conferindo…',
  checkedFan: 'Conferido: você é fã.',
  checkedNotFan: 'Conferido: você não é fã.',
  checkFailed: 'Não deu para conferir agora. Tente de novo em instantes.',
  checkedNotWritten: 'Conferido: o pedido não ficou no seu diário. Você pode tentar de novo.',
  loadingMarks: 'Carregando…',
  fansTitle: 'Fãs',
  fansSegment: 'Fãs',
  followingSegment: 'Seguindo',
  fansEmptyTitle: 'Ninguém é fã ainda',
  fansEmptyBodyOwn: 'Quando alguém virar fã, aparece aqui.',
  fansEmptyBody: 'Quando alguém virar fã desta pessoa, aparece aqui.',
  fansNone: 'Ninguém pôde ser conferido agora',
  fansNoneBody: 'Tente de novo em instantes.',
  fansNote: 'A lista mostra só quem tem o registro de fã no próprio diário.',
  topTitle: 'Melhores amigos',
  topEdit: 'Editar',
  topChoose: 'Escolher melhores amigos',
  topEmptyOwn: 'Você ainda não escolheu ninguém.',
  topOwnerNote: NOTICES.pendingOwner,
  topOlderNote: 'Pode existir uma lista mais antiga. Salvar agora substitui essa lista.',
  editorEmptyTitle: 'Nenhum melhor amigo ainda',
  editorEmptyBody: 'Procure entre as pessoas que você segue e toque em Adicionar.',
  yourPicks: 'Sua lista',
  addSection: 'Adicionar',
  add: 'Adicionar',
  remove: 'Remover',
  up: 'Subir',
  down: 'Descer',
  save: 'Salvar',
  saving: 'Salvando…',
  saved: 'Melhores amigos salvos.',
  discard: 'Descartar mudanças',
  noFollows: 'Você ainda não segue ninguém. Siga pessoas na Busca para escolhê-las aqui.',
  noMatch: 'Ninguém com esse nome entre as pessoas que você segue.',
  loadingNames: 'Carregando nomes…',
  followsFailed: 'Não deu para carregar quem você segue.',
  checkedSaved: 'Conferido: a lista foi salva.',
  checkedNotSaved: 'Conferido: a lista não foi salva. Você pode salvar de novo.',
  slot: (n) => 'posição ' + n
})

// ---- the own marks ------------------------------------------------------

// The own diary, newest page first (log.read pages), to what it holds:
// `fans` the newest fan mark per key (key -> { seq, on }), `top` the newest
// top-friends record ({ seq, keys }) or null, `settled` true when the walk
// reached the start of the diary (so what is not held does not exist), `next`
// the `before` of the next page or null. A page of another diary settles
// nothing: the scan is then empty and unsettled.
export function ownFansScan (pages, own) {
  const empty = { fans: new Map(), top: null, settled: false, next: null }
  if (!isHex64(own)) return empty
  const fans = new Map()
  let top = null
  let start = false
  let low = Infinity
  for (const page of Array.isArray(pages) ? pages : []) {
    if (!isObject(page) || page.key !== own || !Array.isArray(page.entries)) return empty
    for (const e of page.entries) {
      if (!isObject(e) || !isSeq(e.seq) || !isObject(e.record)) continue
      low = Math.min(low, e.seq)
      const r = e.record
      if (r.type === 'fan' && isHex64(r.key) && typeof r.on === 'boolean') {
        const prev = fans.get(r.key)
        if (prev === undefined || e.seq > prev.seq) fans.set(r.key, { seq: e.seq, on: r.on })
      } else if (r.type === 'top-friends' && Array.isArray(r.keys) && r.keys.every(isHex64) && (top === null || e.seq > top.seq)) {
        top = { seq: e.seq, keys: r.keys.slice() }
      }
    }
    for (const e of Array.isArray(page.invalid) ? page.invalid : []) {
      if (isObject(e) && isSeq(e.seq)) low = Math.min(low, e.seq)
    }
    if (page.entriesTruncated === 0) start = true
  }
  return { fans, top, settled: start, next: start || low === Infinity ? null : low }
}

// A held state of the own marks. status: 'loading', 'ready' (the walk settled),
// 'unsure' (it stopped short: what was found is true, the rest unknown) or
// 'failed' (no answer, nothing held).
export const NO_MARKS = Object.freeze({ status: 'loading', fans: new Map(), top: null })

export function marksFromScan (scan) {
  return { status: scan.settled ? 'ready' : 'unsure', fans: scan.fans, top: scan.top }
}

// true / false / null (not known).
export function fanOf (marks, key) {
  if (!isObject(marks) || !(marks.fans instanceof Map)) return null
  const held = marks.fans.get(key)
  if (held !== undefined) return held.on === true
  return marks.status === 'ready' ? false : null
}

export function withFan (marks, key, on, seq) {
  const fans = new Map(marks.fans)
  fans.set(key, { seq: isSeq(seq) ? seq : 0, on: on === true })
  return { ...marks, fans }
}

export function withTop (marks, keys, seq) {
  return { ...marks, top: { seq: isSeq(seq) ? seq : 0, keys: keys.slice() } }
}

// ---- the fan button -----------------------------------------------------

// What the button on someone else's profile shows. null when there is no
// button: not a hosted node, no identity, the own profile, a page (neither
// fanned nor listed) or a blocked person.
// `marks` the held own marks, `busy` the write in flight, `uncertain` an
// unanswered write the person has not checked yet.
export function fanButtonView ({ hosted, online, ownKey, author, page, blocked, marks, busy, uncertain } = {}) {
  if (hosted !== true || !isHex64(ownKey) || !isHex64(author) || ownKey === author || page === true || blocked === true) return null
  const on = fanOf(marks, author)
  const status = isObject(marks) ? marks.status : 'loading'
  if (status === 'failed') return { on: null, label: TEXTS.retry, kind: 'retry', disabled: online === false || busy === true, pending: busy === true }
  // A walk that stopped short (a long diary) without finding a mark offers
  // 'Sou fã': turning it on is idempotent, so an older mark the walk did not
  // reach cannot make it write the opposite. 'Deixar de ser fã' only when the
  // mark is known to be on.
  const waiting = on === null && status !== 'unsure'
  return {
    on,
    label: on === true ? TEXTS.unfan : TEXTS.fan,
    kind: on === true ? 'unfan' : 'fan',
    pendingLabel: on === true ? TEXTS.unfanning : TEXTS.fanning,
    disabled: waiting || busy === true || uncertain === true || online === false,
    pending: busy === true || waiting
  }
}

export const fanDoneText = (on) => (on === true ? TEXTS.fanDone : TEXTS.unfanDone)

export const fanButtonLabel = (on, name) => (on === true ? 'deixar de ser fã de ' : 'ser fã de ') + name

// After 'Conferir': what the diary says now about the mark.
export const fanCheckedText = (on) => (on === true ? TEXTS.checkedFan : TEXTS.checkedNotFan)

// 'Conferir' after an uncertain fan.set, from the marks a forced walk read:
// { settled, text }. A walk that stopped short still saw the newest blocks, so
// a write that landed is among them: no mark there means the write did not
// stay (but an older mark may exist, so it never says 'not a fan'). No answer
// settles nothing.
export function fanCheck (marks, key) {
  if (!isObject(marks) || (marks.status !== 'ready' && marks.status !== 'unsure')) return { settled: false, text: TEXTS.checkFailed }
  const on = fanOf(marks, key)
  if (on === null) return { settled: true, text: TEXTS.checkedNotWritten }
  return { settled: true, text: fanCheckedText(on) }
}

// ---- the top list -------------------------------------------------------

// The rows the owner sees: the own record's picks in order (the diary is the
// authority) with what the seeder's evidence says about each ('pending' waits
// for a follow back). A pick the evidence did not reach has no status and no
// label: nothing is claimed about it.
export function ownTopRows (top, view) {
  const keys = isObject(top) && Array.isArray(top.keys) ? top.keys : []
  return editorRows(editorState(keys), view).map((r) => ({ key: r.key, slot: r.index, status: r.status, label: r.label }))
}

// A single line for the top row of a profile: how many are shown.
export function topCountText (n) {
  if (!Number.isSafeInteger(n) || n < 0) return ''
  return n === 1 ? '1 pessoa' : n + ' pessoas'
}

// ---- the editor ---------------------------------------------------------

// The state of the editor from the own record.
export function openEditor (top) {
  return editorState(isObject(top) && Array.isArray(top.keys) ? top.keys : [])
}

// The people the search can still add: followed people, not yet picked, never
// the own key or a blocked one, filtered by the cached names. Blank text keeps
// the follow order.
export function addCandidates ({ follows, state, self, isBlocked, profileOf, text } = {}) {
  const picked = new Set(Array.isArray(state && state.keys) ? state.keys : [])
  const blocked = typeof isBlocked === 'function' ? (k) => isBlocked(k) === true : () => false
  const keys = (Array.isArray(follows) ? follows : []).filter((k) => isHex64(k) && k !== self && !picked.has(k) && !blocked(k))
  return filterPeople(keys, profileOf, text)
}

// After a saved or checked list: the editor starts again from it.
export function rebase (keys) {
  return editorState(keys)
}

// 'Conferir' after an uncertain top.set: did the diary take the list?
export function sameList (top, keys) {
  if (!isObject(top) || !Array.isArray(top.keys) || !Array.isArray(keys)) return false
  return top.keys.length === keys.length && top.keys.every((k, i) => k === keys[i])
}

// The same question from the marks a forced walk read: true / false, or null
// when it cannot tell (no answer). A walk that stopped short saw the newest
// blocks, where a list that was taken would be: its newest list (or none)
// answers too.
export function topCheck (marks, keys) {
  if (!isObject(marks) || (marks.status !== 'ready' && marks.status !== 'unsure')) return null
  return sameList({ keys: marks.top ? marks.top.keys : [] }, keys)
}

// The own top-friends record at `seq` from a diary.peek of the own diary, as
// { seq, keys }, or null when the peek is not that: another diary, another
// seq, another type, or keys the node would refuse (the own key, a repeat,
// over the limit).
export function topFromPeek (peek, own, seq) {
  if (!isHex64(own) || !isSeq(seq) || !isObject(peek) || peek.key !== own || !Array.isArray(peek.entries)) return null
  const e = peek.entries.find((x) => isObject(x) && x.seq === seq)
  if (!e || !isObject(e.record)) return null
  const r = e.record
  if (r.type !== 'top-friends' || !Array.isArray(r.keys) || r.keys.length > maxTopFriends()) return null
  const seen = new Set()
  for (const k of r.keys) {
    if (!isHex64(k) || k === own || seen.has(k)) return null
    seen.add(k)
  }
  return { seq, keys: r.keys.slice() }
}

// Where the editor starts. The own diary is the authority: a settled walk, or
// one that found a list before stopping (the newest wins). A walk that stopped
// short without a list falls back on the seeder's pointer to the own list,
// read back from the own diary (`peekSeq` asks the caller for that peek;
// `fallback` is { seq, top } once done, top null when it did not verify).
// No pointer and a complete answer: an empty editor with a note that an older
// list may exist. Anything less sure keeps the editor locked.
// `index` the /index/profile answer for the own key (null while loading),
// `indexFailed` true when that read failed.
// -> { phase: 'loading' | 'open' | 'locked', top, note, peekSeq }
export function editorSource ({ marks, index, indexFailed, fallback } = {}) {
  const loading = { phase: 'loading', top: null, note: null, peekSeq: null }
  const locked = { phase: 'locked', top: null, note: null, peekSeq: null }
  const status = isObject(marks) ? marks.status : 'loading'
  if (status === 'ready' || (status === 'unsure' && isObject(marks.top))) return { phase: 'open', top: isObject(marks.top) ? marks.top : null, note: null, peekSeq: null }
  if (status === 'failed') return locked
  if (status !== 'unsure') return loading
  if (indexFailed === true) return locked
  if (!isObject(index)) return loading
  if (index.complete !== true) return locked
  const seq = isObject(index.top) && isSeq(index.top.seq) ? index.top.seq : null
  if (seq === null) return { phase: 'open', top: null, note: TEXTS.topOlderNote, peekSeq: null }
  if (isObject(fallback) && fallback.seq === seq) return isObject(fallback.top) ? { phase: 'open', top: fallback.top, note: null, peekSeq: null } : locked
  return { ...loading, peekSeq: seq }
}

// The editor's opening line; the limit is the contract's, never typed here.
export function editorIntroText () {
  const n = maxTopFriends()
  return (n > 0 ? 'Escolha até ' + n + ' pessoas que você segue. ' : 'Escolha pessoas que você segue. ') + 'Elas aparecem para os outros quando seguirem você de volta.'
}

export function canAddMore (state) {
  return Array.isArray(state && state.keys) && state.keys.length < maxTopFriends()
}
