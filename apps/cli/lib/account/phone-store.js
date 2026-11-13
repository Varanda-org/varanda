'use strict'

// The phone numbers the account service has verified. ONE sidecar file,
// <dataDir>/phone.json (mode 0o600), always replaced whole through
// writeJsonAtomic (packages/core/lib/store.js). The number itself is only
// ever on disk sealed (AES-256-GCM, AAD bound to the member, so a seal moved
// to another member's row never opens) beside a keyed HMAC index, which is
// what uniqueness and burns compare. Both subkeys come from
// VARANDA_PHONE_KEY; a `check` value derived from the same key makes a file
// written under another key fail closed instead of being rewritten, so a
// wrong key can never fork the index.
//
// Opening never creates, mkdirs or chmods anything (a missing file is an
// empty store) and a readOnly store never writes. Validation is total: a file
// this module would not have written is never rewritten, and every method
// then throws { code: 'indisponivel' } until an operator repairs it. Bad
// argument shapes throw TypeError, and no message ever carries a number.
//
// No union merge: every mutation runs in one in-process queue, re-reads the
// file (the service lock can go stale and writeJsonAtomic renames
// unconditionally), applies its one change to the disk state and only
// replaces memory after the write. A write that throws or a guard that
// refuses marks the store dirty and adopts the file as it then reads (the
// rename may have landed before the error); when that re-read fails too,
// every call answers 'indisponivel' until heal() reads the file again.
//
// Nothing is logged here, and reveal() is the only call that returns a
// number, only on a store opened with `disclose: true` (a court order).

const fs = require('node:fs')
const path = require('node:path')
const nodeCrypto = require('node:crypto')
const { writeJsonAtomic } = require('@varanda/core/lib/store')
const { isLowerHex, isCanonicalIso, isPlainObject, refuseSymlinkDir } = require('@varanda/core/lib/cert')
const { isBrMobile } = require('@varanda/core/lib/phone')

const FILE = 'phone.json'
const VERSION = 1
const DAY = 24 * 3600 * 1000
// Both periods: sujeita a revisão jurídica (LGPD section of docs/design.md).
// RETENTION_MS is how long a number stays sealed after it stops being a
// member's, for a court order; UNLINKED_TTL_MS is how long a number verified
// by a member who never linked holds before it is forgotten.
const RETENTION_MS = 180 * DAY
const UNLINKED_TTL_MS = 7 * DAY

const ENDS = Object.freeze(['trocado', 'excluida', 'substituido', 'liberado'])
const END_REASONS = Object.freeze(['excluida', 'trocado', 'substituido'])
const FILE_KEYS = ['v', 'check', 'since', 'rows', 'released']
const ROW_KEYS = ['member', 'index', 'sealed', 'verifiedAt', 'endedAt', 'end', 'burnedAt']
const SEALED_KEYS = ['iv', 'tag', 'data']
const SEAL_LABEL = 'varanda-phone-seal-v1'
const INDEX_LABEL = 'varanda-phone-index-v1'
const CHECK_LABEL = 'varanda-phone-check-v1'
const AAD_PREFIX = 'varanda-phone-v1\n'
const IV_BYTES = 12
const TAG_BYTES = 16
const MAX_PLAIN_BYTES = 64

function fail (code) {
  const err = new Error(code)
  err.code = code
  return err
}

function has (map, key) {
  return Object.prototype.hasOwnProperty.call(map, key)
}

function exactKeys (obj, keys) {
  return Object.keys(obj).length === keys.length && keys.every((k) => has(obj, k))
}

function validMember (m) {
  return isLowerHex(m, 32)
}

function checkMember (m) {
  if (!validMember(m)) throw new TypeError('member must be 64 lowercase hex characters')
}

function checkPhone (phone) {
  if (!isBrMobile(phone)) throw new TypeError('phone must be a Brazilian mobile in E.164')
}

function checkCallbacks (cbs) {
  if (!isPlainObject(cbs)) throw new TypeError('linked, burnable and deleted must be functions')
  for (const name of ['linked', 'burnable', 'deleted']) {
    if (typeof cbs[name] !== 'function') throw new TypeError('linked, burnable and deleted must be functions')
  }
  if (cbs.blocked !== undefined && typeof cbs.blocked !== 'function') throw new TypeError('blocked must be a function')
}

