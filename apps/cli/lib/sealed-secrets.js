'use strict'

// Shared provider credentials sealed to the seeder servers (`varanda secrets`).
// Pure: no file system, only node:crypto. Every message thrown here carries a
// name or a line number at most, never a value or a secret key.
//
// The recipient public keys sit in clear in the sealed file, so anyone could
// seal other values to the same servers, and nobody but a server can read
// what a pull request changes. So the maintainer who seals also signs: open
// and verify accept a file only when its signer is in the signers file
// pinned in the repository and the signature holds, both checked before any
// decryption.
//
// Sealed file, v1 (JSON, exactly these keys at each level):
//   { "v": 1, "seq": <integer 1 to 4294967295>,
//     "recipients": [ { "publicKey": <64 hex>, "ephemeral": <64 hex>,
//                       "iv": <b64 12 B>, "tag": <b64 16 B>, "key": <b64 32 B> }, ... ],
//     "iv": <b64 12 B>, "tag": <b64 16 B>, "data": <b64>,
//     "signer": <64 hex>, "signature": <b64 64 B> }
//
// Signature: Ed25519 by `signer` over signedBytes, built from the decoded
// fields (parsing is strict: lower-case hex, canonical base64), never from
// the JSON text, so key order and whitespace do not change what is verified:
//   UTF-8("varanda-secrets-signature-v1"), then each field below as
//   uint32be(byte length) || bytes, in this order: v (uint32be, 4 B); seq
//   (uint32be, 4 B); the recipient count (uint32be, 4 B); per recipient in
//   file order publicKey (32 B), ephemeral (32 B), iv, tag, key; iv; tag;
//   data; signer (32 B). Every field but `signature` is covered.
// seq: an older file stays validly signed forever, so each new seal carries
// a larger seq and servers never go back to a lower one on the timer.
// Signers file: the recipients file format (one 64-hex Ed25519 public key
// per line, # starts a comment), 1 to 16 distinct keys.
//
// Payload: a random 32-byte content key encrypts the canonical payload with
// AES-256-GCM (iv, tag, data at the top level). Its AAD is the recipient list:
//   UTF-8("varanda-secrets-v1") followed, for each recipient in the order of
//   the recipients file, by "\n" and its 64 lower-case hex public key.
// Canonical payload: UTF-8 of one "NAME=value\n" line per name, names sorted
// ascending (plain code unit order, they are ASCII), no blank line, no
// comment. Names come from ALLOWED, values are 1 to 4096 printable ASCII
// characters (0x20 to 0x7e) without a single quote or a backslash, with no
// space at either end and not wrapped in double quotes (validValue). The
// split at the first "=" is unambiguous.
// Wrap, per recipient: a fresh ephemeral X25519 pair; shared = X25519(
// ephemeral secret, recipient public); kek = HKDF-SHA256(ikm = shared, salt =
// ephemeral public (32 B) || recipient public (32 B), info =
// "varanda-secrets-v1", 32 B); the content key is encrypted with AES-256-GCM
// under kek (iv, tag, key in the recipient entry).
//
// Server key file: {"v":1,"publicKey":<64 hex>,"secretKey":<64 hex>}, raw
// X25519 keys.
// Signing key file: {"v":1,"type":"varanda-secrets-signing-key",
// "publicKey":<64 hex>,"secretKey":<64 hex>}, raw Ed25519 keys. Each parser
// demands its exact key set, so one kind of file is never taken for the other.

const crypto = require('node:crypto')

