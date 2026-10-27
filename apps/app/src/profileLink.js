// Profile links (https://<origin>/@ana or /m/<hex64>) that invite a visitor
// to enter and follow someone. Pure ES module: no React, no globals, no Node
// built-ins; it never touches location or storage itself, the caller passes
// them in, so Node's import() tests every branch with fakes.
//
// The pending invite is a small record kept in tab storage. It is untrusted
// input on every read (anything on the origin could have written it), so
// decodeInvite rebuilds it field by field and drops anything doubtful. Consent
// to follow lives only in that record ('accepted' for one recipient key) and
// is never carried by the link itself.

import { isUsername, usernameMatches } from './account.js'
import { isAuthorKey } from './nav.js'

export const INVITE_KEY = 'varanda-profile-invite'
export const INVITE_TTL_MS = 3600000

const MAX_PATH = 80
const MAX_RAW = 512
const CLOCK_SKEW_MS = 60000
const USERNAME_PATH = /^\/@([A-Za-z0-9_]{3,20})\/?$/
const KEY_PATH = /^\/m\/([0-9a-fA-F]{64})\/?$/
const STATES = ['new', 'accepted']

export const NOT_FOUND_TEXT = 'Não encontramos esse @nome.'
export const OFFLINE_TEXT = 'Sem conexão: o perfil abre quando a conexão voltar.'
export const OPEN_IN_BROWSER_TEXT = 'Para entrar e seguir, abra este link no Chrome ou no Safari.'

// Cheap prefix test: any path under /@ or /m/ is a profile link attempt and
// gets cleaned from the address bar, valid or not.
export function isProfilePath (p) {
  return typeof p === 'string' && (p.startsWith('/@') || p.startsWith('/m/'))
}

// {username} | {key} | null. Strict regexes over the raw path, never
// decodeURIComponent: '%', '..', '//', whitespace and extra segments all fail.
export function parseProfilePath (p) {
  if (typeof p !== 'string' || p.length > MAX_PATH) return null
  let m = USERNAME_PATH.exec(p)
  if (m) {
    const username = isUsername(m[1])
    return username === null ? null : { username }
  }
  m = KEY_PATH.exec(p)
  if (m) {
    const key = m[1].toLowerCase() // canonical form, as openMember uses
    return isAuthorKey(key) ? { key } : null
  }
  return null
}

// A bare https origin only: no path, trailing slash, userinfo or query, so the
// link is exactly what the person sees and no host is hardcoded.
function validOrigin (origin) {
  if (typeof origin !== 'string') return false
  let url
  try { url = new URL(origin) } catch { return false }
  return url.protocol === 'https:' && url.origin === origin
}

// The @username link when there is one (readable), else the key link.
export function buildProfileUrl ({ origin, username, publicKey } = {}) {
  if (!validOrigin(origin)) return null
  const name = isUsername(username)
  if (name !== null) return origin + '/@' + name
  if (isAuthorKey(publicKey)) return origin + '/m/' + publicKey
  return null
}

function makeInvite ({ username, key, state, recipient, at }) {
  return Object.freeze({ v: 1, username, key, state, recipient, at })
}

export function encodeInvite (rec) {
  return JSON.stringify({
    v: 1,
    username: rec.username,
    key: rec.key,
    state: rec.state,
    recipient: rec.recipient,
    at: rec.at
  })
}

// Frozen record or null. Extra keys (including __proto__) are never copied.
export function decodeInvite (raw, now) {
  if (typeof raw !== 'string' || raw.length > MAX_RAW) return null
  let o
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  if (o.v !== 1) return null
  const hasName = typeof o.username === 'string' && isUsername(o.username) === o.username
  const hasKey = isAuthorKey(o.key)
  // Exactly one target, the other explicitly null.
  if (hasName === hasKey) return null
  if (hasName && o.key !== null) return null
  if (hasKey && o.username !== null) return null
  if (!STATES.includes(o.state)) return null
  // Consent belongs to one recipient key: none before accepting, one after.
  if (o.state === 'new' && o.recipient !== null) return null
  if (o.state === 'accepted' && !isAuthorKey(o.recipient)) return null
  if (!Number.isSafeInteger(o.at)) return null
  if (o.at > now + CLOCK_SKEW_MS || now - o.at > INVITE_TTL_MS) return null
  return makeInvite({
    username: hasName ? o.username : null,
    key: hasKey ? o.key : null,
    state: o.state,
    recipient: o.recipient,
    at: o.at
  })
}

// Storage access is always guarded: private modes and quota errors throw, and
// a missing storage (null) means "nothing remembered".
export function readInvite (storage, now) {
  if (!storage) return null
  let raw
  try { raw = storage.getItem(INVITE_KEY) } catch { return null }
  if (raw === null || raw === undefined) return null
  const rec = decodeInvite(raw, now)
  if (rec === null) {
    try { storage.removeItem(INVITE_KEY) } catch {}
  }
  return rec
}

