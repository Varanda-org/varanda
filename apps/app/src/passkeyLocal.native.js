// What this installation learned from its own passkey creations, per rp.id:
// the creation still waiting for its PRF output (pending, finished by
// complete()) and the passkeys the app refused (bound to one device, no PRF,
// superseded by a newer creation). The refused ids go into excludeCredentials
// so the same manager is not asked to make the same useless passkey again.
//
// One JSON file in the app's Documents, like the keychain epoch marker of
// src/sessionStore.native.js: it dies with the app on reinstall, unlike the
// keychain, so a reinstall starts clean. Never holds the PRF output or any
// key: only credential ids, user ids and codes.
//
// { v: 1, byRp: { [rpId]: { pending: { credentialId, userId } | null,
//   refused: [{ credentialId, userId, code, cleaned: false, created }] } } }
// A missing file reads as empty. A file that cannot be read or parsed is a
// failure, not an empty record: the last good copy is served from memory and
// no write goes out until a read works again, so one bad read never wipes the
// other rp.ids. Every write goes to a sibling temporary file first and then
// replaces the original, so a failed write leaves the previous content.

import { File, Paths } from 'expo-file-system'

const FILE_NAME = 'varanda-passkey-attempts.json'
const TEMP_NAME = 'varanda-passkey-attempts.json.tmp'
export const MAX_REFUSED = 32
const ID = /^[A-Za-z0-9_-]{1,1024}$/
// The strict base64url of fromBase64Url (src/passkeyOptions.js): a length of
// 1 mod 4 decodes to nothing and would throw in buildCreateOptions.
const validId = (id) => typeof id === 'string' && ID.test(id) && id.length % 4 !== 1
const USER_ID = /^([0-9a-f]{64})?$/
const CODE = /^[A-Z_]{1,32}$/

// A passkey this app created and refused as bound to one device. Its entry is
// what keeps it from ever signing in (src/identity.native.js), so the cap and
// a reset never drop it while other entries can go instead.
export function isBound (r) {
  return r !== null && typeof r === 'object' && r.code === 'NOT_SYNCED' && r.created === true
}

// Trims to MAX_REFUSED, oldest first, among the other entries only; bound
// entries are never dropped, even past the cap (each took a creation).
export function capRefused (list) {
  if (list.length <= MAX_REFUSED) return list
  const bound = list.filter(isBound)
  if (bound.length >= MAX_REFUSED) return bound
  let drop = list.length - MAX_REFUSED
  return list.filter((r) => {
    if (drop === 0 || isBound(r)) return true
    drop--
    return false
  })
}

function own (obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

function empty () {
  return { pending: null, refused: [] }
}

function cleanPending (p) {
  if (p === null || typeof p !== 'object') return null
  if (!validId(p.credentialId)) return null
  if (typeof p.userId !== 'string' || !USER_ID.test(p.userId)) return null
  return { credentialId: p.credentialId, userId: p.userId }
}

function cleanRefused (list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const r of list) {
    if (r === null || typeof r !== 'object') continue
    if (!validId(r.credentialId)) continue
    if (typeof r.userId !== 'string' || !USER_ID.test(r.userId)) continue
    if (typeof r.code !== 'string' || !CODE.test(r.code)) continue
    if (out.some((o) => o.credentialId === r.credentialId)) continue
    out.push({ credentialId: r.credentialId, userId: r.userId, code: r.code, cleaned: false, created: r.created === true })
  }
  return capRefused(out)
}

function cleanEntry (entry) {
  if (entry === null || typeof entry !== 'object') return empty()
  return { pending: cleanPending(entry.pending), refused: cleanRefused(entry.refused) }
}

function parseDoc (text) {
  const doc = JSON.parse(text)
  if (doc === null || typeof doc !== 'object' || doc.v !== 1 || doc.byRp === null || typeof doc.byRp !== 'object' || Array.isArray(doc.byRp)) throw new Error('passkey attempts file malformed')
  const byRp = Object.create(null)
  for (const [rpId, entry] of Object.entries(doc.byRp)) byRp[rpId] = cleanEntry(entry)
  return byRp
}

function copyAll (byRp) {
  const out = Object.create(null)
  for (const rpId of Object.keys(byRp)) out[rpId] = cleanEntry(byRp[rpId])
  return out
}