const VERSION = 1
const INFO = 'varanda-secrets-v1'
const SIGNATURE_CONTEXT = 'varanda-secrets-signature-v1'
const SIGNING_KEY_TYPE = 'varanda-secrets-signing-key'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const SIGNATURE_BYTES = 64
const MAX_RECIPIENTS = 64
const MAX_SIGNERS = 16
const MAX_SEQ = 4294967295
const SEALED_KEYS = ['v', 'seq', 'recipients', 'iv', 'tag', 'data', 'signer', 'signature']
const SERVER_KEY_KEYS = ['v', 'publicKey', 'secretKey']
const SIGNING_KEY_KEYS = ['v', 'type', 'publicKey', 'secretKey']
const MAX_VALUE = 4096
const HEX64 = /^[0-9a-f]{64}$/
const NAME_RE = /^[A-Z][A-Z0-9_]*$/
// No single quote (0x27) and no backslash (0x5c): formatEnv wraps values in
// single quotes for docker compose --env-file, and a trailing backslash would
// escape the closing quote there and let the next line inject a variable.
const VALUE_RE = /^[\x20-\x26\x28-\x5b\x5d-\x7e]+$/

// Only credentials shared by every server. VARANDA_PHONE_KEY and
// VARANDA_PAGE_KEYS seal one server's own data, and VARANDA_TRIAGE_TOKEN and
// VARANDA_PUSH_TOKEN are per host: they are never distributed.
const ALLOWED = Object.freeze([
  'VARANDA_AUDIUS_API_KEY',
  'VARANDA_DIDIT_API_KEY',
  'VARANDA_DIDIT_WORKFLOW_ID',
  'VARANDA_GIF_API_KEY',
  'VARANDA_GIF_API_URL',
  'VARANDA_GIF_MEDIA_HOSTS',
  'VARANDA_GOOGLE_CLIENT_ID',
  'VARANDA_GOOGLE_CLIENT_SECRET'
])
const ALLOWED_SET = new Set(ALLOWED)
const NEVER_DISTRIBUTED = new Set(['VARANDA_PAGE_KEYS', 'VARANDA_PHONE_KEY', 'VARANDA_PUSH_TOKEN', 'VARANDA_TRIAGE_TOKEN'])

const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function invalidSealed () {
  return new Error('arquivo selado inválido')
}

function invalidKeyFile () {
  return new Error('arquivo de chave inválido')
}

function publicKeyObject (raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
}

function rawPublic (keyObject) {
  return Buffer.from(keyObject.export({ format: 'jwk' }).x, 'base64url')
}

function rawSecret (keyObject) {
  return Buffer.from(keyObject.export({ format: 'jwk' }).d, 'base64url')
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys (value, keys) {
  if (!isPlainObject(value)) return false
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k))
}

// Strict base64 of exactly `bytes` bytes (any length when bytes is null).
function b64 (value, bytes) {
  if (typeof value !== 'string' || value.length === 0) return null
  const buf = Buffer.from(value, 'base64')
  if (buf.toString('base64') !== value) return null
  if (bytes !== null && buf.length !== bytes) return null
  return buf
}

function generateKeyFile () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  return {
    v: VERSION,
    publicKey: rawPublic(publicKey).toString('hex'),
    secretKey: rawSecret(privateKey).toString('hex')
  }
}

function generateSigningKeyFile () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    v: VERSION,
    type: SIGNING_KEY_TYPE,
    publicKey: rawPublic(publicKey).toString('hex'),
    secretKey: rawSecret(privateKey).toString('hex')
  }
}

function parseJsonKey (text) {
  try {
    return JSON.parse(text)
  } catch {
    throw invalidKeyFile()
  }
}

// Shared by both key files: `keys` is the exact key set, `prefix` the PKCS#8
// prefix of the curve. -> { publicKey: hex, privateKey: KeyObject }; the
// derived public key must match the stored one.
function parseKeyPair (value, keys, prefix) {
  if (!hasExactKeys(value, keys) || value.v !== VERSION) throw invalidKeyFile()
  if (typeof value.publicKey !== 'string' || !HEX64.test(value.publicKey)) throw invalidKeyFile()
  if (typeof value.secretKey !== 'string' || !HEX64.test(value.secretKey)) throw invalidKeyFile()
  let privateKey
  try {
    privateKey = crypto.createPrivateKey({ key: Buffer.concat([prefix, Buffer.from(value.secretKey, 'hex')]), format: 'der', type: 'pkcs8' })
  } catch {
    throw invalidKeyFile()
  }
  if (rawPublic(crypto.createPublicKey(privateKey)).toString('hex') !== value.publicKey) throw invalidKeyFile()
  return { publicKey: value.publicKey, privateKey }
}

