'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const { isUsername, verifyAccountLink } = require('@varanda/core/lib/account-link')
const { TERMS_VERSION, verifyTerms } = require('@varanda/core/lib/terms')
const { loadKeyPairFile, verifyIssuerCert, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { createModRoutes } = require('./mod-routes')

// The account service's HTTPS surface (behind Caddy, deploy/seeder/Caddyfile
// `handle /account/*`): the member proves its diary key over a single-use
// nonce, signs in at Google (server-side code exchange with PKCE,
// apps/cli/lib/account/google.js), proves the key again over the Google
// subject and receives the v2 certificate and the first username record
// from the directory (apps/cli/lib/account/store.js). A linked member may
// later rename itself with one more key proof (no cookie: the key is the
// authority), and record its acceptance of the Termos de Uso and the
// Política de Privacidade the same way (/account/terms/*, ./terms-store.js).
//
// The moderation desk (reports from the app, the moderators' panel and the
// operator's signed pull/ack) lives in ./mod-routes.js and is dispatched
// before any route that needs the issuer: reports and the panel work on a
// service that has no certified issuer yet (C10).
//
// Modelled on health.js and seed-ws.js: loopback bind, Host pinned to the
// listener (DNS-rebinding defence), no CORS headers at all (a cross-origin
// page can neither read a response nor, without the exact Origin, POST), a
// bounded JSON body, and nothing personal in logs: `log` only ever receives
// { event, reason } tokens; no e-mail, subject, address, code, token or
// signature leaves the process except in the response to its own request.
// Error bodies are { error: <token> } and only the tokens in ERROR_STATUS.
//
// Rate limits need no client address (Caddy strips X-Forwarded-For and
// nothing here reads it). Nothing shared is charged before a proof, so an
// unauthenticated flood cannot spend a quota that members need: the
// per-member windows are charged only AFTER the member's signature
// verified (authorize, finish, rename/finish) and keyed on the member it
// proved; the callback quota is per pending row, charged only after the
// cookie and the state named the same row; the public reads share one wide
// window; the routes that need no proof (start, rename/start) are bounded
// by their tables (oldest evicted) and by the one global token bucket.
// Residual: a flood can still drain the global bucket (by default 20/s,
// burst 100; `ratePerSecond` and `burst` configure it, and `maxConnections`
// the socket ceiling, by default 64) for everyone. A per-source limit needs client addresses, which the
// design keeps out of this service pending the legal opinion on logs
// (GitHub issue #38); the operator can add per-IP limiting in front of
// Caddy.

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8790
const MAX_SOCKETS = 64
const DEFAULT_RATE = 20
const DEFAULT_BURST = 100
const HEADERS_TIMEOUT_MS = 4000
const REQUEST_TIMEOUT_MS = 10000
const CHECK_INTERVAL_MS = 1000
const MAX_BODY = 4096
const COOKIE = '__Host-varanda-link'
const COOKIE_MAX_AGE_S = 600
const RENAME_TTL_MS = 600 * 1000
const MAX_RENAMES = 1000
const TERMS_TTL_MS = 600 * 1000
const MAX_TERMS_NONCES = 1000
const KEY_FILE = 'issuer-key.json'
const CERT_FILE = 'issuer-cert.json'
const LOCK_FILE = '.account-lock'
const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/
// Plain HTTP on loopback: accepted by createAccountServer only, for the
// loopback end-to-end tests that bind the real port into the origin the
// operator signs (packages/core/lib/mod-request.js LOOPBACK_ORIGIN_RE). The
// CLI reads VARANDA_PUBLIC_ORIGIN with ORIGIN_RE (https only), so a
// deployment never runs with it.
const LOOPBACK_ORIGIN_RE = /^http:\/\/127\.0\.0\.1(:[0-9]{1,5})?$/
const HEX64_RE = /^[0-9a-f]{64}$/
// A store id, nonce or state: 32 random bytes, base64url (store.js randomToken).
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
const HEX128_RE = /^[0-9a-f]{128}$/
// Google authorization codes and error tokens: printable ASCII, bounded.
const PARAM_RE = /^[\x21-\x7e]{1,512}$/

const ERROR_STATUS = Object.freeze({
  'pedido-invalido': 400,
  'nome-em-uso': 409,
  'nome-invalido': 400,
  'conta-vinculada': 409,
  'assinatura-invalida': 400,
  expirado: 404,
  'nao-encontrado': 404,
  'google-recusado': 502,
  'troca-bloqueada': 409,
  indisponivel: 503,
  lotado: 503,
  // The member cap is reached (store.js maxMembers): the body is only the
  // token, so the app can show the waitlist answer.
  'lista-de-espera': 503,
  // The moderation desk (./mod-routes.js, apps/cli/lib/account/moderation-store.js).
  'nao-vinculado': 403,
  'nao-autorizado': 401,
  'limite-denuncias': 429,
  limite: 503,
  defasado: 409,
  // A group block whose key the seeder did not confirm as a group root.
  'grupo-nao-confirmado': 409,
  // A block of a key without a linked account that the seeder did not
  // confirm as a served diary (it could be a group root).
  'alvo-nao-confirmado': 409,
  'ja-revertido': 409
})

const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
})

