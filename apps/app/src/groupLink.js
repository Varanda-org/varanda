// Group links (https://<origin>/g/<hex64>) that open a group on the hosted
// web. Pure ES module: no React, no globals, no Node built-ins; the caller
// passes location and history in, so Node's import() tests every branch.
//
// Same strictness as profileLink.js: a regex over the raw path, never
// decodeURIComponent, and lowercase hex only (the canonical key form).
// A tapped link is kept as a small, untrusted entry record in tab storage so
// it survives the Google sign-in reload; it only names a screen to open.

import { isAuthorKey } from './nav.js'

const MAX_PATH = 80
const GROUP_PATH = /^\/g\/([0-9a-f]{64})\/?$/
const COMMUNITY_PATH = /^\/c\/([0-9a-f]{64})\/?$/

// Cheap prefix test: any path under /g/ is a group link attempt and gets
// cleaned from the address bar, valid or not.
export function isGroupPath (p) {
  return typeof p === 'string' && p.startsWith('/g/')
}

// The lowercase hex64 group key, or null.
export function parseGroupPath (p) {
  if (typeof p !== 'string' || p.length > MAX_PATH) return null
  const m = GROUP_PATH.exec(p)
  return m && isAuthorKey(m[1]) ? m[1] : null
}

// Runs once at startup. A /g/ path is cleaned to '/' keeping search and hash
// byte for byte (?conta= and #token= are read later by the account flow);
// returns the key to open, or null. Any other path touches nothing.
export function captureGroupLink (env) {
  return capture(env, isGroupPath, parseGroupPath)
}

// Community links (https://<origin>/c/<hex64>) follow the same rules.
export function isCommunityPath (p) {
  return typeof p === 'string' && p.startsWith('/c/')
}

export function parseCommunityPath (p) {
  if (typeof p !== 'string' || p.length > MAX_PATH) return null
  const m = COMMUNITY_PATH.exec(p)
  return m && isAuthorKey(m[1]) ? m[1] : null
}

export function captureCommunityLink (env) {
  return capture(env, isCommunityPath, parseCommunityPath)
}

// The path a person shares for a community, or null for a bad key.
export function communityLink (community) {
  if (typeof community !== 'string') return null
  const c = community.toLowerCase()
  return isAuthorKey(c) ? '/c/' + c : null
}

function capture ({ location, history } = {}, isPath, parse) {
  try {
    const pathname = location && location.pathname
    if (!isPath(pathname)) return null
    const key = parse(pathname)
    try {
      history.replaceState(history.state, '', '/' + (location.search || '') + (location.hash || ''))
    } catch {}
    return key
  } catch {
    return null
  }
}

export const ENTRY_KEY = 'varanda-entry-link'
export const ENTRY_TTL_MS = 3600000

const MAX_ENTRY_RAW = 256
const CLOCK_SKEW_MS = 60000
const ENTRY_KINDS = ['grupo', 'comunidade']

export const ENTRY_TEXT = Object.freeze({
  comunidade: 'Você recebeu um convite para uma comunidade. Entre para ver e participar.',
  grupo: 'Você recebeu um convite para um grupo. Entre para ver e participar.'
})
export const ENTRY_OPEN_TEXT = 'Para participar, abra este link no Chrome ou no Safari.'
export const ENTRY_LINK_LABELS = Object.freeze({
  field: 'link do convite',
  copyLabel: 'copiar link do convite',
  shareLabel: 'compartilhar convite'
})

function makeEntry (kind, key, at) {
  return Object.freeze({ v: 1, kind, key, at })
}

// Anything on the origin could have written the record, so it is rebuilt
// field by field; extra keys (including __proto__) are never copied.
export function decodeEntry (raw, now) {
  if (typeof raw !== 'string' || raw.length > MAX_ENTRY_RAW) return null
  let o
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  if (o.v !== 1 || !ENTRY_KINDS.includes(o.kind) || !isAuthorKey(o.key)) return null
  if (!Number.isSafeInteger(o.at) || !Number.isSafeInteger(now)) return null
  if (o.at > now + CLOCK_SKEW_MS || now - o.at > ENTRY_TTL_MS) return null
  return makeEntry(o.kind, o.key, o.at)
}

// Storage access is always guarded: private modes and quota errors throw.
export function readEntry (storage, now) {
  if (!storage) return null
  let raw
  try { raw = storage.getItem(ENTRY_KEY) } catch { return null }
  if (raw === null || raw === undefined) return null
  const rec = decodeEntry(raw, now)
  if (rec === null) {
    try { storage.removeItem(ENTRY_KEY) } catch {}
  }
  return rec
}

export function writeEntry (storage, rec) {
  if (!storage || !rec) return false
  try {
    storage.setItem(ENTRY_KEY, JSON.stringify({ v: 1, kind: rec.kind, key: rec.key, at: rec.at }))
    return true
  } catch {
    return false
  }
}

export function clearEntry (storage) {
  if (!storage) return false
  try {
    storage.removeItem(ENTRY_KEY)
    return true
  } catch {
    return false
  }
}

// Runs once at startup. A /g/ or /c/ path first clears the stored record:
// a newer link wins, and a malformed one never leaves an older record
// behind. A valid key then stores a fresh record; a failed write still
// returns it for this page load. Any other path reads what is stored and
// never touches history.
export function captureEntryLink ({ location, history, storage, now } = {}) {
  try {
    const pathname = location && location.pathname
    let kind
    let key
    if (isGroupPath(pathname)) {
      clearEntry(storage)
      kind = 'grupo'
      key = captureGroupLink({ location, history })
    } else if (isCommunityPath(pathname)) {
      clearEntry(storage)
      kind = 'comunidade'
      key = captureCommunityLink({ location, history })
    } else {
      return readEntry(storage, now)
    }
    if (key === null || !Number.isSafeInteger(now)) return null
    const fresh = makeEntry(kind, key, now)
    writeEntry(storage, fresh)
    return fresh
  } catch {
    return null
  }
}

// The path to open again for a record, or null.
export function entryPath ({ kind, key } = {}) {
  if (!isAuthorKey(key)) return null
  if (kind === 'grupo') return '/g/' + key
  if (kind === 'comunidade') return '/c/' + key
  return null
}

export function entryCardText (kind) {
  return Object.prototype.hasOwnProperty.call(ENTRY_TEXT, kind) ? ENTRY_TEXT[kind] : ''
}