function isSigningKeyShape (value) {
  return hasExactKeys(value, SIGNING_KEY_KEYS) && value.type === SIGNING_KEY_TYPE
}

// Server key (X25519).
function parseKeyFile (text) {
  const value = parseJsonKey(text)
  if (isSigningKeyShape(value)) throw new Error('este arquivo é uma chave de assinatura, não a chave do servidor')
  return parseKeyPair(value, SERVER_KEY_KEYS, PKCS8_PREFIX)
}

// Signing key (Ed25519).
function parseSigningKeyFile (text) {
  const value = parseJsonKey(text)
  if (hasExactKeys(value, SERVER_KEY_KEYS)) throw new Error('este arquivo é uma chave de servidor, não uma chave de assinatura')
  if (!isSigningKeyShape(value)) throw invalidKeyFile()
  return parseKeyPair(value, SIGNING_KEY_KEYS, ED25519_PKCS8_PREFIX)
}

// The same rule for seal, open and formatEnv. Spaces at the ends and
// surrounding double quotes are refused: they are almost always a copy
// mistake that the literal single-quoted output would keep.
function valueProblem (value) {
  if (typeof value !== 'string' || value.length > MAX_VALUE || !VALUE_RE.test(value)) return 'charset'
  if (value.trim() !== value) return 'space'
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return 'quoted'
  return null
}

function checkValue (name, value) {
  const problem = valueProblem(value)
  if (problem === 'charset') throw new Error('valor inválido em ' + name + ': use de 1 a ' + MAX_VALUE + ' caracteres ASCII imprimíveis, sem aspas simples nem barra invertida')
  if (problem === 'space') throw new Error('valor inválido em ' + name + ': tire os espaços do começo e do fim')
  if (problem === 'quoted') throw new Error('valor inválido em ' + name + ': tire as aspas duplas em volta do valor')
}

// A refused name is echoed only when it is exactly a known one (never
// distributed): a stray line such as a base32 secret ending in "=", or a
// known name glued to its value, would otherwise put value characters in the
// message.
function checkName (name, line = null) {
  if (ALLOWED_SET.has(name)) return
  if (NEVER_DISTRIBUTED.has(name)) throw new Error('nome não permitido: ' + name)
  throw new Error(line === null ? 'nome não permitido' : 'linha ' + line + ': nome não permitido')
}

// plain.env: NAME=value lines; blank lines and lines starting with # are
// skipped. The value is taken literally (no unquoting, no trimming), so
// checkValue refuses spaces at the ends and surrounding double quotes.
// -> Map name -> value, in file order.
function parsePlainEnv (text) {
  const secrets = new Map()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = line.indexOf('=')
    const name = eq === -1 ? null : line.slice(0, eq)
    if (name === null || !NAME_RE.test(name)) throw new Error('linha ' + (i + 1) + ' inválida: use NOME=valor')
    checkName(name, i + 1)
    if (secrets.has(name)) throw new Error('nome repetido: ' + name)
    const value = line.slice(eq + 1)
    checkValue(name, value)
    secrets.set(name, value)
  }
  if (secrets.size === 0) throw new Error('nenhum segredo no arquivo')
  return secrets
}

// One 64-hex public key per line, # starts a comment, blank lines skipped.
// -> array of lower-case hex keys, in file order.
function parseKeyList (text, max, messages) {
  const keys = []
  const seen = new Set()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const hash = lines[i].indexOf('#')
    const entry = (hash === -1 ? lines[i] : lines[i].slice(0, hash)).trim()
    if (entry === '') continue
    if (!/^[0-9a-fA-F]{64}$/.test(entry)) throw new Error(messages.invalid + (i + 1))
    const key = entry.toLowerCase()
    if (seen.has(key)) throw new Error(messages.repeated + (i + 1))
    seen.add(key)
    keys.push(key)
  }
  if (keys.length === 0) throw new Error(messages.none)
  if (keys.length > max) throw new Error(messages.tooMany)
  return keys
}

