// Association data dir: key pair, certificate issuing and audit logs (docs/protocol.md section 1).
const fs = require('#fs')
const path = require('#path')
const b4a = require('b4a')
const cert = require('./cert')

function keyFile (dir) {
  return path.join(dir, 'association.json')
}

function codedError (message, code) {
  const err = new Error(message)
  err.code = code
  return err
}

// Appends one line to a private audit log (created 0o600, tightened if it already
// existed). Opened with O_NOFOLLOW and O_NONBLOCK (a planted FIFO is refused at
// once instead of blocking until a reader shows up: ENXIO with no reader, or
// the fstat check below) and checked on the descriptor BEFORE anything is
// written, so a planted symlink (or any non-regular file) is refused and its
// target never touched; a regular file is then written normally.
function appendPrivate (file, line) {
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd
  try {
    fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EMLINK') throw new Error('registro de auditoria é um link simbólico')
    if (err.code === 'ENXIO') throw new Error('registro de auditoria inválido')
    throw err
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('registro de auditoria inválido')
    fs.fchmodSync(fd, 0o600)
    fs.writeFileSync(fd, line)
  } finally {
    fs.closeSync(fd)
  }
}

function lstatExists (file) {
  try {
    fs.lstatSync(file)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

function initAssociation (dir) {
  cert.refuseSymlinkDir(dir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  cert.refuseSymlinkDir(dir)
  fs.chmodSync(dir, 0o700)
  const file = keyFile(dir)
  if (lstatExists(file)) throw codedError('associação já existe', 'ALREADY_INITIALIZED')
  const kp = cert.generateAssociationKeyPair()
  try {
    // No-clobber publish (hard link): of two concurrent inits exactly one succeeds.
    cert.saveAssociationKeyPair(file, kp)
  } catch (err) {
    if (err.code === 'EEXIST') throw codedError('associação já existe', 'ALREADY_INITIALIZED')
    throw err
  }
  return { publicKey: b4a.toString(kp.publicKey, 'hex') }
}

function loadKeyPair (dir) {
  cert.refuseSymlinkDir(dir)
  const file = keyFile(dir)
  // lstat: a dangling planted symlink is not "not initialized", it is refused
  // by the O_NOFOLLOW read below.
  if (!lstatExists(file)) throw codedError('associação não inicializada', 'NOT_INITIALIZED')
  return cert.loadAssociationKeyPair(file)
}

function showAssociation (dir) {
  const kp = loadKeyPair(dir)
  return { publicKey: b4a.toString(kp.publicKey, 'hex') }
}

function issueCertificate (dir, { member, ageBand = '18+', method = 'stub' } = {}) {
  const kp = loadKeyPair(dir)
  const issued = cert.createCert({ member, ageBand, method }, kp)
  // TODO(phase1): the real age-check vendor decides here; today the operator asserts the age band.
  // Store only public key, age band, method and date — never a face image or a document.
  const line = JSON.stringify({
    member: issued.member,
    ageBand: issued.ageBand,
    method: issued.method,
    date: issued.date
  }) + '\n'
  appendPrivate(path.join(dir, 'members.jsonl'), line)
  return issued
}

function issueSeederCertificate (dir, { seeder } = {}) {
  const kp = loadKeyPair(dir)
  const issued = cert.createSeederCert({ seeder }, kp)
  // Only the seeder key and the date are recorded: never a signature or a secret.
  const line = JSON.stringify({ seeder: issued.seeder, date: issued.date }) + '\n'
  appendPrivate(path.join(dir, 'seeders.jsonl'), line)
  return issued
}

// The association signs a delegation to the account service's issuer key. Only the
// issuer key and the date are recorded: never a signature or a secret. No key is
// generated here: the issuer pair lives in the account volume.
function issueIssuerCertificate (dir, { issuer } = {}) {
  const kp = loadKeyPair(dir)
  // Checked before signing so a mistyped association key is a clear error (createIssuerCert refuses it too).
  if (typeof issuer === 'string' && issuer.toLowerCase() === b4a.toString(kp.publicKey, 'hex')) {
    throw new TypeError('issuer must differ from the association')
  }
  const issued = cert.createIssuerCert({ issuer }, kp)
  const line = JSON.stringify({ issuer: issued.issuer, date: issued.date }) + '\n'
  appendPrivate(path.join(dir, 'issuers.jsonl'), line)
  return issued
}

// The association signs a delegation to the moderation key (blocklist
// snapshots, packages/core/lib/blocklist.js). Only the moderator key and the
// date are recorded: never a signature or a secret. No key is generated here:
// the moderator pair lives in the moderation dir (`mod init`).
function issueModeratorCertificate (dir, { moderator } = {}) {
  const kp = loadKeyPair(dir)
  // Checked before signing so a mistyped association key is a clear error (createModeratorCert refuses it too).
  if (typeof moderator === 'string' && moderator.toLowerCase() === b4a.toString(kp.publicKey, 'hex')) {
    throw new TypeError('moderator must differ from the association')
  }
  const issued = cert.createModeratorCert({ moderator }, kp)
  const line = JSON.stringify({ moderator: issued.moderator, date: issued.date }) + '\n'
  appendPrivate(path.join(dir, 'moderators.jsonl'), line)
  return issued
}

module.exports = {
  initAssociation,
  showAssociation,
  issueCertificate,
  issueSeederCertificate,
  issueIssuerCertificate,
  issueModeratorCertificate,
  appendPrivate
}
