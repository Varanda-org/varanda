// Public post links. The seeder serves /p/<author>/<seq>; when it will not
// show the post it redirects to /publicacao/<author>/<seq>, and the app
// keeps that post as the sign-in destination. Inside the app the same post
// is already the colon ref <hex64>:<seq> (nav.isRef), so these helpers only
// translate between the two forms.

import { isRef } from './nav.js'

// 16 digits includes values past Number.MAX_SAFE_INTEGER. Those must not
// become a ref: the app cannot name them.
const POST_PATH = /^\/(?:publicacao|p)\/([0-9a-f]{64})\/([1-9][0-9]{0,15})$/

// Query and hash are rejected because this function takes a path. A caller
// that still has them attached has not split the URL, and neither the seeder
// page nor the app route carries them in the path.
export function parsePostPath (path) {
  if (typeof path !== 'string') return null
  if (path.includes('?') || path.includes('#')) return null
  const m = POST_PATH.exec(path)
  if (!m) return null
  const seq = Number(m[2])
  if (!Number.isSafeInteger(seq)) return null
  return { author: m[1], seq }
}

// Runs once at startup on the hosted web page. A public post path, valid or
// not, is cleaned to '/', keeping search and hash byte for byte for the
// account flow, so a reload after the post opened cannot save it again; a
// valid one is first handed to save. Any other path is left alone.
// -> the saved target | null.
const POST_PREFIX = /^\/(?:publicacao|p)\//
export function capturePostPath (location, history, save) {
  try {
    const pathname = location && location.pathname
    if (typeof pathname !== 'string' || !POST_PREFIX.test(pathname)) return null
    const target = parsePostPath(pathname)
    if (target !== null) save(target)
    try {
      history.replaceState(history.state, '', '/' + (location.search || '') + (location.hash || ''))
    } catch {}
    return target
  } catch {
    return null
  }
}

export function postRef (target) {
  if (!target || typeof target !== 'object') return null
  const ref = target.author + ':' + target.seq
  return isRef(ref) ? ref : null
}

export const POST_OPEN_WAIT_MS = 6000

// Fails closed: anything short of a clear "no account here" keeps the preview
// away from a person who already has one. A pending passkey ceremony still has
// exists false, so it is named before the exists check. An older node omits
// pending and an unreadable attempts file leaves it unset, so only an explicit
// false counts as no ceremony. held is a step the screen itself still owns,
// such as a recovery code accepted while the node keeps the opened root.
export function postAccount ({ identity, status, recovering, deleted, held } = {}) {
  if (deleted === true) return 'deleted'
  if (recovering === true) return 'recovering'
  if (held === true) return 'pending'
  if (identity !== true || status === null || typeof status !== 'object') return 'unknown'
  if (status.unlocked === true) return 'signedIn'
  if (status.pending === true) return 'pending'
  if (status.exists !== false) return 'locked'
  if (status.pending !== false) return 'unknown'
  return 'none'
}

export function postWaitDelay (startedAt, now) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return null
  return Math.max(0, startedAt + POST_OPEN_WAIT_MS - now)
}

// A returning visitor sees the preview only once the identity says no account
// exists here, and only before another screen took its place. The signed
// invite card has its own opening and wins, so the two never stack.
function postOpening ({ introShow, ageReturn, inviteOpening, otherLink, post, dismissed, account, passed, booting, waitedMs } = {}) {
  if (ageReturn || inviteOpening !== 'none' || otherLink || postRef(post) === null || dismissed) return 'none'
  if (account === 'signedIn' || account === 'pending' || account === 'locked' || account === 'recovering' || account === 'deleted') return 'none'
  if (introShow === true) return 'show'
  if (passed === true) return 'none'
  if (account === 'none') return 'show'
  if (booting === true && Number.isFinite(waitedMs) && waitedMs < POST_OPEN_WAIT_MS) return 'wait'
  return 'none'
}

export function postOpeningGate (o = {}) {
  return postOpening(o) === 'show'
}

export function postOpeningWait (o = {}) {
  return postOpening(o) === 'wait'
}

// A bare origin only. The public link is always <origin>/p/<author>/<seq>,
// so a path or a trailing slash would point somewhere else.
function bareOrigin (origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false
  let host = ''
  if (origin.startsWith('https://')) host = origin.slice('https://'.length)
  else if (origin.startsWith('http://')) host = origin.slice('http://'.length)
  else return false
  return host.length > 0 && !host.includes('/')
}

export function postLink (origin, ref) {
  if (!bareOrigin(origin) || !isRef(ref)) return null
  const colon = ref.indexOf(':')
  return origin + '/p/' + ref.slice(0, colon) + '/' + ref.slice(colon + 1)
}