function parseRecipients (text) {
  return parseKeyList(text, MAX_RECIPIENTS, {
    invalid: 'destinatário inválido na linha ',
    repeated: 'destinatário repetido na linha ',
    none: 'nenhum destinatário',
    tooMany: 'mais de ' + MAX_RECIPIENTS + ' destinatários'
  })
}

// The Ed25519 public keys allowed to sign a sealed file.
function parseSigners (text) {
  return parseKeyList(text, MAX_SIGNERS, {
    invalid: 'lista de quem sela: chave inválida na linha ',
    repeated: 'lista de quem sela: chave repetida na linha ',
    none: 'lista de quem sela: nenhuma chave',
    tooMany: 'lista de quem sela: mais de ' + MAX_SIGNERS + ' chaves'
  })
}

function canonicalPayload (secrets) {
  const names = [...secrets.keys()].sort()
  let text = ''
  for (const name of names) {
    checkName(name)
    checkValue(name, secrets.get(name))
    text += name + '=' + secrets.get(name) + '\n'
  }
  return Buffer.from(text, 'utf8')
}

// Inverse of canonicalPayload, strict: the bytes must be exactly the
// canonical form of what they hold.
function parsePayload (buf) {
  const text = buf.toString('utf8')
  if (!text.endsWith('\n')) throw invalidSealed()
  const secrets = new Map()
  let previous = null
  for (const line of text.slice(0, -1).split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1) throw invalidSealed()
    const name = line.slice(0, eq)
    if (!ALLOWED_SET.has(name) || (previous !== null && name <= previous)) throw invalidSealed()
    const value = line.slice(eq + 1)
    if (valueProblem(value) !== null) throw invalidSealed()
    secrets.set(name, value)
    previous = name
  }
  if (!canonicalPayload(secrets).equals(buf)) throw invalidSealed()
  return secrets
}

function recipientsAad (keys) {
  return Buffer.from(INFO + keys.map((k) => '\n' + k).join(''), 'utf8')
}

function kek (shared, ephemeralPublic, recipientPublic) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, recipientPublic]), INFO, KEY_BYTES))
}

function gcmEncrypt (key, plain, aad) {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
  if (aad) cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(plain), cipher.final()])
  return { iv, tag: cipher.getAuthTag(), data }
}

function gcmDecrypt (key, iv, tag, data, aad) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    if (aad) decipher.setAAD(aad)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()])
  } catch {
    throw invalidSealed()
  }
}

function u32 (n) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32BE(n)
  return buf
}

function validSeq (seq) {
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 1 && seq <= MAX_SEQ
}

// fields: { v, seq, recipients: [{ publicKey: hex, ephemeral, iv, tag, key
// }], iv, tag, data, signer: hex }, binary fields as Buffers (parseSealed's
// shape). -> the bytes the signature covers (format in the header).
function signedBytes (fields) {
  const parts = [u32(fields.v), u32(fields.seq), u32(fields.recipients.length)]
  for (const r of fields.recipients) {
    parts.push(Buffer.from(r.publicKey, 'hex'), r.ephemeral, r.iv, r.tag, r.key)
  }
  parts.push(fields.iv, fields.tag, fields.data, Buffer.from(fields.signer, 'hex'))
  const out = [Buffer.from(SIGNATURE_CONTEXT, 'utf8')]
  for (const part of parts) out.push(u32(part.length), part)
  return Buffer.concat(out)
}

