// Signup from a Feira listing link: a visitor who opened a listing and has
// no account yet. Pure ES module: no React, no globals, no Node built-ins;
// storage, the clock and the requests are passed in, so Node's import()
// tests every branch with fakes.
//
// The captured listing ref (feiraLink.js on the web, linkReturn.parseAppLink
// kind 'anuncio' in the app) is kept here with the installation it was
// captured for, so it survives the Google round trip, the Terms and the node
// setup. A ref of another installation is dropped, never opened. The Feira
// code (POST /account/feira/start) goes through the ordinary signup invite
// flow under SIGNUP_INVITE_KEY; this record only remembers which code came
// from the Feira, so a refusal of that code reads as the seller's weekly
// limit. Nothing here sends a message: the listing screen only opens.

import { LISTING_LINK_TTL_MS } from './feiraLink.js'
import { startBody } from './feiraInvite.js'
import { CODE_RE, writeSignupInvite } from './signupInvite.js'

export const FEIRA_ENTRY_KEY = 'varanda-feira-entry'
export const FEIRA_ENTRY_TTL_MS = LISTING_LINK_TTL_MS

export const ENTRY_TITLE = 'Anúncio da Feira'
export const ENTRY_TEXT = 'Entre para falar com quem anunciou.'
export const ENTRY_INVITE_TEXT = 'Entre para falar com quem anunciou. Por enquanto, entrar pede um convite: peça um link a alguém da rede.'
export const LIMIT_TEXT = 'Quem anunciou não tem mais entradas nesta semana. Peça um convite a alguém da rede ou tente na próxima semana.'
export const START_FAILED_TEXT = 'Não deu para pedir a entrada agora. Tente de novo daqui a pouco.'
export const START_UNCERTAIN_TEXT = 'Não deu para saber se a entrada foi criada. Tente de novo daqui a pouco.'
export const START_GONE_TEXT = 'Este anúncio não abre uma entrada agora: ele saiu do ar ou a Feira está desligada.'

const MAX_RAW = 512
const CLOCK_SKEW_MS = 60000
const HEX64 = /^[0-9a-f]{64}$/
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/
const LOOPBACK_ORIGIN = /^http:\/\/127\.0\.0\.1(:[0-9]{1,5})?$/

// '' is the hosted page's own origin (relative requests).
function isOrigin (o) {
  return o === '' || (typeof o === 'string' && (HTTPS_ORIGIN.test(o) || LOOPBACK_ORIGIN.test(o)))
}

function makeRecord ({ author, seq, origin, at, code }) {
  return Object.freeze({ v: 1, author, seq, origin, at, code })
}

// Frozen record or null, from the stored JSON or an in-memory record. Extra
// keys (including __proto__) are never copied.
export function decodeEntry (raw, now) {
  let o = raw
  if (typeof raw === 'string') {
    if (raw.length > MAX_RAW) return null
    try { o = JSON.parse(raw) } catch { return null }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.v !== 1) return null
  if (typeof o.author !== 'string' || !HEX64.test(o.author)) return null
  if (!Number.isSafeInteger(o.seq) || o.seq < 1) return null
  if (!isOrigin(o.origin)) return null
  if (o.code !== null && (typeof o.code !== 'string' || !CODE_RE.test(o.code))) return null
  if (!Number.isSafeInteger(o.at) || !Number.isFinite(now)) return null
  if (o.at > now + CLOCK_SKEW_MS || now - o.at > FEIRA_ENTRY_TTL_MS) return null
  return makeRecord(o)
}

function encode (rec) {
  return JSON.stringify({ v: 1, author: rec.author, seq: rec.seq, origin: rec.origin, at: rec.at, code: rec.code })
}

// Holds the entry: storage first, then memory (storage can refuse writes).
// getStorage is called on each access, never cached.
export function createFeiraEntry ({ getStorage, now = () => Date.now() } = {}) {
  let memory = null
  // After a refused write the stored record is older than memory (or gone):
  // memory wins until a write succeeds again.
  let memoryWins = false
  const storage = () => {
    try { return getStorage ? getStorage() : null } catch { return null }
  }
  const save = (rec) => {
    memory = rec
    const s = storage()
    if (!s) return
    try {
      if (rec === null) s.removeItem(FEIRA_ENTRY_KEY)
      else s.setItem(FEIRA_ENTRY_KEY, encode(rec))
      memoryWins = false
    } catch {
      memoryWins = true
      try { s.removeItem(FEIRA_ENTRY_KEY) } catch {}
    }
  }
  const read = () => {
    const t = now()
    const s = memoryWins ? null : storage()
    if (s) {
      let raw = null
      try { raw = s.getItem(FEIRA_ENTRY_KEY) } catch {}
      if (raw !== null && raw !== undefined) {
        const rec = decodeEntry(raw, t)
        if (rec !== null) return rec
        try { s.removeItem(FEIRA_ENTRY_KEY) } catch {}
      }
    }
    memory = decodeEntry(memory, t)
    return memory
  }
  return {
    // A newer listing link wins; the same listing keeps its held code and
    // its first capture time.
    capture ({ author, seq, origin }) {
      const t = now()
      const prev = read()
      if (prev !== null && prev.author === author && prev.seq === seq && prev.origin === origin) return prev
      // A newer listing replaces the listing, not the Feira code already
      // asked for on this installation: that code is still held, and only
      // its route (/account/feira/idade) can open the age step with it.
      const code = prev !== null && prev.origin === origin ? prev.code : null
      const rec = decodeEntry({ v: 1, author, seq, origin, at: t, code }, t)
      save(rec)
      return rec
    },
    // The entry for this installation, or null. Another installation's is
    // dropped.
    load (origin) {
      const rec = read()
      if (rec === null) return null
      if (rec.origin !== origin) {
        save(null)
        return null
      }
      return rec
    },
    noteCode (code) {
      const rec = read()
      if (rec === null || typeof code !== 'string' || !CODE_RE.test(code)) return null
      const next = makeRecord({ ...rec, code })
      save(next)
      return next
    },
    forgetCode () {
      const rec = read()
      if (rec === null || rec.code === null) return rec
      const next = makeRecord({ ...rec, code: null })
      save(next)
      return next
    },
    // Once the listing screen can open: { author, seq } exactly once.
    consume (origin) {
      const rec = this.load(origin)
      save(null)
      return rec === null ? null : { author: rec.author, seq: rec.seq }
    },
    drop () { save(null) }
  }
}

