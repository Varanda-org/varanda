/* global AbortController, URL */

// Whether an installation turned public post pages on (GET /p/policy,
// docs/protocol.md section 16). It gates the publish row, so every doubt
// answers false. Pure ES module: no React and no Node built-ins, so Metro
// bundles it and the tests load it with import().
//
// No identifier rides on the probe: no credentials, no custom header, no
// query, no cache option. A definite answer is kept for the session, per origin; a network
// error, a server error, a 408 or a 429 is not, so the next call asks again.
// One call never repeats its request.

import { installationOrigin, resolveUrl } from './installation.js'

export const POLICY_PATH = '/p/policy'
export const POLICY_TIMEOUT_MS = 5000

const answers = new Map()
const inFlight = new Map()
// Bumped by forgetPostPublicPolicy, so an answer asked before it is dropped.
let generation = 0

// The URL to ask, or null. The installation's own origin goes through
// resolveUrl, which keeps the hosted web app's same-origin path; any other
// origin must be a bare https origin (http only for a local dev server).
export function policyUrl (origin) {
  if (origin === installationOrigin()) return resolveUrl(POLICY_PATH)
  return isBareOrigin(origin) ? origin + POLICY_PATH : null
}

// -> Promise<boolean>, never rejects.
export function postPublicEnabled (origin) {
  if (answers.has(origin)) return Promise.resolve(answers.get(origin))
  if (inFlight.has(origin)) return inFlight.get(origin)
  let url
  try {
    url = policyUrl(origin)
  } catch {
    url = null
  }
  if (url === null) return Promise.resolve(false)
  // Callers that ask at once share one request instead of each sending one.
  const asked = generation
  const pending = probe(url).then((answer) => {
    if (answer !== null && asked === generation) answers.set(origin, answer)
    return answer === true
  }, () => false).finally(() => {
    if (inFlight.get(origin) === pending) inFlight.delete(origin)
  })
  inFlight.set(origin, pending)
  return pending
}

// For tests and for a change of installation.
export function forgetPostPublicPolicy () {
  generation++
  answers.clear()
  inFlight.clear()
}

// true or false for a definite answer, null for one worth asking again.
async function probe (url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), POLICY_TIMEOUT_MS)
  let text
  try {
    // No cache option: React Native's fetch (whatwg-fetch) turns 'no-store'
    // into a ?_=<time> query, which redirectedAway refuses, and the seeder
    // already answers with Cache-Control: no-store.
    const res = await fetch(url, { method: 'GET', credentials: 'omit', signal: ctl.signal })
    // A redirect leaves the origin the person chose: not its answer.
    if (redirectedAway(res, url)) return false
    // A timeout or a rate limit (Caddy's /p/* zone also counts page views)
    // says nothing about the switch: ask again later, like a server error.
    if (res.status >= 500 || res.status === 408 || res.status === 429) return null
    if (res.status !== 200) return false
    text = await res.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return false
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false
  return body.enabled === true
}

// React Native's fetch follows a redirect and leaves `redirected` unset, so
// the final URL is judged too, by the rule of src/version.js redirectedAway.
// An absent or empty url is judged by `redirected` alone; a relative request
// (the hosted web app asking its own origin) compares no origin.
function redirectedAway ({ redirected, url } = {}, asked) {
  if (redirected === true) return true
  if (typeof url !== 'string' || url === '') return false
  try {
    const u = new URL(url)
    if (u.pathname !== POLICY_PATH || u.search !== '' || u.username !== '' || u.password !== '') return true
    let want = null
    try { want = new URL(asked).origin } catch {}
    return want !== null && u.origin !== want
  } catch {
    return true
  }
}

function isBareOrigin (origin) {
  if (typeof origin !== 'string') return false
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol === 'http:') {
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return false
  } else if (url.protocol !== 'https:') {
    return false
  }
  // The exact spelling of an origin: no path, slash, query, fragment,
  // credentials, default port or uppercase host.
  return url.origin === origin
}