export function createPasskeyLocal ({ file = () => new File(Paths.document, FILE_NAME), tempFile = () => new File(Paths.document, TEMP_NAME) } = {}) {
  // The last content read or written, served while the file cannot be read.
  let memory = Object.create(null)

  // The whole record, or null when the file exists but cannot be read.
  function readAll () {
    let byRp
    try {
      const f = file()
      if (f.exists) {
        const text = f.textSync()
        // Content that does not parse will never parse: read it as empty so
        // the next save replaces it, instead of blocking every save until a
        // reinstall. Only a failed read (above) keeps the file untouched.
        try {
          byRp = parseDoc(text)
        } catch {
          byRp = Object.create(null)
        }
      } else {
        byRp = Object.create(null)
        // A write that deleted the original but did not move the temporary
        // file into place yet: the temporary file is complete. A failed read
        // of it is unreadable (outer catch); only content that does not
        // parse reads as empty, as for the original.
        const tmp = tempFile()
        if (tmp.exists) {
          const text = tmp.textSync()
          try { byRp = parseDoc(text) } catch {}
        }
      }
    } catch {
      return null
    }
    memory = copyAll(byRp)
    return byRp
  }

  // Neither File#move nor File#copy overwrites an existing destination
  // (FileManager.moveItem on iOS, Path.moveTo on Android), so the original
  // is deleted only once the temporary file holds the full content.
  function writeAll (byRp) {
    const tmp = tempFile()
    if (tmp.exists) tmp.delete()
    tmp.create()
    tmp.write(JSON.stringify({ v: 1, byRp }))
    const f = file()
    if (f.exists) f.delete()
    tmp.move(f)
    memory = copyAll(byRp)
  }

  // The temporary file left by a write that deleted the original becomes
  // the original before any other write, so writeAll never deletes the only
  // complete copy. Throws when the move fails, with the temporary file kept.
  function promote () {
    const f = file()
    if (f.exists) return
    const tmp = tempFile()
    if (tmp.exists) tmp.move(f)
  }

  function unreadable () {
    return new Error('passkey attempts file unreadable')
  }

  return {
    // Throws when the file exists but cannot be read and no earlier read
    // holds this rp.id: the caller must not mistake that for an empty record
    // (a later save would replace the real one with it).
    load (rpId) {
      const byRp = readAll()
      if (byRp !== null) return own(byRp, rpId) ? cleanEntry(byRp[rpId]) : empty()
      if (own(memory, rpId)) return cleanEntry(memory[rpId])
      throw unreadable()
    },
    // An unreadable file is read once more; still unreadable, the write is
    // skipped (it would replace the other rp.ids with nothing) and only the
    // memory copy changes.
    save (rpId, { pending = null, refused = [] } = {}) {
      const entry = cleanEntry({ pending, refused })
      try {
        promote()
      } catch (err) {
        memory[rpId] = entry
        throw err
      }
      const byRp = readAll() || readAll()
      if (byRp === null) {
        memory[rpId] = entry
        throw unreadable()
      }
      byRp[rpId] = entry
      writeAll(byRp)
    },
    // keepBound: the passkeys refused as bound to one device stay (they
    // describe this device's managers, not the account); the pending
    // creation and every other refusal go.
    clear (rpId, { keepBound = false } = {}) {
      const kept = (entry) => {
        const refused = keepBound && entry ? cleanEntry(entry).refused.filter(isBound) : []
        return refused.length > 0 ? { pending: null, refused } : null
      }
      const forget = () => {
        const entry = own(memory, rpId) ? kept(memory[rpId]) : null
        if (entry) memory[rpId] = entry
        else delete memory[rpId]
      }
      try {
        promote()
      } catch (err) {
        forget()
        throw err
      }
      const byRp = readAll() || readAll()
      forget()
      if (byRp === null) throw unreadable()
      if (!own(byRp, rpId)) return
      const entry = kept(byRp[rpId])
      if (entry) byRp[rpId] = entry
      else delete byRp[rpId]
      writeAll(byRp)
    },

    // The last resort of a reset whose clear() failed: drops the whole file
    // (every rp.id) so a file that keeps failing to read cannot block
    // 'recomeçar' until a reinstall. Only exclusions and pending creations
    // are lost, never an account.
    drop () {
      const f = file()
      if (f.exists) f.delete()
      const tmp = tempFile()
      if (tmp.exists) tmp.delete()
      memory = Object.create(null)
    }
  }
}

export const passkeyLocal = createPasskeyLocal()
