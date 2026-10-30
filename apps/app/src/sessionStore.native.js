// The persistent sign-in of the in-app web node: the native counterpart of
// packages/web-member/lib/session-store.js ("stay signed in on this device
// until 'Sair'"). After a successful non-resumed identity.install (docs/rpc.md
// 5.35), and only then, the passkey's 32-byte PRF output (the root every
// member key derives from) is kept in the platform keychain (iOS Keychain,
// Android Keystore-backed storage through expo-secure-store) so a cold start
// resumes the session without a new ceremony.
//
// What is protected: the item is readable only while the device is unlocked
// and never leaves it (WHEN_UNLOCKED_THIS_DEVICE_ONLY: not in iCloud Keychain,
// not in backups); the key of the item and the record itself bind it to this
// rp.id and this identity's public key; it expires after MAX_IDLE_MS (30
// days) without a successful load. What is NOT protected: anyone holding the
// unlocked device, or code running inside this app, can act as the member
// until 'Sair' or the expiry.
//
// Record (JSON, one per rp.id and public key, the index key naming the
// current one): { v: 1, rpId, credentialId (base64url), publicKey (hex64),
// prfHex (hex64), usedAt (ms epoch) }. load() fails closed like the web
// store: another rp.id or public key, an unknown version, a malformed field,
// usedAt missing, not a non-negative safe integer, more than MAX_FUTURE_MS
// (1 day) ahead or more than maxIdleMs behind deletes the item and returns
// null; a successful load rewrites usedAt (best effort).

import * as SecureStore from 'expo-secure-store'
import { File, Paths } from 'expo-file-system'

const VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000
export const MAX_IDLE_MS = 30 * DAY_MS
export const MAX_FUTURE_MS = DAY_MS
const INDEX_KEY = 'varanda-session.index'
const ITEM_PREFIX = 'varanda-session.v1.'

const HEX64 = /^[0-9a-f]{64}$/
const RP_ID = /^[a-z0-9.-]{1,253}$/
const BASE64URL = /^[A-Za-z0-9_-]{1,1024}$/

function validRpId (rpId) {
  return typeof rpId === 'string' && RP_ID.test(rpId)
}

function validPublicKey (publicKey) {
  return typeof publicKey === 'string' && HEX64.test(publicKey)
}

function validCredentialId (credentialId) {
  return typeof credentialId === 'string' && BASE64URL.test(credentialId) && credentialId.length % 4 !== 1
}

// SecureStore keys allow only [A-Za-z0-9._-]; rp.id and hex keys stay in it.
export function itemKey (rpId, publicKey) {
  return ITEM_PREFIX + rpId + '.' + publicKey
}

