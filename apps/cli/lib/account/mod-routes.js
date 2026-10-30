'use strict'

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { verifyReport } = require('@varanda/core/lib/report')
const { verifyModeratorCert } = require('@varanda/core/lib/cert')
const { canonicalBody, verifyModRequest } = require('@varanda/core/lib/mod-request')
const { MAX_REPORTS, AI_ACTOR } = require('./moderation-store')

// The moderation desk of the account service (mounted by ./server.js before
// any issuer-only route, so it works on an unconfigured service):
//
//   - member reports (POST /account/report/start, POST /account/report): no
//     cookie, the reporter's key proof over a single-use nonce is the
//     authority (packages/core/lib/report.js); only a member linked to a
//     Google account may report, so every report has an accountable author.
//   - the moderators' panel: Google sign-in on the server (PKCE, the same
//     google.js as the link flow, its own redirect URI), an in-memory
//     session cookie `__Host-varanda-mod` for e-mails in
//     VARANDA_MODERATOR_EMAILS only, a small JSON API and three static
//     assets read once at start by literal path. Sessions live in memory: a
//     restart signs every moderator out.
//   - the operator's `mod apply` (api/challenge, api/pull, api/ack): no
//     cookie and no Origin rule; a signature by the association-certified
//     moderator key over a single-use server nonce, bound to this origin and
//     the exact body (packages/core/lib/mod-request.js), is the authority.
//
// Every server.js rule holds here: { error: token } bodies, no CORS, the
// browser POST rules (exact Origin + JSON) on every cookie route, which with
// SameSite=Lax cookies is the CSRF defence, and logs that only ever carry
// { event, reason } tokens: never an e-mail, Google sub, code, nonce,
// signature, note or report text. Members are shown to moderators by key
// and @username only; e-mails and subs never leave this module except as
// the signed-in moderator's own e-mail in api/me (the deciding moderator's
// e-mail stays in moderation.json and `account reports`).
//   - the stats tab (api/stats): for e-mails in VARANDA_STATS_EMAILS, a
//     subset of VARANDA_MODERATOR_EMAILS (anyone else in it is ignored), an
//     anonymous usage view from ./usage-stats.js; counts only, never a key,
//     e-mail, sub, username or address.

const LOGIN_COOKIE = '__Host-varanda-mod-login'
const SESSION_COOKIE = '__Host-varanda-mod'
const LOGIN_TTL_MS = 600 * 1000
const SESSION_TTL_MS = 8 * 3600 * 1000
const MAX_SESSIONS = 100
// The sealed login cookie (see `sealLogin`): plaintext expiry (8 bytes) ||
// login id (16) || state (32) || PKCE verifier (32) = 88 bytes, sealed with
// AES-256-GCM as iv (12) || ciphertext (88) || tag (16) = 116 bytes, 155
// base64url characters. Fixed length, so the cookie is size-bounded.
const LOGIN_AAD = Buffer.from('varanda-mod-login-v1')
const LOGIN_PLAIN_BYTES = 88
const LOGIN_IV_BYTES = 12
const LOGIN_TAG_BYTES = 16
const LOGIN_SEALED_BYTES = LOGIN_IV_BYTES + LOGIN_PLAIN_BYTES + LOGIN_TAG_BYTES
const LOGIN_COOKIE_RE = /^[A-Za-z0-9_-]{155}$/
const REPORT_NONCE_TTL_MS = 600 * 1000
const CHALLENGE_TTL_MS = 120 * 1000
// Nonce domains: a report nonce can never stand in for an operator
// challenge, nor the reverse.
const REPORT_NONCE_DOMAIN = 'varanda-report-nonce'
const CHALLENGE_DOMAIN = 'varanda-mod-challenge'
// expiry (8 bytes) || random (16) || truncated HMAC-SHA256 (16) = 40 bytes,
// 54 base64url characters: inside the NONCE_RE of report.js and
// mod-request.js (/^[A-Za-z0-9_-]{43,128}$/).
const NONCE_RAW_BYTES = 40
const NONCE_STR_RE = /^[A-Za-z0-9_-]{54}$/
const NONCE_MAC_BYTES = 16
// Rows of api/reports per answer (moderation-store.js LIST_DEFAULT).
const REPORTS_PAGE = 100
const REPORT_BODY_MAX = 8192
// A legal snapshot is at most 393216 bytes (blocklist.js MAX_SNAPSHOT_BYTES)
// plus at most 4096 change ids (mod-request.js MAX_CHANGE_IDS).
const ACK_BODY_MAX = 524288
const HEX64_RE = /^[0-9a-f]{64}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
// Report and change ids (moderation-store.js newId: 16 bytes base64url).
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
// Google authorization codes: printable ASCII, bounded (as server.js).
const PARAM_RE = /^[\x21-\x7e]{1,512}$/
const MOD_EMAIL_RE = /^[^\s,@]{1,64}@[^\s,@]{1,255}$/
const MAX_MOD_EMAILS = 32

const PANEL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
const ASSETS = Object.freeze({
  '/account/mod/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/account/mod/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/account/mod/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' }
})

function randomToken () {
  return nodeCrypto.randomBytes(32).toString('base64url')
}

function codeChallenge (verifier) {
  return nodeCrypto.createHash('sha256').update(verifier).digest('base64url')
}

// VARANDA_MODERATOR_EMAILS -> a sorted, de-duplicated array of lowercase
// e-mails ([] = panel sign-in disabled); null when the value is malformed.
// The value itself is never echoed.
function parseModEmails (value) {
  if (value === undefined || value === null) return []
  if (typeof value !== 'string') return null
  const out = new Set()
  for (const part of value.split(',')) {
    const email = part.trim().toLowerCase()
    if (email === '') continue
    if (!MOD_EMAIL_RE.test(email)) return null
    out.add(email)
  }
  if (out.size > MAX_MOD_EMAILS) return null
  return [...out].sort()
}