class RouteError extends Error {
  constructor (token, status, extra) {
    super(token)
    this.token = token
    this.status = status
    this.extra = extra
  }
}

function refuse (token, extra) {
  return new RouteError(token, ERROR_STATUS[token] ?? 400, extra)
}

// A store error carries only a token in `code` (store.js fail()); anything
// else is an internal failure answered as 'indisponivel' without its message.
function fromStore (err) {
  if (err instanceof RouteError) return err
  const token = err && typeof err.code === 'string' && Object.hasOwn(ERROR_STATUS, err.code) ? err.code : 'indisponivel'
  const extra = token === 'troca-bloqueada' && typeof err.nextChangeAt === 'string' ? { nextChangeAt: err.nextChangeAt } : undefined
  return refuse(token, extra)
}

function base64url (buf) {
  return Buffer.from(buf).toString('base64url')
}

function codeChallenge (verifier) {
  return base64url(nodeCrypto.createHash('sha256').update(verifier).digest())
}

function isPlainObject (o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

// host:port as a Host header carries it (IPv6 literals bracketed).
function authority (host, port) {
  return (host.includes(':') ? '[' + host + ']' : host) + ':' + port
}

// --- limits (no addresses) -------------------------------------------------

function tokenBucket (ratePerSecond, burst, now) {
  let tokens = burst
  let last = now()
  return () => {
    const t = now()
    tokens = Math.min(burst, tokens + Math.max(0, t - last) * ratePerSecond / 1000)
    last = t
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
}

function fixedWindow (limit, windowMs, now) {
  let start = now()
  let count = 0
  return () => {
    const t = now()
    if (t - start >= windowMs) {
      start = t
      count = 0
    }
    if (count >= limit) return false
    count++
    return true
  }
}

// One fixed window per key, at most `max` live keys. A new key is always
// admitted: when the table is full the expired windows go first, then the
// oldest live one (insertion order: a window is re-inserted when it
// restarts), so a flood of keys can at worst forget someone's count, never
// lock a new key out.
function keyedWindow (limit, windowMs, now, max = 10000) {
  const windows = new Map()
  return (key) => {
    const t = now()
    let w = windows.get(key)
    if (w !== undefined && t - w.start >= windowMs) {
      windows.delete(key)
      w = undefined
    }
    if (w === undefined) {
      if (windows.size >= max) {
        for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k)
        if (windows.size >= max) windows.delete(windows.keys().next().value)
      }
      w = { start: t, count: 0 }
      windows.set(key, w)
    }
    if (w.count >= limit) return false
    w.count++
    return true
  }
}

// --- issuer and data-dir lock -------------------------------------------------

// The issuer key pair and certificate of `dataDir`, or null while either is
// missing or the certificate does not verify for this association and key
// (C10: the service boots unconfigured). A present but unreadable key file
// throws: that is an operator error, not an unconfigured service.
function loadIssuer (dataDir, association, log = () => {}) {
  let keyPair
  try {
    keyPair = loadKeyPairFile(path.join(dataDir, KEY_FILE))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  let cert
  try {
    cert = JSON.parse(fs.readFileSync(path.join(dataDir, CERT_FILE), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return null
    log({ event: 'issuer', reason: 'malformed' })
    return null
  }
  const reason = checkIssuerCert(cert, keyPair, association)
  if (reason !== null) {
    log({ event: 'issuer', reason })
    return null
  }
  return { keyPair, cert }
}

// null when `cert` is an issuer certificate of `association` for `keyPair`,
// else the reason ('malformed', 'untrusted-association', 'bad-signature' or
// 'issuer-mismatch').
function checkIssuerCert (cert, keyPair, association) {
  const verdict = verifyIssuerCert(cert, association)
  if (!verdict.ok) return verdict.reason
  if (cert.issuer !== b4a.toString(keyPair.publicKey, 'hex')) return 'issuer-mismatch'
  return null
}

// Exclusive single-writer lock on the data dir (orchestrator note 1): the
// store keeps one in-memory copy of directory.json with no cross-process
// lock, so two serving processes would overwrite each other's links. Only
// the serve path takes it; key, cert add, status and export never write
// the directory.
//
// The lock is published atomically with its content (the saveKeyPairFile
// pattern in @varanda/core/lib/cert: write a temp file, hard-link it into
// place, EEXIST means someone holds it), so a reader never sees an empty
// lock from a writer mid-publish. Liveness is a HEARTBEAT, never a pid: the
// holder refreshes the file's mtime every LOCK_HEARTBEAT_MS and a lock is
// live while its mtime is within LOCK_STALE_MS of now (an mtime in the
// future counts as live: clock skew refuses rather than recovers). The
// content's pid is informational only. In the deployed container Node is
// PID 1 and the lock persists in the volume, so after a SIGKILL, OOM or
// host crash the replacement process is PID 1 too, and `account status` /
// `account export` run in another container whose node is also PID 1:
// process.kill(pid, 0) says nothing useful there. An empty or malformed
// file (older code, a crash mid-write) follows the same mtime rule.
//
// Recovery of a stale lock is deliberately simple: re-read it right before
// unlinking and unlink only if its mtime is still stale and its bytes are
// unchanged, then retry the link once; any mismatch is treated as live and
// refused. Residual race: two startups recovering the same stale lock in
// the same instant can both proceed only if one unlinks the other's
// freshly linked lock between its own re-read and its unlink, a
// sub-millisecond window that needs two simultaneous starts right after a
// crash; Docker Compose runs one `account` service. There the service
// restarts on crash (restart: unless-stopped): the first restarts within
// LOCK_STALE_MS of the crash are refused and exit non-zero, then one
// succeeds.
//
// The heartbeat also checks that the lock is still ours (present and
// carrying this process's token): when it is not, onLost fires once and
// the heartbeat stops, since another writer may now exist; the service
// shuts down with a non-zero exit. The holder can touch another's lock
// only if its own went stale first (a heartbeat delayed by more than
// LOCK_STALE_MS, say a suspended process) and was recovered between its
// read and its utimes; the next tick then notices the foreign token.
// release() removes only a lock carrying this process's own token.
const LOCK_HEARTBEAT_MS = 10000
const LOCK_STALE_MS = 30000

// -> { file, owned(), release() }. `heartbeatMs`, `staleMs` and `onLost` are for
// tests and the serve path; the heartbeat timer is unref'd so it never
// keeps a process alive on its own.
function takeLock (dataDir, { heartbeatMs = LOCK_HEARTBEAT_MS, staleMs = LOCK_STALE_MS, onLost = () => {} } = {}) {
  refuseSymlinkDir(dataDir)
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = path.join(dataDir, LOCK_FILE)
  const token = nodeCrypto.randomBytes(16).toString('hex')
  const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }) + '\n'
  for (let attempt = 0; attempt < 2; attempt++) {
    if (publishLock(file, body)) return heartbeat(file, token, { heartbeatMs, onLost })
    if (attempt > 0) break
    const current = readLock(file)
    if (current === null) continue // gone between link and read: retry once
    if (lockLive(current, staleMs)) break
    // Re-read right before unlinking: still stale and the same bytes, else
    // someone published a fresh lock in between and it is theirs.
    const again = readLock(file)
    if (again === null) continue
    if (lockLive(again, staleMs) || !b4a.equals(again.bytes, current.bytes)) break
    try {
      fs.unlinkSync(file)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
  }
  throw new Error('outro serviço de conta usa este diretório')
}

// Refreshes the lock's mtime every `heartbeatMs` while it is still ours;
// -> { file, owned(), release() }. owned() reads the lock file now, for a
// check that cannot wait for the next tick (the shutdown close).
function heartbeat (file, token, { heartbeatMs, onLost }) {
  let timer = null
  const stop = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
  const tick = () => {
    if (ownLock(file, token)) {
      try {
        const now = new Date()
        fs.utimesSync(file, now, now)
        return
      } catch {}
    }
    stop()
    onLost()
  }
  timer = setInterval(tick, heartbeatMs)
  timer.unref()
  return {
    file,
    owned: () => ownLock(file, token),
    release: () => {
      stop()
      releaseLock(file, token)
    }
  }
}

// Links `body` into place as the lock; false when a lock already exists.
function publishLock (file, body) {
  const tmp = file + '.' + nodeCrypto.randomBytes(12).toString('hex') + '.tmp'
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    try {
      fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, body)
    } finally {
      fs.closeSync(fd)
    }
    fs.linkSync(tmp, file)
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

// The lock's bytes and mtime, or null when there is none.
function readLock (file) {
  try {
    const bytes = fs.readFileSync(file)
    const { mtimeMs } = fs.statSync(file)
    return { bytes, mtimeMs }
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Live while the mtime is within `staleMs` of now (see the note above).
function lockLive ({ mtimeMs }, staleMs) {
  return Date.now() - mtimeMs <= staleMs
}

// True while the lock exists and carries `token`.
function ownLock (file, token) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isPlainObject(data) && data.token === token
  } catch {
    return false
  }
}

// Removes the lock only while it carries `token`: never another's lock.
function releaseLock (file, token) {
  if (!ownLock(file, token)) return
  try { fs.unlinkSync(file) } catch {}
}

// The read-only probe of `account status` and `account export`: a lock
// exists and is live by mtime.
function lockHeld (dataDir, { staleMs = LOCK_STALE_MS } = {}) {
  const current = readLock(path.join(dataDir, LOCK_FILE))
  return current !== null && lockLive(current, staleMs)
}

// --- HTTP helpers --------------------------------------------------------------

function send (res, status, body, headers = {}) {
  const text = JSON.stringify(body) + '\n'
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...BASE_HEADERS,
    ...headers
  })
  res.end(text)
}

function sendError (res, err, headers) {
  send(res, err.status, { error: err.token, ...err.extra }, headers)
}

function redirect (res, location, headers = {}) {
  res.writeHead(302, { Location: location, 'Content-Length': 0, ...BASE_HEADERS, ...headers })
  res.end()
}

function cookieHeader (id, maxAge = COOKIE_MAX_AGE_S) {
  return COOKIE + '=' + id + '; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge
}

// The pending id carried by the request's cookie, or null.
function cookieId (req) {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header.length > 4096) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== COOKIE) continue
    const value = part.slice(eq + 1).trim()
    return TOKEN_RE.test(value) ? value : null
  }
  return null
}

