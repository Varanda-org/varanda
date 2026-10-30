'use strict'

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const { isUsername, verifyAccountLink } = require('@varanda/core/lib/account-link')
const { TERMS_VERSION, verifyTerms } = require('@varanda/core/lib/terms')
const { verifyInvite } = require('@varanda/core/lib/invite')
const { loadKeyPairFile, verifyIssuerCert, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { createModRoutes } = require('./mod-routes')
const { inviteId, CODE_RE } = require('./invites-store')
const { createPushRoutes } = require('./push-routes')
const { createAgeRoutes } = require('./age-routes')
const { LINK_HEADER, REDEEM_HEADER, isAppRequest, isAppProof, proofOf, safeEqual, mintRedeem, redeemMatches, accountReturnUrl, header } = require('./app-return')

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
const MAX_APP_STATES = 10000
const APP_SWEEP_MS = 1000
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
  'ja-revertido': 409,
  // Sign-up invites (./invites-store.js): one public token for an unknown,
  // used, expired or held code.
  'convite-obrigatorio': 403,
  'convite-invalido': 404,
  'limite-convites': 429,
  // Web Push (./push-routes.js): turning notices on needs the current terms.
  'termos-pendentes': 409,
  // Hosted age verification (./age-routes.js): no certificate, rename or
  // invite for a key whose age band is not on record.
  'idade-pendente': 403,
  'limite-idade': 429,
  // The age routes could not tell whether something was applied (the provider
  // timed out after maybe creating a session, a write that may have landed):
  // unlike 'indisponivel', the app must not read this as a plain refusal.
  'resultado-incerto': 503
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
// The native app's fetch may send no Origin at all: an absent Origin passes
// only with the custom x-varanda-client: app header, which a cross-site page
// can no more send without a preflight than the JSON type. A present Origin
// (including 'null') must still match exactly.
function checkPost (req, origin, { requireOrigin = true } = {}) {
  if (requireOrigin && req.headers.origin !== origin && !(req.headers.origin === undefined && isAppRequest(req))) throw new RouteError('pedido-invalido', 403)
  const type = String(req.headers['content-type'] || '').toLowerCase()
  if (!/^application\/json(\s*;.*)?$/.test(type)) throw refuse('pedido-invalido')
}

// createAccountServer({ association, origin, google, store, issuer, log, now,
// moderation, googleMod, modEmails, triage, statsEmails, usage, panelDir,
// terms, invites })
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
// or null when the stats tab is off) and `panelDir` (tests only) are passed
// to ./mod-routes.js. `terms` is an openTermsStore (./terms-store.js), or
// null: the terms routes then answer 503 'indisponivel'. `invites` is an
// openInvitesStore (./invites-store.js) or null: null is open sign-up (the
// policy route answers { required: false }, the two POST invite routes are
// 404 and start ignores `invite`); otherwise every new link needs a
// usable invite code, held in memory from start to finish. `push` is null
// (the push routes and /push-event are not mounted at all) or the options of
// ./push-routes.js { pushStore, vapid, send, relayTokenHash }. `didit` (a
// createDidit of ./didit.js) and `ages` (an openAgeStore of ./age-store.js)
// turn on hosted age verification when both are set: authorize, finish,
// rename/start and invites/start then refuse 'idade-pendente' until the
// member's band is on record. Either null keeps today's behaviour and the
// age policy route answers { required: false }. `ageDailyLimit` caps the
// paid Didit sessions opened per day across all members.
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
  panelDir,
  terms = null,
  invites = null,
  push = null,
  didit = null,
  ages = null,
  ageDailyLimit = 200,
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
    invitesFinish: keyedWindow(10, 600 * 1000, now),
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
    panelDir,
    log,
    now,
    http: { send, sendError, readJsonBody, checkPost: (req, opts) => checkPost(req, origin, opts), RouteError, refuse, fromStore, keyedWindow, fixedWindow, BASE_HEADERS }
  })

  const pushRoutes = push === null
    ? null
    : createPushRoutes({
      ...push,
      association,
      accounts: store,
      terms,
      log,
      now,
      http: { send, sendError, readJsonBody, checkPost: (req, opts) => checkPost(req, origin, opts), RouteError, refuse, fromStore, keyedWindow }
    })

  // Always mounted, so /account/age/policy answers even when the feature is off.
  const ageRoutes = createAgeRoutes({
    didit,
    ages,
    association,
    origin,
    store,
    invites,
    inviting: invites !== null,
    log,
    now,
    dailyLimit: ageDailyLimit,
    http: { send, sendError, redirect, readJsonBody, checkPost: (req, opts) => checkPost(req, origin, opts), RouteError, refuse, fromStore, keyedWindow, fixedWindow }
  })

  // With age verification on, no key without a band on record gets a Google
  // sign-in, a certificate, a rename or an invite. Off, it never refuses.
  function ageChecked (member) {
    if (ageRoutes.required() && !ageRoutes.verified(member)) throw refuse('idade-pendente')
  }

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
  // Invite issue requests by nonce: { member, expiresAt }, the same rules.
  const inviteNonces = new Map()
  // Sign-up invite reservations: invite id -> { pendingId, expiresAt }. In
  // memory beside the pending rows, which are memory-only too, so a
  // reservation never outlives its row across a restart.
  const inviting = invites !== null
  const held = new Map()
  // Pending ids with a finish in progress: never dropped meanwhile.
  const finishing = new Set()
  // Native app rows (./app-return.js, RFC 8252): the system browser that
  // runs the Google step shares no cookie jar with the app, so an app row
  // gets no cookie. Pending id -> { proof, expiresAt, redeem, google }:
  // `proof` is base64url(sha256(V)) from start, `redeem` the hash of the
  // one-time code R minted by the callback (null before it and once spent),
  // `google` the exchange result held until R is presented. Plus
  // appProof -> pending id. Memory only beside the rows, pruned with them.
  //
  // Why both secrets: anyone who completes the authorizeUrl at Google sends
  // the redirect carrying R to THEIR device, so an initiator who shares the
  // link holds V but never sees R; another app on the device that claims
  // the varanda:// scheme receives R but never V, which stays in the app's
  // memory. pending and finish need both.
  const apps = new Map()
  const appByProof = new Map()
  // OAuth states ever minted for an app row: state -> expiresAt. A callback
  // for one that is no longer live (its row superseded, taken over, expired
  // or done) still returns to varanda://conta?conta=erro, never to the
  // website. Expiring, at most MAX_APP_STATES (the oldest evicted for room).
  const appStates = new Map()

  function sweep (map) {
    const t = now()
    for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k)
  }

  function configured () {
    if (issuer === null) throw refuse('indisponivel')
  }

  function pendingRow (req) {
    if (header(req, LINK_HEADER) !== null) return appRow(req)
    const id = cookieId(req)
    if (id === null) throw refuse('expirado')
    // An app row is never named by a cookie, only by V.
    if (apps.has(id)) throw refuse('expirado')
    const row = store.get(id)
    if (row === null) throw refuse('expirado')
    return row
  }

  // The appProof that the request's V proves, or null.
  function linkProof (req) {
    const link = header(req, LINK_HEADER)
    return link === null ? null : proofOf(link)
  }

  // True when `proof` (from V) is the appProof of the app row `id`.
  function appOwns (id, proof) {
    const entry = apps.get(id)
    return proof !== null && entry !== undefined && safeEqual(proof, entry.proof)
  }

  // Also kills the row's live OAuth state, so a Google page opened for a
  // superseded row can never complete.
  function forgetApp (id) {
    const entry = apps.get(id)
    if (entry === undefined) return
    apps.delete(id)
    if (appByProof.get(entry.proof) === id) appByProof.delete(entry.proof)
    if (states.get(entry.state)?.id === id) states.delete(entry.state)
  }

  function rememberAppState (state, expiresAt) {
    sweep(appStates)
    while (appStates.size >= MAX_APP_STATES) appStates.delete(appStates.keys().next().value)
    appStates.set(state, { expiresAt })
  }

  // The store expires and evicts rows on its own without telling this file,
  // so every request (at most once per APP_SWEEP_MS) drops the entries, and
  // any Google answer they hold, whose row is gone.
  let appSweptAt = -Infinity
  function sweepApps () {
    const t = now()
    appSweptAt = t
    for (const [id, entry] of apps) if (entry.expiresAt <= t || store.get(id) === null) forgetApp(id)
  }

  // The map is keyed by sha256(V), whose timing says nothing about V; the
  // comparison that grants the row is constant time.
  function appRow (req) {
    const proof = linkProof(req)
    const id = proof === null ? undefined : appByProof.get(proof)
    if (id === undefined || !appOwns(id, proof)) throw refuse('expirado')
    const row = store.get(id)
    if (row === null) {
      forgetApp(id)
      throw refuse('expirado')
    }
    return row
  }

  // An app row past the callback also needs R (x-varanda-redeem); `spend`
  // (finish) makes it single use whatever the outcome. The Google identity
  // is bound to the row only here, so a callback completed by someone else
  // writes nothing under their subject until the code is redeemed.
  function redeemed (req, row, spend) {
    const entry = apps.get(row.id)
    if (entry === undefined || entry.redeem === null || !redeemMatches(header(req, REDEEM_HEADER), entry.redeem)) throw refuse('expirado')
    if (spend) entry.redeem = null
    if (entry.google === null) return row
    const google = entry.google
    entry.google = null
    try {
      return store.putGoogle(row.id, google)
    } catch (err) {
      throw fromStore(err)
    } finally {
      // putGoogle may have dropped this subject's other rows for its cap.
      sweepApps()
    }
  }

  // The cookie clearing of the web flow; an app row never had a cookie.
  function clearCookie (row) {
    return apps.has(row.id) ? undefined : { 'Set-Cookie': cookieHeader(row.id, 0) }
  }

  function proof (fields, signature) {
    if (!verifyAccountLink(fields, signature).ok) throw refuse('assinatura-invalida')
  }

  // Usable = known, unused and unexpired in the sidecar AND held by no link
  // in the directory (the authority on single use). -> null or the token.
  // Throws 'indisponivel' when the sidecar is unavailable.
  function inviteRefusal (id) {
    if (!invites.available()) throw refuse('indisponivel')
    let why
    try {
      why = invites.check(id)
    } catch (err) {
      throw fromStore(err)
    }
    if (why !== null || store.inviteUsed(id)) return 'convite-invalido'
    return null
  }

  // Deletes the reservation of `row` (if it still names that row).
  function release (row) {
    if (!inviting || row.invite === null || row.invite === undefined) return
    const entry = held.get(row.invite)
    if (entry !== undefined && entry.pendingId === row.id) held.delete(row.invite)
  }

  // -> { id, takeover } for start, or throws. A reservation whose row is
  // gone is stale; one held by the same member (a retry) is taken over by
  // the caller only once the new row exists; a live row of another member,
  // or one with a finish in flight, keeps it. `cookie` is the link cookie
  // of the request (or null), `proof` the appProof its V proves (or null).
  function reserveInvite (member, code, cookie, proof) {
    if (typeof code !== 'string') throw refuse('convite-obrigatorio')
    if (!CODE_RE.test(code)) throw refuse('convite-invalido')
    const id = inviteId(code)
    if (inviteRefusal(id) !== null) throw refuse('convite-invalido')
    sweep(held)
    const entry = held.get(id)
    if (entry === undefined) return { id, takeover: null }
    const old = store.get(entry.pendingId)
    if (old === null) {
      held.delete(id)
      return { id, takeover: null }
    }
    if (old.member !== member || finishing.has(old.id)) throw refuse('convite-invalido')
    // start is unsigned: without more it may replace only a bare row, never
    // one past the signed authorize or the Google callback. The link cookie
    // naming that very row is the bearer proof of owning it (an outsider
    // with only the code and the public key has no cookie), so its own
    // browser may start over, for instance with another Google account.
    // For an app row, V is that bearer proof.
    const owner = cookie === old.id || appOwns(old.id, proof)
    if (!owner && (old.phase !== 'reserve' || typeof old.sub === 'string')) throw refuse('convite-invalido')
    return { id, takeover: old.id }
  }

  async function start (req, res, body) {
    configured()
    const member = memberParam(body.member)
    const username = usernameParam(body.username)
    const app = isAppRequest(req)
    const proof = app ? linkProof(req) : null
    if (app) {
      if (!isAppProof(body.appProof)) throw refuse('pedido-invalido')
      sweepApps()
      // A live row already answers to this appProof: only the holder of its
      // V may start over with it.
      if (appByProof.has(body.appProof) && !safeEqual(proof ?? '', body.appProof)) throw refuse('pedido-invalido')
    }
    // The live app row the request's V owns: starting over abandons it.
    const ownedId = proof === null ? undefined : appByProof.get(proof)
    const superseded = ownedId !== undefined && appOwns(ownedId, proof) ? ownedId : null
    let reserved = null
    if (inviting) {
      // A linked key never reaches the sidecar: store.start refuses it.
      if (store.status(member).linked) throw refuse('conta-vinculada')
      if (!invites.available()) throw refuse('indisponivel')
      reserved = reserveInvite(member, body.invite, cookieId(req), proof)
    }
    let row
    try {
      row = inviting ? store.start({ member, username, invite: reserved.id }) : store.start({ member, username })
    } catch (err) {
      // The previous row and its reservation stay as they were.
      throw fromStore(err)
    }
    if (inviting) {
      const old = reserved.takeover
      if (old !== null && !finishing.has(old)) {
        store.dropPending(old)
        forgetApp(old)
      }
      held.set(reserved.id, { pendingId: row.id, expiresAt: row.expiresAt })
    }
    if (superseded !== null) {
      // Its Google page dies with it (forgetApp drops the state), so a late
      // completion of the old page cannot bind an identity no V can redeem.
      const old = store.get(superseded)
      if (old !== null && !finishing.has(superseded)) {
        release(old)
        store.dropPending(superseded)
      }
      forgetApp(superseded)
    }
    if (app) {
      apps.set(row.id, { proof: body.appProof, state: row.state, expiresAt: row.expiresAt, redeem: null, google: null })
      appByProof.set(body.appProof, row.id)
      return send(res, 200, { nonce: row.nonce })
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
    // Before reserve: the row stays in 'reserve', so the same row can be
    // authorized once the member has verified.
    ageChecked(row.member)
    if (!limits.authorize(row.member)) throw over()
    try {
      store.reserve(row.id)
    } catch (err) {
      throw fromStore(err)
    }
    sweep(states)
    states.set(row.state, { id: row.id, expiresAt: row.expiresAt })
    if (apps.has(row.id)) rememberAppState(row.state, row.expiresAt + COOKIE_MAX_AGE_S * 1000)
    const authorizeUrl = google.authorizeUrl({ state: row.state, codeChallenge: codeChallenge(row.verifier) })
    send(res, 200, { authorizeUrl })
  }

  // The cookie id and the state must name the same live row BEFORE the
  // token endpoint is called; a mismatch sends the browser back with
  // ?conta=erro and nothing is exchanged (and charges no quota). Nothing
  // from Google (code, error, sub, e-mail) is ever put in the redirect.
  // An app row has no cookie: the single-use state alone names it, every
  // outcome returns to varanda://conta, and 'ok' carries the redeem code R
  // instead of binding the Google answer to the row (see `apps`).
  async function callback (req, res, url) {
    configured()
    const state = url.searchParams.get('state')
    const entry = typeof state === 'string' && TOKEN_RE.test(state) ? states.get(state) : undefined
    const known = entry !== undefined && apps.has(entry.id)
    // A dead app state (superseded, taken over, expired, spent) names no row
    // but still returns to the app, with 'erro' and no code.
    const app = known || (entry === undefined && typeof state === 'string' && TOKEN_RE.test(state) && appStates.get(state)?.expiresAt > now())
    const to = (outcome) => (app ? accountReturnUrl(outcome) : origin + '/?conta=' + outcome)
    const clear = (id) => (app ? {} : { 'Set-Cookie': cookieHeader(id, 0) })
    const back = (outcome) => {
      log({ event: 'callback', reason: outcome })
      redirect(res, to(outcome))
    }
    const id = known ? entry.id : app ? null : cookieId(req)
    if (id === null || entry === undefined || entry.id !== id) return back('erro')
    states.delete(state)
    const row = store.get(id)
    if (row === null || row.state !== state || row.phase !== 'finish') {
      if (app) forgetApp(id)
      return back('erro')
    }
    // From here every exit short of putGoogle frees the row's invite, so a
    // fresh start can take the code.
    const out = (outcome) => {
      release(row)
      return back(outcome)
    }
    // A top-level navigation: answer with the page, not a JSON 429.
    if (!limits.callback(id)) return out('erro')
    const error = url.searchParams.get('error')
    if (error !== null) return out('cancelado')
    // Cap reached since start: refuse BEFORE the code is exchanged, so no
    // Google subject or e-mail is ever held for a link finish() would
    // refuse. The row goes and the cookie is cleared, as finish() does on
    // its own waitlist refusal (kept for a cap that fills after this point).
    // A key that is already linked is never a new member: its callback goes
    // on to finish(), whose same-account branch the cap does not touch.
    if (store.isFull() && !store.status(row.member).linked) {
      release(row)
      store.dropPending(id)
      forgetApp(id)
      log({ event: 'lista-de-espera' })
      return redirect(res, to('lista-de-espera'), clear(id))
    }
    // Invite-only: a new member reaches the token exchange only with a live
    // reservation on a usable code, so nothing from Google is collected for
    // a link finish() would refuse.
    if (inviting && !store.status(row.member).linked) {
      let why
      if (row.invite === null) why = 'convite-obrigatorio'
      else if (held.get(row.invite)?.pendingId !== id) why = 'convite-invalido'
      else {
        try {
          why = inviteRefusal(row.invite)
        } catch {
          why = 'indisponivel'
        }
      }
      if (why !== null) {
        release(row)
        store.dropPending(id)
        forgetApp(id)
        log({ event: 'convite', reason: why })
        const outcome = why === 'indisponivel' ? 'erro' : 'convite-invalido'
        return redirect(res, to(outcome), clear(id))
      }
    }
    const code = url.searchParams.get('code')
    if (typeof code !== 'string' || !PARAM_RE.test(code)) return out('erro')
    const result = await google.exchange({ code, codeVerifier: row.verifier })
    if (!result.ok) return out('erro')
    if (app) {
      const pendingApp = apps.get(id)
      // The store may have expired or evicted the row during the exchange (an
      // app row is unproven until Google answers): a code no V could redeem is
      // never handed out, and the Google answer is not kept.
      if (pendingApp === undefined || store.get(id) === null) {
        forgetApp(id)
        return out('erro')
      }
      const redeem = mintRedeem()
      pendingApp.google = { sub: result.sub, email: result.email }
      pendingApp.redeem = redeem.hash
      // Keeps a start flood from evicting the row while the person returns
      // to the app; the sub itself still waits here for R. The subject's
      // MAX_PER_SUB cap may drop its older rows: their app state goes too.
      for (const old of store.markAnswered(id, result.sub) || []) forgetApp(old)
      log({ event: 'callback', reason: 'ok' })
      return redirect(res, accountReturnUrl('ok', redeem.code))
    }
    try {
      store.putGoogle(id, { sub: result.sub, email: result.email })
    } catch {
      return out('erro')
    }
    back('ok')
  }

  async function pending (req, res) {
    configured()
    let row = pendingRow(req)
    if (apps.has(row.id)) row = redeemed(req, row, false)
    const body = { nonce: row.nonce, member: row.member, username: row.username }
    if (typeof row.sub === 'string') body.sub = row.sub
    send(res, 200, body)
  }

  async function finish (req, res, body) {
    configured()
    const signature = signatureParam(body.signature)
    let row = pendingRow(req)
    if (apps.has(row.id)) row = redeemed(req, row, true)
    if (typeof row.sub !== 'string') throw refuse('expirado')
    proof({ phase: 'finish', nonce: row.nonce, member: row.member, username: row.username, association, sub: row.sub }, signature)
    if (!limits.finish(row.member)) throw over()
    ageChecked(row.member)
    if (!inviting) return finishRow(res, row, signature, false)
    // The same answer store.finish gives once the first finish removed the row.
    if (finishing.has(row.id)) throw refuse('expirado')
    finishing.add(row.id)
    try {
      await finishInvited(res, row, signature)
    } finally {
      finishing.delete(row.id)
      // A row that survived the refusal keeps its code, so a retry works.
      if (store.get(row.id) === null) release(row)
    }
  }

  // Invite-only finish. An e-mail update, an already linked key or sub, a
  // full cap and a name held by another member are store.finish's own
  // answers and need no invite. A new link needs the reservation on a
  // usable code; store.finish then refuses atomically, inside its queue, an
  // invite another link took meanwhile and records it on the link, and only
  // after the link is on disk is the sidecar marked. A refusal never marks
  // it, so the invite stays usable. A failed mark does not undo the link:
  // the sidecar heals through isUsed (the directory is the authority).
  async function finishInvited (res, row, signature) {
    const holder = store.lookup(row.username)
    const known = store.memberForSub(row.sub) !== null || store.status(row.member).linked
    const plain = known || store.isFull() || (holder !== null && holder.member !== row.member)
    if (!plain) {
      const entry = row.invite === null ? undefined : held.get(row.invite)
      const why = entry === undefined || entry.pendingId !== row.id ? 'convite-invalido' : inviteRefusal(row.invite)
      if (why !== null) {
        store.dropPending(row.id)
        log({ event: 'convite', reason: why })
        const err = refuse('convite-invalido')
        err.headers = clearCookie(row)
        forgetApp(row.id)
        throw err
      }
    }
    await finishRow(res, row, signature, true)
  }

  // `mark`: the sidecar is marked only when the directory recorded this
  // row's invite on a link. The classification above runs outside the store
  // queue, so an overlapping finish may turn this one into an e-mail update
  // that records no invite.
  async function finishRow (res, row, signature, mark) {
    const clear = clearCookie(row)
    let result
    try {
      result = await store.finish(row.id, { signature }, issuer.keyPair, issuer.cert, association)
    } catch (err) {
      const routeErr = fromStore(err)
      // A row whose name or key is taken can never produce this link, and
      // keeping it would hold the invite until it expires. The refused
      // finish is signed, so dropping a proven row here is safe; the caller
      // then releases the reservation and the code works at once.
      const taken = mark && row.invite !== null && row.invite !== undefined && (routeErr.token === 'nome-em-uso' || routeErr.token === 'conta-vinculada')
      if (taken) store.dropPending(row.id)
      // A waitlist or invite refusal deleted the row too: clear the cookie
      // as on success, so a retry starts over instead of answering 'expirado'.
      if (taken || routeErr.token === 'lista-de-espera' || routeErr.token === 'convite-invalido') routeErr.headers = clear
      throw routeErr
    }
    forgetApp(row.id)
    log({ event: 'linked' })
    if (mark && row.invite !== null && store.inviteUsed(row.invite)) {
      try {
        await invites.consume(row.invite)
        log({ event: 'convite', reason: 'usado' })
      } catch {
        log({ event: 'convite', reason: 'marca-falhou' })
      }
    }
    // The row is gone (C8): the cookie has nothing left to name.
    send(res, 200, result, clear)
  }

  async function status (req, res, url) {
    if (!limits.lookup()) throw over()
    const member = memberParam(url.searchParams.get('member'))
    // Member keys are public: the weekly invite counts reach a member only
    // in the signed /account/invites/finish answer, never here.
    send(res, 200, store.status(member))
  }

  // Exact keys: the app decides from `required` alone whether start needs a
  // code, even while the sidecar is unavailable.
  async function invitesPolicy (req, res) {
    if (!limits.lookup()) throw over()
    send(res, 200, inviting ? { required: true, perWeek: invites.perWeek } : { required: false })
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
    // The age gate waits for the signed finish: this unsigned answer must not
    // tell anyone whether a given key passed the age check.
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
    ageChecked(member)
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

  function invitesAvailable () {
    if (!inviting || !invites.available()) throw refuse('indisponivel')
  }

  // Issue routes: the terms pattern. Every linked member may issue, the
  // operator included; the code is only ever in this response.
  async function invitesStart (req, res, body) {
    const member = memberParam(body.member)
    invitesAvailable()
    linked(member)
    // The age gate waits for the signed finish (see renameStart).
    sweep(inviteNonces)
    while (inviteNonces.size >= MAX_TERMS_NONCES) inviteNonces.delete(inviteNonces.keys().next().value)
    const nonce = base64url(nodeCrypto.randomBytes(32))
    inviteNonces.set(nonce, { member, expiresAt: now() + TERMS_TTL_MS })
    send(res, 200, { nonce })
  }

  async function invitesFinish (req, res, body) {
    const member = memberParam(body.member)
    const nonce = typeof body.nonce === 'string' && TOKEN_RE.test(body.nonce) ? body.nonce : null
    const signature = signatureParam(body.signature)
    const row = nonce === null ? undefined : inviteNonces.get(nonce)
    if (nonce !== null) inviteNonces.delete(nonce)
    if (row === undefined || row.member !== member || row.expiresAt <= now()) throw refuse('expirado')
    if (!verifyInvite({ action: 'issue', nonce, member, association }, signature).ok) throw refuse('assinatura-invalida')
    ageChecked(member)
    if (!limits.invitesFinish(member)) throw over()
    invitesAvailable()
    linked(member)
    let result
    try {
      result = await invites.issue(member)
    } catch (err) {
      throw fromStore(err)
    }
    log({ event: 'convite', reason: 'emitido' })
    send(res, 200, { code: result.code, expiresAt: result.expiresAt, used: result.used, remaining: result.remaining, resetsAt: result.resetsAt })
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
  // Open sign-up has no POST invite routes; the policy route still answers.
  if (inviting) {
    POST['/account/invites/start'] = invitesStart
    POST['/account/invites/finish'] = invitesFinish
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
    // The seeder's relay never spends the browsers' global bucket; its own
    // token, dedupe and caps bound it (./push-routes.js).
    if (pushRoutes !== null && pathname === '/push-event') return pushRoutes.handleRelay(req, res)
    if (!limits.global()) throw over()
    if (now() - appSweptAt >= APP_SWEEP_MS) sweepApps()
    // Before the issuer-only routes: see the note at the top of the file.
    if (mod.owns(pathname)) return mod.handle(req, res, url)
    if (pushRoutes !== null && pushRoutes.owns(pathname)) return pushRoutes.handle(req, res, url)
    if (ageRoutes.owns(pathname)) return ageRoutes.handle(req, res, url)
    if (req.method === 'GET') {
      if (pathname === '/account/callback') return callback(req, res, url)
      if (pathname === '/account/pending') return pending(req, res)
      if (pathname === '/account/status') return status(req, res, url)
      if (pathname === '/account/invites/policy') return invitesPolicy(req, res)
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
  // appStats: counts of app rows and of those holding a Google answer.
  return { listen, modStats: () => mod.stats(), pushStats: () => (pushRoutes === null ? null : pushRoutes.stats()), ageStats: () => ageRoutes.stats(), appStats: () => ({ rows: apps.size, google: [...apps.values()].filter((e) => e.google !== null).length }) }
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
