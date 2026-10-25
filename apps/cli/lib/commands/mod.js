'use strict'

const fs = require('node:fs')
const path = require('node:path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { UsageError } = require('../cli')
const { readConfig, writeConfig, writeJsonAtomic, lockDataDir } = require('@varanda/core/lib/store')
const { loadKeyPairFile, saveKeyPairFile, refuseSymlinkDir, verifyModeratorCert } = require('@varanda/core/lib/cert')
const { createSnapshot, verifySnapshot, acceptSnapshot, MAX_BLOCKED, MAX_REVOKED_ISSUERS } = require('@varanda/core/lib/blocklist')
const { appendPrivate } = require('@varanda/core/lib/assoc')
const { safe, jsonLine } = require('@varanda/core/lib/safe')
// Called through the module object so a test can stand in for the network.
const modPublish = require('../mod-publish')

// `mod`: the moderation key on the operator's machine (README "Bloquear uma
// conta"). Its data dir holds config.json { v: 1, role: 'moderator',
// association[, seeder] }, the moderator key pair (moderator.json, 0o600,
// never printed and never sent anywhere), the certificate the association
// signed for it (moderator-cert.json), the last signed snapshot
// (blocklist.json, { v: 1, snapshot }) and an audit log (moderation.jsonl).
// A member, seeder, account or association dir is refused. The snapshot
// holds public keys only: the list says WHICH accounts are blocked, never
// why. Publishing goes to the association's seeder only, by its Noise key
// (--seeder, or `seeder` stored by `mod init --seeder`; mod-publish.js).
// `mod apply --server <origin>` signs the decisions taken in the account
// service's moderation panel (mod-apply.js).
const USAGE = 'node bin/varanda.js mod init|show|cert add|block|unblock|revoke-issuer|unrevoke-issuer|publish|apply'
const NO_SEEDER = 'informe --seeder <chave do semeador> (seed status a mostra) ou use --no-publish'
const NO_LIST = 'este diretório não tem lista anterior; copie o blocklist.json da moderação anterior para cá ou, se é a primeira lista da associação, use --new-list'
const HEX64_RE = /^[0-9a-f]{64}$/
const KEY_FILE = 'moderator.json'
const CERT_FILE = 'moderator-cert.json'
const LIST_FILE = 'blocklist.json'
const LOG_FILE = 'moderation.jsonl'
const SOURCE_OPERATOR = 'operacao'
const SOURCE_PANEL = 'painel'
// Files that mark the dir as another role's (an association dir has no config.json).
const FOREIGN_FILES = ['association.json', 'seeder-key.json', 'issuer-key.json', 'store']

// op -> which list it edits, the jsonl field naming the key, whether it adds,
// and the two output lines (changed / unchanged).
const OPS = {
  block: { list: 'blocked', field: 'member', add: true, changed: 'conta bloqueada: ', same: 'já estava bloqueada: ' },
  unblock: { list: 'blocked', field: 'member', add: false, changed: 'conta desbloqueada: ', same: 'não estava bloqueada: ' },
  'revoke-issuer': { list: 'revokedIssuers', field: 'issuer', add: true, changed: 'emissor revogado: ', same: 'emissor já estava revogado: ' },
  'unrevoke-issuer': { list: 'revokedIssuers', field: 'issuer', add: false, changed: 'revogação desfeita: ', same: 'emissor não estava revogado: ' }
}
const LIMITS = { blocked: MAX_BLOCKED, revokedIssuers: MAX_REVOKED_ISSUERS }

function print (flags, result, line) {
  process.stdout.write((flags.json ? jsonLine(result) : line) + '\n')
}

function notModDir () {
  return new Error('diretório não é da moderação')
}

function configuredAssociation (config, given) {
  if (config === null || typeof config !== 'object' || config.role !== 'moderator') throw notModDir()
  if (typeof config.association !== 'string' || !HEX64_RE.test(config.association)) throw notModDir()
  if (given !== null && given !== config.association) throw new Error('associação diferente da configurada')
  if (config.seeder !== undefined && (typeof config.seeder !== 'string' || !HEX64_RE.test(config.seeder))) {
    throw new Error('chave do semeador gravada inválida')
  }
  return config.association
}

// Read-only checks of `mod init`: the association of an existing mod dir, or
// null for a dir that may become one (no other role's files, so a member,
// seeder, account or association dir, and any dir with a corestore, is never
// locked or written by `mod`).
function initChecks (dataDir, given) {
  refuseSymlinkDir(dataDir)
  const config = readConfig(dataDir)
  if (config !== null) return configuredAssociation(config, given)
  for (const name of FOREIGN_FILES) {
    if (fs.existsSync(path.join(dataDir, name))) throw notModDir()
  }
  if (given === null) throw new UsageError('informe --association ou VARANDA_ASSOCIATION')
  return null
}

// `mod init` fixes the trust root in config.json (as `account key` does).
// `--seeder` stores the seeder's Noise key the publishing commands dial; on
// an existing dir it only sets or changes that field. Runs under the lock,
// so the checks are repeated there.
function ensureConfig (dataDir, given, seeder) {
  const association = initChecks(dataDir, given)
  if (association === null) {
    const config = { v: 1, role: 'moderator', association: given }
    if (seeder !== null) config.seeder = seeder
    writeConfig(dataDir, config)
    return given
  }
  if (seeder !== null) writeConfig(dataDir, { ...readConfig(dataDir), seeder })
  return association
}

// Every command that writes the mod dir holds the data-dir lock (the same
// one openStore takes, store.js lockDataDir) from its first read to its last
// write and through the publish: two `mod block` on one dir would otherwise
// both read seq N and sign different snapshots N+1, peers keep whichever
// arrives first and reject the other as stale, and one change is lost
// although its command reported success. A held lock fails at once.
async function withLock (dataDir, fn) {
  let release
  try {
    release = await lockDataDir(dataDir)
  } catch (err) {
    if (err.code === 'LOCKED') throw new Error('outra operação de moderação em andamento')
    throw err
  }
  try {
    return await fn()
  } finally {
    release()
  }
}

function checkConfig (dataDir, given) {
  refuseSymlinkDir(dataDir)
  const config = readConfig(dataDir)
  if (config === null) throw notModDir()
  return configuredAssociation(config, given)
}

// The seeder key a publishing command dials: --seeder, else the one stored
// by `mod init --seeder`. Resolved before the lock and before anything is
// signed, so a command that could not publish leaves the list untouched.
function resolveSeeder (dataDir, flags) {
  if (flags.seeder) return flags.seeder
  const config = readConfig(dataDir)
  if (config && typeof config.seeder === 'string') return config.seeder
  throw new Error(NO_SEEDER)
}

function loadKeyPair (dataDir) {
  try {
    return loadKeyPairFile(path.join(dataDir, KEY_FILE))
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('chave da moderação ausente (use mod init)')
    throw err
  }
}

function publicKeyOrNull (dataDir) {
  try {
    return b4a.toString(loadKeyPairFile(path.join(dataDir, KEY_FILE)).publicKey, 'hex')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

// Idempotent and never clobbers: an existing key is kept and only its public
// half is printed (saveKeyPairFile publishes with a hard link, EEXIST on a race).
function createKey (dataDir) {
  const existing = publicKeyOrNull(dataDir)
  if (existing !== null) return existing
  const kp = crypto.keyPair()
  try {
    saveKeyPairFile(path.join(dataDir, KEY_FILE), kp)
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    return publicKeyOrNull(dataDir)
  }
  return b4a.toString(kp.publicKey, 'hex')
}

function readJsonFile (file, invalid) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(invalid)
  }
  // Only a missing file reads as absent: a parsed null would otherwise
  // restart the list at seq 1 and drop every block (peers keep the old one).
  if (value === null) throw new Error(invalid)
  return value
}

// The certificate must verify for this association and name this key.
function checkCert (certificate, publicKey, association) {
  const verdict = verifyModeratorCert(certificate, association)
  if (!verdict.ok) return verdict.reason
  if (certificate.moderator !== publicKey) return 'moderator-mismatch'
  return null
}

function addCert (dataDir, certFile, association) {
  let certificate
  try {
    certificate = JSON.parse(fs.readFileSync(certFile, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('arquivo não encontrado: ' + safe(certFile))
    throw new Error('certificado da moderação inválido (malformed)')
  }
  const publicKey = b4a.toString(loadKeyPair(dataDir).publicKey, 'hex')
  const reason = checkCert(certificate, publicKey, association)
  if (reason === 'moderator-mismatch') throw new Error('certificado da moderação é de outra chave')
  if (reason !== null) throw new Error('certificado da moderação inválido (' + safe(reason) + ')')
  writeJsonAtomic(path.join(dataDir, CERT_FILE), certificate, 0o600)
  return { moderator: certificate.moderator }
}

// 'ok', 'missing' or the reason the stored certificate fails.
function certificateState (dataDir, publicKey, association) {
  let certificate
  try {
    certificate = readJsonFile(path.join(dataDir, CERT_FILE), 'malformed')
  } catch {
    return 'malformed'
  }
  if (certificate === null) return 'missing'
  if (publicKey === null) return 'moderator-mismatch'
  return checkCert(certificate, publicKey, association) ?? 'ok'
}

function loadCert (dataDir, publicKey, association) {
  const certificate = readJsonFile(path.join(dataDir, CERT_FILE), 'certificado da moderação inválido (malformed)')
  if (certificate === null) throw new Error('certificado da moderação ausente (use mod cert add)')
  const reason = checkCert(certificate, publicKey, association)
  if (reason !== null) throw new Error('certificado da moderação inválido (' + safe(reason) + ')')
  return certificate
}

// The last snapshot this dir signed, or null when there is none yet. Unlike a
// node's readBlocklist (store.js, a torn file reads as absent), a damaged file
// here is an error: restarting at seq 1 would sign a list every node ignores
// as stale.
function loadSnapshot (dataDir, association) {
  const data = readJsonFile(path.join(dataDir, LIST_FILE), 'lista gravada inválida')
  if (data === null) return null
  if (typeof data !== 'object' || data.v !== 1 || !verifySnapshot(data.snapshot, association).ok) {
    throw new Error('lista gravada inválida')
  }
  return data.snapshot
}

function listKey (value) {
  if (value === undefined || value === null) throw new UsageError('informe a chave')
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new UsageError('chave inválida')
  return value.toLowerCase()
}

// Builds, signs and stores the next snapshot from `edits` ([{ op, key }],
// applied in order); the audit log gets one line per edit with the op, the
// key, the new seq, the date and the source: 'painel' for `mod apply` (a
// decision taken in the account service's panel), 'operacao' for the
// operator's own commands (never a signature or a secret). Lines written
// before the field existed read as 'operacao' (blockSources).
// A dir without a list starts one only with --new-list: after a moderator
// rotation (fresh dir, newer moderator certificate) a list signed from empty
// sets would be accepted everywhere as newer (blocklist.js acceptSnapshot)
// and silently undo every earlier block and issuer revocation. The rotation
// copies blocklist.json into the new dir and continues from it.
function signNext (dataDir, association, edits, newList, date, source = SOURCE_OPERATOR) {
  const kp = loadKeyPair(dataDir)
  const publicKey = b4a.toString(kp.publicKey, 'hex')
  const certificate = loadCert(dataDir, publicKey, association)
  const previous = loadSnapshot(dataDir, association)
  if (previous === null && !newList) throw new Error(NO_LIST)
  if (previous !== null && newList) throw new Error('este diretório já tem uma lista')
  const lists = {
    blocked: new Set(previous ? previous.blocked : []),
    revokedIssuers: new Set(previous ? previous.revokedIssuers : [])
  }
  const had = []
  for (const { op, key } of edits) {
    const spec = OPS[op]
    const set = lists[spec.list]
    had.push(set.has(key))
    if (spec.add) set.add(key)
    else set.delete(key)
  }
  // Only the final sets must fit: `mod apply` passes its blocks before its
  // unblocks, so a full list with an unblock and a replacement block would
  // overflow midway although the result fits (and retrying never helps).
  // A single-key command has one edit, so its check is unchanged.
  for (const list of ['blocked', 'revokedIssuers']) {
    if (lists[list].size > LIMITS[list]) throw new Error('lista cheia (máximo ' + LIMITS[list] + ')')
  }
  const snapshot = createSnapshot({
    seq: previous ? previous.seq + 1 : 1,
    date,
    blocked: [...lists.blocked],
    revokedIssuers: [...lists.revokedIssuers]
  }, kp, certificate)
  // A stored list from a newer moderator certificate would make ours stale everywhere.
  if (!acceptSnapshot(previous, snapshot, association).ok) throw new Error('a lista gravada é de uma moderação mais recente')
  writeJsonAtomic(path.join(dataDir, LIST_FILE), { v: 1, snapshot }, 0o600)
  let lines = ''
  for (const { op, key } of edits) {
    lines += JSON.stringify({ op, [OPS[op].field]: key, seq: snapshot.seq, date: snapshot.date, source }) + '\n'
  }
  if (lines !== '') appendPrivate(path.join(dataDir, LOG_FILE), lines)
  return { snapshot, had }
}

function change (dataDir, association, op, key, newList) {
  const { snapshot, had } = signNext(dataDir, association, [{ op, key }], newList, new Date().toISOString())
  return { snapshot, changed: OPS[op].add ? !had[0] : had[0] }
}

// `mod apply` (mod-apply.js): ONE snapshot (seq + 1, as `mod block` and
// `mod unblock` do, so an unblock of an absent key still bumps it) with
// next = (current ∪ block) − unblock, one moderation.jsonl line per key,
// then the publish unless `publish` is null. The caller holds the data-dir
// lock (withLock) through the publish and the ack. Its audit lines carry
// source 'painel'. publish(snapshot) ->
// mod-publish.js { delivered, conflict, peers }.
// -> { snapshot, published, result } (result: the publish answer or null).
async function applySet (dataDir, { block = [], unblock = [] } = {}, { association, newList = false, publish = null, now = () => new Date() } = {}) {
  const edits = []
  for (const key of block) edits.push({ op: 'block', key: checkedKey(key) })
  for (const key of unblock) edits.push({ op: 'unblock', key: checkedKey(key) })
  const { snapshot } = signNext(dataDir, association, edits, newList, now().toISOString(), SOURCE_PANEL)
  if (publish === null) return { snapshot, published: false, result: null }
  const result = await publish(snapshot)
  return { snapshot, published: !!(result && result.delivered === true), result }
}

function checkedKey (key) {
  if (typeof key !== 'string' || !HEX64_RE.test(key)) throw new TypeError('invalid key')
  return key
}

function listLine (snapshot) {
  if (snapshot === null) return 'lista vazia'
  return 'lista seq ' + snapshot.seq + ' de ' + snapshot.date + ': ' + snapshot.blocked.length + ' contas bloqueadas, ' +
    snapshot.revokedIssuers.length + ' emissores revogados'
}

function certificateLine (state) {
  if (state === 'ok') return 'certificado: válido'
  if (state === 'missing') return 'certificado: ausente (use mod cert add)'
  return 'certificado: inválido (' + safe(state) + ')'
}

async function run (flags) {
  const sub = flags.positionals[0]
  const dataDir = flags.dataDir
  if (sub === 'init') {
    if (initChecks(dataDir, flags.association) === null) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    return withLock(dataDir, () => {
      const association = ensureConfig(dataDir, flags.association, flags.seeder)
      const publicKey = createKey(dataDir)
      print(flags, { association, publicKey }, 'chave da moderação: ' + publicKey)
      return 0
    })
  }
  if (sub === 'cert') {
    if (flags.positionals[1] !== 'add') throw new UsageError(USAGE)
    if (!flags.certFile) throw new UsageError('informe --cert-file <arquivo>')
    const association = checkConfig(dataDir, flags.association)
    return withLock(dataDir, () => {
      const result = addCert(dataDir, flags.certFile, association)
      print(flags, result, 'certificado da moderação gravado')
      return 0
    })
  }
  if (sub === 'show') {
    const association = checkConfig(dataDir, flags.association)
    const publicKey = publicKeyOrNull(dataDir)
    const certificate = certificateState(dataDir, publicKey, association)
    const snapshot = loadSnapshot(dataDir, association)
    const lines = [
      'associação: ' + association,
      'chave da moderação: ' + (publicKey === null ? 'ausente (use mod init)' : publicKey),
      certificateLine(certificate),
      listLine(snapshot)
    ]
    print(flags, { association, publicKey, certificate, snapshot }, lines.join('\n'))
    return 0
  }
  if (sub === 'publish') {
    if (flags.positionals.length > 1) throw new UsageError(USAGE)
    if (flags.noPublish) throw new UsageError('--no-publish não se aplica a mod publish')
    const association = checkConfig(dataDir, flags.association)
    const seeder = resolveSeeder(dataDir, flags)
    return withLock(dataDir, () => republish(flags, dataDir, association, seeder))
  }
  if (sub === 'apply') {
    if (flags.positionals.length > 1) throw new UsageError(USAGE)
    // apply exists to publish and then acknowledge: an ack for a list no
    // seeder holds would empty the panel's queue for nothing.
    if (flags.noPublish) throw new UsageError('apply publica; não aceita --no-publish')
    // Loaded here: mod-apply.js requires this module for applySet.
    const modApply = require('../mod-apply')
    const server = modApply.checkServer(flags.server)
    const association = checkConfig(dataDir, flags.association)
    const seeder = resolveSeeder(dataDir, flags)
    // Decided before the lock and before any request: without a terminal
    // to review the changes, only --yes runs (and it applies blocks only).
    const interactive = !!(process.stdin.isTTY && process.stdout.isTTY)
    modApply.checkMode({ yes: flags.yes, interactive })
    return withLock(dataDir, () => modApply.apply({
      dir: dataDir,
      association,
      server,
      newList: flags.newList,
      json: flags.json,
      yes: flags.yes,
      interactive,
      publish: (snapshot) => sendTo(flags, snapshot, association, seeder)
    }))
  }
  if (Object.prototype.hasOwnProperty.call(OPS, sub)) {
    const key = listKey(flags.positionals[1])
    if (flags.positionals.length > 2) throw new UsageError(USAGE)
    const association = checkConfig(dataDir, flags.association)
    const seeder = flags.noPublish ? null : resolveSeeder(dataDir, flags)
    return withLock(dataDir, () => changeAndPublish(flags, dataDir, association, sub, key, seeder))
  }
  throw new UsageError(USAGE)
}

function sendTo (flags, snapshot, association, seeder) {
  return modPublish.publish({
    snapshot,
    association,
    seeder,
    bootstrap: flags.bootstrap,
    host: flags.dhtHost,
    timeoutMs: flags.timeoutMs || modPublish.DEFAULT_TIMEOUT_MS
  })
}

function conflictMessage (snapshot) {
  return 'o semeador já tem outra lista com o mesmo número (seq ' + snapshot.seq + '); isto acontece ao restaurar uma cópia antiga da moderação'
}

// The one-line error `mod apply` exits with when a publish was not delivered.
function publishFailedMessage (result, snapshot) {
  return result && result.conflict ? conflictMessage(snapshot) : 'não foi possível publicar a lista'
}

// The signed list stays in blocklist.json; `mod publish` re-sends it.
// A conflict (mod-publish.js header: the seeder holds another list with the
// same seq, typically after restoring an old backup of this dir) has its
// own message: re-sending the same list would never succeed.
function publishFailed (result, snapshot) {
  if (result && result.conflict) {
    process.stderr.write('erro: ' + conflictMessage(snapshot) + '\n')
    process.stderr.write('faça uma nova alteração (ela recebe um número maior) ou rode mod publish depois de recuperar a lista mais recente\n')
    return 1
  }
  process.stderr.write('erro: não foi possível publicar a lista\n')
  process.stderr.write('a lista ficou gravada; rode mod publish quando o semeador estiver no ar\n')
  return 1
}

async function changeAndPublish (flags, dataDir, association, sub, key, seeder) {
  const { snapshot, changed } = change(dataDir, association, sub, key, flags.newList)
  if (!flags.json) {
    process.stdout.write((changed ? OPS[sub].changed : OPS[sub].same) + key + '\n')
    process.stdout.write('lista seq ' + snapshot.seq + ' gravada\n')
  }
  let published = false
  let result = null
  if (!flags.noPublish) {
    result = await sendTo(flags, snapshot, association, seeder)
    published = result.delivered
  }
  if (flags.json) {
    process.stdout.write(jsonLine({ op: sub, key, changed, published, snapshot }) + '\n')
  } else if (flags.noPublish) {
    process.stdout.write('lista não publicada (--no-publish)\n')
  } else if (published) {
    process.stdout.write('lista publicada\n')
  }
  if (!flags.noPublish && !published) return publishFailed(result, snapshot)
  return 0
}

// `mod publish`: the stored list, unchanged (no seq bump, no audit line).
async function republish (flags, dataDir, association, seeder) {
  const snapshot = loadSnapshot(dataDir, association)
  if (snapshot === null) throw new Error('nenhuma lista para publicar')
  const result = await sendTo(flags, snapshot, association, seeder)
  const delivered = result.delivered
  if (flags.json) process.stdout.write(jsonLine({ op: 'publish', published: delivered, snapshot }) + '\n')
  else if (delivered) process.stdout.write('lista seq ' + snapshot.seq + ' publicada\n')
  if (!delivered) return publishFailed(result, snapshot)
  return 0
}

// For mod-apply.js: key -> source ('operacao' | 'painel') of the LAST
// 'block' line of each of `keys` in moderation.jsonl. A key with no block
// line (a list copied from another dir, or older than the log) and a line
// without the field read as 'operacao': a block made outside the panel.
// Unreadable lines are skipped.
function blockSources (dataDir, keys) {
  const wanted = new Set(keys)
  const sources = new Map()
  for (const key of wanted) sources.set(key, SOURCE_OPERATOR)
  if (wanted.size === 0) return sources
  let text
  try {
    text = fs.readFileSync(path.join(dataDir, LOG_FILE), 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return sources
    throw err
  }
  for (const raw of text.split('\n')) {
    if (raw === '') continue
    let line
    try {
      line = JSON.parse(raw)
    } catch {
      continue
    }
    if (line === null || typeof line !== 'object' || line.op !== 'block' || !wanted.has(line.member)) continue
    sources.set(line.member, line.source === SOURCE_PANEL ? SOURCE_PANEL : SOURCE_OPERATOR)
  }
  return sources
}

// For mod-apply.js: the key pair and the certificate, 'moderação não
// certificada' when either file is missing (a damaged or foreign one keeps
// its own message).
function loadModerator (dataDir, association) {
  let keyPair
  try {
    keyPair = loadKeyPairFile(path.join(dataDir, KEY_FILE))
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('moderação não certificada')
    throw err
  }
  const publicKey = b4a.toString(keyPair.publicKey, 'hex')
  if (!fs.existsSync(path.join(dataDir, CERT_FILE))) throw new Error('moderação não certificada')
  return { keyPair, publicKey, certificate: loadCert(dataDir, publicKey, association) }
}

module.exports = {
  applySet,
  blockSources,
  SOURCE_OPERATOR,
  SOURCE_PANEL,
  loadModerator,
  loadSnapshot,
  publishFailedMessage,
  commands: {
    mod: { summary: 'chave da moderação e lista de bloqueio assinada', run }
  }
}
