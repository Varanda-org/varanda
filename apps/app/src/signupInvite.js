// Signup invite links (https://<origin>/convite/<code>). Pure ES module: no
// React, no globals, no Node built-ins; the caller passes location, history
// and storage in, so Node's import() tests every branch with fakes.
//
// The pending code is a small record kept in tab storage until the Google
// account link sends it to the service. It is untrusted input on every read
// (anything on the origin could have written it), so decodeSignupInvite
// rebuilds it field by field. The TTL only bounds how long this tab holds it:
// whether the code is still valid is the service's decision.

import rpc from '@varanda/rpc'
import { INVITE_CODE_RE, INVITE_NEEDED_TEXT } from './account.js'

const { parseInviteCardUrl } = rpc

export { INVITE_NEEDED_TEXT }

export const SIGNUP_INVITE_KEY = 'varanda-signup-invite'
export const SIGNUP_INVITE_TTL_MS = 24 * 3600000
export const CODE_RE = INVITE_CODE_RE
export const SIGNUP_PATH_RE = /^\/convite\/([A-Za-z0-9_-]{43})\/?$/
export const SIGNUP_INVITE_CARD_KEY = 'varanda-signup-invite-card'

const MAX_PATH = 80
const MAX_RAW = 512
// The real bound is the 400-character link that parseInviteCardUrl enforces:
// a shorter origin leaves room for a body longer than bora.varanda.app's
// 320 characters, so the body itself is only capped by that link limit.
const MAX_CARD_BODY = 400
const MAX_CARD_RAW = 512
const CARD_MARK = '#c1.'
const CARD_BODY_RE = /^[A-Za-z0-9_-]{1,400}$/
const CLOCK_SKEW_MS = 60000
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1(:[0-9]{1,5})?$/

export const INVITE_READY_TEXT = 'Convite pronto para usar.'
export const INVITE_VALID_TEXT = 'Esse link serve para uma pessoa só e vale 7 dias. Nada sobre quem recebe o link fica guardado.'
export const WEEK_RESET_TEXT = 'Os convites renovam toda segunda-feira, no horário de Brasília, e os que sobram não acumulam.'
const INVITES_GONE_TEXT = 'Seus convites desta semana acabaram.'
export const INVITE_DROP_TITLE = 'Chegou um convite pra sua varanda'
export const INVITE_DROP_BODY = 'Escolha com carinho quem você quer chamar: alguém próximo, que faz falta na conversa.'
export const DROPS_HINT_TEXT = 'Os convites chegam de surpresa, um de cada vez, com um aviso. Escolha com carinho quem você quer chamar.'

// Cheap prefix test: any path under /convite is an invite attempt and gets
// cleaned from the address bar, valid or not.
export function isSignupInvitePath (p) {
  return typeof p === 'string' && (p === '/convite' || p.startsWith('/convite/'))
}

// The code or null. A strict regex over the raw path, never
// decodeURIComponent: '%', '//', and extra segments all fail.
export function parseSignupInvitePath (p) {
  if (typeof p !== 'string' || p.length > MAX_PATH) return null
  const m = SIGNUP_PATH_RE.exec(p)
  return m ? m[1] : null
}

function makeRecord (code, at) {
  return Object.freeze({ v: 1, code, at })
}

