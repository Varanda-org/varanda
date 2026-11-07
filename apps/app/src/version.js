/* global URL */

// The build this app came from and the commit the installation serves at
// /version.json, shown in Ajustes. Every value is checked against a strict
// pattern before it reaches the screen: build metadata and the server answer
// are both outside this code, so anything that fails is shown as unknown,
// never echoed.

export const COMMIT_RE = /^[0-9a-f]{40}$/
export const RELEASE_RE = /^[0-9a-f]{16}$/
export const BUILD_DATE_RE = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/
export const VERSION_PATH = '/version.json'
export const MAX_VERSION_BYTES = 256
export const UNKNOWN = 'desconhecido'
export const KIND_LABELS = { web: 'web', android: 'Android', ios: 'iOS' }

const KINDS = ['web', 'android', 'ios']
const CONTENT_LENGTH_RE = /^(0|[1-9][0-9]{0,15})$/

function kindLabel (kind) {
  return typeof kind === 'string' && KINDS.includes(kind) ? KIND_LABELS[kind] : UNKNOWN
}

function matches (re, value) {
  return typeof value === 'string' && re.test(value)
}

export function buildInfo ({ kind, commit, builtAt, release } = {}) {
  return {
    kind: typeof kind === 'string' && KINDS.includes(kind) ? kind : null,
    commit: matches(COMMIT_RE, commit) ? commit : null,
    builtAt: matches(BUILD_DATE_RE, builtAt) ? builtAt : null,
    release: matches(RELEASE_RE, release) ? release : null
  }
}

export function shortCommit (commit) {
  return matches(COMMIT_RE, commit) ? commit.slice(0, 7) : UNKNOWN
}

// -> the commit of a { "v": 1, "commit": "<40 hex>" } body, else null.
export function parseDeployedCommit (text) {
  try {
    if (typeof text !== 'string' || text.length > MAX_VERSION_BYTES) return null
    const doc = JSON.parse(text)
    if (Object.prototype.toString.call(doc) !== '[object Object]') return null
    const keys = Object.keys(doc).sort()
    if (keys.length !== 2 || keys[0] !== 'commit' || keys[1] !== 'v') return null
    if (doc.v !== 1 || !matches(COMMIT_RE, doc.commit)) return null
    return doc.commit
  } catch {
    return null
  }
}

// Same rule as src/discoverHosted.js redirectedAway. On the web the request
// is same origin, so the origin is compared only when an installation is
// given.
export function redirectedAway ({ redirected, url } = {}, { installation = null } = {}) {
  if (redirected === true) return true
  if (typeof url !== 'string' || url === '') return false
  try {
    const u = new URL(url)
    if (u.pathname !== VERSION_PATH || u.search !== '' || u.username !== '' || u.password !== '') return true
    return typeof installation === 'string' && installation !== '' && u.origin !== installation
  } catch {
    return true
  }
}

function cancelBody (res) {
  try {
    if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {})
  } catch {}
}

// -> the body text, or null once it grows past MAX_VERSION_BYTES. Without a
// body stream (React Native) a declared length must keep the read bounded.
async function readBounded (res) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_VERSION_BYTES) {
        try { reader.cancel().catch(() => {}) } catch {}
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (typeof globalThis.TextDecoder === 'function') return new globalThis.TextDecoder().decode(bytes)
    return String.fromCharCode(...bytes)
  }
  // React Native's fetch has already buffered the body here, so this bounds
  // what is parsed, not what is downloaded; the caller's abort timer bounds
  // the download, as for /varanda.json in configStore.native.js.
  const length = res.headers.get('content-length')
  if (!matches(CONTENT_LENGTH_RE, length) || Number(length) > MAX_VERSION_BYTES) return null
  const text = await res.text()
  return typeof text === 'string' && text.length <= MAX_VERSION_BYTES ? text : null
}

// No cache option: React Native's fetch turns no-store into a ?_= query,
// which redirectedAway would reject, and the server already sends no-cache.
export async function fetchDeployedCommit ({ installation = null, fetch: f = globalThis.fetch, signal } = {}) {
  const unavailable = { status: 'unavailable' }
  try {
    const url = (installation === null ? '' : installation) + VERSION_PATH
    const res = await f(url, { credentials: 'omit', redirect: 'error', signal })
    if (redirectedAway({ redirected: res.redirected, url: res.url }, { installation })) {
      cancelBody(res)
      return unavailable
    }
    if (!(res.status >= 200 && res.status <= 299)) {
      cancelBody(res)
      return unavailable
    }
    let type = null
    try { type = res.headers.get('content-type') } catch {}
    if (typeof type !== 'string' || !/application\/json/i.test(type)) {
      cancelBody(res)
      return unavailable
    }
    const commit = parseDeployedCommit(await readBounded(res))
    return commit === null ? unavailable : { status: 'ok', commit }
  } catch {
    return unavailable
  }
}

export function versionLines ({ app, server }) {
  const appLine = 'App: ' + kindLabel(app.kind) +
    ' · ' + shortCommit(app.commit) +
    ' · ' + (matches(BUILD_DATE_RE, app.builtAt) ? app.builtAt.slice(0, 10) : UNKNOWN) +
    (app.kind === 'web' ? ' · release ' + (matches(RELEASE_RE, app.release) ? app.release : UNKNOWN) : '')
  let serverLine = null
  if (server.status === 'loading') serverLine = 'Servidor: consultando…'
  else if (server.status === 'ok') serverLine = 'Servidor: ' + shortCommit(server.commit)
  else if (server.status === 'unavailable') serverLine = 'Servidor: ' + UNKNOWN
  return { appLine, serverLine }
}

export function versionDetails ({ app, server }) {
  const lines = [
    'Varanda',
    'App: ' + kindLabel(app.kind),
    'Commit: ' + (matches(COMMIT_RE, app.commit) ? app.commit : UNKNOWN),
    'Build: ' + (matches(BUILD_DATE_RE, app.builtAt) ? app.builtAt : UNKNOWN)
  ]
  if (app.kind === 'web') lines.push('Release web: ' + (matches(RELEASE_RE, app.release) ? app.release : UNKNOWN))
  // A copy made while the lookup runs, or from a native build with no
  // installation, says so instead of claiming the server is unknown.
  let serverValue = UNKNOWN
  if (server.status === 'ok' && matches(COMMIT_RE, server.commit)) serverValue = server.commit
  else if (server.status === 'loading') serverValue = 'consultando'
  else if (server.status === 'unconfigured') serverValue = 'sem instalação'
  lines.push('Servidor: ' + serverValue)
  return lines.join('\n')
}