function hmac (key, data) {
  return nodeCrypto.createHmac('sha256', key).update(data).digest()
}

function canonicalBase64 (s, min, max) {
  if (typeof s !== 'string') return false
  const buf = Buffer.from(s, 'base64')
  return buf.length >= min && buf.length <= max && buf.toString('base64') === s
}

function validSealed (s) {
  return isPlainObject(s) && exactKeys(s, SEALED_KEYS) &&
    canonicalBase64(s.iv, IV_BYTES, IV_BYTES) &&
    canonicalBase64(s.tag, TAG_BYTES, TAG_BYTES) &&
    canonicalBase64(s.data, 1, MAX_PLAIN_BYTES)
}

function isoOrNull (v) {
  return v === null || isCanonicalIso(v)
}

function validRow (r) {
  if (!isPlainObject(r) || !exactKeys(r, ROW_KEYS)) return false
  if (!validMember(r.member) || !isLowerHex(r.index, 32)) return false
  if (r.sealed !== null && !validSealed(r.sealed)) return false
  if (!isCanonicalIso(r.verifiedAt) || !isoOrNull(r.endedAt) || !isoOrNull(r.burnedAt)) return false
  if (r.end !== null && !ENDS.includes(r.end)) return false
  if ((r.end === null) !== (r.endedAt === null)) return false
  if (r.sealed === null && r.burnedAt === null) return false
  return true
}

function copyRow (r) {
  return {
    member: r.member,
    index: r.index,
    sealed: r.sealed === null ? null : { iv: r.sealed.iv, tag: r.sealed.tag, data: r.sealed.data },
    verifiedAt: r.verifiedAt,
    endedAt: r.endedAt,
    end: r.end,
    burnedAt: r.burnedAt
  }
}

function emptyState () {
  return { since: null, rows: [], released: Object.create(null) }
}

function copyState (s) {
  const out = { since: s.since, rows: s.rows.map(copyRow), released: Object.create(null) }
  for (const m of Object.keys(s.released)) out.released[m] = s.released[m]
  return out
}

function invalid () {
  return new Error('telefone inválido')
}

function fromJson (obj, check) {
  if (!isPlainObject(obj) || !exactKeys(obj, FILE_KEYS) || obj.v !== VERSION) throw invalid()
  if (!isLowerHex(obj.check, 32) || !nodeCrypto.timingSafeEqual(Buffer.from(obj.check, 'hex'), check)) throw invalid()
  if (!isCanonicalIso(obj.since) || !Array.isArray(obj.rows) || !isPlainObject(obj.released)) throw invalid()
  const state = emptyState()
  state.since = obj.since
  const liveMembers = new Set()
  const liveIndexes = new Set()
  for (const r of obj.rows) {
    if (!validRow(r)) throw invalid()
    if (r.end === null) {
      if (liveMembers.has(r.member) || liveIndexes.has(r.index)) throw invalid()
      liveMembers.add(r.member)
      liveIndexes.add(r.index)
    }
    state.rows.push(copyRow(r))
  }
  for (const [m, at] of Object.entries(obj.released)) {
    if (!validMember(m) || !isCanonicalIso(at)) throw invalid()
    state.released[m] = at
  }
  return state
}

function toJson (state, check) {
  const released = {}
  for (const m of Object.keys(state.released).sort()) released[m] = state.released[m]
  return { v: VERSION, check, since: state.since, rows: state.rows.map(copyRow), released }
}

// The file's state, or null when it does not exist. O_NOFOLLOW so a symlink
// planted in place of the file is refused rather than read.
function readState (file, check) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  let fd
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw invalid()
  }
  let raw
  try {
    if (!fs.fstatSync(fd).isFile()) throw invalid()
    raw = fs.readFileSync(fd, 'utf8')
  } finally {
    fs.closeSync(fd)
  }
  return fromJson(JSON.parse(raw), check)
}