// At most `max` bytes of JSON forming a plain object; anything else is
// 'pedido-invalido' (413 when the body is too large).
function readJsonBody (req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > max) return reject(new RouteError('pedido-invalido', 413))
    const chunks = []
    let size = 0
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      if (err) reject(err)
      else resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      // Past the limit nothing more is kept; the 413 closes the connection.
      if (size > max) return finish(new RouteError('pedido-invalido', 413))
      chunks.push(chunk)
    })
    req.on('error', () => finish(refuse('pedido-invalido')))
    req.on('aborted', () => finish(refuse('pedido-invalido')))
    req.on('end', () => {
      let value
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return finish(refuse('pedido-invalido'))
      }
      if (!isPlainObject(value)) return finish(refuse('pedido-invalido'))
      finish(null, value)
    })
  })
}

function memberParam (value) {
  if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
  return value
}

function usernameParam (value) {
  if (!isUsername(value)) throw refuse('nome-invalido')
  return value
}

function signatureParam (value) {
  if (typeof value !== 'string' || !HEX128_RE.test(value)) throw refuse('assinatura-invalida')
  return value
}

// --- the service --------------------------------------------------------------

// The POST rules of every browser route: the exact Origin (a browser's
// cross-site POST of a simple form never carries it) and a JSON content
// type (never sent cross-site without a CORS preflight, which is never
// answered). `requireOrigin: false` only for the operator's signed routes
// (./mod-routes.js), whose authority is a signature, not a browser.
function checkPost (req, origin, { requireOrigin = true } = {}) {
  if (requireOrigin && req.headers.origin !== origin) throw new RouteError('pedido-invalido', 403)
  const type = String(req.headers['content-type'] || '').toLowerCase()
  if (!/^application\/json(\s*;.*)?$/.test(type)) throw refuse('pedido-invalido')
}

