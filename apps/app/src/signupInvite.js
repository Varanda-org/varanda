// Signup invite links (https://<origin>/convite/<code>). Pure ES module: no
// React, no globals, no Node built-ins; the caller passes location, history
// and storage in, so Node's import() tests every branch with fakes.
//
// The pending code is a small record kept in tab storage until the Google
// account link sends it to the service. It is untrusted input on every read
// (anything on the origin could have written it), so decodeSignupInvite
// rebuilds it field by field. The TTL only bounds how long this tab holds it:
// whether the code is still valid is the service's decision.

import { INVITE_CODE_RE, INVITE_NEEDED_TEXT } from './account.js'

export { INVITE_NEEDED_TEXT }

export const SIGNUP_INVITE_KEY = 'varanda-signup-invite'
export const SIGNUP_INVITE_TTL_MS = 24 * 3600000
export const CODE_RE = INVITE_CODE_RE
export const SIGNUP_PATH_RE = /^\/convite\/([A-Za-z0-9_-]{43})\/?$/

const MAX_PATH = 80
const MAX_RAW = 512
const CLOCK_SKEW_MS = 60000
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1(:[0-9]{1,5})?$/

export const INVITE_READY_TEXT = 'Convite pronto para usar.'
export const INVITE_VALID_TEXT = 'Esse link serve para uma pessoa só e vale 7 dias. Nada sobre quem recebe o link fica guardado.'
export const WEEK_RESET_TEXT = 'Os convites renovam toda segunda-feira, no horário de Brasília, e os que sobram não acumulam.'
const INVITES_GONE_TEXT = 'Seus convites desta semana acabaram.'

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

// Runs once at startup. The code must not stay in the address bar (history,
// screenshots, a shared screen), so any /convite path is cleaned to '/'
// keeping search and hash byte for byte. The code rides in the path, not the
// fragment, because #token= already owns the fragment. Any /convite path first
// clears the stored code, so a newer link always wins and a malformed one
// never leaves an older code behind; a valid path then stores a fresh record,
// and when that write fails the in-memory record still serves this load. Any
// other path (the Google return lands on /?conta=) only reads: it must keep
// the code for the account link.
export function captureSignupInvite ({ location, history, storage, now } = {}) {
  try {
    const pathname = location && location.pathname
    if (!isSignupInvitePath(pathname)) return readSignupInvite(storage, now)
    clearSignupInvite(storage)
    const code = parseSignupInvitePath(pathname)
    let fresh = null
    if (code !== null && Number.isSafeInteger(now)) {
      fresh = makeRecord(code, now)
      writeSignupInvite(storage, fresh)
    }
    try {
      history.replaceState(history.state, '', '/' + (location.search || '') + (location.hash || ''))
    } catch {}
    return fresh
  } catch {
    return null
  }
}

// Holds the captured record for a store module: storage first, then the
// in-memory copy (tab storage can refuse writes in private modes and
// sandboxed frames), re-validated on every load. getStorage is called on each
// access, never cached.
export function createSignupInviteHolder ({ getStorage, now = () => Date.now() } = {}) {
  let memory = null
  const storage = () => {
    try { return getStorage ? getStorage() : null } catch { return null }
  }
  return {
    // A later capture runs on the already cleaned '/', where the storage read
    // is null when the first write failed: that must not wipe the memory.
    capture ({ location, history }) {
      const onInvitePath = isSignupInvitePath(location && location.pathname)
      const rec = captureSignupInvite({ location, history, storage: storage(), now: now() })
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