function aad (member) {
  return Buffer.from(AAD_PREFIX + member, 'utf8')
}

function seal (key, member, phone) {
  const plain = Buffer.from(phone, 'utf8')
  try {
    const iv = nodeCrypto.randomBytes(IV_BYTES)
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(aad(member))
    const data = Buffer.concat([cipher.update(plain), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
  } finally {
    plain.fill(0)
  }
}

function unseal (key, member, sealed) {
  let plain
  try {
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'), { authTagLength: TAG_BYTES })
    decipher.setAAD(aad(member))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()])
  } catch {
    throw fail('indisponivel')
  }
  try {
    return plain.toString('utf8')
  } finally {
    plain.fill(0)
  }
}

function openPhoneStore (dataDir, { key, now = Date.now, guard = () => true, readOnly = false, disclose = false } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('key must be a 32-byte Buffer')
  const sealKey = hmac(key, SEAL_LABEL)
  const indexKey = hmac(key, INDEX_LABEL)
  const check = hmac(indexKey, CHECK_LABEL)
  const checkHex = check.toString('hex')
  const file = path.join(dataDir, FILE)
  let state = emptyState()
  // Set by fail(): nothing clears it.
  let killed = false
  // Set when a read fails (or a failed write cannot be followed by a good
  // read): memory may be behind the disk, so nothing answers until heal()
  // reads a file that passes the check again.
  let failed = false
  let dirty = false
  // Once this holder has seen the file, a missing file is a loss (a restore
  // gone wrong, a wiped volume), never an empty store: adopting it would
  // drop every burn, and the next record would start a new file.
  let hadFile = false
  try {
    state = load() || emptyState()
  } catch {
    failed = true
  }
  let tail = Promise.resolve()

  function enqueue (fn) {
    const p = tail.then(fn)
    tail = p.catch(() => {})
    return p
  }

  function usable () {
    if (killed || failed) throw fail('indisponivel')
  }

  function load () {
    refuseSymlinkDir(dataDir)
    const disk = readState(file, check)
    if (disk === null) {
      if (hadFile) throw invalid()
      return null
    }
    hadFile = true
    return disk
  }

  function guarded () {
    let ok = false
    try {
      ok = !!guard()
    } catch {}
    if (!ok) throw fail('indisponivel')
  }

  function nowIso () {
    return new Date(now()).toISOString()
  }

  function indexOfPhone (phone) {
    return hmac(indexKey, phone).toString('hex')
  }

  function readDisk () {
    try {
      return load()
    } catch {
      failed = true
      throw fail('indisponivel')
    }
  }

  // Runs one mutation: guard, re-read, apply to the disk state, guard again,
  // write, and only then replace memory. `apply` returns [changed, result].
  function mutate (apply) {
    usable()
    if (readOnly) throw fail('indisponivel')
    guarded()
    const disk = readDisk()
    const next = disk ? copyState(disk) : emptyState()
    // A refusal still adopts what was just read, so reads reflect the disk
    // at once.
    state = disk || emptyState()
    dirty = false
    const [changed, result] = apply(next)
    if (!changed) return result
    // Only record() starts the file, so `since` is when the first number
    // was verified.
    if (next.since === null) throw fail('indisponivel')
    try {
      guarded()
      refuseSymlinkDir(dataDir)
      writeJsonAtomic(file, toJson(next, checkHex), 0o600)
    } catch {
      dirty = true
      try {
        state = load() || emptyState()
      } catch {
        failed = true
      }
      throw fail('indisponivel')
    }
    hadFile = true
    dirty = false
    state = next
    return result
  }

  function ownerTest (cbs, s) {
    const cache = new Map()
    return (name, owner) => {
      const k = name + ':' + owner
      if (!cache.has(k)) {
        let v = cbs[name](owner) === true
        if (name === 'burnable') v = v && !has(s.released, owner)
        cache.set(k, v)
      }
      return cache.get(k)
    }
  }

  function endRow (r, reason, at) {
    r.end = reason
    r.endedAt = at
  }

  function record ({ member, phone, verifiedAt } = {}, cbs) {
    return enqueue(() => {
      checkMember(member)
      checkPhone(phone)
      checkCallbacks(cbs)
      const at = verifiedAt === undefined ? nowIso() : verifiedAt
      if (!isCanonicalIso(at)) throw new TypeError('verifiedAt must be a canonical ISO date')
      return mutate((s) => {
        const is = ownerTest(cbs, s)
        // A deletion during the provider wait must not create a live row nor
        // end another holder's.
        if (is('deleted', member)) throw fail('conta-excluida')
        const index = indexOfPhone(phone)
        const own = s.rows.find((r) => r.member === member && r.end === null)
        if (own && own.index === index && own.sealed !== null) return [false, { changed: false }]
        for (const r of s.rows) {
          if (r.member === member || r.index !== index) continue
          if (r.burnedAt !== null || is('burnable', r.member)) throw fail('telefone-em-uso')
        }
        const stamp = nowIso()
        const holder = s.rows.find((r) => r.member !== member && r.index === index && r.end === null)
        if (holder) {
          if (is('deleted', holder.member)) endRow(holder, 'excluida', stamp)
          else if (is('linked', holder.member)) throw fail('telefone-em-uso')
          else endRow(holder, 'substituido', stamp)
        }
        if (own) endRow(own, 'trocado', stamp)
        if (s.since === null) s.since = stamp
        s.rows.push({
          member,
          index,
          sealed: seal(sealKey, member, phone),
          verifiedAt: at,
          endedAt: null,
          end: null,
          burnedAt: null
        })
        return [true, { changed: true }]
      })
    })
  }

  // Excluir conta and the like: ends the live row, keeping the seal for
  // RETENTION_MS. -> { changed }
  function end (member, reason = 'excluida') {
    return enqueue(() => {
      checkMember(member)
      if (!END_REASONS.includes(reason)) throw new TypeError('reason must be one of ' + END_REASONS.join(', '))
      return mutate((s) => {
        const own = s.rows.find((r) => r.member === member && r.end === null)
        if (!own) return [false, { changed: false }]
        endRow(own, reason, nowIso())
        return [true, { changed: true }]
      })
    })
  }

  // A court-ordered release: the member's number is given back while the
  // block stays, until sweep sees the block lifted. Rows without a seal only
  // existed to hold a burn, so they go with it. -> { rows } (kept rows)
  function release (member) {
    return enqueue(() => {
      checkMember(member)
      return mutate((s) => {
        if (!s.rows.some((r) => r.member === member)) return [false, { rows: 0 }]
        const stamp = nowIso()
        let changed = false
        const kept = []
        for (const r of s.rows) {
          if (r.member !== member) {
            kept.push(r)
            continue
          }
          if (r.end === null) {
            endRow(r, 'liberado', stamp)
            changed = true
          }
          if (r.burnedAt !== null) {
            r.burnedAt = null
            changed = true
            if (r.sealed === null) continue
          }
          kept.push(r)
        }
        s.rows = kept
        // An earlier release keeps its time: it is the one a court order
        // refers to.
        if (!has(s.released, member)) {
          s.released[member] = stamp
          changed = true
        }
        return [changed, { rows: kept.filter((r) => r.member === member).length }]
      })
    })
  }

  // With cbs.blocked, a burn and a release are only lifted when blocked()
  // answers false (mod unblock or an accepted appeal), never because the
  // member was deleted or its reports were dropped; without it, when the
  // owner is no longer burnable.
  function sweep (cbs) {
    return enqueue(() => {
      checkCallbacks(cbs)
      return mutate((s) => {
        const counts = { ended: 0, burned: 0, unburned: 0, unsealed: 0, removed: 0, released: 0 }
        const t = now()
        const stamp = new Date(t).toISOString()
        const lifted = typeof cbs.blocked === 'function'
          ? (m) => cbs.blocked(m) === false
          : (m) => cbs.burnable(m) !== true
        const liftedOf = new Map()
        const isLifted = (m) => {
          if (!liftedOf.has(m)) liftedOf.set(m, lifted(m))
          return liftedOf.get(m)
        }
        for (const m of Object.keys(s.released)) {
          if (isLifted(m)) {
            delete s.released[m]
            counts.released++
          }
        }
        const is = ownerTest(cbs, s)
        const kept = []
        for (const r of s.rows) {
          const o = r.member
          if (r.end === null && is('deleted', o)) {
            endRow(r, 'excluida', stamp)
            counts.ended++
          }
          if (is('burnable', o)) {
            if (r.burnedAt === null) {
              r.burnedAt = stamp
              counts.burned++
            }
          } else if (r.burnedAt !== null && (has(s.released, o) || isLifted(o))) {
            r.burnedAt = null
            counts.unburned++
            if (r.sealed === null) {
              counts.removed++
              continue
            }
          }
          const starts = []
          if (r.endedAt !== null) starts.push(Date.parse(r.endedAt))
          if (r.burnedAt !== null) starts.push(Date.parse(r.burnedAt))
          if (starts.length > 0 && t - Math.min(...starts) >= RETENTION_MS) {
            if (r.burnedAt === null) {
              counts.removed++
              continue
            }
            if (r.sealed !== null) {
              r.sealed = null
              counts.unsealed++
            }
          }
          if (r.end === null && r.burnedAt === null && !is('linked', o) && !is('deleted', o) && !is('burnable', o) &&
              t - Date.parse(r.verifiedAt) >= UNLINKED_TTL_MS) {
            counts.removed++
            continue
          }
          kept.push(r)
        }
        s.rows = kept
        const changed = Object.values(counts).some((n) => n > 0)
        return [changed, counts]
      })
    })
  }

  // Resolves once every call queued before it has committed or failed.
  function settled (member) {
    return enqueue(() => { checkMember(member) })
  }

  // Never throws, never writes. Retries the read while failed, so a passing
  // I/O error or a restored file recovers; a wrong key or a corrupt file
  // fails every time.
  function heal () {
    return enqueue(() => {
      if (killed) return false
      let disk
      try {
        disk = load()
      } catch {
        failed = true
        return false
      }
      state = disk || emptyState()
      failed = false
      dirty = false
      return false
    }).catch(() => false)
  }

  function liveRow (member) {
    checkMember(member)
    usable()
    return state.rows.find((r) => r.member === member && r.end === null) || null
  }

  function indexOf (phone) {
    checkPhone(phone)
    usable()
    return indexOfPhone(phone)
  }

  function verified (member) {
    const r = liveRow(member)
    return r !== null && r.sealed !== null
  }

  function live (member) {
    const r = liveRow(member)
    return r === null ? null : { index: r.index, verifiedAt: r.verifiedAt }
  }

  function counts () {
    usable()
    let liveN = 0
    let ended = 0
    let burned = 0
    for (const r of state.rows) {
      if (r.end === null) liveN++
      else ended++
      if (r.burnedAt !== null) burned++
    }
    return { live: liveN, ended, burned }
  }

  function since () {
    usable()
    return state.since
  }

  // The only call that returns a number. A seal that does not open (or
  // opens to a number whose index is not the row's) marks nothing and comes
  // back as phone null with sealError true; the member's other rows still
  // reveal.
  function reveal (member) {
    checkMember(member)
    if (disclose !== true) throw fail('sem-permissao')
    usable()
    const out = []
    for (const r of state.rows) {
      if (r.member !== member || r.sealed === null) continue
      let phone = null
      try {
        phone = unseal(sealKey, member, r.sealed)
      } catch {}
      const sealError = phone === null || !isBrMobile(phone) || indexOfPhone(phone) !== r.index
      out.push({ phone: sealError ? null : phone, verifiedAt: r.verifiedAt, endedAt: r.endedAt, end: r.end, burned: r.burnedAt !== null, sealError })
    }
    return out
  }

  return {
    indexOf,
    verified,
    live,
    record,
    end,
    release,
    sweep,
    settled,
    counts,
    since,
    reveal,
    heal,
    dirty () { return dirty },
    fail () { killed = true },
    available () { return !killed && !failed }
  }
}

module.exports = {
  openPhoneStore,
  FILE,
  RETENTION_MS,
  UNLINKED_TTL_MS
}
