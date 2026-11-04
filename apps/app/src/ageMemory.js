// The device's part of the age check: only refusals. Pure ES module: no
// imports, no globals; storage lives in ageStore.web.js / ageStore.native.js.
//
// Owner decision 2026-11-04: the check is remembered per account through two
// proofs signed by the account service's issuer and checked by the node on
// every read (node.info ageVerifiedDate, and memberCertDate against ageSince).
// The device record can never open the gate: anything on the origin can write
// localStorage or the JSON file. It keeps only a refusal per member and
// installation (origin), so a refused account stays closed even offline, when
// a proof the node still holds would otherwise open it; a later 'verificado'
// from that installation clears it. Never the age band, a photo, a document,
// a method or a provider id. Deleting a denial only loses a fail-closed
// helper: the service still refuses the link, the rename and invites.
//
// The record is untrusted on every read, so ageRecordOf rebuilds it strictly
// and refuses anything doubtful (an older record shape included): a refused
// record reads as "no denial", which only the live answers can close again.

export const STORAGE_KEY = 'varanda-age'
export const FILE_NAME = 'varanda-age.json'
export const MAX_DENIED = 32

const MEMBER_RE = /^[0-9a-f]{64}$/
const RECORD_KEYS = ['denied', 'v']
const ENTRY_KEYS = ['member', 'origin']

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype

const isMember = (s) => typeof s === 'string' && MEMBER_RE.test(s)

function sameKeys (obj, keys) {
  const own = Object.keys(obj).sort()
  return own.length === keys.length && own.every((k, i) => k === keys[i])
}

function isIso (s) {
  if (typeof s !== 'string' || s.length !== 24) return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString() === s
}

function isOrigin (s) {
  if (typeof s !== 'string' || s === '' || s.length > 200) return false
  try {
    const u = new URL(s)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s
  } catch {
    return false
  }
}

// The session set key: one member at one installation.
export const denialKey = (member, origin) => member + '\n' + origin

export function emptyAgeRecord () {
  return { v: 2, denied: [] }
}

// value -> a fresh, validated record, or null. Strict and total.
export function ageRecordOf (value) {
  try {
    if (!isObject(value) || value.v !== 2 || !sameKeys(value, RECORD_KEYS)) return null
    const { denied } = value
    if (!Array.isArray(denied) || denied.length > MAX_DENIED) return null
    const out = emptyAgeRecord()
    const seen = new Set()
    for (const entry of denied) {
      if (!isObject(entry) || !sameKeys(entry, ENTRY_KEYS)) return null
      if (!isMember(entry.member) || !isOrigin(entry.origin)) return null
      const key = denialKey(entry.member, entry.origin)
      if (seen.has(key)) return null
      seen.add(key)
      out.denied.push({ member: entry.member, origin: entry.origin })
    }
    return out
  } catch {
    return null
  }
}

// What a store returns for a record that is present but cannot be trusted
// (corrupt, partial, an unknown shape, storage that throws). Reads as "no
// denial known", but a save must never replace it: other refusals may be in
// there. The same frozen value from both platform stores.
export const AGE_RECORD_UNREADABLE = Object.freeze({ unreadable: true })

// A stored value (already parsed) -> a record, null for the v1 shape (it held
// no v2 refusal and the upgrade replaces it), or AGE_RECORD_UNREADABLE.
export function ageRecordRead (value) {
  const valid = ageRecordOf(value)
  if (valid !== null) return valid
  if (isObject(value) && value.v === 1) return null
  return AGE_RECORD_UNREADABLE
}

// A refusal for this member at this installation, moved last, so when the
// cap is reached the oldest denial goes first, never the one just written.
export function withDenied (record, member, origin) {
  const out = ageRecordOf(record) || emptyAgeRecord()
  if (!isMember(member) || !isOrigin(origin)) return out
  out.denied = out.denied.filter((d) => d.member !== member || d.origin !== origin)
  out.denied.push({ member, origin })
  while (out.denied.length > MAX_DENIED) out.denied.shift()
  return out
}

// Only this installation's denial: a 'verificado' at one origin says nothing
// about another installation's service.
export function withoutDenied (record, member, origin) {
  const out = ageRecordOf(record) || emptyAgeRecord()
  out.denied = out.denied.filter((d) => d.member !== member || d.origin !== origin)
  return out
}

export function isDenied (record, member, origin) {
  if (!isMember(member) || !isOrigin(origin)) return false
  const valid = ageRecordOf(record)
  return valid !== null && valid.denied.some((d) => d.member === member && d.origin === origin)
}

// A fresh service answer always wins over the proofs, even a worse one.
export function ageStateShown ({ answered, remembered } = {}) {
  if (answered !== undefined) return answered
  return remembered === true ? 'verificado' : undefined
}

// What a service answer does to the device record. Only a refusal is
// written; 'verificado' clears this installation's refusal (the node stores
// the proof). The others are shown for this run and leave both alone: a
// pending or expired session says nothing against a band already on record,
// and errors and unknown answers must not log a verified member out.
export function ageAnswerOutcome (state) {
  if (state === 'verificado') return 'clear'
  if (state === 'recusado') return 'deny'
  return 'show'
}

// The member certificate's `date` is canonical ISO (packages/core/lib/cert.js
// refuses anything else), so nothing looser is accepted here. `until` is the
// since attestation's signing date: the service re-signs it fresh, and an old
// one must not vouch for certificates issued after it, maybe while the check
// was off.
export function certVouches ({ certDate, since, until } = {}) {
  if (!isIso(certDate) || !isIso(since) || !isIso(until)) return false
  const cert = new Date(certDate).getTime()
  return cert >= new Date(since).getTime() && cert <= new Date(until).getTime()
}

// The only opener, fed from node.info: the node reports a value only for an
// attestation that verifies under its association (and its own key).
export function nodeVouches ({ ageVerifiedDate, memberCertDate, ageSince, ageSinceUntil } = {}) {
  return isIso(ageVerifiedDate) || certVouches({ certDate: memberCertDate, since: ageSince, until: ageSinceUntil })
}