// True when the held signup code is the Feira code this entry asked for.
export function heldIsFeira (entry, held) {
  return !!entry && typeof entry.code === 'string' && !!held && typeof held.code === 'string' && held.code === entry.code
}

// What to do with a held entry:
// - 'none': no entry;
// - 'open': a member (signed in, node ready) opens the listing;
// - 'wait': a member whose node is not ready yet keeps the entry;
// - 'invite': a held signup code (a personal invite, or the Feira code of an
//   earlier return) goes through the existing flow; the entry stays;
// - 'start': ask the service for a Feira code (policy on, no code held);
// - 'needs-invite': Feira off and the network by invite: the calm invite
//   screen with ENTRY_INVITE_TEXT;
// - 'signup': an open network: the ordinary flow, no code needed.
// `policy` is feiraPolicy()'s answer ({ enabled } or null); `required` the
// invite policy's required flag.
export function decideEntry ({ entry, signedIn = false, ready = false, held = null, policy = null, required = false } = {}) {
  if (!entry) return { action: 'none' }
  if (signedIn === true) return ready === true ? { action: 'open', author: entry.author, seq: entry.seq } : { action: 'wait' }
  if (held && typeof held.code === 'string') {
    return { action: 'invite', feira: heldIsFeira(entry, held) }
  }
  if (policy && policy.enabled === true) {
    const body = startBody({ author: entry.author, seq: entry.seq })
    if (body !== null) return { action: 'start', body }
  }
  return required === true ? { action: 'needs-invite', text: ENTRY_INVITE_TEXT } : { action: 'signup' }
}

// One POST /account/feira/start, never repeated here. On success the code is
// stored under SIGNUP_INVITE_KEY through the signupInvite writer (or the
// caller's `hold`, the app's in-memory holder) and remembered as the Feira
// code. -> { ok: true, code } | { ok: false, text, code, uncertain }.
export async function startEntry ({ holder, entry, start, storage, hold, isHeld, now = Date.now() } = {}) {
  const body = entry ? startBody({ author: entry.author, seq: entry.seq }) : null
  if (body === null) return { ok: false, text: START_FAILED_TEXT, code: 'pedido-invalido', uncertain: false }
  let answer
  try {
    answer = await start(body)
  } catch (err) {
    const token = err && typeof err.code === 'string' ? err.code : 'indisponivel'
    const uncertain = !!err && err.uncertain === true
    return { ok: false, text: startErrorText(err), code: token, uncertain }
  }
  const code = answer && typeof answer.code === 'string' && CODE_RE.test(answer.code) ? answer.code : null
  if (code === null) return { ok: false, text: START_UNCERTAIN_TEXT, code: 'indisponivel', uncertain: true }
  // A code that arrived (a pasted invite, say) while this request was in
  // flight is the person's choice: the late Feira code never replaces it.
  if (typeof isHeld === 'function' && isHeld()) return { ok: false, text: '', code: 'superado', uncertain: false, superseded: true }
  const rec = { v: 1, code, at: now }
  let kept
  if (typeof hold === 'function') {
    const r = hold(code)
    kept = r !== null && r !== false && r !== undefined
  } else {
    kept = writeSignupInvite(storage, rec)
  }
  if (!kept) return { ok: false, text: START_FAILED_TEXT, code: 'indisponivel', uncertain: false }
  if (holder) holder.noteCode(code)
  return { ok: true, code }
}

// Whether a failed start may be asked again by a press (never on its own):
// a listing that is gone or a malformed ref will not change by asking again.
export function startRetryable (r) {
  return !!r && r.ok !== true && r.superseded !== true && r.code !== 'nao-encontrado' && r.code !== 'pedido-invalido'
}

export function startErrorText (err) {
  if (err && err.uncertain === true) return START_UNCERTAIN_TEXT
  if (err && err.code === 'nao-encontrado') return START_GONE_TEXT
  return START_FAILED_TEXT
}

// The ordinary flow refused a held code with 'convite-invalido'. When that
// code is the Feira one, the seller's weekly entries ran out (the service
// charges the cap when the code is used): LIMIT_TEXT, and the caller drops
// the held code and forgets it here. -> { text, drop: true } | null.
export function limitRefusal ({ err, entry, held } = {}) {
  if (!err || err.code !== 'convite-invalido') return null
  if (!entry || entry.code === null || !held || held.code !== entry.code) return null
  return { text: LIMIT_TEXT, drop: true }
}

// Whether "Pedir entrada" shows: the decision asks for a Feira code, the
// seller's week did not run out, nothing else blocks it (a member already
// linked, say), and either no press yet or the last one may be asked again.
export function entryOffer ({ action, limited = false, blocked = false, tried = false, retry = false } = {}) {
  return action === 'start' && limited !== true && blocked !== true && (tried !== true || retry === true)
}