// The bytes of each asset, read once by literal name (no filesystem path is
// ever derived from a request); a missing file is simply not served.
function loadAssets (dir) {
  const out = new Map()
  for (const [route, { file, type }] of Object.entries(ASSETS)) {
    try {
      const st = fs.lstatSync(path.join(dir, file))
      if (!st.isFile()) continue
      out.set(route, { body: fs.readFileSync(path.join(dir, file)), type })
    } catch {}
  }
  return out
}

// The value of cookie `name` when it matches `re` (by default a 32-byte
// base64url token), else null. Names are compared exactly, so neither the
// link cookie nor the login cookie is ever read as a session.
function cookieValue (req, name, re = TOKEN_RE) {
  const header = req.headers.cookie
  if (typeof header !== 'string' || header.length > 4096) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    const value = part.slice(eq + 1).trim()
    return re.test(value) ? value : null
  }
  return null
}

function setCookie (name, value, maxAgeS) {
  return name + '=' + value + '; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAgeS
}

// Drops expired rows, then the oldest ones until there is room for one more
// (sessions only: each row needs an allowed moderator's Google sign-in).
function makeRoom (map, max, now) {
  const t = now()
  for (const [k, v] of map) if (v.expiresAt <= t) map.delete(k)
  while (map.size >= max) map.delete(map.keys().next().value)
}

