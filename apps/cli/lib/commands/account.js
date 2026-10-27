'use strict'

const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { UsageError } = require('../cli')
const { readConfig, writeConfig, writeJsonAtomic } = require('@varanda/core/lib/store')
const { loadKeyPairFile, saveKeyPairFile, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { safe, jsonLine } = require('@varanda/core/lib/safe')
const { createGoogle } = require('../account/google')
const { openAccountStore } = require('../account/store')
const { openModerationStore, FILE: MODERATION_FILE } = require('../account/moderation-store')
const { parseModEmails } = require('../account/mod-routes')
const { revokedIssuerSet } = require('@varanda/core/lib/blocklist')
const { FILE: EXEMPLARS_FILE } = require('../account/ai/exemplar-store')
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
  lockHeld
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
const USAGE = 'node bin/varanda.js account [key|cert add|status|export|reports [--member <hex>]]'
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
  const links = openAccountStore(dataDir, { readOnly: true }).exportLinks().length
  const moderation = moderationStatus(dataDir, association)
  const triage = triageStatus(dataDir)
  return { association, publicKey, certificate, configured: publicKey !== null && certificate === 'ok', links, moderation, triage, running: lockHeld(dataDir) }
}

function triageLine (triage) {
  if (triage === null) return 'Triagem IA: desligada'
  if (triage === 'indisponivel') return 'Triagem IA: indisponível (exemplars.json inválido)'
  return 'Triagem IA: ' + triage.exemplars + ' precedentes'
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
  lines.push('estado: ' + (s.running ? 'em execução' : 'parado'))
  return lines.join('\n')
}

// The AI report triage's settings, or null when VARANDA_AI is unset or ''
// (off). Validated by shape only and never printed. VARANDA_TRIAGE_TOKEN is
// the Bearer token of the seeder's loopback post route: the seeder service
// reads the SAME variable (deploy/seeder/*.env), so both must be given the
// same 64-hex value.
function readTriageEnv (env, dataDir) {
  const ai = env.VARANDA_AI
  if (ai === undefined || ai === '') return null
  if (typeof ai !== 'string' || !Object.hasOwn(AI_MODES, ai)) throw new UsageError('VARANDA_AI inválido')
  const token = env.VARANDA_TRIAGE_TOKEN
  if (typeof token !== 'string' || !HEX64_RE.test(token)) throw new UsageError('VARANDA_TRIAGE_TOKEN inválido')
  const seederHttp = env.VARANDA_SEEDER_HTTP === undefined || env.VARANDA_SEEDER_HTTP === '' ? DEFAULT_SEEDER_HTTP : env.VARANDA_SEEDER_HTTP
  const m = typeof seederHttp === 'string' ? SEEDER_HTTP_RE.exec(seederHttp) : null
  const port = m === null ? 0 : Number(m[2])
  if (port < 1 || port > 65535) throw new UsageError('VARANDA_SEEDER_HTTP inválido')
  let modelDir = env.VARANDA_AI_MODEL_DIR
  if (modelDir === undefined || modelDir === '') {
    modelDir = typeof dataDir === 'string' ? path.join(dataDir, AI_MODEL_DIR) : null
  }
  if (modelDir !== null && typeof modelDir !== 'string') throw new UsageError('VARANDA_AI_MODEL_DIR inválido')
  return { mode: AI_MODES[ai], token, seederHttp: seederHttp.replace(/\/$/, ''), modelDir }
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
  const triage = readTriageEnv(env, dataDir)
  return { origin, clientId, clientSecret, modEmails, triage }
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

// For the operator (LGPD access requests, legal orders): every report row
// (optionally only those about `member`), with the reporter's and the
// target's directory contact ({ email, username } | null). Reads only
// directory.json and moderation.json, never the issuer key; safe while the
// service runs (both files are replaced whole by rename).
function reportRows (dataDir, given, member) {
  const association = checkConfig(dataDir, given)
  const accounts = openAccountStore(dataDir, { readOnly: true })
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
  const { origin, clientId, clientSecret, modEmails, triage: triageConfig } = readEnv(env, flags.dataDir)
  const association = ensureConfig(flags.dataDir, flags.association)
  const log = (event) => {
    process.stdout.write((flags.json ? jsonLine(event) : eventLine(event)) + '\n')
  }
  const google = createGoogle({ clientId, clientSecret, redirectUri: origin + '/account/callback' })
  const googleMod = createGoogle({ clientId, clientSecret, redirectUri: origin + '/account/mod/callback' })

  // The lock comes first (single writer), the store after it. Its heartbeat
  // keeps the lock live; once the lock is no longer ours (removed, or
  // another token on disk) another writer may exist, so the service stops
  // and exits non-zero (Docker restarts it; see takeLock).
  let stop
  let stopRequested = false
  const stopped = new Promise((resolve) => {
    stop = () => {
      stopRequested = true
      resolve()
    }
  })
  let lost = false
  const lock = takeLock(flags.dataDir, {
    onLost: () => {
      lost = true
      log({ event: 'lock', reason: 'perdido' })
      stop()
    }
  })
  let listener = null
  let triage = null
  const onSignal = () => stop()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    const store = openAccountStore(flags.dataDir)
    const moderation = openModerationStore(flags.dataDir, { association })
    const issuer = loadIssuer(flags.dataDir, association, log)
    if (triageConfig === null) log({ event: 'triage', reason: 'desligada' })
    else {
      triage = await openTriage({ config: triageConfig, dataDir: flags.dataDir, association, moderation, log })
      if (triage !== null) log({ event: 'triage', reason: triageConfig.mode })
    }
    // A signal (or a lost lock) during the model load: do not open the port
    // or start the worker; go straight to the cleanup below.
    if (stopRequested) return lost ? 1 : 0
    const server = createAccountServer({ association, origin, google, store, issuer, log, moderation, googleMod, modEmails, triage: triage === null ? null : triage.worker })
    try {
      listener = await server.listen({ host, port })
    } catch (err) {
      if (err.code === 'EADDRINUSE') throw new Error('porta em uso')
      throw new Error('não foi possível abrir o serviço de conta (' + safe(err.code || err.message) + ')')
    }
    log({ event: 'listening', host: listener.host, port: listener.port })
    log({ event: 'ready', configured: issuer !== null })
    if (triage !== null) triage.worker.start()
    await stopped
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
    lock.release()
  }
  return lost ? 1 : 0
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
  // member, sub, e-mail, username and date; never a signature, certificate
  // or secret. Refused while the service runs (its copy is the live one).
  if (sub === 'export' && subsub === undefined) {
    checkConfig(flags.dataDir, flags.association)
    if (lockHeld(flags.dataDir)) throw new Error('serviço de conta em execução')
    for (const link of openAccountStore(flags.dataDir, { readOnly: true }).exportLinks()) {
      process.stdout.write(jsonLine(link) + '\n')
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
  readEnv
}