// Frozen record or null, from the stored JSON or an in-memory record. Extra
// keys (including __proto__) are never copied.
export function decodeSignupInvite (raw, now) {
  let o = raw
  if (typeof raw === 'string') {
    if (raw.length > MAX_RAW) return null
    try { o = JSON.parse(raw) } catch { return null }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  if (o.v !== 1) return null
  if (typeof o.code !== 'string' || !CODE_RE.test(o.code)) return null
  if (!Number.isSafeInteger(o.at) || !Number.isFinite(now)) return null
  if (o.at > now + CLOCK_SKEW_MS || now - o.at > SIGNUP_INVITE_TTL_MS) return null
  return makeRecord(o.code, o.at)
}

// Storage access is always guarded: private modes and quota errors throw, and
// a missing storage (null) means "nothing remembered".
export function readSignupInvite (storage, now) {
  if (!storage) return null
  let raw
  try { raw = storage.getItem(SIGNUP_INVITE_KEY) } catch { return null }
  if (raw === null || raw === undefined) return null
  const rec = decodeSignupInvite(raw, now)
  if (rec === null) {
    try { storage.removeItem(SIGNUP_INVITE_KEY) } catch {}
  }
  return rec
}

export function writeSignupInvite (storage, rec) {
  if (!storage || !rec) return false
  try {
    storage.setItem(SIGNUP_INVITE_KEY, JSON.stringify({ v: 1, code: rec.code, at: rec.at }))
    return true
  } catch {
    return false
  }
}

export function clearSignupInvite (storage) {
  if (!storage) return false
  try {
    storage.removeItem(SIGNUP_INVITE_KEY)
    return true
  } catch {
    return false
  }
}

// The invite card (packages/rpc/lib/invite-card.js) rides beside the code as
// the '#c1.<body>' fragment. It holds the sender's name and message, so it
// lives only in tab storage (or native memory) for the same 24 h, and is
// untrusted on every read: decodeSignupInviteCard rebuilds it field by field
// and re-parses the body. Nothing here checks the signature; a body carries
// no code, so the record only says which code it arrived with.
export function makeCardRecord (code, body, at) {
  return Object.freeze({ v: 1, code, body, at })
}

export function decodeSignupInviteCard (raw, now) {
  let o = raw
  if (typeof raw === 'string') {
    if (raw.length > MAX_CARD_RAW) return null
    try { o = JSON.parse(raw) } catch { return null }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  if (o.v !== 1) return null
  if (typeof o.code !== 'string' || !CODE_RE.test(o.code)) return null
  if (typeof o.body !== 'string' || !CARD_BODY_RE.test(o.body)) return null
  if (!Number.isSafeInteger(o.at) || !Number.isFinite(now)) return null
  if (o.at > now + CLOCK_SKEW_MS || now - o.at > SIGNUP_INVITE_TTL_MS) return null
  const card = parseInviteCardUrl('varanda:///convite/' + o.code + CARD_MARK + o.body)
  if (card === null || card.code !== o.code) return null
  return makeCardRecord(o.code, o.body, o.at)
}

export function readSignupInviteCard (storage, now) {
  if (!storage) return null
  let raw
  try { raw = storage.getItem(SIGNUP_INVITE_CARD_KEY) } catch { return null }
  if (raw === null || raw === undefined) return null
  const rec = decodeSignupInviteCard(raw, now)
  if (rec === null) {
    try { storage.removeItem(SIGNUP_INVITE_CARD_KEY) } catch {}
  }
  return rec
}

export function writeSignupInviteCard (storage, rec) {
  if (!storage || !rec) return false
  try {
    storage.setItem(SIGNUP_INVITE_CARD_KEY, JSON.stringify({ v: 1, code: rec.code, body: rec.body, at: rec.at }))
    return true
  } catch {
    return false
  }
}

export function clearSignupInviteCard (storage) {
  if (!storage) return false
  try {
    storage.removeItem(SIGNUP_INVITE_CARD_KEY)
    return true
  } catch {
    return false
  }
}

// The search without any 'c' parameter, every other one byte for byte and
// in order; unchanged when there is none.
function withoutCardQuery (search) {
  if (typeof search !== 'string' || !search.startsWith('?')) return ''
  const parts = search.slice(1).split('&')
  const kept = parts.filter((p) => p.split('=')[0] !== 'c')
  if (kept.length === parts.length) return search
  return kept.length === 0 ? '' : '?' + kept.join('&')
}

// The raw value of the only 'c' parameter: undefined when absent, null when
// repeated (a doubtful link carries no card).
function cardQueryValue (search) {
  if (typeof search !== 'string' || !search.startsWith('?')) return undefined
  const values = []
  for (const p of search.slice(1).split('&')) {
    const eq = p.indexOf('=')
    if ((eq === -1 ? p : p.slice(0, eq)) === 'c') values.push(eq === -1 ? '' : p.slice(eq + 1))
  }
  if (values.length === 0) return undefined
  return values.length === 1 ? values[0] : null
}

// The fragment without its leading '#c1.<body>' piece: what followed the
// first '&' survives as its own fragment.
function withoutCardHash (hash) {
  if (typeof hash !== 'string') return ''
  if (!hash.startsWith(CARD_MARK)) return hash
  const amp = hash.indexOf('&')
  return amp === -1 ? '' : '#' + hash.slice(amp + 1)
}

function cardFromLocation ({ origin, pathname, search, hash, code, now }) {
  if (code === null || !Number.isSafeInteger(now)) return null
  if (typeof hash !== 'string' || !hash.startsWith(CARD_MARK)) return null
  const amp = hash.indexOf('&')
  const piece = amp === -1 ? hash : hash.slice(0, amp)
  const body = piece.slice(CARD_MARK.length)
  if (body.length === 0 || body.length > MAX_CARD_BODY) return null
  const c = cardQueryValue(search)
  if (c === null) return null
  const query = c === undefined ? '' : '?c=' + c
  const card = parseInviteCardUrl(String(origin) + pathname + query + piece)
  if (card === null || card.code !== code) return null
  return makeCardRecord(code, body, now)
}

function captureParts ({ location, history, storage, now, origin } = {}) {
  try {
    const pathname = location && location.pathname
    if (!isSignupInvitePath(pathname)) return { rec: readSignupInvite(storage, now), card: null }
    clearSignupInvite(storage)
    clearSignupInviteCard(storage)
    const code = parseSignupInvitePath(pathname)
    let fresh = null
    if (code !== null && Number.isSafeInteger(now)) {
      fresh = makeRecord(code, now)
      writeSignupInvite(storage, fresh)
    }
    let card = null
    try {
      card = cardFromLocation({ origin, pathname, search: location.search, hash: location.hash, code, now })
    } catch {}
    if (card !== null) writeSignupInviteCard(storage, card)
    try {
      history.replaceState(history.state, '', '/' + withoutCardQuery(location.search || '') + withoutCardHash(location.hash || ''))
    } catch {}
    return { rec: fresh, card }
  } catch {
    return { rec: null, card: null }
  }
}

// Runs once at startup. The code must not stay in the address bar (history,
// screenshots, a shared screen), so any /convite path is cleaned to '/'
// keeping search and hash byte for byte, except the card: its '?c' query and
// '#c1.' fragment go in the same pass that stores it, before any render. The
// code rides in the path, not the fragment, because #token= already owns the
// fragment. Any /convite path first clears the stored code and card, so a
// newer link always wins and a malformed one never leaves an older one
// behind; a valid path then stores a fresh record (and the card when it
// parses), and when that write fails the in-memory record still serves this
// load. Any other path (the Google return lands on /?conta=) only reads: it
// must keep the code for the account link.
export function captureSignupInvite (args) {
  return captureParts(args).rec
}

// Holds the captured record for a store module: storage first, then the
// in-memory copy (tab storage can refuse writes in private modes and
// sandboxed frames), re-validated on every load. getStorage is called on each
// access, never cached. The card follows the same rules beside the code.
export function createSignupInviteHolder ({ getStorage, now = () => Date.now() } = {}) {
  let memory = null
  let cardMemory = null
  const storage = () => {
    try { return getStorage ? getStorage() : null } catch { return null }
  }
  return {
    // A later capture runs on the already cleaned '/', where the storage read
    // is null when the first write failed: that must not wipe the memory.
    capture ({ location, history, origin }) {
      const onInvitePath = isSignupInvitePath(location && location.pathname)
      const { rec, card } = captureParts({ location, history, storage: storage(), now: now(), origin })
      if (onInvitePath) cardMemory = card
      if (onInvitePath || rec !== null) {
        memory = rec
        return rec
      }
      memory = decodeSignupInvite(memory, now())
      return memory
    },
    load () {
      const t = now()
      const stored = readSignupInvite(storage(), t)
      if (stored) return stored
      memory = decodeSignupInvite(memory, t)
      return memory
    },
    drop () {
      memory = null
      return clearSignupInvite(storage())
    },
    loadCard () {
      const t = now()
      const stored = readSignupInviteCard(storage(), t)
      if (stored) return stored
      cardMemory = decodeSignupInviteCard(cardMemory, t)
      return cardMemory
    },
    keepCard (code, body) {
      const t = now()
      const rec = decodeSignupInviteCard(makeCardRecord(code, body, t), t)
      if (rec === null) return null
      writeSignupInviteCard(storage(), rec)
      cardMemory = rec
      return rec
    },
    dropCard () {
      cardMemory = null
      return clearSignupInviteCard(storage())
    }
  }
}

// origin + '/convite/' + code, or null. Origins follow the account service's
// own rules: a bare https host, or http on loopback 127.0.0.1.
export function buildSignupInviteUrl ({ origin, code } = {}) {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return null
  if (typeof origin !== 'string' || !(HTTPS_ORIGIN.test(origin) || LOOPBACK_ORIGIN.test(origin))) return null
  return origin + '/convite/' + code
}

// 'Restam K de N convites nesta semana.', or '' for doubtful numbers.
export function inviteCountText ({ remaining, perWeek } = {}) {
  if (!Number.isInteger(perWeek) || perWeek < 1) return ''
  if (!Number.isInteger(remaining) || remaining < 0 || remaining > perWeek) return ''
  if (remaining === 0) return INVITES_GONE_TEXT
  const verb = remaining === 1 ? 'Resta ' : 'Restam '
  const noun = perWeek === 1 ? ' convite' : ' convites'
  return verb + remaining + ' de ' + perWeek + noun + ' nesta semana.'
}

// 'Você pode criar até N convites por semana.', or '' for a doubtful number
// (the policy allows 1..100).
export function allowanceText (perWeek) {
  if (!Number.isInteger(perWeek) || perWeek < 1 || perWeek > 100) return ''
  return 'Você pode criar até ' + perWeek + (perWeek === 1 ? ' convite' : ' convites') + ' por semana.'
}

export function dropView ({ mode, opened, used, remaining, perWeek } = {}) {
  if ((mode !== 'semanal' && mode !== 'sorteio') ||
    !Number.isInteger(perWeek) || perWeek < 1 || perWeek > 100 ||
    !Number.isInteger(opened) || opened < 0 || opened > perWeek ||
    !Number.isSafeInteger(used) || used < 0 || remaining !== Math.max(0, opened - used) ||
    (mode === 'semanal' && opened !== perWeek)) {
    return { text: '', enabled: false }
  }
  if (mode === 'semanal') return { text: inviteCountText({ remaining, perWeek }), enabled: remaining > 0 }
  if (opened === 0) return { text: 'Seu convite desta semana ainda não chegou. Ele aparece de surpresa, com um aviso.', enabled: false }
  if (remaining > 0) {
    return { text: 'Você tem ' + remaining + (remaining === 1 ? ' convite' : ' convites') + ' para usar até o fim da semana.', enabled: true }
  }
  return { text: 'O próximo convite chega de surpresa.', enabled: false }
}
