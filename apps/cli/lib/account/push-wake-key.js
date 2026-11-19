'use strict'

// The account service's wake key (X25519, push-wake.json in the data dir):
// members seal a DM recipient's key to its public half
// (packages/core/lib/dm-notice.js) and only this service can open the box.
// Created once and then only read: a new key would make every box sealed to
// the old one unreadable, so a file that is not exactly a pair this module
// wrote stops the service instead of being replaced.

const fs = require('node:fs')
const path = require('node:path')
const { refuseSymlinkDir, saveKeyPairFile, isPlainObject } = require('@varanda/core/lib/cert')

const coreDir = path.dirname(require.resolve('@varanda/core/lib/seeder'))
const sodium = require(require.resolve('sodium-universal', { paths: [coreDir] }))

const WAKE_KEY_FILE = 'push-wake.json'
const HEX64_RE = /^[0-9a-f]{64}$/
// One message for every bad file, so no part of it (the secret) reaches a log.
const INVALID = 'chave de aviso de conversa inválida (' + WAKE_KEY_FILE + ')'

function invalid () {
  return new Error(INVALID)
}

// As readKeyFile in packages/core/lib/cert.js: no symlink is followed, and a
// FIFO or anything else that is not a regular file is refused before a read.
function readFile (file) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw invalid()
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw invalid()
    return fs.readFileSync(fd, 'utf8')
  } catch {
    throw invalid()
  } finally {
    fs.closeSync(fd)
  }
}

function parse (text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch {
    // JSON.parse quotes the input in its message.
    throw invalid()
  }
  if (!isPlainObject(obj) || Object.keys(obj).sort().join(',') !== 'publicKey,secretKey,v' || obj.v !== 1) throw invalid()
  if (typeof obj.publicKey !== 'string' || !HEX64_RE.test(obj.publicKey)) throw invalid()
  if (typeof obj.secretKey !== 'string' || !HEX64_RE.test(obj.secretKey)) throw invalid()
  const publicKey = Buffer.from(obj.publicKey, 'hex')
  const secretKey = Buffer.from(obj.secretKey, 'hex')
  const derived = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_scalarmult_base(derived, secretKey)
  if (!derived.equals(publicKey)) {
    sodium.sodium_memzero(secretKey)
    throw invalid()
  }
  return { publicKey, secretKey }
}

// { publicKey, secretKey }, 32-byte buffers. saveKeyPairFile writes a 0o600
// temp file and publishes it with link(), which never replaces an existing
// file, so of two first starts only one key is kept and both read it.
function loadOrCreateWakeKey (dataDir) {
  refuseSymlinkDir(dataDir)
  const file = path.join(dataDir, WAKE_KEY_FILE)
  const text = readFile(file)
  if (text !== null) return parse(text)
  const publicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_keypair(publicKey, secretKey)
  try {
    saveKeyPairFile(file, { publicKey, secretKey })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
    const raced = readFile(file)
    if (raced === null) throw invalid()
    return parse(raced)
  }
  return { publicKey, secretKey }
}

module.exports = { WAKE_KEY_FILE, loadOrCreateWakeKey }