function createModRoutes ({
  association,
  origin,
  accounts,
  moderation = null,
  googleMod = null,
  modEmails = [],
  // The AI report triage worker (./ai/worker.js) or null when it is off.
  // Its hooks run only AFTER the HTTP answer went out, never awaited, and
  // their errors are swallowed into one log token: a throwing or slow model
  // can change neither the status nor the latency of a member's report or
  // a moderator's decision. Nothing AI-related is ever read from a body.
  triage = null,
  // Lowercase e-mails allowed to see the usage statistics. Only those that
  // are also moderators count: the stats tab lives behind the same session.
  statsEmails = [],
  // A createUsageStats instance (./usage-stats.js) exposing async view(), or
  // null when the stats tab is off.
  usage = null,
  // A createGroupCheck instance (./group-check.js) or null. Either block of
  // a group report is refused unless it confirms, through the seeder's
  // public group index, that the report's `group` is a served group root
  // and its `writer` belongs to the reported diary: both keys come from the
  // reporter, so blocking unchecked would let a reporter aim an
  // association-wide block at any key, a diary included.
  groupCheck = null,
  panelDir = path.join(__dirname, 'panel'),
  log = () => {},
  now = Date.now,
  http
}) {
  const { send, readJsonBody, checkPost, RouteError, refuse, fromStore, keyedWindow, fixedWindow, BASE_HEADERS } = http
  const emails = new Set(Array.isArray(modEmails) ? modEmails.map((e) => String(e).toLowerCase()) : [])
  const panelEnabled = emails.size > 0 && googleMod !== null && moderation !== null
  // Anything without a view() is treated as off, so a miswired caller shows
  // no tab instead of a tab that always fails.
  if (usage === null || usage === undefined || typeof usage.view !== 'function') usage = null
  if (groupCheck === null || groupCheck === undefined || typeof groupCheck.check !== 'function') groupCheck = null
  // The subset rule enforced here too (not only where the env is parsed): a
  // stats e-mail that is not a moderator can never hold a session anyway,
  // and keeping it out makes that explicit.
  const statsAllowed = new Set((Array.isArray(statsEmails) ? statsEmails : [])
    .map((e) => String(e).toLowerCase())
    .filter((e) => emails.has(e)))
  function canSeeStats (session) {
    return usage !== null && statsAllowed.has(session.email)
  }
  const assets = loadAssets(panelDir)

  // Report nonces and operator challenges are stateless: the server keeps
  // no row per issued nonce, so an unauthenticated flood of report/start or
  // api/challenge fills no table and evicts nobody's nonce. Each nonce
  // carries its expiry and a MAC under a per-process secret over its domain
  // and the fields it is bound to (the member; the moderator key and the
  // op). A restart draws a new secret, which simply expires every
  // outstanding nonce.
  const nonceSecret = nodeCrypto.randomBytes(32)

  // Single use without a table strangers can fill: a nonce is recorded as
  // spent only AFTER the request carrying it verified completely (the
  // member's or the moderator's signature over it), and is kept only until
  // its own expiry. Growth is therefore bounded by the rate of VALIDLY
  // SIGNED requests (and the global bucket), never by anonymous traffic.
  // nonce -> expiresAt.
  const spentReportNonces = new Map()
  const spentChallenges = new Map()

  // The moderator sign-in is stateless until the callback: GET /login stores
  // nothing and seals { expiry, loginId, state, verifier } into the login
  // cookie under this per-process AES-256-GCM key (a restart simply
  // invalidates in-flight logins). Anonymous /login traffic therefore fills
  // no table and can never evict a moderator's in-flight sign-in.
  const loginKey = nodeCrypto.randomBytes(32)
  // loginId -> expiresAt of every callback that presented a valid sealed
  // cookie AND the matching state, so a callback works once. It grows only
  // from such callbacks: each needs a cookie this process sealed (a /login
  // round trip) plus the state Google echoes back, and every request first
  // passes the server's global token bucket, so its size is bounded by that
  // rate times LOGIN_TTL_MS. Rows are pruned at their own expiry (after
  // which the sealed cookie is refused anyway), so evicting a live row is
  // never needed and would only reopen a replay window.
  const spentLogins = new Map()
  // Sessions: id -> { email, member, expiresAt }. Bounded, oldest evicted.
  const sessions = new Map()

  // Besides the server's global token bucket (server.js, every route), only
  // limits that no one else can spend on a victim's behalf:
  //   - session: keyed on the moderator's own session id, which only that
  //     moderator's browser holds.
  //   - operatorSigned: one window for pull/ack, charged only AFTER the
  //     certified moderator's signature verified, so anonymous callers
  //     (challenges, forged pulls) can never push the operator into 429.
  // There is deliberately no per-member limit on report/start (anyone may
  // name any public key, so such a quota would let a harasser silence the
  // person reporting them) and none on api/challenge (stateless). The
  // per-reporter cap that matters lives in the store (moderation-store.js
  // MAX_PER_REPORTER_DAY), reached only with the reporter's signature.
  //   - group: the panel's api/reports/<id>/grupo lookups, keyed on the
  //     session too but in a window of their own, so a queue full of group
  //     reports cannot spend the budget decide and the lists need.
  const limits = {
    session: keyedWindow(60, 60 * 1000, now),
    group: keyedWindow(30, 60 * 1000, now),
    operatorSigned: fixedWindow(30, 60 * 1000, now)
  }
  const over = () => new RouteError('pedido-invalido', 429)
  const unauthorized = () => new RouteError('nao-autorizado', 401)
  const forbidden = () => new RouteError('nao-autorizado', 403)

  // Fire-and-forget: the hook runs on a later microtask, after send().
  function afterAnswer (hook) {
    if (triage === null) return
    Promise.resolve().then(hook).catch(() => {
      try {
        log({ event: 'triage', reason: 'erro' })
      } catch {}
    })
  }

  // A read of the worker's view of one report; a failure shows as null, so
  // the panel never breaks on the AI.
  function triageView (method, id) {
    if (triage === null) return null
    try {
      return triage[method](id) ?? null
    } catch {
      return null
    }
  }

  function needModeration () {
    if (moderation === null) throw refuse('indisponivel')
  }

  function store (fn) {
    try {
      return fn()
    } catch (err) {
      throw fromStore(err)
    }
  }

  async function storeAsync (fn) {
    try {
      return await fn()
    } catch (err) {
      throw fromStore(err)
    }
  }

  function hex64 (value) {
    if (typeof value !== 'string' || !HEX64_RE.test(value)) throw refuse('pedido-invalido')
    return value
  }

  // --- stateless nonces ----------------------------------------------------

  function nonceMac (domain, fields, expiry, random) {
    const h = nodeCrypto.createHmac('sha256', nonceSecret)
    // Every bound field has a fixed alphabet without LF (hex64, 'pull' or
    // 'ack'), so the LF-joined prefix is unambiguous.
    h.update(domain + '\n' + fields.join('\n') + '\n')
    h.update(expiry)
    h.update(random)
    return h.digest().subarray(0, NONCE_MAC_BYTES)
  }

  function mintNonce (domain, fields, ttlMs) {
    const expiry = Buffer.alloc(8)
    expiry.writeBigUInt64BE(BigInt(now() + ttlMs))
    const random = nodeCrypto.randomBytes(16)
    return Buffer.concat([expiry, random, nonceMac(domain, fields, expiry, random)]).toString('base64url')
  }

  // -> the nonce's expiry (ms) when this process minted it for exactly this
  // domain and these fields and it has not expired, else null. Only the
  // canonical base64url spelling is accepted (54 characters carry 2 spare
  // bits), so one nonce has one string and the spent set cannot be dodged
  // by re-spelling it.
  function checkNonce (nonce, domain, fields) {
    if (typeof nonce !== 'string' || !NONCE_STR_RE.test(nonce)) return null
    const raw = Buffer.from(nonce, 'base64url')
    if (raw.length !== NONCE_RAW_BYTES || raw.toString('base64url') !== nonce) return null
    const expiry = raw.subarray(0, 8)
    const random = raw.subarray(8, 24)
    const mac = raw.subarray(24)
    if (!nodeCrypto.timingSafeEqual(mac, nonceMac(domain, fields, expiry, random))) return null
    const expiresAt = Number(expiry.readBigUInt64BE())
    return expiresAt > now() ? expiresAt : null
  }

  function spend (spent, nonce, expiresAt) {
    const t = now()
    for (const [k, at] of spent) if (at <= t) spent.delete(k)
    spent.set(nonce, expiresAt)
  }

  // --- sealed login cookie -----------------------------------------------

  function sealLogin ({ expiresAt, loginId, state, verifier }) {
    const expiry = Buffer.alloc(8)
    expiry.writeBigUInt64BE(BigInt(expiresAt))
    const plain = Buffer.concat([expiry, loginId, Buffer.from(state, 'base64url'), Buffer.from(verifier, 'base64url')])
    const iv = nodeCrypto.randomBytes(LOGIN_IV_BYTES)
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', loginKey, iv, { authTagLength: LOGIN_TAG_BYTES })
    cipher.setAAD(LOGIN_AAD)
    const sealed = Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
    return sealed.toString('base64url')
  }

  // -> { expiresAt, loginId (base64url), state, verifier } when this process
  // sealed `value` (auth tag verified) and it has not expired, else null.
  // Only the canonical spelling is accepted.
  function openLogin (value) {
    if (typeof value !== 'string' || !LOGIN_COOKIE_RE.test(value)) return null
    const raw = Buffer.from(value, 'base64url')
    if (raw.length !== LOGIN_SEALED_BYTES || raw.toString('base64url') !== value) return null
    const iv = raw.subarray(0, LOGIN_IV_BYTES)
    const tag = raw.subarray(raw.length - LOGIN_TAG_BYTES)
    let plain
    try {
      const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', loginKey, iv, { authTagLength: LOGIN_TAG_BYTES })
      decipher.setAAD(LOGIN_AAD)
      decipher.setAuthTag(tag)
      plain = Buffer.concat([decipher.update(raw.subarray(LOGIN_IV_BYTES, raw.length - LOGIN_TAG_BYTES)), decipher.final()])
    } catch {
      return null
    }
    if (plain.length !== LOGIN_PLAIN_BYTES) return null
    const expiresAt = Number(plain.readBigUInt64BE(0))
    if (expiresAt <= now()) return null
    return {
      expiresAt,
      loginId: plain.subarray(8, 24).toString('base64url'),
      state: plain.subarray(24, 56).toString('base64url'),
      verifier: plain.subarray(56, 88).toString('base64url')
    }
  }

  function redirectTo (res, location, cookies = []) {
    const headers = { Location: location, 'Content-Length': 0, ...BASE_HEADERS }
    if (cookies.length > 0) headers['Set-Cookie'] = cookies
    res.writeHead(302, headers)
    res.end()
  }

  // --- member reports ----------------------------------------------------

  async function reportStart (req, res, body) {
    needModeration()
    const member = hex64(body.member)
    // Only a member linked to a Google account may report.
    if (accounts.contact(member) === null) throw refuse('nao-vinculado')
    // No per-member quota and no stored row (see `limits`): issuing a nonce
    // for someone else's key costs them nothing.
    send(res, 200, { nonce: mintNonce(REPORT_NONCE_DOMAIN, [member], REPORT_NONCE_TTL_MS) })
  }

  async function report (req, res, body) {
    needModeration()
    const member = hex64(body.member)
    const nonce = body.nonce
    const expiresAt = checkNonce(nonce, REPORT_NONCE_DOMAIN, [member])
    // Forged, tampered, expired, another member's, or already spent by a
    // verified report.
    if (expiresAt === null || spentReportNonces.has(nonce)) throw new RouteError('expirado', 400)
    const target = hex64(body.target)
    // The own key is never a target; checked before the signature and the store.
    if (target === member) throw refuse('pedido-invalido')
    const seq = body.seq === undefined || body.seq === null ? null : body.seq
    // A group message (report v2): writer and group come together, only with
    // a seq.
    const writer = body.writer === undefined || body.writer === null ? null : hex64(body.writer)
    const group = body.group === undefined || body.group === null ? null : hex64(body.group)
    if ((writer === null) !== (group === null) || (writer !== null && seq === null)) throw refuse('pedido-invalido')
    // A group root is not a diary, and a writer core is not one either. The
    // writer MAY be the group key: the creator posts through the root core.
    if (writer !== null && (group === target || writer === target)) throw refuse('pedido-invalido')
    const text = body.text === undefined ? '' : body.text
    const quote = body.quote === undefined ? '' : body.quote
    const { reason, signature } = body
    const fields = writer === null
      ? { nonce, member, association, target, seq, reason, text, quote }
      : { nonce, member, association, target, seq, writer, group, reason, text, quote }
    if (!verifyReport(fields, signature).ok) throw refuse('assinatura-invalida')
    // Spent only now that the member's signature over it verified (no await
    // between the check above and this line, so two concurrent copies of one
    // signed report cannot both pass). A failed store write leaves it spent:
    // the app asks for a fresh nonce, and the store answers a retry of a
    // landed report as a duplicate.
    spend(spentReportNonces, nonce, expiresAt)
    const { report: added, duplicate } = await storeAsync(() => moderation.add({ reporter: member, target, seq, writer, group, reason, text, quote, signature, nonce }))
    log({ event: 'report', reason: duplicate ? 'duplicada' : 'nova' })
    send(res, 200, { id: added.id, duplicate })
    // A duplicate is a report the triage already has. A group message never
    // reaches the triage: it reads the diary at `seq`, which is not the
    // reported block, so only a human decides it.
    if (!duplicate && writer === null) afterAnswer(() => triage.onReport(added))
  }

  // --- moderator sign-in ---------------------------------------------------

  async function login (req, res) {
    if (!panelEnabled) throw refuse('indisponivel')
    // Nothing is stored here: the transaction travels in the sealed cookie.
    const state = randomToken()
    const verifier = randomToken()
    const sealed = sealLogin({ expiresAt: now() + LOGIN_TTL_MS, loginId: nodeCrypto.randomBytes(16), state, verifier })
    const url = googleMod.authorizeUrl({ state, codeChallenge: codeChallenge(verifier) })
    // SameSite=Lax: the callback is a cross-site top-level GET from Google.
    redirectTo(res, url, [setCookie(LOGIN_COOKIE, sealed, LOGIN_TTL_MS / 1000)])
  }

  // The sealed login cookie must open (auth tag, expiry) and its state match
  // the query's, in constant time, BEFORE the token endpoint is called; the
  // login id is spent before awaiting the provider, so a callback works
  // once. Nothing from Google (code, error, sub, e-mail) is put in the
  // redirect.
  async function callback (req, res, url) {
    const clearLogin = setCookie(LOGIN_COOKIE, '', 0)
    const back = (outcome, cookies = [clearLogin]) => {
      log({ event: 'mod-login', reason: outcome })
      redirectTo(res, origin + '/account/mod/?erro=' + outcome, cookies)
    }
    if (!panelEnabled) return back('indisponivel')
    const tx = openLogin(cookieValue(req, LOGIN_COOKIE, LOGIN_COOKIE_RE))
    const state = url.searchParams.get('state')
    if (tx === null || typeof state !== 'string' || !TOKEN_RE.test(state) ||
      !nodeCrypto.timingSafeEqual(Buffer.from(state), Buffer.from(tx.state))) {
      return back('sessao')
    }
    if (spentLogins.has(tx.loginId)) return back('sessao')
    // Spent before any await (see `spentLogins`).
    const t = now()
    for (const [k, at] of spentLogins) if (at <= t) spentLogins.delete(k)
    spentLogins.set(tx.loginId, tx.expiresAt)
    if (url.searchParams.get('error') !== null) return back('cancelado')
    const code = url.searchParams.get('code')
    if (typeof code !== 'string' || !PARAM_RE.test(code)) return back('google')
    const result = await googleMod.exchange({ code, codeVerifier: tx.verifier })
    if (!result.ok) return back('google')
    const email = String(result.email).toLowerCase()
    if (!emails.has(email)) {
      log({ event: 'mod-login', reason: 'fora-da-lista' })
      return redirectTo(res, origin + '/account/mod/?erro=nao-autorizado', [clearLogin])
    }
    // A moderator signs in only with the Google account linked to their
    // diary: that diary becomes the session's own member, kept out of every
    // case they see or decide (as target and as reporter); without the link
    // their own diary could not be recognised. Residual: a moderator who
    // ALSO owns a second diary linked to a second Google account is not
    // detectable.
    const member = accounts.memberForSub(result.sub)
    if (typeof member !== 'string' || !HEX64_RE.test(member)) return back('sem-diario')
    // One session per moderator: a new login replaces the old one.
    for (const [sid, s] of sessions) if (s.email === email) sessions.delete(sid)
    makeRoom(sessions, MAX_SESSIONS, now)
    const sid = randomToken()
    sessions.set(sid, { email, member, expiresAt: now() + SESSION_TTL_MS })
    log({ event: 'mod-login', reason: 'ok' })
    redirectTo(res, origin + '/account/mod/', [setCookie(SESSION_COOKIE, sid, SESSION_TTL_MS / 1000), clearLogin])
  }

  // -> { id, email, member } of the request's live session, or null.
  function sessionOf (req) {
    const id = cookieValue(req, SESSION_COOKIE)
    if (id === null) return null
    const s = sessions.get(id)
    if (s === undefined) return null
    if (s.expiresAt <= now()) {
      sessions.delete(id)
      return null
    }
    return { id, email: s.email, member: s.member }
  }

  async function logout (req, res) {
    const id = cookieValue(req, SESSION_COOKIE)
    if (id !== null) sessions.delete(id)
    send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(SESSION_COOKIE, '', 0) })
  }

  // --- panel API (session required) ---------------------------------------

  function usernameOf (member, cache) {
    if (!cache.has(member)) {
      const c = accounts.contact(member)
      cache.set(member, c === null ? null : c.username)
    }
    return cache.get(member)
  }

  // The moderator's own linked diary (recorded at sign-in, never null): they
  // never see or decide a case about it or filed from it, nor lift or
  // cancel a block on it.
  function ownMember (session) {
    return session.member
  }

  // A case the moderator may not see or decide: about their own diary
  // (retaliation, self-unblock) or filed from it (accuser and judge at
  // once). moderation.list's `exclude` applies the same rule. The group key
  // is the reporter's choice, so it does not hide a case: anyone could
  // otherwise file reports naming a moderator's diary as the group that
  // this moderator can never discard. Only 'Bloquear grupo' aimed at the
  // moderator's own diary is refused, in decide.
  function ownCase (r, own) {
    return r.target === own || r.reporter === own
  }

  // -> { ok: true, root, name, creator, texto } | { ok: false, code }. Never throws.
  async function confirmGroup (r) {
    if (r.writer === null || r.group === null) return { ok: false, code: 'pedido-invalido' }
    if (groupCheck === null) return { ok: false, code: 'config' }
    try {
      const v = await groupCheck.check({ group: r.group, writer: r.writer, diary: r.target, seq: r.seq })
      return v !== null && typeof v === 'object' && v.ok === true ? v : { ok: false, code: v && typeof v.code === 'string' ? v.code : 'recusado' }
    } catch {
      return { ok: false, code: 'recusado' }
    }
  }

  // A report without a group names only a key, which could be a group root:
  // 'Bloquear' would then drop the whole group everywhere. A linked account
  // proves nothing here (a creator can link the root key itself as an
  // account), so every such block waits for the seeder to confirm a served
  // diary. -> { ok: true, needed } | { ok: false, code }. Never throws.
  async function confirmTarget (r) {
    if (r.group !== null) return { ok: true, needed: false }
    if (groupCheck === null || typeof groupCheck.checkDiary !== 'function') return { ok: false, code: 'config' }
    try {
      const v = await groupCheck.checkDiary({ diary: r.target })
      return v !== null && typeof v === 'object' && v.ok === true ? { ok: true, needed: true } : { ok: false, code: v && typeof v.code === 'string' ? v.code : 'recusado' }
    } catch {
      return { ok: false, code: 'recusado' }
    }
  }

  // { seq, at } of the last acked snapshot, or null before the first.
  function publishedInfo () {
    const { published } = moderation.pending()
    return published.snapshot === null ? null : { seq: published.snapshot.seq, at: published.at }
  }

  function projectReport (r, cache) {
    const reportedName = usernameOf(r.target, cache)
    return {
      id: r.id,
      at: r.at,
      kind: r.kind,
      target: r.target,
      seq: r.seq,
      writer: r.writer,
      group: r.group,
      quote: r.quote,
      reason: r.reason,
      text: r.text,
      reporter: { member: r.reporter, username: usernameOf(r.reporter, cache) },
      reported: { member: r.target, username: reportedName, linked: accounts.contact(r.target) !== null },
      status: r.status,
      decidedAt: r.decidedAt,
      note: r.note,
      // Who decided, never the e-mail (decidedBy stays in the store).
      actor: r.status === 'aberta' ? null : r.decidedBy === AI_ACTOR ? 'ia' : 'pessoa',
      // The triage's suggestion (tokens and numbers) and the verified post
      // text it read from the seeder ({ texto, midia, citacao }), or null.
      ia: triageView('suggestionOf', r.id),
      publicacao: triageView('verifiedOf', r.id)
    }
  }

  // The keys a 'bloquear' decision blocked as a group root, over every
  // stored row (not one listing window), so an old group block keeps its
  // label.
  function groupKeys () {
    return moderation.groupKeys()
  }

  function projectChange (c, cache, groups = null) {
    if (c === null || c === undefined) return null
    const isGroup = groups !== null
      ? groups.has(c.member)
      : c.reportIds.some((id) => {
        const r = moderation.get(id)
        return r !== null && r.blocked === 'grupo' && r.group === c.member
      })
    return {
      id: c.id,
      op: c.op,
      member: c.member,
      username: usernameOf(c.member, cache),
      at: c.at,
      reportIds: [...c.reportIds],
      claimedAt: c.claimedAt ?? null,
      byAi: c.by === AI_ACTOR,
      kind: isGroup ? 'grupo' : 'conta'
    }
  }

  // The counts leave out the moderator's own cases too: a count above what
  // api/reports shows would tell them someone reported them.
  async function me (req, res, session) {
    const own = ownMember(session)
    const { reports: rows } = store(() => moderation.list({ status: 'aberta', limit: MAX_REPORTS, exclude: own }))
    const { changes } = store(() => moderation.pending())
    send(res, 200, {
      email: session.email,
      published: store(publishedInfo),
      open: rows.length,
      pending: changes.filter((c) => c.member !== own).length,
      // Present only for the stats allow-list; never `stats: false`, so
      // everyone else gets the exact body they always got.
      ...(canSeeStats(session) ? { stats: true } : {})
    })
  }

  // The anonymous usage view (./usage-stats.js). It never carries report,
  // pending or blocked-case counts: those include the admin's own cases,
  // which me() deliberately hides, so a total here could tell them someone
  // reported them. No log line of its own (the view is counts only anyway).
  async function usageStats (req, res, session) {
    if (!canSeeStats(session)) throw forbidden()
    let body
    try {
      body = await usage.view()
    } catch {
      throw refuse('indisponivel')
    }
    send(res, 200, body)
  }

  async function reports (req, res, session, url) {
    const estado = url.searchParams.get('estado') ?? 'aberta'
    if (estado !== 'aberta' && estado !== 'decidida') throw refuse('pedido-invalido')
    // `antes`, only for the history: the id of the last row the caller holds;
    // the page starts right after it.
    const antes = url.searchParams.get('antes')
    if (antes !== null && (estado !== 'decidida' || !ID_RE.test(antes))) throw refuse('pedido-invalido')
    // The moderator's own cases (as target or as reporter) leave the store's
    // list before its cut at MAX_REPORTS and before the page: truncating
    // first could hide every actionable report behind a first page of the
    // moderator's own cases, and `truncated` must not count them either.
    const own = ownMember(session)
    const { reports: visible, truncated: cut } = store(() => moderation.list({ status: estado, limit: MAX_REPORTS, exclude: own }))
    let start = 0
    if (antes !== null) {
      const at = visible.findIndex((r) => r.id === antes)
      if (at === -1) throw refuse('pedido-invalido')
      start = at + 1
    }
    const cache = new Map()
    send(res, 200, {
      reports: visible.slice(start, start + REPORTS_PAGE).map((r) => projectReport(r, cache)),
      truncated: visible.length > start + REPORTS_PAGE,
      // The store lists at most MAX_REPORTS rows: on the last page the panel
      // can reach, older rows may exist that it never shows.
      alemDoLimite: cut && visible.length <= start + REPORTS_PAGE
    })
  }

  async function decide (req, res, session, id, body) {
    const row = store(() => moderation.get(id))
    const own = ownMember(session)
    if (row === null || ownCase(row, own)) throw refuse('nao-encontrado')
    const note = body.note === undefined ? '' : body.note
    const block = body.block === undefined ? 'diario' : body.block
    // Blocking one's own diary as a "group" would also hide it from them in
    // api/blocked.
    if (body.decision === 'bloquear' && block === 'grupo' && row.group === own) throw refuse('nao-encontrado')
    // A report without a group is refused by the store ('pedido-invalido').
    // A group report gets no AI triage and no verified read: its quote is
    // the reporter's word only. Either block (the root, or the diary named
    // as author) therefore waits for the seeder to confirm that the writer
    // belongs to that diary, so an invented quote cannot aim a block at a
    // diary that never wrote it. Fails closed; 'descartar' never asks.
    if (body.decision === 'bloquear' && row.group !== null) {
      const v = await confirmGroup(row)
      if (!v.ok) {
        log({ event: 'grupo', reason: v.code })
        throw refuse('grupo-nao-confirmado')
      }
      // The writer row alone confirms the reported diary, never that the
      // reported `group` is a group root: without the root header's kind a
      // reporter could have 'Bloquear grupo' drop any key association-wide.
      if (block === 'grupo' && v.root !== true) {
        log({ event: 'grupo', reason: 'sem-raiz' })
        throw refuse('grupo-nao-confirmado')
      }
    }
    // ('grupo' on a report without a group is the store's refusal.)
    if (body.decision === 'bloquear' && row.group === null && block === 'diario') {
      const v = await confirmTarget(row)
      if (!v.ok) {
        log({ event: 'alvo', reason: v.code })
        throw refuse('alvo-nao-confirmado')
      }
    }
    const result = await storeAsync(() => moderation.decide(id, { decision: body.decision, by: session.email, note, block }))
    log({ event: 'decided', reason: result.report.status })
    const cache = new Map()
    send(res, 200, { report: projectReport(result.report, cache), change: projectChange(result.change, cache) })
    // The store's row (decidedBy = this moderator), so the worker can learn.
    afterAnswer(() => triage.onHumanDecision(result.report))
  }

  // The moderator's own case stays hidden here too (as in api/reports): a
  // block or pending change about their own diary is not listed.
  async function blocked (req, res, session) {
    const cache = new Map()
    const own = ownMember(session)
    const list = store(() => moderation.blocked()).filter(({ member }) => member !== own)
    const { changes } = store(() => moderation.pending())
    const groups = store(groupKeys)
    send(res, 200, {
      published: store(publishedInfo),
      blocked: list.map(({ member, reportIds, kind }) => ({ member, username: usernameOf(member, cache), reportIds: [...reportIds], kind })),
      pending: changes.filter((c) => c.member !== own).map((c) => projectChange(c, cache, groups))
    })
  }

  // The panel asks before offering either block: { confirmed: true, root,
  // name, creator } (`root` false: no root header, so only the diary can be
  // blocked; the root header as the seeder holds it, peer text the panel
  // renders as text) or { confirmed: false, reason }. A hint for the button
  // only: decide checks again.
  async function groupInfo (req, res, session, id) {
    const row = store(() => moderation.get(id))
    if (row === null || row.writer === null || ownCase(row, ownMember(session))) throw refuse('nao-encontrado')
    const v = await confirmGroup(row)
    if (!v.ok) log({ event: 'grupo', reason: v.code })
    // `texto`: the reported message as the seeder decoded it (peer text,
    // rendered by the panel as text only).
    send(res, 200, v.ok ? { confirmed: true, root: v.root === true, name: v.name ?? null, creator: v.creator ?? null, texto: typeof v.texto === 'string' ? v.texto : null } : { confirmed: false, reason: v.code })
  }

  // The panel asks before offering 'Bloquear' on a report without a group
  // whose target has no linked account: { confirmed: true } or {
  // confirmed: false, reason }. A hint for the button only: decide checks
  // again.
  async function targetInfo (req, res, session, id) {
    const row = store(() => moderation.get(id))
    if (row === null || row.group !== null || ownCase(row, ownMember(session))) throw refuse('nao-encontrado')
    const v = await confirmTarget(row)
    if (!v.ok) log({ event: 'alvo', reason: v.code })
    send(res, 200, v.ok ? { confirmed: true } : { confirmed: false, reason: v.code })
  }

  async function unblock (req, res, session, body) {
    const member = hex64(body.member)
    if (member === ownMember(session)) throw refuse('nao-encontrado')
    const { change } = await storeAsync(() => moderation.unblock(member, { by: session.email }))
    log({ event: 'unblock' })
    send(res, 200, { change: projectChange(change, new Map()) })
    afterAnswer(() => triage.onUnblock(member))
  }

  async function cancel (req, res, session, id) {
    const { changes } = store(() => moderation.pending())
    const target = changes.find((c) => c.id === id)
    if (target === undefined || target.member === ownMember(session)) throw refuse('nao-encontrado')
    const { change } = await storeAsync(() => moderation.cancel(id, { by: session.email }))
    log({ event: 'cancel' })
    send(res, 200, { change: projectChange(change, new Map()) })
    // The change as it was before the cancel (its reportIds), read above.
    afterAnswer(() => triage.onCancel(target))
  }

  // --- operator (signed by the certified moderator key) -------------------

  // Stateless (no row, no limit beyond the global bucket): anonymous
  // challenges fill nothing and cannot crowd out the operator's.
  async function challenge (req, res, url) {
    needModeration()
    const moderator = hex64(url.searchParams.get('moderator'))
    const op = url.searchParams.get('op')
    if (op !== 'pull' && op !== 'ack') throw refuse('pedido-invalido')
    send(res, 200, { nonce: mintNonce(CHALLENGE_DOMAIN, [moderator, op], CHALLENGE_TTL_MS) })
  }

  // Throws 403 'nao-autorizado' unless `cert` is the association's moderator
  // certificate, not older than the last acked snapshot's (a rotated-out key
  // is refused, plan D3), and `signature` signs this request over an
  // unexpired, unspent challenge minted for that moderator and op. The
  // nonce is spent only once all of that verified; then the signed-request
  // window applies (429), which only the moderator key can charge.
  // `bodyFor()` builds the canonical body; a body it cannot build is
  // 'pedido-invalido'.
  function operatorAuth (body, op, bodyFor) {
    const cert = body.cert
    if (!verifyModeratorCert(cert, association).ok) throw forbidden()
    const nonce = body.nonce
    const expiresAt = checkNonce(nonce, CHALLENGE_DOMAIN, [cert.moderator, op])
    if (expiresAt === null || spentChallenges.has(nonce)) throw forbidden()
    const newest = store(() => moderation.newestModeratorDate())
    if (cert.date < newest) throw forbidden()
    let bytes
    try {
      bytes = bodyFor()
    } catch {
      throw refuse('pedido-invalido')
    }
    const verdict = verifyModRequest({ origin, association, moderator: cert.moderator, nonce, op, body: bytes }, body.signature)
    if (!verdict.ok) throw forbidden()
    spend(spentChallenges, nonce, expiresAt)
    if (!limits.operatorSigned()) throw over()
    return cert
  }

  async function pull (req, res, body) {
    needModeration()
    operatorAuth(body, 'pull', () => canonicalBody('pull'))
    const result = await storeAsync(() => moderation.pull())
    log({ event: 'pull', reason: String(result.changes.length) })
    // Exactly { changes: [{ id, op, member, at, actor }], published: { snapshot } }
    // (plan D1). `actor` is the store's projection ('ia' or 'pessoa'); the
    // moderator's e-mail (`by`) never reaches the operator.
    send(res, 200, {
      changes: result.changes.map(({ id, op, member, at, actor }) => ({ id, op, member, at, actor })),
      published: { snapshot: result.published.snapshot }
    })
  }

  async function ack (req, res, body) {
    needModeration()
    const { changeIds, snapshot } = body
    const cert = operatorAuth(body, 'ack', () => canonicalBody('ack', { changeIds, snapshot }))
    const result = await storeAsync(() => moderation.ack({ changeIds, snapshot, moderatorCert: cert }))
    log({ event: 'ack' })
    send(res, 200, { ok: true, seq: result.seq })
  }

  // --- dispatch -----------------------------------------------------------

  function owns (pathname) {
    return pathname === '/account/report' || pathname.startsWith('/account/report/') ||
      pathname === '/account/mod' || pathname.startsWith('/account/mod/')
  }

  function sendAsset (res, asset) {
    res.writeHead(200, {
      'Content-Type': asset.type,
      'Content-Length': asset.body.length,
      ...BASE_HEADERS,
      'Content-Security-Policy': PANEL_CSP
    })
    res.end(asset.body)
  }

  async function postBody (req, max, opts) {
    checkPost(req, opts)
    return readJsonBody(req, max)
  }

  async function withSession (req, fn, limit = limits.session) {
    const session = sessionOf(req)
    if (session === null) throw unauthorized()
    if (!limit(session.id)) throw over()
    needModeration()
    return fn(session)
  }

  async function handle (req, res, url) {
    const p = url.pathname
    const get = req.method === 'GET'
    const post = req.method === 'POST'

    if (post && p === '/account/report/start') return reportStart(req, res, await postBody(req, undefined))
    if (post && p === '/account/report') return report(req, res, await postBody(req, REPORT_BODY_MAX))

    if (get && p === '/account/mod') return redirectTo(res, origin + '/account/mod/')
    if (get && Object.hasOwn(ASSETS, p)) {
      const asset = assets.get(p)
      if (asset === undefined) throw refuse('nao-encontrado')
      return sendAsset(res, asset)
    }
    if (get && p === '/account/mod/login') return login(req, res)
    if (get && p === '/account/mod/callback') return callback(req, res, url)
    if (post && p === '/account/mod/logout') {
      await postBody(req, undefined)
      return logout(req, res)
    }

    // Operator routes: exempt from the Origin rule (no browser, no cookie;
    // the moderator signature over a server nonce is the authority).
    if (get && p === '/account/mod/api/challenge') return challenge(req, res, url)
    if (post && p === '/account/mod/api/pull') return pull(req, res, await postBody(req, undefined, { requireOrigin: false }))
    if (post && p === '/account/mod/api/ack') return ack(req, res, await postBody(req, ACK_BODY_MAX, { requireOrigin: false }))

    // Panel API. api/me answers 401 without a session even when the panel
    // is disabled: deploy/seeder/deploy.sh probes exactly that.
    if (get && p === '/account/mod/api/me') return withSession(req, (s) => me(req, res, s))
    if (get && p === '/account/mod/api/reports') return withSession(req, (s) => reports(req, res, s, url))
    if (get && p === '/account/mod/api/blocked') return withSession(req, (s) => blocked(req, res, s))
    if (get && p === '/account/mod/api/stats') return withSession(req, (s) => usageStats(req, res, s))
    if (post && p === '/account/mod/api/unblock') {
      const body = await postBody(req, undefined)
      return withSession(req, (s) => unblock(req, res, s, body))
    }
    const decideMatch = /^\/account\/mod\/api\/reports\/([^/]+)\/decide$/.exec(p)
    if (post && decideMatch && ID_RE.test(decideMatch[1])) {
      const id = decideMatch[1]
      const body = await postBody(req, undefined)
      return withSession(req, (s) => decide(req, res, s, id, body))
    }
    const groupMatch = /^\/account\/mod\/api\/reports\/([^/]+)\/grupo$/.exec(p)
    if (get && groupMatch && ID_RE.test(groupMatch[1])) {
      const id = groupMatch[1]
      return withSession(req, (s) => groupInfo(req, res, s, id), limits.group)
    }
    const targetMatch = /^\/account\/mod\/api\/reports\/([^/]+)\/alvo$/.exec(p)
    if (get && targetMatch && ID_RE.test(targetMatch[1])) {
      const id = targetMatch[1]
      return withSession(req, (s) => targetInfo(req, res, s, id), limits.group)
    }
    const cancelMatch = /^\/account\/mod\/api\/pending\/([^/]+)\/cancel$/.exec(p)
    if (post && cancelMatch && ID_RE.test(cancelMatch[1])) {
      const id = cancelMatch[1]
      await postBody(req, undefined)
      return withSession(req, (s) => cancel(req, res, s, id))
    }
    throw refuse('nao-encontrado')
  }

  // Sizes only (server.js modStats): tests check that anonymous or invalid
  // requests never grow a table.
  function stats () {
    return { spentReportNonces: spentReportNonces.size, spentChallenges: spentChallenges.size, spentLogins: spentLogins.size, sessions: sessions.size }
  }

  return { owns, handle, stats }
}

module.exports = {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  REPORT_BODY_MAX,
  ACK_BODY_MAX,
  MAX_MOD_EMAILS,
  PANEL_CSP,
  parseModEmails,
  createModRoutes
}
