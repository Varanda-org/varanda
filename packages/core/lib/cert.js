// Membership (v1 and v2), issuer and seeder certificates, the `username`
// record (docs/protocol.md section 3) and key pair files.
const fs = require('#fs')
const path = require('#path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')

const LF = '\n'
const MEMBER_PREFIX = 'varanda-cert-v1'
const MEMBER_PREFIX_V2 = 'varanda-cert-v2'
const SEEDER_PREFIX = 'varanda-seeder-v1'
const ISSUER_PREFIX = 'varanda-issuer-v1'
const USERNAME_PREFIX = 'varanda-username-v1'
const MEMBER_KEYS = ['v', 'member', 'ageBand', 'method', 'date', 'association', 'signature']
const MEMBER_KEYS_V2 = ['v', 'member', 'ageBand', 'method', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']
const SEEDER_KEYS = ['v', 'seeder', 'date', 'association', 'signature']
const ISSUER_KEYS = ['v', 'issuer', 'date', 'association', 'signature']
const USERNAME_KEYS = ['type', 'username', 'member', 'date', 'association', 'issuer', 'issuerDate', 'issuerSignature', 'signature']
const AGE_BAND_RE = /^[a-z0-9+-]{1,32}$/
const METHOD_RE = /^[a-z0-9-]{1,32}$/
// A v2 certificate asserts no age: its issuer only links a Google account.
const AGE_BAND_V2 = 'unchecked'
const METHOD_V2 = 'google'
const USERNAME_RE = /^[a-z][a-z0-9_]{2,19}$/
// A 6-hex name would read like the fallback handle '@' + key.slice(0, 6)
// (apps/app/src/format.js:7-9), so it is never a username.
const FALLBACK_HANDLE_RE = /^[0-9a-f]{6}$/

function isHex (str, bytes) {
  return typeof str === 'string' && str.length === bytes * 2 && /^[0-9a-fA-F]*$/.test(str)
}

function normalizeHex (str) {
  if (typeof str !== 'string' || str.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(str)) return null
  return str.toLowerCase()
}

function isLowerHex (str, bytes) {
  return typeof str === 'string' && str.length === bytes * 2 && /^[0-9a-f]*$/.test(str)
}

function isCanonicalIso (s) {
  try {
    return typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s
  } catch {
    return false
  }
}

function isPlainObject (o) {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const proto = Object.getPrototypeOf(o)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (o, keys) {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))
}

function isUsername (s) {
  return typeof s === 'string' && USERNAME_RE.test(s) && !FALLBACK_HANDLE_RE.test(s)
}

function isKeyBytes (buf, length) {
  return (b4a.isBuffer(buf) || buf instanceof Uint8Array) && buf.byteLength === length
}

function certPayload (cert) {
  return b4a.from([
    MEMBER_PREFIX,
    cert.member.toLowerCase(),
    cert.ageBand,
    cert.method,
    cert.date,
    cert.association.toLowerCase()
  ].join(LF), 'utf8')
}

function seederCertPayload (cert) {
  return b4a.from([
    SEEDER_PREFIX,
    cert.seeder.toLowerCase(),
    cert.date,
    cert.association.toLowerCase()
  ].join(LF), 'utf8')
}

function issuerCertPayload (cert) {
  return b4a.from([
    ISSUER_PREFIX,
    cert.issuer.toLowerCase(),
    cert.date,
    cert.association.toLowerCase()
  ].join(LF), 'utf8')
}

function certPayloadV2 (cert) {
  return b4a.from([
    MEMBER_PREFIX_V2,
    cert.member.toLowerCase(),
    cert.ageBand,
    cert.method,
    cert.date,
    cert.association.toLowerCase(),
    cert.issuer.toLowerCase(),
    cert.issuerDate,
    cert.issuerSignature.toLowerCase()
  ].join(LF), 'utf8')
}

function usernameRecordPayload (record) {
  return b4a.from([
    USERNAME_PREFIX,
    record.username,
    record.member.toLowerCase(),
    record.date,
    record.association.toLowerCase(),
    record.issuer.toLowerCase(),
    record.issuerDate,
    record.issuerSignature.toLowerCase()
  ].join(LF), 'utf8')
}

