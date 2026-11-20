// The varanda:// URLs the native app is opened with. Pure ES module: no
// React, no react-native, no Node built-ins, and no URL parsing (React
// Native's URL lacks most getters), so every rule is a plain string test.
//
// Two families, both untrusted (any app or page can open varanda://):
//   - the age return of the account service (apps/cli/lib/account/
//     app-return.js): varanda://idade?volta=1. Only a hint: the outcome is
//     always asked of the service again. varanda://conta is not a return
//     (any app can claim or forge it);
//   - invite, profile, group (/g/<hex64>), community (/c/<hex64>), listing
//     (/anuncio/<hex64>/<seq> or /f/<hex64>/<seq>) and public post
//     (/publicacao/<hex64>/<seq> or /p/<hex64>/<seq>) links,
//     either varanda:///<path> (empty host, so the path is the web path) or
//     an https link of this installation.
// A link is never consent to follow or to join: the profile store records
// 'new' only, and a group or community link only names what to open.
// An https App Link that arrives before the installation loads is held, not
// parsed (waitsForInstallation).

import { installationOrigin } from './installation.js'
import { parseSignupInvitePath, CODE_RE } from './signupInvite.js'
import { parseProfilePath } from './profileLink.js'
import { parseGroupPath, parseCommunityPath } from './groupLink.js'
import { parseListingPath } from './feiraLink.js'
import { parsePostPath } from './postLink.js'

const MAX_URL = 400
const AGE_PREFIX = 'varanda://idade?'
const LINK_PREFIX = 'varanda://'
function clean (url) {
  return typeof url === 'string' && url.length <= MAX_URL && !/[\s\\]/.test(url) && !hasControl(url)
}

function hasControl (text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

// name -> value of a raw query (no fragment), or null when a name repeats:
// a repeated parameter has no single meaning.
function readQuery (query) {
  const out = new Map()
  for (const part of query.split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const name = eq === -1 ? part : part.slice(0, eq)
    const value = eq === -1 ? '' : part.slice(eq + 1)
    if (out.has(name)) return null
    out.set(name, value)
  }
  return out
}

function queryOf (url, prefix) {
  const rest = url.slice(prefix.length)
  const hash = rest.indexOf('#')
  return readQuery(hash === -1 ? rest : rest.slice(0, hash))
}

// -> { kind: 'idade' } | null. Strict on the scheme and the host; other
// parameters are ignored.
export function parseAppReturn (url) {
  if (!clean(url)) return null
  if (url.startsWith(AGE_PREFIX)) {
    const q = queryOf(url, AGE_PREFIX)
    return q !== null && q.get('volta') === '1' ? { kind: 'idade' } : null
  }
  return null
}

function pathOf (rest) {
  const end = rest.search(/[?#]/)
  return end === -1 ? rest : rest.slice(0, end)
}

// The web path an invite or profile link names, or null: 'varanda:///<path>'
// (empty host only: 'varanda://convite/x' and 'varanda://@ana' name a host,
// not a path) or 'https://<this installation>/<path>'.
function linkPath (url) {
  if (url.startsWith(LINK_PREFIX + '/')) return pathOf(url.slice(LINK_PREFIX.length))
  const origin = installationOrigin()
  if (typeof origin === 'string' && origin.startsWith('https://') && url.startsWith(origin + '/')) {
    return pathOf(url.slice(origin.length))
  }
  return null
}

// -> { kind: 'convite', code } | { kind: 'perfil', username } |
// { kind: 'perfil', key } | { kind: 'grupo', key } |
// { kind: 'comunidade', key } | { kind: 'anuncio', author, seq } |
// { kind: 'publicacao', author, seq } | null.
export function parseAppLink (url) {
  if (!clean(url)) return null
  const path = linkPath(url)
  if (path === null || path.startsWith('//')) return null
  if (path.startsWith('/anuncio/') || path.startsWith('/f/')) {
    const listing = parseListingPath(path)
    return listing !== null ? { kind: 'anuncio', author: listing.author, seq: listing.seq } : null
  }
  // A /p/ or /publicacao/ path that is not a post must not fall through:
  // /p/policy is neither a profile nor an invite.
  if (path.startsWith('/publicacao/') || path.startsWith('/p/')) {
    const post = parsePostPath(path)
    return post !== null ? { kind: 'publicacao', author: post.author, seq: post.seq } : null
  }
  const code = parseSignupInvitePath(path)
  if (code !== null) return { kind: 'convite', code }
  const target = parseProfilePath(path)
  if (target === null) {
    const group = parseGroupPath(path)
    if (group !== null) return { kind: 'grupo', key: group }
    const community = parseCommunityPath(path)
    return community !== null ? { kind: 'comunidade', key: community } : null
  }
  return target.username ? { kind: 'perfil', username: target.username } : { kind: 'perfil', key: target.key }
}

// An App Link can start the app before the saved installation loads, so
// linkPath cannot yet tell whether the URL belongs to this installation.
// App.js holds it and parses it again once one loads; a URL of another host
// is dropped then.
export function waitsForInstallation (url) {
  return clean(url) && url.startsWith('https://') && installationOrigin() === null
}

// What the person pasted in the invite field: the bare code or a full
// invite link (https of this installation, or varanda:///convite/<code>).
export function parseInviteInput (text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (CODE_RE.test(t)) return t
  const link = parseAppLink(t)
  return link !== null && link.kind === 'convite' ? link.code : null
}

const INVITE_REFUSALS = ['convite-obrigatorio', 'convite-invalido']

// An account answer that refuses the invite (missing, or used, expired or
// unknown).
export function isInviteRefusal (err) {
  return !!err && INVITE_REFUSALS.includes(err.code)
}

// The app drops its held code on 'convite-invalido', so the paste field
// shows again for another link. The web keeps its stored code (another
// pending link may free it up).
export function dropsHeldInvite (err, native) {
  return native === true && !!err && err.code === 'convite-invalido'
}

// Whether a native step (Identidade's link step, Idade) offers the paste
// field: the app holds no code and the network is by invite, or the service
// just refused the invite.
export function invitePasteShown ({ native, required, held, refused } = {}) {
  return native === true && held !== true && (required === true || refused === true)
}

// One token per captured profile link: a lookup started for an older link
// is stale once a newer link arrives, and must neither forget nor open.
export function createLinkToken () {
  let n = 0
  return {
    next: () => ++n,
    current: () => n,
    isCurrent: (t) => t === n
  }
}