// secrets: Map name -> value; recipients: array of lower-case hex keys;
// signingKey: the result of parseSigningKeyFile; seq: 1 to 4294967295. ->
// the v1 object (JSON-ready), signed.
function seal (secrets, recipients, signingKey, seq) {
  if (!signingKey || typeof signingKey.publicKey !== 'string' || !HEX64.test(signingKey.publicKey)) throw new Error('falta a chave de assinatura')
  if (!validSeq(seq)) throw new Error('seq inválido: use um inteiro de 1 a ' + MAX_SEQ)
  const contentKey = crypto.randomBytes(KEY_BYTES)
  const plain = canonicalPayload(secrets)
  try {
    const entries = recipients.map((hex, i) => {
      const recipientPublic = Buffer.from(hex, 'hex')
      const ephemeral = crypto.generateKeyPairSync('x25519')
      const ephemeralPublic = rawPublic(ephemeral.publicKey)
      let shared
      try {
        shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: publicKeyObject(recipientPublic) })
      } catch {
        throw new Error('chave pública inválida: destinatário ' + (i + 1))
      }
      const wrapKey = kek(shared, ephemeralPublic, recipientPublic)
      shared.fill(0)
      const wrapped = gcmEncrypt(wrapKey, contentKey, null)
      wrapKey.fill(0)
      return { publicKey: hex, ephemeral: ephemeralPublic, iv: wrapped.iv, tag: wrapped.tag, key: wrapped.data }
    })
    const body = gcmEncrypt(contentKey, plain, recipientsAad(recipients))
    const fields = { v: VERSION, seq, recipients: entries, iv: body.iv, tag: body.tag, data: body.data, signer: signingKey.publicKey }
    const signature = crypto.sign(null, signedBytes(fields), signingKey.privateKey)
    return {
      v: VERSION,
      seq,
      recipients: entries.map((r) => ({
        publicKey: r.publicKey,
        ephemeral: r.ephemeral.toString('hex'),
        iv: r.iv.toString('base64'),
        tag: r.tag.toString('base64'),
        key: r.key.toString('base64')
      })),
      iv: body.iv.toString('base64'),
      tag: body.tag.toString('base64'),
      data: body.data.toString('base64'),
      signer: signingKey.publicKey,
      signature: signature.toString('base64')
    }
  } finally {
    contentKey.fill(0)
    plain.fill(0)
  }
}

// Checks the whole structure, not the signature. -> { v, seq, recipients: [{
// publicKey (hex), ephemeral, iv, tag, key }], iv, tag, data, signer (hex),
// signature }, binary fields as Buffers.
function parseSealed (text) {
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw invalidSealed()
  }
  if (isPlainObject(value) && value.v !== VERSION) throw new Error('versão do arquivo selado desconhecida')
  if (isPlainObject(value) && !Object.prototype.hasOwnProperty.call(value, 'signer') && !Object.prototype.hasOwnProperty.call(value, 'signature')) throw new Error('arquivo selado sem assinatura')
  if (!hasExactKeys(value, SEALED_KEYS)) throw invalidSealed()
  if (!validSeq(value.seq)) throw invalidSealed()
  if (!Array.isArray(value.recipients) || value.recipients.length === 0 || value.recipients.length > MAX_RECIPIENTS) throw invalidSealed()
  const seen = new Set()
  const recipients = value.recipients.map((entry) => {
    if (!hasExactKeys(entry, ['publicKey', 'ephemeral', 'iv', 'tag', 'key'])) throw invalidSealed()
    if (typeof entry.publicKey !== 'string' || !HEX64.test(entry.publicKey) || seen.has(entry.publicKey)) throw invalidSealed()
    if (typeof entry.ephemeral !== 'string' || !HEX64.test(entry.ephemeral)) throw invalidSealed()
    seen.add(entry.publicKey)
    const iv = b64(entry.iv, IV_BYTES)
    const tag = b64(entry.tag, TAG_BYTES)
    const key = b64(entry.key, KEY_BYTES)
    if (iv === null || tag === null || key === null) throw invalidSealed()
    return { publicKey: entry.publicKey, ephemeral: Buffer.from(entry.ephemeral, 'hex'), iv, tag, key }
  })
  const iv = b64(value.iv, IV_BYTES)
  const tag = b64(value.tag, TAG_BYTES)
  const data = b64(value.data, null)
  if (iv === null || tag === null || data === null) throw invalidSealed()
  if (typeof value.signer !== 'string' || !HEX64.test(value.signer)) throw invalidSealed()
  const signature = b64(value.signature, SIGNATURE_BYTES)
  if (signature === null) throw invalidSealed()
  return { v: value.v, seq: value.seq, recipients, iv, tag, data, signer: value.signer, signature }
}