function checkKeyPair (keyPair) {
  if (!keyPair || !isKeyBytes(keyPair.secretKey, 64) || !isKeyBytes(keyPair.publicKey, 32)) {
    throw new TypeError('association key pair must have a 32-byte public key and a 64-byte secret key')
  }
}

function createCert ({ member, ageBand = '18+', method = 'stub', date = new Date().toISOString() } = {}, keyPair) {
  if (!isHex(member, 32)) throw new TypeError('member must be 64 hex characters')
  if (typeof ageBand !== 'string' || !AGE_BAND_RE.test(ageBand)) throw new TypeError('invalid ageBand')
  if (typeof method !== 'string' || !METHOD_RE.test(method)) throw new TypeError('invalid method')
  if (!isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  checkKeyPair(keyPair)
  const cert = {
    v: 1,
    member: member.toLowerCase(),
    ageBand,
    method,
    date,
    association: b4a.toString(keyPair.publicKey, 'hex'),
    signature: ''
  }
  cert.signature = b4a.toString(crypto.sign(certPayload(cert), keyPair.secretKey), 'hex')
  return cert
}

function createSeederCert ({ seeder, date = new Date().toISOString() } = {}, keyPair) {
  if (!isHex(seeder, 32)) throw new TypeError('seeder must be 64 hex characters')
  if (!isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  checkKeyPair(keyPair)
  const cert = {
    v: 1,
    seeder: seeder.toLowerCase(),
    date,
    association: b4a.toString(keyPair.publicKey, 'hex'),
    signature: ''
  }
  cert.signature = b4a.toString(crypto.sign(seederCertPayload(cert), keyPair.secretKey), 'hex')
  return cert
}

// Signed by the association: lets `issuer` sign v2 member certificates and
// username records on its behalf.
function createIssuerCert ({ issuer, date = new Date().toISOString() } = {}, keyPair) {
  if (!isHex(issuer, 32)) throw new TypeError('issuer must be 64 hex characters')
  if (!isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  checkKeyPair(keyPair)
  const association = b4a.toString(keyPair.publicKey, 'hex')
  if (issuer.toLowerCase() === association) throw new TypeError('issuer must differ from the association')
  const cert = {
    v: 1,
    issuer: issuer.toLowerCase(),
    date,
    association,
    signature: ''
  }
  cert.signature = b4a.toString(crypto.sign(issuerCertPayload(cert), keyPair.secretKey), 'hex')
  return cert
}

// Refuses an issuer certificate that is malformed, does not verify for its
// own association or names another key than the signing key pair, so the
// issuer never signs anything a verifier would reject.
function checkIssuer (keyPair, issuerCert) {
  if (!keyPair || !isKeyBytes(keyPair.secretKey, 64) || !isKeyBytes(keyPair.publicKey, 32)) {
    throw new TypeError('issuer key pair must have a 32-byte public key and a 64-byte secret key')
  }
  if (validateIssuerCertShape(issuerCert) !== null) throw new TypeError('invalid issuer certificate')
  if (b4a.toString(keyPair.publicKey, 'hex') !== issuerCert.issuer) throw new TypeError('issuer certificate is for another key')
  if (!verifyIssuerCert(issuerCert, issuerCert.association).ok) throw new TypeError('invalid issuer certificate')
}

function createIssuedCert ({ member, date = new Date().toISOString() } = {}, issuerKeyPair, issuerCert) {
  if (!isHex(member, 32)) throw new TypeError('member must be 64 hex characters')
  if (!isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  checkIssuer(issuerKeyPair, issuerCert)
  const cert = {
    v: 2,
    member: member.toLowerCase(),
    ageBand: AGE_BAND_V2,
    method: METHOD_V2,
    date,
    association: issuerCert.association,
    issuer: issuerCert.issuer,
    issuerDate: issuerCert.date,
    issuerSignature: issuerCert.signature,
    signature: ''
  }
  cert.signature = b4a.toString(crypto.sign(certPayloadV2(cert), issuerKeyPair.secretKey), 'hex')
  return cert
}

function createUsernameRecord ({ member, username, date = new Date().toISOString() } = {}, issuerKeyPair, issuerCert) {
  if (!isHex(member, 32)) throw new TypeError('member must be 64 hex characters')
  if (!isUsername(username)) throw new TypeError('invalid username')
  if (!isCanonicalIso(date)) throw new TypeError('date must be a canonical ISO-8601 UTC string')
  checkIssuer(issuerKeyPair, issuerCert)
  const record = {
    type: 'username',
    username,
    member: member.toLowerCase(),
    date,
    association: issuerCert.association,
    issuer: issuerCert.issuer,
    issuerDate: issuerCert.date,
    issuerSignature: issuerCert.signature,
    signature: ''
  }
  record.signature = b4a.toString(crypto.sign(usernameRecordPayload(record), issuerKeyPair.secretKey), 'hex')
  return record
}

function v1ShapeReason (cert) {
  if (cert.v !== 1) return 'malformed'
  if (!isLowerHex(cert.member, 32) || !isLowerHex(cert.association, 32)) return 'malformed'
  if (!isLowerHex(cert.signature, 64)) return 'malformed'
  if (typeof cert.ageBand !== 'string' || !AGE_BAND_RE.test(cert.ageBand)) return 'malformed'
  if (typeof cert.method !== 'string' || !METHOD_RE.test(cert.method)) return 'malformed'
  if (!isCanonicalIso(cert.date)) return 'malformed'
  return null
}

// The issuer fields shared by a v2 certificate and a username record.
function validDelegation (o) {
  return isLowerHex(o.association, 32) &&
    isLowerHex(o.issuer, 32) &&
    o.issuer !== o.association &&
    isLowerHex(o.issuerSignature, 64) &&
    isCanonicalIso(o.issuerDate)
}

function v2ShapeReason (cert) {
  if (cert.v !== 2) return 'malformed'
  if (!isLowerHex(cert.member, 32) || !validDelegation(cert)) return 'malformed'
  if (!isLowerHex(cert.signature, 64)) return 'malformed'
  if (cert.ageBand !== AGE_BAND_V2 || cert.method !== METHOD_V2) return 'malformed'
  if (!isCanonicalIso(cert.date)) return 'malformed'
  return null
}

// null for a valid v1 or v2 membership certificate shape, else 'malformed'.
// Same rule as validCertShape in records.js (which does not import this file).
function validateCertShape (cert) {
  try {
    if (!isPlainObject(cert)) return 'malformed'
    if (hasExactKeys(cert, MEMBER_KEYS)) return v1ShapeReason(cert)
    if (hasExactKeys(cert, MEMBER_KEYS_V2)) return v2ShapeReason(cert)
    return 'malformed'
  } catch {
    return 'malformed'
  }
}

function validateIssuerCertShape (cert) {
  try {
    if (!isPlainObject(cert) || !hasExactKeys(cert, ISSUER_KEYS)) return 'malformed'
    if (cert.v !== 1) return 'malformed'
    if (!isLowerHex(cert.issuer, 32) || !isLowerHex(cert.association, 32)) return 'malformed'
    if (cert.issuer === cert.association) return 'malformed'
    if (!isLowerHex(cert.signature, 64)) return 'malformed'
    if (!isCanonicalIso(cert.date)) return 'malformed'
    return null
  } catch {
    return 'malformed'
  }
}

// Same rule as the `username` case of validateRecord in records.js.
function validateUsernameRecordShape (record) {
  try {
    if (!isPlainObject(record) || !hasExactKeys(record, USERNAME_KEYS)) return 'malformed'
    if (record.type !== 'username' || !isUsername(record.username)) return 'malformed'
    if (!isLowerHex(record.member, 32) || !validDelegation(record)) return 'malformed'
    if (!isLowerHex(record.signature, 64)) return 'malformed'
    if (!isCanonicalIso(record.date)) return 'malformed'
    return null
  } catch {
    return 'malformed'
  }
}

function validateSeederCertShape (cert) {
  try {
    if (!isPlainObject(cert) || !hasExactKeys(cert, SEEDER_KEYS)) return 'malformed'
    if (cert.v !== 1) return 'malformed'
    if (!isLowerHex(cert.seeder, 32) || !isLowerHex(cert.association, 32)) return 'malformed'
    if (!isLowerHex(cert.signature, 64)) return 'malformed'
    if (!isCanonicalIso(cert.date)) return 'malformed'
    return null
  } catch {
    return 'malformed'
  }
}

function checkSignature (payload, cert) {
  return crypto.verify(payload, b4a.from(cert.signature, 'hex'), b4a.from(cert.association, 'hex'))
}

function verifyIssuerCert (cert, associationHex) {
  try {
    if (validateIssuerCertShape(cert) !== null) return { ok: false, reason: 'malformed' }
    if (!isHex(associationHex, 32)) return { ok: false, reason: 'malformed' }
    if (cert.association !== normalizeHex(associationHex)) return { ok: false, reason: 'untrusted-association' }
    if (!checkSignature(issuerCertPayload(cert), cert)) return { ok: false, reason: 'bad-signature' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

// Shared tail for a v2 certificate or a username record whose shape already
// passed: the association, then the embedded issuer certificate, then the
// issuer's own signature over `payload`.
function verifyIssued (o, payload, associationHex) {
  if (!isHex(associationHex, 32)) return { ok: false, reason: 'malformed' }
  if (o.association !== normalizeHex(associationHex)) return { ok: false, reason: 'untrusted-association' }
  const delegation = { v: 1, issuer: o.issuer, date: o.issuerDate, association: o.association, signature: o.issuerSignature }
  if (!verifyIssuerCert(delegation, o.association).ok) return { ok: false, reason: 'bad-issuer-signature' }
  if (!crypto.verify(payload, b4a.from(o.signature, 'hex'), b4a.from(o.issuer, 'hex'))) return { ok: false, reason: 'bad-signature' }
  return { ok: true }
}

function verifyUsernameRecord (record, memberHex, associationHex) {
  try {
    if (validateUsernameRecordShape(record) !== null) return { ok: false, reason: 'malformed' }
    if (record.member !== normalizeHex(memberHex)) return { ok: false, reason: 'member-mismatch' }
    return verifyIssued(record, usernameRecordPayload(record), associationHex)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

function verifyCert (cert, associationHex) {
  try {
    if (validateCertShape(cert) !== null) return { ok: false, reason: 'malformed' }
    if (cert.v === 2) return verifyIssued(cert, certPayloadV2(cert), associationHex)
    if (!isHex(associationHex, 32)) return { ok: false, reason: 'malformed' }
    if (cert.association !== normalizeHex(associationHex)) return { ok: false, reason: 'untrusted-association' }
    if (!checkSignature(certPayload(cert), cert)) return { ok: false, reason: 'bad-signature' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

function certForKey (cert, keyHex, associationHex) {
  try {
    if (validateCertShape(cert) !== null) return { ok: false, reason: 'malformed' }
    if (cert.member !== normalizeHex(keyHex)) return { ok: false, reason: 'member-mismatch' }
    return verifyCert(cert, associationHex)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

function verifySeederCert (cert, associationHex) {
  try {
    if (validateSeederCertShape(cert) !== null) return { ok: false, reason: 'malformed' }
    if (!isHex(associationHex, 32)) return { ok: false, reason: 'malformed' }
    if (cert.association !== normalizeHex(associationHex)) return { ok: false, reason: 'untrusted-association' }
    if (!checkSignature(seederCertPayload(cert), cert)) return { ok: false, reason: 'bad-signature' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

function seederCertForKey (cert, noiseHex, associationHex) {
  try {
    if (validateSeederCertShape(cert) !== null) return { ok: false, reason: 'malformed' }
    if (cert.seeder !== normalizeHex(noiseHex)) return { ok: false, reason: 'seeder-mismatch' }
    return verifySeederCert(cert, associationHex)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}

function generateAssociationKeyPair () {
  return crypto.keyPair()
}

// A data or association directory that is itself a symlink is refused (lstat),
// so mkdir/chmod and every file below it never follow a planted link. A
// missing directory is fine (the caller may create it).
function refuseSymlinkDir (dir) {
  let st
  try {
    st = fs.lstatSync(dir)
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (st.isSymbolicLink()) throw new Error('diretório é um link simbólico')
}

// Best effort: makes a just-published directory entry durable. Platforms that
// cannot fsync a directory are ignored.
function fsyncDir (dir) {
  let fd
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch {} finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch {}
    }
  }
}

// Reads a key file without following a symlink (O_NOFOLLOW) and without
// blocking on open (O_NONBLOCK: a planted FIFO opens at once instead of
// waiting for a writer); the descriptor is fstat'ed and anything that is not
// a regular file is rejected BEFORE anything is read (a regular file is then
// read normally: O_NONBLOCK has no effect on it). A link or a non-regular
// file is an invalid key file; ENOENT propagates with its code.
function readKeyFile (file) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (err) {
    if (err.code === 'ELOOP' || err.code === 'EMLINK') throw new Error('arquivo de chave inválido')
    throw err
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('arquivo de chave inválido')
    return fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

// Writes { v, publicKey, secretKey } through a unique temp file opened with 'wx' and 0o600
// (never follows a planted symlink), fsynced, then published atomically and the
// parent directory fsynced. Without { overwrite: true } the publish is a hard link,
// which fails with EEXIST when the destination exists, so an existing key is never
// clobbered. A directory that is a symlink is refused.
function saveKeyPairFile (file, kp, { overwrite = false } = {}) {
  const dir = path.dirname(file)
  refuseSymlinkDir(dir)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  refuseSymlinkDir(dir)
  fs.chmodSync(dir, 0o700)
  const body = JSON.stringify({
    v: 1,
    publicKey: b4a.toString(kp.publicKey, 'hex'),
    secretKey: b4a.toString(kp.secretKey, 'hex')
  }, null, 2) + LF
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + b4a.toString(crypto.randomBytes(12), 'hex') + '.tmp')
  const fd = fs.openSync(tmp, 'wx', 0o600)
  try {
    try {
      fs.fchmodSync(fd, 0o600)
      fs.writeFileSync(fd, body)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (overwrite) {
      fs.renameSync(tmp, file)
      fsyncDir(dir)
      return
    }
    try {
      fs.linkSync(tmp, file)
    } catch (err) {
      if (err.code === 'EEXIST') {
        const exists = new Error('arquivo de chave já existe')
        exists.code = 'EEXIST'
        throw exists
      }
      throw err
    }
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
  // After the temp name is unlinked, so the synced directory holds only the key.
  fsyncDir(dir)
}

function loadKeyPairFile (file) {
  refuseSymlinkDir(path.dirname(file))
  const text = readKeyFile(file)
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('arquivo de chave inválido')
  }
  if (!isPlainObject(data) || data.v !== 1 || !isLowerHex(data.publicKey, 32) || !isLowerHex(data.secretKey, 64)) {
    throw new Error('arquivo de chave inválido')
  }
  return {
    publicKey: b4a.from(data.publicKey, 'hex'),
    secretKey: b4a.from(data.secretKey, 'hex')
  }
}

function saveAssociationKeyPair (file, kp, opts) {
  saveKeyPairFile(file, kp, opts)
}

function loadAssociationKeyPair (file) {
  try {
    return loadKeyPairFile(file)
  } catch (err) {
    if (err.message === 'arquivo de chave inválido') throw new Error('chave da associação inválida')
    throw err
  }
}

module.exports = {
  USERNAME_RE,
  isUsername,
  isHex,
  normalizeHex,
  certPayload,
  certPayloadV2,
  createCert,
  createIssuedCert,
  validateCertShape,
  verifyCert,
  certForKey,
  issuerCertPayload,
  createIssuerCert,
  validateIssuerCertShape,
  verifyIssuerCert,
  usernameRecordPayload,
  createUsernameRecord,
  validateUsernameRecordShape,
  verifyUsernameRecord,
  generateAssociationKeyPair,
  refuseSymlinkDir,
  saveKeyPairFile,
  loadKeyPairFile,
  saveAssociationKeyPair,
  loadAssociationKeyPair,
  seederCertPayload,
  createSeederCert,
  validateSeederCertShape,
  verifySeederCert,
  seederCertForKey
}