export function writeInvite (storage, rec) {
  if (!storage || !rec) return false
  try {
    storage.setItem(INVITE_KEY, encodeInvite(rec))
    return true
  } catch {
    return false
  }
}

export function clearInvite (storage) {
  if (!storage) return false
  try {
    storage.removeItem(INVITE_KEY)
    return true
  } catch {
    return false
  }
}

// Runs once at startup. Any profile path first clears the stored invite, valid
// or not: a newer link always wins, so a malformed link or a failed write can
// never leave an older invite (possibly already accepted, for someone else)
// to be picked up now or after the Google return. A valid path then stores a
// fresh 'new' invite, so a link never inherits earlier consent; when the write
// fails the in-memory record still opens the profile in this load. The path
// is cleaned to '/' keeping search and hash byte for byte (?conta= and
// #token= are read later by the account flow). Any other path touches nothing.
export function captureInvite ({ location, history, storage, now } = {}) {
  try {
    const pathname = location && location.pathname
    if (!isProfilePath(pathname)) return readInvite(storage, now)
    clearInvite(storage)
    const target = parseProfilePath(pathname)
    let fresh = null
    if (target) {
      fresh = makeInvite({
        username: target.username || null,
        key: target.key || null,
        state: 'new',
        recipient: null,
        at: now
      })
      writeInvite(storage, fresh)
    }
    try {
      history.replaceState(history.state, '', '/' + (location.search || '') + (location.hash || ''))
    } catch {}
    return fresh
  } catch {
    return null
  }
}

export function acceptInvite (rec, recipient, now) {
  if (!rec || !isAuthorKey(recipient)) return null
  return makeInvite({ ...rec, state: 'accepted', recipient, at: now })
}

// The shell's decision table, evaluated in order. 'accept' records consent
// only for a card the visitor saw in this load (cardShown, not resumed) and a
// known key; 'follow' only fires for the key that accepted, so another
// account unlocking in the same tab just gets the profile opened. It also
// needs that consent to have been given in this page load (acceptedHere): an
// accepted record found after a reload (the Google return) could have been
// written by any same-origin writer of tab storage, so it only 'confirm's —
// the profile opens and the visitor taps Seguir.
export function inviteAction ({ invite, hosted, statusKnown, locked, resumed, cardShown, unlockedKey, ownKey, atTabs, acceptedHere } = {}) {
  if (!invite) return 'none'
  if (!statusKnown) return 'wait'
  if (hosted !== true) return 'drop'
  if (locked) return 'card'
  const fromCard = cardShown === true && resumed !== true
  // Right after a first passkey ceremony the key is unknown until the diary
  // exists: wait rather than fall through to 'open' and lose the consent.
  if (fromCard && !isAuthorKey(unlockedKey)) return 'wait'
  if (fromCard && !(invite.state === 'accepted' && invite.recipient === unlockedKey)) return 'accept'
  if (atTabs !== true) return 'wait'
  if (invite.state === 'accepted' && isAuthorKey(ownKey) && invite.recipient === ownKey) {
    return acceptedHere === true ? 'follow' : 'confirm'
  }
  return 'open'
}

// Username -> key through the same-origin account lookup. The match is a
// consistency check on same-origin data, not a signature (as Seguindo does).
export async function resolveInvite (rec, lookup) {
  if (rec && isAuthorKey(rec.key)) return { status: 'ready', key: rec.key }
  if (!rec || typeof rec.username !== 'string') return { status: 'not-found' }
  let found
  try { found = await lookup(rec.username) } catch { return { status: 'unavailable' } }
  if (!found || !isAuthorKey(found.member) || !usernameMatches(found.usernameRecord, found.member, rec.username)) {
    return { status: 'not-found' }
  }
  return { status: 'ready', key: found.member }
}

// pt-BR copy; never shows the key or the raw path.
export function inviteCardText (rec) {
  const name = rec && isUsername(rec.username)
  return (name ? '@' + name + ' convidou você' : 'Alguém convidou você') + ' — entre para seguir'
}

export function followedText ({ username, changed } = {}) {
  const name = isUsername(username)
  const who = name ? '@' + name : 'esta pessoa'
  return changed ? 'Agora você segue ' + who + '.' : 'Você já segue ' + who + '.'
}

// 'confirm': the profile is open and the follow is one tap away.
export function confirmText ({ username } = {}) {
  const name = isUsername(username)
  return 'Para seguir ' + (name ? '@' + name : 'esta pessoa') + ', toque em Seguir.'
}