export function createSessionStore ({ secureStore = SecureStore, now = Date.now, maxIdleMs = MAX_IDLE_MS } = {}) {
  if (typeof now !== 'function') throw new TypeError('relógio inválido')
  if (!Number.isSafeInteger(maxIdleMs) || maxIdleMs <= 0) throw new TypeError('validade da sessão inválida')
  const options = { keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

  function clock () {
    const t = now()
    if (!Number.isSafeInteger(t) || t < 0) throw new Error('relógio inválido')
    return t
  }

  async function removeQuietly (key) {
    try { await secureStore.deleteItemAsync(key, options) } catch {}
  }

  async function save ({ rpId, credentialId, publicKey, prfHex } = {}) {
    if (!validRpId(rpId)) throw new TypeError('rp.id inválido')
    if (!validCredentialId(credentialId)) throw new TypeError('identificador de passkey inválido')
    if (!validPublicKey(publicKey)) throw new TypeError('chave pública inválida')
    if (typeof prfHex !== 'string' || !HEX64.test(prfHex)) throw new TypeError('resultado PRF inválido')
    const key = itemKey(rpId, publicKey)
    const record = { v: VERSION, rpId, credentialId, publicKey, prfHex, usedAt: clock() }
    let previous = null
    try { previous = await secureStore.getItemAsync(INDEX_KEY, options) } catch {}
    // The record already under this key (same rp.id and identity): a failed
    // save puts it back instead of deleting a session that still works.
    let older = null
    try { older = await secureStore.getItemAsync(key, options) } catch {}
    let wrote = false
    try {
      await secureStore.setItemAsync(key, JSON.stringify(record), options)
      wrote = true
      await secureStore.setItemAsync(INDEX_KEY, key, options)
    } catch (err) {
      if (typeof older === 'string') {
        if (wrote) {
          try { await secureStore.setItemAsync(key, older, options) } catch {}
        }
      } else {
        await removeQuietly(key)
      }
      throw err
    }
    // One stored session per device, as on the web.
    if (typeof previous === 'string' && previous !== key && previous.startsWith(ITEM_PREFIX)) await removeQuietly(previous)
  }

  // -> { credentialId, prfHex } or null. Never throws for a bad or absent
  // record; the caller zero-fills nothing (a string), so it hands prfHex
  // straight to the IPC.
  async function load ({ rpId, publicKey } = {}) {
    if (!validRpId(rpId) || !validPublicKey(publicKey)) return null
    const key = itemKey(rpId, publicKey)
    let raw
    try {
      raw = await secureStore.getItemAsync(key, options)
    } catch {
      await removeQuietly(key)
      return null
    }
    if (raw === null || raw === undefined) return null
    let record = null
    try {
      record = JSON.parse(raw)
    } catch {}
    let t
    try {
      t = clock()
    } catch {
      return null
    }
    const usable = record !== null && typeof record === 'object' &&
      record.v === VERSION &&
      record.rpId === rpId &&
      record.publicKey === publicKey &&
      validCredentialId(record.credentialId) &&
      typeof record.prfHex === 'string' && HEX64.test(record.prfHex) &&
      Number.isSafeInteger(record.usedAt) && record.usedAt >= 0 &&
      record.usedAt - t <= MAX_FUTURE_MS &&
      t - record.usedAt <= maxIdleMs
    if (!usable) {
      await removeQuietly(key)
      return null
    }
    try {
      await secureStore.setItemAsync(key, JSON.stringify({ ...record, usedAt: t }), options)
    } catch {}
    return { credentialId: record.credentialId, prfHex: record.prfHex }
  }

  // Deletes the stored session (the one the index names, and the item of
  // { rpId, publicKey } when given, in case the index never got written);
  // throws when the keychain refuses, so 'Sair' can report SIGNOUT_INCOMPLETE.
  async function clear ({ rpId, publicKey } = {}) {
    const key = await secureStore.getItemAsync(INDEX_KEY, options)
    if (typeof key === 'string' && key.startsWith(ITEM_PREFIX)) await secureStore.deleteItemAsync(key, options)
    if (validRpId(rpId) && validPublicKey(publicKey) && itemKey(rpId, publicKey) !== key) {
      await secureStore.deleteItemAsync(itemKey(rpId, publicKey), options)
    }
    await secureStore.deleteItemAsync(INDEX_KEY, options)
  }

  // Deletes every stored session the index names (one per device), or only
  // one of `rpId` when given, whatever its public key: a status with no
  // diary has no key to bind to. Throws when the keychain refuses.
  async function clearAll ({ rpId } = {}) {
    const key = await secureStore.getItemAsync(INDEX_KEY, options)
    if (typeof key !== 'string' || !key.startsWith(ITEM_PREFIX)) {
      await secureStore.deleteItemAsync(INDEX_KEY, options)
      return
    }
    if (rpId !== undefined && !(validRpId(rpId) && key.startsWith(ITEM_PREFIX + rpId + '.') && HEX64.test(key.slice((ITEM_PREFIX + rpId + '.').length)))) return
    await secureStore.deleteItemAsync(key, options)
    await secureStore.deleteItemAsync(INDEX_KEY, options)
  }

  return { save, load, clear, clearAll }
}

export const sessionStore = createSessionStore()

// iOS deletes the app's Documents with the app but keeps its keychain items,
// so a reinstall would find the PRF root secret of the deleted app. A marker
// file in Documents tells a fresh install: absent at the first resume, every
// stored session is deleted before the marker is written.
const EPOCH_FILE = 'varanda-keychain-epoch'

export function createKeychainEpoch ({ file = () => new File(Paths.document, EPOCH_FILE) } = {}) {
  return {
    present () {
      try { return file().exists === true } catch { return false }
    },
    mark () {
      const f = file()
      if (!f.exists) f.create()
      f.write('1')
    }
  }
}

export const keychainEpoch = createKeychainEpoch()
