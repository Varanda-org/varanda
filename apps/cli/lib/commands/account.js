'use strict'

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { UsageError } = require('../cli')
const { readConfig, writeConfig, writeJsonAtomic } = require('@varanda/core/lib/store')
const { loadKeyPairFile, saveKeyPairFile, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { safe, jsonLine } = require('@varanda/core/lib/safe')
const { createGoogle } = require('../account/google')
const { openAccountStore } = require('../account/store')
const { openTermsStore } = require('../account/terms-store')
const { openInvitesStore } = require('../account/invites-store')
const { openPushStore } = require('../account/push-store')
const { openAgeStore } = require('../account/age-store')
const { createDidit } = require('../account/didit')
const { createHodle, NETWORKS: HODLE_NETWORKS } = require('../account/hodle')
const { openWalletStore } = require('../account/wallet-store')
const { openWalletOpsStore } = require('../account/wallet-ops-store')
const { parseFees, isActive: feesActive } = require('../account/fees')
const { parseWebhookSecrets } = require('../account/wallet-webhook')
const { generateVapidKeys } = require('../account/web-push')
const { openModerationStore, FILE: MODERATION_FILE } = require('../account/moderation-store')
const { parseModEmails } = require('../account/mod-routes')
const { revokedIssuerSet } = require('@varanda/core/lib/blocklist')
const { FILE: EXEMPLARS_FILE } = require('../account/ai/exemplar-store')
const { createUsageStats } = require('../account/usage-stats')
const { createSeederHealthReader, parseSeederHealthUrl } = require('../account/seeder-health')
const { createGroupCheck } = require('../account/group-check')
const { localDay } = require('@varanda/core/lib/activity')
const {
  DEFAULT_HOST,
  DEFAULT_PORT,
  KEY_FILE,
  CERT_FILE,
  ORIGIN_RE,
  createAccountServer,
  loadIssuer,
  checkIssuerCert,
  takeLock,
  lockHeld,
  LOCK_HEARTBEAT_MS
} = require('../account/server')

// `account`: the Google account-link service (README "Vínculo de conta Google
// e @nome"). Its data dir holds config.json { v: 1, role: 'account',
// association }, the issuer key pair (issuer-key.json, 0o600), the issuer
// certificate the association signed (issuer-cert.json) and the directory
// (apps/cli/lib/account/store.js). A member or seeder dir is refused.
//
// The ceremony order is fixed by the first deploy (C10): the service boots
// before any issuer exists, answering health and 503 'indisponivel' on the
// link routes, then `account key`, `assoc certify-issuer` on the operator's
// machine, `account cert add` and a restart make it configured.
//
// The same dir holds the moderation desk (moderation.json,
// apps/cli/lib/account/moderation-store.js): reports from the app, the
// moderators' decisions and the pending blocklist changes. The panel's
// sign-in is open only to the e-mails in VARANDA_MODERATOR_EMAILS (empty:
// disabled); its sessions live in memory, so a restart signs every
// moderator out.
//
// It also holds usage.json, the daily history of the anonymous usage
// statistics (apps/cli/lib/account/usage-stats.js: member count and the
// local seeder's /health counts) shown on the panel's stats tab to the
// e-mails in VARANDA_STATS_EMAILS (a subset of the moderators). Without stats
// e-mails nothing is sampled, the seeder is never fetched and usage.json is
// never written.
//
// Web Push for the hosted PWA (apps/cli/lib/account/push-routes.js) is on
// once `account push-key` wrote push-vapid.json (the VAPID key pair, 0o600);
// the browser subscriptions live in push.json (./push-store.js). The seeder
// relays notices to POST /push-event only when both services share
// VARANDA_PUSH_TOKEN.
const USAGE = 'node bin/varanda.js account [key|push-key|cert add|status|export|reports [--member <hex>]]'
const PUSH_VAPID_FILE = 'push-vapid.json'
const B64U_RE = /^[A-Za-z0-9_-]+$/
const HEX64_RE = /^[0-9a-f]{64}$/
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{1,200}$/
const MAX_SECRET = 256
// VARANDA_AI: unset or '' (off), 'sombra' (suggestions only) or '1' (the
// worker's 'auto' mode: it may decide within its daily caps).
const AI_MODES = { sombra: 'sombra', 1: 'auto' }
// How long shutdown waits for the embedder to finish an inference.
const EMBEDDER_CLOSE_MS = 5000
const DEFAULT_SEEDER_HTTP = 'http://127.0.0.1:8789'
// The seeder's loopback route only: http, a loopback host, an explicit
// port and no path (the reader, ../account/ai/read-post.js, refuses
// anything else too).
const SEEDER_HTTP_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/
const AI_MODEL_DIR = 'ai-model'
// Optional capacity knobs: name -> [option, min, max]. Absent or blank keeps
// the store/server default; '0' is invalid, never "unlimited".
const LIMIT_ENV = Object.freeze({
  VARANDA_MAX_MEMBERS: ['maxMembers', 1, 4096],
  VARANDA_ACCOUNT_MAX_PENDING: ['maxPending', 1, 100000],
  VARANDA_ACCOUNT_MAX_CONNECTIONS: ['maxConnections', 1, 4096],
  VARANDA_ACCOUNT_RATE: ['ratePerSecond', 1, 10000],
  VARANDA_ACCOUNT_BURST: ['burst', 1, 100000],
  // Unset is open signup; set, a new member needs an invite. There is no
  // "off" value: removing the feature is unsetting the variable.
  VARANDA_INVITES_PER_WEEK: ['invitesPerWeek', 1, 100]
})
const CANONICAL_INT_RE = /^[1-9][0-9]{0,8}$/
const DIDIT_KEY_RE = /^[\x21-\x7e]+$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIDIT_DAILY_DEFAULT = 200
const DIDIT_DAILY_MAX = 100000
// The client's own key shape (../account/hodle.js), so a key readEnv lets
// through is never one createHodle refuses at start.
const HODLE_KEY_RE = /^hodle_(live|test)_[\x21-\x7e]{8,200}$/
// This release ships the first three modes of wallet-routes.js MODES:
// cadastro (subaccount and KYC only), carteira (adds wallet-create with the
// member's PIN), the latter only once Hodle confirmed in writing that
// member-chosen PINs work on individual subaccounts, and pix (adds balance,
// Pix deposits and Pix payouts).
const HODLE_MODES = Object.freeze(['cadastro', 'carteira', 'pix'])
const HODLE_DAILY_DEFAULT = 100
const HODLE_DAILY_MAX = 100000
// wallet-routes.js refuses a cap below its minimum deposit (R$ 1,00).
const HODLE_MAX_CENTS_MIN = 100
const HODLE_MAX_CENTS_MAX = 100000000
const HODLE_MAX_CENTS_DEFAULT = 300000
// The fee kinds each mode can actually charge. A rate for any other kind
// would never be collected, and the operator must not believe it is.
const FEE_KINDS_BY_MODE = Object.freeze({ cadastro: [], carteira: [], pix: ['payout'] })
// PINs belong to members, typed at the moment they sign; the service never
// holds one, the treasury's included, so one in the environment is a mistake.
const FORBIDDEN_PIN_VARS = Object.freeze(['VARANDA_HODLE_PIN', 'VARANDA_FEE_TREASURY_PIN'])
const WALLET_PRUNE_MS = 6 * 60 * 60 * 1000

function print (flags, result, line) {
  process.stdout.write((flags.json ? jsonLine(result) : line) + '\n')
}

function notAccountDir () {
  return new Error('diretório não é do serviço de conta')
}

function configuredAssociation (config, given) {
  if (config === null || typeof config !== 'object' || config.role !== 'account') throw notAccountDir()
  if (typeof config.association !== 'string' || !HEX64_RE.test(config.association)) throw notAccountDir()
  if (given !== null && given !== config.association) throw new Error('associação diferente da configurada')
  return config.association
}

// key, cert add and the service itself: the first of them fixes the trust
// root in config.json (as Seeder.ensureConfig does for a seeder dir).
function ensureConfig (dataDir, given) {
  refuseSymlinkDir(dataDir)
  const config = readConfig(dataDir)
  if (config !== null) return configuredAssociation(config, given)
  if (given === null) throw new UsageError('informe --association ou VARANDA_ASSOCIATION')
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  writeConfig(dataDir, { v: 1, role: 'account', association: given })
  return given
}

// status and export never write: a missing config is not an account dir.
function checkConfig (dataDir, given) {
  refuseSymlinkDir(dataDir)
  const config = readConfig(dataDir)
  if (config === null) throw notAccountDir()
  return configuredAssociation(config, given)
}

// The public key hex of the issuer key file, or null when there is none.
function issuerPublicKey (dataDir) {
  try {
    return b4a.toString(loadKeyPairFile(path.join(dataDir, KEY_FILE)).publicKey, 'hex')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Idempotent: an existing key is kept and only its public half is printed.
function createKey (dataDir) {
  const file = path.join(dataDir, KEY_FILE)
  const existing = issuerPublicKey(dataDir)
  if (existing !== null) return existing
  const kp = crypto.keyPair()
  try {
    saveKeyPairFile(file, kp)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    return issuerPublicKey(dataDir)
  }
  return b4a.toString(kp.publicKey, 'hex')
}

function readCertFile (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('arquivo não encontrado: ' + safe(file))
    throw new Error('certificado do emissor inválido (malformed)')
  }
}

function addCert (dataDir, certFile, association) {
  const cert = readCertFile(certFile)
  let keyPair
  try {
    keyPair = loadKeyPairFile(path.join(dataDir, KEY_FILE))
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('chave do emissor ausente (use account key)')
    throw err
  }
  const reason = checkIssuerCert(cert, keyPair, association)
  if (reason === 'issuer-mismatch') throw new Error('certificado do emissor é de outra chave')
  if (reason !== null) throw new Error('certificado do emissor inválido (' + reason + ')')
  writeJsonAtomic(path.join(dataDir, CERT_FILE), cert, 0o600)
  return { issuer: cert.issuer }
}

// Unpadded, canonical base64url of exactly `bytes` bytes, or null.
function b64uBytes (value, bytes) {
  if (typeof value !== 'string' || !B64U_RE.test(value)) return null
  const buf = Buffer.from(value, 'base64url')
  return buf.length === bytes && buf.toString('base64url') === value ? buf : null
}

// Refused while the service runs (it would keep serving the old key) and
// when a key exists: a new key silently orphans every browser subscription.
function createPushKey (dataDir) {
  if (lockHeld(dataDir)) throw new Error('serviço de conta em execução')
  const file = path.join(dataDir, PUSH_VAPID_FILE)
  if (fs.existsSync(file)) throw new Error('chave de push já existe')
  const { publicKey, privateKey } = generateVapidKeys()
  try {
    writeJsonExclusive(file, { v: 1, publicKey, privateKey }, 0o600)
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error('chave de push já existe')
    throw err
  }
  return publicKey
}

// Like writeJsonAtomic, but publishing with link() instead of rename(): link
// fails with EEXIST rather than replacing, so of two concurrent runs past the
// existence check only the first key is kept.
function writeJsonExclusive (file, obj, mode) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.' + nodeCrypto.randomBytes(6).toString('hex') + '.tmp')
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
  const fd = fs.openSync(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode)
  try {
    try {
      fs.fchmodSync(fd, mode)
      fs.writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.linkSync(tmp, file)
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

// { publicKey, privateKey } of push-vapid.json, null when there is none, or
// 'malformed' when it is not a pair this command would have written (the
// private half must derive the public one).
function loadVapid (dataDir) {
  let obj
  try {
    obj = JSON.parse(fs.readFileSync(path.join(dataDir, PUSH_VAPID_FILE), 'utf8'))
  } catch (err) {
    return err.code === 'ENOENT' ? null : 'malformed'
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'malformed'
  const keys = Object.keys(obj).sort()
  if (keys.join(',') !== 'privateKey,publicKey,v' || obj.v !== 1) return 'malformed'
  const pub = b64uBytes(obj.publicKey, 65)
  const priv = b64uBytes(obj.privateKey, 32)
  if (pub === null || priv === null || pub[0] !== 0x04) return 'malformed'
  try {
    const ecdh = nodeCrypto.createECDH('prime256v1')
    ecdh.setPrivateKey(priv)
    if (!ecdh.getPublicKey().equals(pub)) return 'malformed'
  } catch {
    return 'malformed'
  }
  return { publicKey: obj.publicKey, privateKey: obj.privateKey }
}

// { enabled, devices }: devices is the number of stored browser
// subscriptions, or 'indisponivel' when push.json cannot be read. Counts
// only: never an endpoint.
function pushStatus (dataDir) {
  const vapid = loadVapid(dataDir)
  const store = openPushStore(dataDir, { readOnly: true })
  return { enabled: vapid !== null && vapid !== 'malformed', devices: store.available() ? store.count() : 'indisponivel' }
}

function pushLine (push) {
  if (push.devices === 'indisponivel') return 'avisos push: indisponível (push.json inválido)'
  if (!push.enabled) return 'avisos push: desligados'
  return 'avisos push: ligados (' + push.devices + ' aparelhos)'
}

// 'ok', 'missing' or the reason the certificate fails for this key and association.
function certificateState (dataDir, association) {
  let cert
  try {
    cert = JSON.parse(fs.readFileSync(path.join(dataDir, CERT_FILE), 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing'
    return 'malformed'
  }
  let keyPair
  try {
    keyPair = loadKeyPairFile(path.join(dataDir, KEY_FILE))
  } catch (err) {
    if (err.code === 'ENOENT') return 'issuer-mismatch'
    throw err
  }
  return checkIssuerCert(cert, keyPair, association) ?? 'ok'
}

// The moderation store of an existing moderation.json, or null when there is
// none yet (the service creates it at start): the read-only commands never
// create the file. Opening an existing one writes no file (it only
// re-applies the 0o700 mode of the data dir, as the service does).
function existingModeration (dataDir, association) {
  if (!fs.existsSync(path.join(dataDir, MODERATION_FILE))) return null
  return openModerationStore(dataDir, { association })
}

// { open, pending, publishedSeq } of the desk; zeros before the first start;
// null when moderation.json cannot be read (the store answers 'indisponivel').
function moderationStatus (dataDir, association) {
  try {
    const moderation = existingModeration(dataDir, association)
    if (moderation === null) return { open: 0, pending: 0, publishedSeq: null }
    const { open, pending, publishedSeq } = moderation.stats()
    return { open, pending, publishedSeq }
  } catch {
    return null
  }
}

// { exemplars } of the AI triage's precedents (exemplars.json), or null when
// the file does not exist (the triage never ran here); 'indisponivel' when
// it cannot be read. Read-only: the file is parsed, never opened through
// the store (which would create or chmod), as existingModeration does.
function triageStatus (dataDir) {
  let raw
  try {
    raw = fs.readFileSync(path.join(dataDir, EXEMPLARS_FILE), 'utf8')
  } catch (err) {
    return err.code === 'ENOENT' ? null : 'indisponivel'
  }
  try {
    const obj = JSON.parse(raw)
    if (obj === null || typeof obj !== 'object' || !Array.isArray(obj.items)) return 'indisponivel'
    return { exemplars: obj.items.length }
  } catch {
    return 'indisponivel'
  }
}

function status (dataDir, given) {
  const association = checkConfig(dataDir, given)
  const publicKey = issuerPublicKey(dataDir)
  const certificate = certificateState(dataDir, association)
  const accounts = openAccountStore(dataDir, { readOnly: true })
  const links = accounts.exportLinks().length
  const moderation = moderationStatus(dataDir, association)
  const triage = triageStatus(dataDir)
  const terms = termsCount(dataDir)
  const invites = invitesCount(dataDir)
  const push = pushStatus(dataDir)
  return { association, publicKey, certificate, configured: publicKey !== null && certificate === 'ok', links, restored: accounts.restored, moderation, triage, terms, invites, push, running: lockHeld(dataDir) }
}

// The number of members with a recorded acceptance of the terms, or
// 'indisponivel' when terms.json is not one the store would have written.
function termsCount (dataDir) {
  const terms = openTermsStore(dataDir, { readOnly: true })
  return terms.available() ? terms.count() : 'indisponivel'
}

// { total, used } over invites.json (a missing file is no invite yet), or
// 'indisponivel' when it is not one the store would have written. Never a
// code or an inviter key; the weekly allowance is environment, not file
// state, so it is not reported here.
function invitesCount (dataDir) {
  const invites = openInvitesStore(dataDir, { readOnly: true })
  return invites.available() ? invites.count() : 'indisponivel'
}

function invitesLine (count) {
  if (count === 'indisponivel') return 'convites: indisponível (invites.json inválido)'
  return 'convites: ' + count.total + ' (' + count.used + ' usados)'
}

function termsLine (count) {
  if (count === 'indisponivel') return 'aceites dos termos: indisponível (terms.json inválido)'
  return 'aceites dos termos: ' + count
}

function triageLine (triage) {
  if (triage === null) return 'Triagem IA: desligada'
  if (triage === 'indisponivel') return 'Triagem IA: indisponível (exemplars.json inválido)'
  return 'Triagem IA: ' + triage.exemplars + ' precedentes'
}

// The directory ends below its high-water mark (directory.hwm): a snapshot
// and journal restored from an older backup, which the service refuses to
// open (store.js, "Restore"). Read-only commands still read it and say so;
// the operator who meant it removes directory.hwm (README).
const RESTORED_LINE = 'aviso: diretório de contas restaurado de uma cópia antiga; confira o backup'

function warnRestored (accounts) {
  if (accounts.restored) process.stderr.write(RESTORED_LINE + '\n')
}

function certificateLine (certificate) {
  if (certificate === 'ok') return 'certificado: válido'
  if (certificate === 'missing') return 'certificado: ausente (use account cert add)'
  return 'certificado: inválido (' + safe(certificate) + ')'
}

function statusLines (s) {
  const lines = [
    'associação: ' + s.association,
    'chave do emissor: ' + (s.publicKey === null ? 'ausente (use account key)' : s.publicKey),
    certificateLine(s.certificate)
  ]
  if (!s.configured) lines.push('emissor não certificado')
  lines.push('vínculos: ' + s.links)
  if (s.restored) lines.push(RESTORED_LINE)
  if (s.moderation === null) {
    lines.push('moderação: indisponível (moderation.json inválido)')
  } else {
    lines.push(
      'denúncias abertas: ' + s.moderation.open,
      'mudanças pendentes: ' + s.moderation.pending,
      'lista publicada: ' + (s.moderation.publishedSeq === null ? 'nenhuma' : 'seq ' + s.moderation.publishedSeq)
    )
  }
  lines.push(triageLine(s.triage))
  lines.push(termsLine(s.terms))
  lines.push(invitesLine(s.invites))
  lines.push(pushLine(s.push))
  lines.push('estado: ' + (s.running ? 'em execução' : 'parado'))
  return lines.join('\n')
}

// The AI report triage's settings, or null when VARANDA_AI is unset or ''
// (off). Validated by shape only and never printed. VARANDA_TRIAGE_TOKEN is
// the Bearer token of the seeder's loopback post route: the seeder service
// reads the SAME variable (deploy/seeder/*.env), so both must be given the
// same 64-hex value.
// The seeder's loopback HTTP listener (default DEFAULT_SEEDER_HTTP), without
// a trailing slash. Read even with the AI off: a group block is confirmed
// against its public /index/group route (../account/group-check.js).
function readSeederHttp (env) {
  const seederHttp = env.VARANDA_SEEDER_HTTP === undefined || env.VARANDA_SEEDER_HTTP === '' ? DEFAULT_SEEDER_HTTP : env.VARANDA_SEEDER_HTTP
  const m = typeof seederHttp === 'string' ? SEEDER_HTTP_RE.exec(seederHttp) : null
  const port = m === null ? 0 : Number(m[2])
  if (port < 1 || port > 65535) throw new UsageError('VARANDA_SEEDER_HTTP inválido')
  return seederHttp.replace(/\/$/, '')
}

function readTriageEnv (env, dataDir) {
  const ai = env.VARANDA_AI
  if (ai === undefined || ai === '') return null
  if (typeof ai !== 'string' || !Object.hasOwn(AI_MODES, ai)) throw new UsageError('VARANDA_AI inválido')
  const token = env.VARANDA_TRIAGE_TOKEN
  if (typeof token !== 'string' || !HEX64_RE.test(token)) throw new UsageError('VARANDA_TRIAGE_TOKEN inválido')
  const seederHttp = readSeederHttp(env)
  let modelDir = env.VARANDA_AI_MODEL_DIR
  if (modelDir === undefined || modelDir === '') {
    modelDir = typeof dataDir === 'string' ? path.join(dataDir, AI_MODEL_DIR) : null
  }
  if (modelDir !== null && typeof modelDir !== 'string') throw new UsageError('VARANDA_AI_MODEL_DIR inválido')
  return { mode: AI_MODES[ai], token, seederHttp, modelDir }
}

// Read once, validated by shape only; no value is ever printed.
function readEnv (env, dataDir) {
  const origin = env.VARANDA_PUBLIC_ORIGIN
  if (typeof origin !== 'string' || !ORIGIN_RE.test(origin)) throw new UsageError('VARANDA_PUBLIC_ORIGIN inválido')
  const clientId = env.VARANDA_GOOGLE_CLIENT_ID
  if (typeof clientId !== 'string' || !CLIENT_ID_RE.test(clientId)) throw new UsageError('VARANDA_GOOGLE_CLIENT_ID inválido')
  const clientSecret = env.VARANDA_GOOGLE_CLIENT_SECRET
  if (typeof clientSecret !== 'string' || clientSecret.length === 0 || clientSecret.length > MAX_SECRET) {
    throw new UsageError('VARANDA_GOOGLE_CLIENT_SECRET inválido')
  }
  const modEmails = parseModEmails(env.VARANDA_MODERATOR_EMAILS)
  // Not a usage error (exit 1), and never the value.
  if (modEmails === null) throw new Error('VARANDA_MODERATOR_EMAILS inválido')
  // Stats admins are a subset of the moderators: the stats tab lives inside
  // the moderation panel, whose sign-in only moderators pass. Like the list
  // above, an error exit 1 that never carries the value.
  const statsEmails = parseModEmails(env.VARANDA_STATS_EMAILS)
  if (statsEmails === null || statsEmails.some((e) => !modEmails.includes(e))) throw new Error('VARANDA_STATS_EMAILS inválido')
  // Ignored while stats are off, so a leftover value never stops a service
  // that does not use it.
  let seederHealth = null
  if (statsEmails.length > 0) {
    seederHealth = parseSeederHealthUrl(env.VARANDA_SEEDER_HEALTH)
    if (seederHealth === null) throw new UsageError('VARANDA_SEEDER_HEALTH inválido')
  }
  const triage = readTriageEnv(env, dataDir)
  const seederHttp = readSeederHttp(env)
  // Read even with the AI off: a block of a group report needs the reported
  // message, read through the seeder's token-gated loopback route
  // (../account/group-check.js). Unset or '' leaves group blocks refused.
  const tokenEnv = env.VARANDA_TRIAGE_TOKEN
  let groupToken = null
  if (tokenEnv !== undefined && tokenEnv !== '') {
    if (typeof tokenEnv !== 'string' || !HEX64_RE.test(tokenEnv)) throw new UsageError('VARANDA_TRIAGE_TOKEN inválido')
    groupToken = tokenEnv
  }
  return { origin, clientId, clientSecret, modEmails, statsEmails, seederHealth, seederHttp, groupToken, limits: readLimits(env), triage, didit: readDiditEnv(env), hodle: readHodleEnv(env) }
}

// Hosted age verification: both variables set is on, both unset or empty is
// off, one alone is a mistake the operator must see. No value is ever echoed.
function readDiditEnv (env) {
  const apiKey = env.VARANDA_DIDIT_API_KEY
  const workflowId = env.VARANDA_DIDIT_WORKFLOW_ID
  const hasKey = apiKey !== undefined && apiKey !== ''
  const hasWorkflow = workflowId !== undefined && workflowId !== ''
  if (!hasKey && !hasWorkflow) return null
  if (hasKey !== hasWorkflow) throw new UsageError('VARANDA_DIDIT_API_KEY e VARANDA_DIDIT_WORKFLOW_ID vêm juntas')
  if (typeof apiKey !== 'string' || apiKey.length > MAX_SECRET || !DIDIT_KEY_RE.test(apiKey)) {
    throw new UsageError('VARANDA_DIDIT_API_KEY inválido')
  }
  if (typeof workflowId !== 'string' || !UUID_RE.test(workflowId)) throw new UsageError('VARANDA_DIDIT_WORKFLOW_ID inválido')
  let dailyLimit = DIDIT_DAILY_DEFAULT
  const raw = env.VARANDA_DIDIT_DAILY_LIMIT
  const text = typeof raw === 'string' ? raw.trim() : null
  if (raw !== undefined && text !== '') {
    const value = text !== null && CANONICAL_INT_RE.test(text) ? Number(text) : NaN
    if (!(value >= 1 && value <= DIDIT_DAILY_MAX)) throw new UsageError('VARANDA_DIDIT_DAILY_LIMIT inválido')
    dailyLimit = value
  }
  return { apiKey, workflowId, dailyLimit }
}

// The optional payments account with Hodle: off unless the API key is set,
// and then every other VARANDA_HODLE_* and VARANDA_FEE_* is ignored, except
// a PIN variable, refused either way. No value is ever echoed.
function readHodleEnv (env) {
  for (const name of FORBIDDEN_PIN_VARS) {
    if (env[name] !== undefined && env[name] !== '') throw new UsageError(name + ' não é aceito')
  }
  const apiKey = env.VARANDA_HODLE_API_KEY
  if (apiKey === undefined || apiKey === '') return null
  if (typeof apiKey !== 'string' || apiKey.length > MAX_SECRET || !HODLE_KEY_RE.test(apiKey)) {
    throw new UsageError('VARANDA_HODLE_API_KEY inválido')
  }
  const network = optionalChoice(env.VARANDA_HODLE_NETWORK, HODLE_NETWORKS, 'polygon', 'VARANDA_HODLE_NETWORK inválido')
  const mode = optionalChoice(env.VARANDA_HODLE_MODE, HODLE_MODES, 'cadastro', 'VARANDA_HODLE_MODE inválido')
  let dailyLimit = HODLE_DAILY_DEFAULT
  const raw = env.VARANDA_HODLE_DAILY_LIMIT
  const text = typeof raw === 'string' ? raw.trim() : null
  if (raw !== undefined && text !== '') {
    const value = text !== null && CANONICAL_INT_RE.test(text) ? Number(text) : NaN
    if (!(value >= 1 && value <= HODLE_DAILY_MAX)) throw new UsageError('VARANDA_HODLE_DAILY_LIMIT inválido')
    dailyLimit = value
  }
  let maxCents = HODLE_MAX_CENTS_DEFAULT
  const rawMax = env.VARANDA_HODLE_MAX_CENTS
  const maxText = typeof rawMax === 'string' ? rawMax.trim() : null
  if (rawMax !== undefined && maxText !== '') {
    const value = maxText !== null && CANONICAL_INT_RE.test(maxText) ? Number(maxText) : NaN
    if (!(value >= HODLE_MAX_CENTS_MIN && value <= HODLE_MAX_CENTS_MAX)) throw new UsageError('VARANDA_HODLE_MAX_CENTS inválido')
    maxCents = value
  }
  const fees = readFeesEnv(env, mode)
  let webhookSecrets
  try {
    // Kept as the strings Hodle shows: the HMAC is keyed with the text.
    webhookSecrets = parseWebhookSecrets(env.VARANDA_HODLE_WEBHOOK_SECRETS)
  } catch {
    throw new UsageError('VARANDA_HODLE_WEBHOOK_SECRETS inválido')
  }
  return { apiKey, network, mode, dailyLimit, maxCents, fees, webhookSecrets }
}

// parseFees (../account/fees.js) names only the variable in its RangeError.
function readFeesEnv (env, mode) {
  let fees
  try {
    fees = parseFees(env)
  } catch (err) {
    if (err instanceof RangeError) throw new UsageError(err.message)
    throw err
  }
  const charged = FEE_KINDS_BY_MODE[mode]
  for (const [kind, rate] of Object.entries(fees.rates)) {
    if (charged.includes(kind)) continue
    const prefix = 'VARANDA_FEE_' + kind.toUpperCase()
    if (rate.cents !== 0) throw new UsageError(prefix + '_CENTS não suportado no modo ' + mode)
    if (rate.bps !== 0) throw new UsageError(prefix + '_BPS não suportado no modo ' + mode)
  }
  return fees
}

function optionalChoice (raw, choices, fallback, message) {
  if (raw === undefined || raw === '') return fallback
  if (typeof raw !== 'string' || !choices.includes(raw)) throw new UsageError(message)
  return raw
}

// Builds and returns the triage worker, or null when it cannot run: a
// missing or tampered model ('sem-modelo') logs its token and the service
// goes on without AI (the healthcheck stays green, reports go to humans).
// The heavy modules are required here only, so a service with VARANDA_AI
// off never loads them.
async function openTriage ({ config, dataDir, association, moderation, log }) {
  const { createEmbedder } = require('../account/ai/embedder')
  const { createPostReader } = require('../account/ai/read-post')
  const { openExemplarStore } = require('../account/ai/exemplar-store')
  const { openLedger } = require('../account/ai/ledger')
  const { createWorker } = require('../account/ai/worker')
  let embedder
  try {
    embedder = await createEmbedder({ modelDir: config.modelDir })
  } catch (err) {
    log({ event: 'triage', reason: err && err.code === 'sem-modelo' ? 'sem-modelo' : 'erro' })
    return null
  }
  try {
    const reader = createPostReader({
      baseUrl: config.seederHttp,
      token: config.token,
      association,
      // The issuers revoked by the last published list, as the seeder's gate.
      revokedIssuers: () => revokedIssuerSet(moderation.pending().published.snapshot)
    })
    const exemplars = openExemplarStore(dataDir, { model: embedder.modelId })
    const ledger = openLedger(dataDir)
    const worker = createWorker({
      mode: config.mode,
      moderation,
      exemplars,
      ledger,
      readPost: (args) => reader.read(args),
      embed: (text) => embedder.embed(text),
      log,
      modelId: embedder.modelId
    })
    return { worker, embedder }
  } catch (err) {
    await embedder.close().catch(() => {})
    log({ event: 'triage', reason: 'erro' })
    return null
  }
}

// -> { [option]: integer } holding only the variables that were set.
function readLimits (env) {
  const limits = {}
  for (const [name, [option, min, max]] of Object.entries(LIMIT_ENV)) {
    const raw = env[name]
    if (raw === undefined) continue
    const text = typeof raw === 'string' ? raw.trim() : null
    if (text === '') continue
    const value = text !== null && CANONICAL_INT_RE.test(text) ? Number(text) : NaN
    if (!(value >= min && value <= max)) throw new UsageError(name + ' inválido')
    limits[option] = value
  }
  return limits
}

// For the operator (LGPD access requests, legal orders): every report row
// (optionally only those about `member`), with the reporter's and the
// target's directory contact ({ email, username } | null). Reads only
// directory.json and moderation.json, never the issuer key; safe while the
// service runs (both files are replaced whole by rename).
function reportRows (dataDir, given, member) {
  const association = checkConfig(dataDir, given)
  const accounts = openAccountStore(dataDir, { readOnly: true })
  warnRestored(accounts)
  const moderation = existingModeration(dataDir, association)
  if (moderation === null) return []
  const contactOf = (key) => {
    const c = accounts.contact(key)
    return c === null ? null : { email: c.email, username: c.username }
  }
  let rows
  try {
    rows = moderation.exportRows(member === null ? {} : { member })
  } catch {
    throw new Error('moderação indisponível (moderation.json inválido)')
  }
  return rows.map((row) => ({ ...row, reporterContact: contactOf(row.reporter), targetContact: contactOf(row.target) }))
}

function eventLine (event) {
  switch (event.event) {
    case 'listening': return 'account ' + safe(event.host) + ' ' + safe(event.port)
    case 'ready': return 'account ' + (event.configured ? 'ready' : 'unconfigured')
    default: return safe(event.event) + (event.reason === undefined ? '' : ' ' + safe(event.reason))
  }
}

async function serve (flags, env) {
  const host = flags.accountHost || DEFAULT_HOST
  if (host === '0.0.0.0' || host === '::') throw new UsageError('account-host inválido')
  const port = flags.accountPort === null ? DEFAULT_PORT : flags.accountPort
  const { origin, clientId, clientSecret, modEmails, statsEmails, seederHealth, seederHttp, groupToken, limits, triage: triageConfig, didit: diditConfig, hodle: hodleConfig } = readEnv(env, flags.dataDir)
  const { maxMembers = null, invitesPerWeek = null, maxPending, maxConnections, ratePerSecond, burst } = limits
  const association = ensureConfig(flags.dataDir, flags.association)
  const log = (event) => {
    process.stdout.write((flags.json ? jsonLine(event) : eventLine(event)) + '\n')
  }
  const google = createGoogle({ clientId, clientSecret, redirectUri: origin + '/account/callback' })
  const googleMod = createGoogle({ clientId, clientSecret, redirectUri: origin + '/account/mod/callback' })

  // The lock comes first (single writer), the store after it. Its heartbeat
  // keeps the lock live; once the lock is no longer ours (removed, or
  // another token on disk) another writer may exist, so the store refuses
  // every write and the service stops and exits non-zero (Docker restarts
  // it; see takeLock).
  let stop
  let stopRequested = false
  const stopped = new Promise((resolve) => {
    stop = () => {
      stopRequested = true
      resolve()
    }
  })
  let lost = false
  let unavailable = false
  let store = null
  let terms = null
  let invites = null
  let pushStore = null
  let stopHeal = null
  let stopInvitesHeal = null
  let stopPushHeal = null
  let ages = null
  let stopAgeHeal = null
  let wallets = null
  let stopWalletHeal = null
  let ops = null
  let stopOpsHeal = null
  let stopOpsPrune = null
  const lock = takeLock(flags.dataDir, {
    onLost: () => {
      lost = true
      loseLock(store, log, stop, terms, invites, pushStore, ages, wallets, ops)
    }
  })
  let listener = null
  let triage = null
  let usage = null
  let closing = 'skipped'
  const onSignal = () => stop()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    try {
      store = openAccountStore(flags.dataDir, {
        maxMembers,
        maxPending,
        onUnavailable: () => {
          unavailable = true
          storeUnavailable(log, stop)
        }
      })
    } catch (err) {
      // A directory restored from an older backup (store.js, "Restore"): a
      // security event, logged as such before the error stops the service.
      if (err.code === 'RESTAURADO') log({ event: 'store', reason: 'restaurado' })
      throw err
    }
    // The terms acceptances (terms.json): every write asks the lock again.
    // An invalid file leaves the routes answering 'indisponivel'; the rest
    // of the service still runs.
    terms = openTermsStore(flags.dataDir, { guard: () => lock.owned() })
    if (!terms.available()) log({ event: 'terms', reason: 'indisponivel' })
    stopHeal = startTermsHeal(terms, log)
    // Signup invites (invites.json), only when VARANDA_INVITES_PER_WEEK is
    // set: unset, nothing is opened or created. The directory is the
    // single-use authority (isUsed). An invalid file keeps the service up and
    // the server refuses new members (fail closed).
    if (invitesPerWeek !== null) {
      invites = openInvitesStore(flags.dataDir, { guard: () => lock.owned(), perWeek: invitesPerWeek, isUsed: (id) => store.inviteUsed(id) })
      if (!invites.available()) log({ event: 'invites', reason: 'indisponivel' })
      stopInvitesHeal = startHeal(invites, 'invites', log)
    }
    // Web Push: on only with a valid push-vapid.json. A malformed one is
    // logged as a token (never its bytes) and push stays off; the key route
    // then answers 'indisponivel' and nothing is delivered.
    let vapid = loadVapid(flags.dataDir)
    if (vapid === 'malformed') {
      log({ event: 'push', reason: 'indisponivel' })
      vapid = null
    }
    pushStore = openPushStore(flags.dataDir, { guard: () => lock.owned() })
    if (!pushStore.available()) log({ event: 'push', reason: 'indisponivel' })
    stopPushHeal = startHeal(pushStore, 'push', log)
    const push = {
      pushStore,
      vapid: vapid === null ? null : { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: origin },
      relayTokenHash: flags.pushToken ? nodeCrypto.createHash('sha256').update(flags.pushToken).digest() : null
    }
    log({ event: 'push', reason: vapid !== null ? 'ligado' : 'desligado' })
    // Hosted age verification (age.json), only with the Didit pair set. An
    // invalid file keeps the service up and the age routes fail closed.
    let didit = null
    if (diditConfig !== null) {
      didit = createDidit({ apiKey: diditConfig.apiKey, workflowId: diditConfig.workflowId })
      ages = openAgeStore(flags.dataDir, { guard: () => lock.owned() })
      if (!ages.available()) log({ event: 'idade', reason: 'indisponivel' })
      stopAgeHeal = startHeal(ages, 'idade', log)
    }
    // 'desligada' reminds the operator that nobody is being asked.
    log({ event: 'idade', reason: didit !== null ? 'ligada' : 'desligada' })
    // The payments account (wallet.json), only with VARANDA_HODLE_API_KEY
    // set. The routes log 'ligada' or 'desligada' themselves; an unreadable
    // file is logged here and keeps the service up with the routes failing
    // closed.
    let hodle = null
    if (hodleConfig !== null) {
      hodle = createHodle({ apiKey: hodleConfig.apiKey, network: hodleConfig.network })
      wallets = openWalletStore(flags.dataDir, { guard: () => lock.owned() })
      if (!wallets.available()) log({ event: 'carteira', reason: 'indisponivel' })
      stopWalletHeal = startHeal(wallets, 'carteira', log)
      // The money ledger (wallet-ops.json), opened in every mode so rows
      // written under pix stay readable after a step back to carteira.
      ops = openWalletOpsStore(flags.dataDir, { guard: () => lock.owned() })
      if (!ops.available()) log({ event: 'carteira', reason: 'indisponivel' })
      stopOpsHeal = startHeal(ops, 'carteira', log)
      stopOpsPrune = startPrune(ops)
      log({ event: 'carteira', reason: feesActive(hodleConfig.fees.rates) ? 'taxa-ligada' : 'taxa-desligada' })
    }
    const moderation = openModerationStore(flags.dataDir, { association })
    const issuer = loadIssuer(flags.dataDir, association, log)
    if (triageConfig === null) log({ event: 'triage', reason: 'desligada' })
    else {
      triage = await openTriage({ config: triageConfig, dataDir: flags.dataDir, association, moderation, log })
      if (triage !== null) log({ event: 'triage', reason: triageConfig.mode })
    }
    // Usage statistics only when someone may see them. usage.json is written
    // under the same gate as the account store: never once the lock is lost
    // or the store failed. Days are Brasília calendar days (localDay), the
    // same day the seeder's activeDay counts.
    if (statsEmails.length > 0) {
      const reader = createSeederHealthReader({ baseUrl: seederHealth })
      usage = createUsageStats({
        dataDir: flags.dataDir,
        accounts: store,
        readSeeder: () => reader.read(),
        log,
        dayOf: localDay,
        canWrite: () => !lost && !unavailable && lock.owned()
      })
    }
    log({ event: 'usage', reason: usage === null ? 'desligada' : 'ligada' })
    // A signal (or a lost lock) during the model load: do not open the port
    // or start the worker; go straight to the cleanup below.
    if (!stopRequested) {
      const groupCheck = createGroupCheck({ baseUrl: seederHttp, token: groupToken })
      const server = createAccountServer({ association, origin, google, store, issuer, log, moderation, googleMod, modEmails, statsEmails, usage, triage: triage === null ? null : triage.worker, groupCheck, terms, invites, push, didit, ages, ageDailyLimit: diditConfig === null ? undefined : diditConfig.dailyLimit, hodle, wallets, walletMode: hodleConfig === null ? undefined : hodleConfig.mode, walletDailyLimit: hodleConfig === null ? undefined : hodleConfig.dailyLimit, walletNetwork: hodleConfig === null ? undefined : hodleConfig.network, ops, fees: hodleConfig === null ? null : hodleConfig.fees, walletMaxCents: hodleConfig === null ? undefined : hodleConfig.maxCents, walletWebhookSecrets: hodleConfig === null ? null : hodleConfig.webhookSecrets, maxConnections, ratePerSecond, burst })
      try {
        listener = await server.listen({ host, port })
      } catch (err) {
        if (err.code === 'EADDRINUSE') throw new Error('porta em uso')
        throw new Error('não foi possível abrir o serviço de conta (' + safe(err.code || err.message) + ')')
      }
      log({ event: 'listening', host: listener.host, port: listener.port })
      log({ event: 'ready', configured: issuer !== null, ...(maxMembers === null ? {} : { maxMembers }), ...(invitesPerWeek === null ? {} : { invitesPerWeek }) })
      if (triage !== null) triage.worker.start()
      if (usage !== null) usage.start()
      await stopped
    }
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (listener) await listener.close()
    // The worker ends its running job (bounded) before the lock goes: it
    // writes moderation.json, exemplars.json and the ledger.
    if (triage !== null) {
      await triage.worker.stop()
      // close() waits for the inference chain; a hung inference must not
      // keep the lock held forever, so the wait is bounded.
      await Promise.race([
        triage.embedder.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, EMBEDDER_CLOSE_MS).unref())
      ])
    }
    // The terms file is healed one last time (a stale writer's rename may
    // have dropped acknowledged entries) while the lock is still held.
    if (stopHeal !== null) stopHeal()
    if (stopInvitesHeal !== null) stopInvitesHeal()
    if (stopPushHeal !== null) stopPushHeal()
    if (stopAgeHeal !== null) stopAgeHeal()
    if (stopWalletHeal !== null) stopWalletHeal()
    if (stopOpsHeal !== null) stopOpsHeal()
    if (stopOpsPrune !== null) stopOpsPrune()
    if (terms !== null && terms.available()) await terms.heal()
    if (invites !== null && invites.available()) await invites.heal()
    if (pushStore !== null && pushStore.available()) await pushStore.heal()
    if (ages !== null && ages.available()) await ages.heal()
    if (wallets !== null && wallets.available()) await wallets.heal()
    if (ops !== null && ops.available()) await ops.heal()
    // The sampler waits for an in-flight read and writes the day's last
    // counts while the lock is still ours; a lost lock or a failed store
    // skips the write, as closeIfOwned below does.
    if (usage !== null) await usage.stop({ flush: !lost && !unavailable && lock.owned() })
    // A failed store has nothing it could fold safely (close() would only
    // answer 'indisponivel'), so it is skipped like a lost lock.
    closing = await closeIfOwned(store, lock, lost || unavailable, log)
    lock.release()
  }
  return lost || unavailable || closing === 'failed' ? 1 : 0
}

// The store marked itself unavailable at runtime (writer guard, a failed
// fsync or reload): every mutation would answer 'indisponivel' until a
// restart re-reads the disk, so the service logs it (no personal data) and
// stops, and serve() exits non-zero (Docker restarts it).
function storeUnavailable (log, stop) {
  log({ event: 'store', reason: 'indisponivel' })
  stop()
}

// The lock is lost: the store is marked unavailable first, synchronously,
// so no request still draining during the stop appends beside the writer
// that took the lock over (store.js, "Writer guard"); then the service
// stops. The terms, invites, push, age, wallet and ledger stores too: their
// next write must not land either.
function loseLock (store, log, stop, terms = null, invites = null, pushStore = null, ages = null, wallets = null, ops = null) {
  if (store !== null) store.fail()
  if (terms !== null) terms.fail()
  if (invites !== null) invites.fail()
  if (pushStore !== null) pushStore.fail()
  if (ages !== null) ages.fail()
  if (wallets !== null) wallets.fail()
  if (ops !== null) ops.fail()
  log({ event: 'lock', reason: 'perdido' })
  stop()
}

// A stale writer's rename can replace terms.json after a takeover and drop
// acceptances this holder acknowledged; nothing else rewrites the file until
// the next accept. So the holder merge-writes it on the lock heartbeat's
// interval (terms-store.js heal(): a no-op unless the file lacks something).
// The invites and push sidecars have the same window (invites-store.js and
// push-store.js heal()).
// -> stop(), which clears the interval.
function startTermsHeal (terms, log, ms = LOCK_HEARTBEAT_MS) {
  return startHeal(terms, 'terms', log, ms)
}

function startHeal (sidecar, event, log, ms = LOCK_HEARTBEAT_MS) {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      if (await sidecar.heal()) log({ event, reason: 'reparado' })
    } finally {
      running = false
    }
  }, ms)
  timer.unref()
  return () => clearInterval(timer)
}

// Final ledger rows older than 90 days go (wallet-ops-store.js prune). A
// failed prune is retried on the next tick; the store already refuses writes
// once the lock is lost.
function startPrune (ops, ms = WALLET_PRUNE_MS) {
  let running = false
  const timer = setInterval(async () => {
    if (running || !ops.available()) return
    running = true
    try {
      await ops.prune(Date.now())
    } catch {} finally {
      running = false
    }
  }, ms)
  timer.unref()
  return () => clearInterval(timer)
}

// A clean stop folds the journal into a complete v1 directory.json, so the
// previous build can open it after a rollback. Never once the lock is lost:
// another writer may own the directory by then. The heartbeat notices a
// takeover only on its next tick, so the lock file is read again right
// before closing. A close that fails (the directory may stay v2) is logged
// without detail and makes serve() exit non-zero.
// -> 'closed' | 'skipped' | 'failed'.
async function closeIfOwned (store, lock, lost, log = () => {}) {
  if (store === null || lost || !lock.owned()) return 'skipped'
  try {
    await store.close()
  } catch {
    log({ event: 'close', reason: 'falhou' })
    return 'failed'
  }
  return 'closed'
}

async function run (flags) {
  const [sub, subsub] = flags.positionals
  if (sub === undefined) return serve(flags, process.env)

  if (sub === 'key' && subsub === undefined) {
    ensureConfig(flags.dataDir, flags.association)
    const publicKey = createKey(flags.dataDir)
    print(flags, { publicKey }, 'chave do emissor: ' + publicKey)
    return 0
  }

  // Only the public half is ever printed.
  if (sub === 'push-key' && subsub === undefined) {
    ensureConfig(flags.dataDir, flags.association)
    const publicKey = createPushKey(flags.dataDir)
    print(flags, { publicKey }, 'chave pública de push: ' + publicKey)
    return 0
  }

  if (sub === 'cert' && subsub === 'add' && flags.positionals.length === 2) {
    if (!flags.certFile) throw new UsageError('informe --cert-file <arquivo>')
    const association = ensureConfig(flags.dataDir, flags.association)
    const result = addCert(flags.dataDir, flags.certFile, association)
    print(flags, result, 'certificado do emissor gravado')
    return 0
  }

  if (sub === 'status' && subsub === undefined) {
    const s = status(flags.dataDir, flags.association)
    print(flags, s, statusLines(s))
    return 0
  }

  // One JSON object per line, for the operator (LGPD access requests):
  // member, sub, e-mail, username and date, plus the member's terms
  // acceptances ({ version, acceptedAt }) and the number of browsers with
  // push notices on (pushDevices); never a signature, certificate, endpoint
  // or secret. Refused while the service runs (its copy is the live one).
  if (sub === 'export' && subsub === undefined) {
    checkConfig(flags.dataDir, flags.association)
    if (lockHeld(flags.dataDir)) throw new Error('serviço de conta em execução')
    const accounts = openAccountStore(flags.dataDir, { readOnly: true })
    warnRestored(accounts)
    const terms = openTermsStore(flags.dataDir, { readOnly: true })
    if (!terms.available()) throw new Error('terms.json inválido')
    const pushStore = openPushStore(flags.dataDir, { readOnly: true })
    if (!pushStore.available()) throw new Error('push.json inválido')
    for (const link of accounts.exportLinks()) {
      process.stdout.write(jsonLine({ ...link, terms: terms.list(link.member), pushDevices: pushStore.devices(link.member) }) + '\n')
    }
    return 0
  }

  if (sub === 'reports' && subsub === undefined) {
    for (const row of reportRows(flags.dataDir, flags.association, flags.member ?? null)) {
      process.stdout.write(jsonLine(row) + '\n')
    }
    return 0
  }

  throw new UsageError(USAGE)
}

module.exports = {
  commands: {
    account: { summary: 'serviço de vínculo de conta Google', run }
  },
  // For tests.
  ensureConfig,
  checkConfig,
  readEnv,
  closeIfOwned,
  loseLock,
  startTermsHeal,
  startHeal,
  storeUnavailable,
  createPushKey,
  writeJsonExclusive
}
