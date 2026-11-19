'use strict'

const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const sodium = require('sodium-universal')

const PREFIX = 'varanda-push-device-v1'
const ACTIONS = Object.freeze(['on', 'off'])
const TRANSPORTS = Object.freeze(['apns', 'fcm'])
const NONCE_RE = /^[A-Za-z0-9_-]{43,128}$/
const KEYS = ['nonce', 'member', 'association', 'action', 'transport', 'tokenHash', 'key']
const isNonce = (v) => typeof v === 'string' && NONCE_RE.test(v)
const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
const isAction = (v) => ACTIONS.includes(v)
const isTransport = (v) => TRANSPORTS.includes(v)

// Sixteen bytes leave four zero padding bits in the last base64url digit.
const isKey = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{21}[AQgw]$/.test(v)

function isToken (transport, token) {
  if (typeof token !== 'string') return false
  if (transport === 'apns') return /^[0-9a-f]{64,200}$/.test(token)
  if (transport === 'fcm') return /^[A-Za-z0-9_:-]{1,4096}$/.test(token)
  return false
}

function tokenHash (transport, token) {
  if (!isToken(transport, token)) throw new TypeError('invalid push device token')
  const hash = b4a.alloc(32)
  sodium.crypto_generichash(hash, b4a.from(transport + ':' + token, 'utf8'))
  return b4a.toString(hash, 'hex')
}

// Snapshot data properties once so accessors cannot change the signed fields.
function snapshotFields (fields, keys) {
  if (fields === null || typeof fields !== 'object') return null
  const proto = Object.getPrototypeOf(fields)
  if (proto !== Object.prototype && proto !== null) return null
  if (Reflect.ownKeys(fields).length !== keys.length) return null
  const snapshot = {}
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(fields, key)
    if (d === undefined || !('value' in d)) return null
    snapshot[key] = d.value
  }
  return snapshot
}

function pushDevicePayload (fields) {
  try {
    const s = snapshotFields(fields, KEYS)
    if (s === null || !isNonce(s.nonce) || !isHex64(s.member) || !isHex64(s.association) ||
        !isAction(s.action) || !isTransport(s.transport) || !isHex64(s.tokenHash) || !isKey(s.key)) return null
    return b4a.from([PREFIX, ...KEYS.map((key) => s[key])].join('\n'), 'utf8')
  } catch {
    return null
  }
}

function verifyPushDevice (statement) {
  try {
    const snapshot = snapshotFields(statement, [...KEYS, 'signature'])
    if (snapshot === null) return false
    const { signature, ...fields } = snapshot
    if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return false
    const payload = pushDevicePayload(fields)
    return payload !== null && crypto.verify(payload, b4a.from(signature, 'hex'), b4a.from(fields.member, 'hex'))
  } catch {
    return false
  }
}

module.exports = {
  PREFIX,
  ACTIONS,
  TRANSPORTS,
  NONCE_RE,
  isNonce,
  isHex64,
  isAction,
  isTransport,
  isToken,
  isKey,
  tokenHash,
  pushDevicePayload,
  verifyPushDevice
}