// createAccountServer({ association, origin, google, store, issuer, log, now,
// moderation, googleMod, modEmails, triage, statsEmails, usage, panelDir,
// terms, groupCheck })
// -> { listen({ host, port }) -> Promise<{ host, port, close }> }.
// `google` is a createGoogle instance (tests inject a loopback fake),
// `store` an openAccountStore, `issuer` { keyPair, cert } or null
// (unconfigured: the link routes answer 503 'indisponivel'). The redirect
// URI is always origin + '/account/callback', never taken from a request.
// `moderation` (openModerationStore), `googleMod` (a createGoogle whose
// redirect URI is origin + '/account/mod/callback'), `modEmails` (the
// moderators' lowercase e-mails; empty disables the panel sign-in), `triage`
// (the AI report triage worker of ./ai/worker.js, or null when it is off),
// `statsEmails` (lowercase e-mails, a subset of `modEmails`, allowed to see
// the usage statistics), `usage` (a createUsageStats of ./usage-stats.js,
// or null when the stats tab is off), `groupCheck` (a createGroupCheck of
// ./group-check.js that confirms a group key at the seeder before a group
// block, or null: group blocks are then refused) and `panelDir` (tests only)
// are passed to ./mod-routes.js. `terms` is an openTermsStore (./terms-store.js), or
// null: the terms routes then answer 503 'indisponivel'.
function createAccountServer ({
  association,
  origin,
  google,
  store,
  issuer = null,
  log = () => {},
  now = Date.now,
  moderation = null,
  googleMod = null,
  modEmails = [],
  triage = null,
  statsEmails = [],
  usage = null,
  groupCheck = null,
  panelDir,
  terms = null,
  maxConnections = MAX_SOCKETS,
  ratePerSecond = DEFAULT_RATE,
  burst = DEFAULT_BURST
} = {}) {
  if (typeof association !== 'string' || !HEX64_RE.test(association)) throw new TypeError('association must be 64 lowercase hex characters')
  if (typeof origin !== 'string' || !(ORIGIN_RE.test(origin) || LOOPBACK_ORIGIN_RE.test(origin))) throw new TypeError('invalid origin')
  if (!google || typeof google.authorizeUrl !== 'function' || typeof google.exchange !== 'function') throw new TypeError('google ausente')
  if (!store || typeof store.start !== 'function') throw new TypeError('store ausente')
  if (issuer !== null && checkIssuerCert(issuer.cert, issuer.keyPair, association) !== null) {
    throw new TypeError('issuer certificate is for another association or key')
  }
  for (const [name, value] of [['maxConnections', maxConnections], ['ratePerSecond', ratePerSecond], ['burst', burst]]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer')
  }

  // Every keyed window is charged after a proof, on the member (or the
  // pending row) the proof named; see the note at the top of the file.
  const limits = {
    global: tokenBucket(ratePerSecond, burst, now),
    authorize: keyedWindow(5, 600 * 1000, now),
    finish: keyedWindow(10, 600 * 1000, now),
    renameFinish: keyedWindow(5, 600 * 1000, now),
    termsFinish: keyedWindow(5, 600 * 1000, now),
    callback: keyedWindow(3, COOKIE_MAX_AGE_S * 1000, now),
    lookup: fixedWindow(1200, 60 * 1000, now)
  }
  const over = () => new RouteError('pedido-invalido', 429)

  const mod = createModRoutes({
    association,
    origin,
    accounts: store,
    moderation,
    googleMod,
    modEmails,
    triage,
    statsEmails,
    usage,
    groupCheck,
    panelDir,
    log,
    now,
    http: { send, sendError, readJsonBody, checkPost: (req, opts) => checkPost(req, origin, opts), RouteError, refuse, fromStore, keyedWindow, fixedWindow, BASE_HEADERS }
  })

  // OAuth state -> pending id, written at authorize and deleted at the first
  // callback that presents it (single-use). One entry per pending row at
  // most (a row is authorized once), so the table is bounded by the store's
  // maxPending; expired entries are swept whenever one is added.
  const states = new Map()
  // Pending renames by nonce: { member, username, expiresAt }, in memory
  // only, single-use; at most MAX_RENAMES, the oldest evicted for room
  // (rename/start needs no proof, so it never refuses for a full table).
  const renames = new Map()
  // Pending terms acceptances by nonce: { member, version, expiresAt }, the
  // same rules as `renames` (terms/start needs no proof either).
  const termsNonces = new Map()

  function sweep (map) {
    const t = now()
    for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k)
  }

  function configured () {
    if (issuer === null) throw refuse('indisponivel')
  }

  function pendingRow (req) {
    const id = cookieId(req)
    if (id === null) throw refuse('expirado')
    const row = store.get(id)
    if (row === null) throw refuse('expirado')
    return row
  }

  function proof (fields, signature) {
    if (!verifyAccountLink(fields, signature).ok) throw refuse('assinatura-invalida')
  }

  async function start (req, res, body) {
    configured()
    const member = memberParam(body.member)
    const username = usernameParam(body.username)
    let row
    try {
      row = store.start({ member, username })
    } catch (err) {
      throw fromStore(err)
    }
    send(res, 200, { nonce: row.nonce }, { 'Set-Cookie': cookieHeader(row.id) })
  }

  async function authorize (req, res, body) {
    configured()
    const signature = signatureParam(body.signature)
    const row = pendingRow(req)
    // The reserve nonce is single-use: a row already reserved is not
    // authorized again (its state would otherwise be minted twice).
    if (row.phase !== 'reserve') throw refuse('assinatura-invalida')
    proof({ phase: 'reserve', nonce: row.nonce, member: row.member, username: row.username, association, sub: '' }, signature)
    if (!limits.authorize(row.member)) throw over()
    try {
      store.reserve(row.id)
    } catch (err) {
      throw fromStore(err)
    }
    sweep(states)
    states.set(row.state, { id: row.id, expiresAt: row.expiresAt })
    const authorizeUrl = google.authorizeUrl({ state: row.state, codeChallenge: codeChallenge(row.verifier) })
    send(res, 200, { authorizeUrl })
  }

  // The cookie id and the state must name the same live row BEFORE the
  // token endpoint is called; a mismatch sends the browser back with
  // ?conta=erro and nothing is exchanged (and charges no quota). Nothing
  // from Google (code, error, sub, e-mail) is ever put in the redirect.
  async function callback (req, res, url) {
    configured()
    const back = (outcome) => {
      log({ event: 'callback', reason: outcome })
      redirect(res, origin + '/?conta=' + outcome)
    }
    const id = cookieId(req)
    const state = url.searchParams.get('state')
    const entry = typeof state === 'string' && TOKEN_RE.test(state) ? states.get(state) : undefined
    if (id === null || entry === undefined || entry.id !== id) return back('erro')
    states.delete(state)
    const row = store.get(id)
    if (row === null || row.state !== state || row.phase !== 'finish') return back('erro')
    // A top-level navigation: answer with the page, not a JSON 429.
    if (!limits.callback(id)) return back('erro')
    const error = url.searchParams.get('error')
    if (error !== null) return back('cancelado')
    // Cap reached since start: refuse BEFORE the code is exchanged, so no
    // Google subject or e-mail is ever held for a link finish() would
    // refuse. The row goes and the cookie is cleared, as finish() does on
    // its own waitlist refusal (kept for a cap that fills after this point).
    // A key that is already linked is never a new member: its callback goes
    // on to finish(), whose same-account branch the cap does not touch.
    if (store.isFull() && !store.status(row.member).linked) {
      store.dropPending(id)
      log({ event: 'lista-de-espera' })
      return redirect(res, origin + '/?conta=lista-de-espera', { 'Set-Cookie': cookieHeader(id, 0) })
    }
    const code = url.searchParams.get('code')
    if (typeof code !== 'string' || !PARAM_RE.test(code)) return back('erro')
    const result = await google.exchange({ code, codeVerifier: row.verifier })
    if (!result.ok) return back('erro')
    try {
      store.putGoogle(id, { sub: result.sub, email: result.email })
    } catch {
      return back('erro')
    }
    back('ok')
  }

  async function pending (req, res) {
    configured()
    const row = pendingRow(req)
    const body = { nonce: row.nonce, member: row.member, username: row.username }
    if (typeof row.sub === 'string') body.sub = row.sub
    send(res, 200, body)
  }

  async function finish (req, res, body) {
    configured()
    const signature = signatureParam(body.signature)
    const row = pendingRow(req)
    if (typeof row.sub !== 'string') throw refuse('expirado')
    proof({ phase: 'finish', nonce: row.nonce, member: row.member, username: row.username, association, sub: row.sub }, signature)
    if (!limits.finish(row.member)) throw over()
    let result
    try {
      result = await store.finish(row.id, { signature }, issuer.keyPair, issuer.cert, association)
    } catch (err) {
      const routeErr = fromStore(err)
      // A waitlist refusal deleted the row too: clear the cookie as on
      // success, so a retry starts over instead of answering 'expirado'.
      if (routeErr.token === 'lista-de-espera') routeErr.headers = { 'Set-Cookie': cookieHeader(row.id, 0) }
      throw routeErr
    }
    log({ event: 'linked' })
    // The row is gone (C8): the cookie has nothing left to name.
    send(res, 200, result, { 'Set-Cookie': cookieHeader(row.id, 0) })
  }

  async function status (req, res, url) {
    if (!limits.lookup()) throw over()
    const member = memberParam(url.searchParams.get('member'))
    send(res, 200, store.status(member))
  }

  async function username (req, res, name) {
    if (!limits.lookup()) throw over()
    if (!isUsername(name)) throw refuse('nao-encontrado')
    const found = store.lookup(name)
    if (found === null) throw refuse('nao-encontrado')
    send(res, 200, found)
  }

  // The cooldown and the name are checked before any signature so the app
  // can tell the member at once; the store re-checks both at finish.
  async function renameStart (req, res, body) {
    configured()
    const member = memberParam(body.member)
    const name = usernameParam(body.username)
    const current = store.status(member)
    if (!current.linked) throw refuse('nao-encontrado')
    if (name !== current.username) {
      if (now() < Date.parse(current.nextChangeAt)) throw refuse('troca-bloqueada', { nextChangeAt: current.nextChangeAt })
      const holder = store.lookup(name)
      if (holder !== null && holder.member !== member) throw refuse('nome-em-uso')
    }
    sweep(renames)
    while (renames.size >= MAX_RENAMES) renames.delete(renames.keys().next().value)
    const nonce = base64url(nodeCrypto.randomBytes(32))
    renames.set(nonce, { member, username: name, expiresAt: now() + RENAME_TTL_MS })
    send(res, 200, { nonce })
  }

  async function renameFinish (req, res, body) {
    configured()
    const member = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' && TOKEN_RE.test(body.nonce) ? body.nonce : null
    const signature = signatureParam(body.signature)
    const row = nonce === null ? undefined : renames.get(nonce)
    // Single-use: the nonce is spent by its first finish, whatever the outcome.
    if (nonce !== null) renames.delete(nonce)
    if (row === undefined || row.member !== member || row.expiresAt <= now()) throw refuse('expirado')
    proof({ phase: 'rename', nonce, member, username: row.username, association, sub: '' }, signature)
    if (!limits.renameFinish(member)) throw over()
    let result
    try {
      result = await store.rename(member, row.username, issuer.keyPair, issuer.cert)
    } catch (err) {
      throw fromStore(err)
    }
    log({ event: 'renamed' })
    send(res, 200, { usernameRecord: result.record, nextChangeAt: result.nextChangeAt })
  }

  // The terms routes need no issuer (an unconfigured service still records
  // acceptances) and never the member cap: only an already linked member
  // can accept, and it is a member already. Links are never removed (the
  // store has no unlink op), so a link checked at start still holds.
  function termsAvailable () {
    if (terms === null || !terms.available()) throw refuse('indisponivel')
  }

  function linked (member) {
    if (!store.status(member).linked) throw refuse('nao-vinculado')
  }

  async function termsStart (req, res, body) {
    const member = memberParam(body.member)
    const version = body.version
    if (!Number.isSafeInteger(version) || version < 1 || version > TERMS_VERSION) throw refuse('pedido-invalido')
    termsAvailable()
    linked(member)
    sweep(termsNonces)
    while (termsNonces.size >= MAX_TERMS_NONCES) termsNonces.delete(termsNonces.keys().next().value)
    const nonce = base64url(nodeCrypto.randomBytes(32))
    termsNonces.set(nonce, { member, version, expiresAt: now() + TERMS_TTL_MS })
    send(res, 200, { nonce })
  }

  // Same order as renameFinish: the nonce is spent first, the per-member
  // window is charged only after the signature verified.
  async function termsFinish (req, res, body) {
    const member = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' && TOKEN_RE.test(body.nonce) ? body.nonce : null
    const signature = signatureParam(body.signature)
    const row = nonce === null ? undefined : termsNonces.get(nonce)
    if (nonce !== null) termsNonces.delete(nonce)
    if (row === undefined || row.member !== member || row.expiresAt <= now()) throw refuse('expirado')
    if (!verifyTerms({ nonce, member, association, version: row.version }, signature).ok) throw refuse('assinatura-invalida')
    if (!limits.termsFinish(member)) throw over()
    termsAvailable()
    linked(member)
    let result
    try {
      result = await terms.accept({ member, version: row.version, nonce, signature })
    } catch (err) {
      // Includes a guard that failed after the write (the lock was lost):
      // never acknowledged, 503 'indisponivel'.
      throw fromStore(err)
    }
    log({ event: 'terms', reason: result.changed ? 'novo' : 'repetido' })
    send(res, 200, { version: result.version, acceptedAt: result.acceptedAt })
  }

  const POST = {
    '/account/start': start,
    '/account/authorize': authorize,
    '/account/finish': finish,
    '/account/rename/start': renameStart,
    '/account/rename/finish': renameFinish,
    '/account/terms/start': termsStart,
    '/account/terms/finish': termsFinish
  }

  async function route (req, res, hostOk) {
    if (!hostOk(req)) {
      res.setHeader('Connection', 'close')
      throw new RouteError('pedido-invalido', 421)
    }
    let url
    try {
      url = new URL(req.url, 'http://' + DEFAULT_HOST)
    } catch {
      throw refuse('pedido-invalido')
    }
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === '/account/health') return send(res, 200, { status: 'ok' })
    if (!limits.global()) throw over()
    // Before the issuer-only routes: see the note at the top of the file.
    if (mod.owns(pathname)) return mod.handle(req, res, url)
    if (req.method === 'GET') {
      if (pathname === '/account/callback') return callback(req, res, url)
      if (pathname === '/account/pending') return pending(req, res)
      if (pathname === '/account/status') return status(req, res, url)
      if (pathname.startsWith('/account/username/')) return username(req, res, pathname.slice('/account/username/'.length))
      throw refuse('nao-encontrado')
    }
    if (req.method === 'POST' && Object.hasOwn(POST, pathname)) {
      checkPost(req, origin)
      const body = await readJsonBody(req)
      return POST[pathname](req, res, body)
    }
    throw refuse('nao-encontrado')
  }

  function listen ({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
    if (host === '0.0.0.0' || host === '::') throw new Error('account-host inválido')
    let hosts = new Set()
    const hostOk = (req) => typeof req.headers.host === 'string' && hosts.has(req.headers.host.toLowerCase())
    const server = http.createServer({ connectionsCheckingInterval: CHECK_INTERVAL_MS }, (req, res) => {
      route(req, res, hostOk).then(() => {
        req.resume()
      }, (err) => {
        req.resume()
        const routeErr = err instanceof RouteError ? err : refuse('indisponivel')
        // A waitlist answer is logged as its event alone (nothing about who).
        if (routeErr.token === 'lista-de-espera') log({ event: 'lista-de-espera' })
        else if (routeErr.token !== 'nao-encontrado') log({ event: 'refused', reason: routeErr.token })
        if (res.headersSent) return res.destroy()
        if (routeErr.status === 413) {
          // The rest of an oversized body is never read: the socket goes
          // once the refusal is flushed.
          res.setHeader('Connection', 'close')
          res.once('finish', () => req.socket.destroy())
        }
        sendError(res, routeErr, routeErr.headers)
      })
    })
    server.maxConnections = maxConnections
    server.headersTimeout = HEADERS_TIMEOUT_MS
    server.requestTimeout = REQUEST_TIMEOUT_MS

    let closing = null
    const close = () => {
      if (closing) return closing
      closing = new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      return closing
    }

    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        server.on('error', () => {})
        const address = server.address()
        hosts = new Set([authority(address.address, address.port).toLowerCase(), authority(host, address.port).toLowerCase()])
        resolve({ host: address.address, port: address.port, close })
      })
    })
  }

  // modStats: table sizes of the moderation desk (counts only, never a
  // nonce), so tests can show that unauthenticated traffic grows nothing.
  return { listen, modStats: () => mod.stats() }
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_SOCKETS,
  DEFAULT_RATE,
  DEFAULT_BURST,
  KEY_FILE,
  CERT_FILE,
  LOCK_FILE,
  LOCK_HEARTBEAT_MS,
  LOCK_STALE_MS,
  COOKIE,
  ORIGIN_RE,
  LOOPBACK_ORIGIN_RE,
  ERROR_STATUS,
  createAccountServer,
  keyedWindow,
  loadIssuer,
  checkIssuerCert,
  takeLock,
  lockHeld
}