// Throws unless the signer is one of `signers` (lower-case hex keys, from
// parseSigners) and the signature holds. Only a pinned key ever reaches
// crypto.
function checkSignature (sealed, signers) {
  if (!Array.isArray(signers) || signers.length === 0) throw new Error('lista de quem sela: nenhuma chave')
  if (!signers.includes(sealed.signer)) throw new Error('o arquivo selado não foi assinado por uma chave da lista de quem sela')
  let ok
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(sealed.signer, 'hex')]), format: 'der', type: 'spki' })
    ok = crypto.verify(null, signedBytes(sealed), publicKey, sealed.signature)
  } catch {
    ok = false
  }
  if (!ok) throw new Error('assinatura do arquivo selado inválida')
}

// Needs no secret key. -> { signer, recipients, seq } (hex, count, seq), in
// this key order: update.sh parses the JSON line.
function verify (sealedText, signers) {
  const sealed = parseSealed(sealedText)
  checkSignature(sealed, signers)
  return { signer: sealed.signer, recipients: sealed.recipients.length, seq: sealed.seq }
}

class NotRecipientError extends Error {
  constructor () {
    super('este servidor não é destinatário')
    this.code = 'NOT_RECIPIENT'
  }
}

// key: the result of parseKeyFile; signers: from parseSigners. -> Map name
// -> value (sorted by name). The signature is checked before anything is
// decrypted, and NotRecipientError (the key is not in the list) only comes
// after it.
function open (sealedText, key, signers) {
  const sealed = parseSealed(sealedText)
  checkSignature(sealed, signers)
  const entry = sealed.recipients.find((r) => r.publicKey === key.publicKey)
  if (!entry) throw new NotRecipientError()
  let shared
  try {
    shared = crypto.diffieHellman({ privateKey: key.privateKey, publicKey: publicKeyObject(entry.ephemeral) })
  } catch {
    throw invalidSealed()
  }
  const wrapKey = kek(shared, entry.ephemeral, Buffer.from(entry.publicKey, 'hex'))
  shared.fill(0)
  let contentKey
  try {
    contentKey = gcmDecrypt(wrapKey, entry.iv, entry.tag, entry.key, null)
  } finally {
    wrapKey.fill(0)
  }
  let plain
  try {
    plain = gcmDecrypt(contentKey, sealed.iv, sealed.tag, sealed.data, recipientsAad(sealed.recipients.map((r) => r.publicKey)))
  } finally {
    contentKey.fill(0)
  }
  try {
    return parsePayload(plain)
  } finally {
    plain.fill(0)
  }
}

// NAME='value' lines sorted by name: single quotes make docker compose
// --env-file take the value literally (values never hold a single quote nor
// a backslash, see VALUE_RE).
function formatEnv (secrets) {
  let text = ''
  for (const name of [...secrets.keys()].sort()) {
    checkName(name)
    checkValue(name, secrets.get(name))
    text += name + "='" + secrets.get(name) + "'\n"
  }
  return text
}

module.exports = {
  ALLOWED,
  VERSION,
  MAX_SEQ,
  NotRecipientError,
  generateKeyFile,
  generateSigningKeyFile,
  parseKeyFile,
  parseSigningKeyFile,
  parsePlainEnv,
  parseRecipients,
  parseSigners,
  canonicalPayload,
  recipientsAad,
  parseSealed,
  signedBytes,
  seal,
  verify,
  open,
  formatEnv
}
