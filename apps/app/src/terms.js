// The device's record of who accepted which version of the Termos de Uso and
// the Política de Privacidade. Pure ES module: no React, no globals, no Node
// built-ins; storage lives in termsStore.web.js / termsStore.native.js and the
// caller passes everything in, so Node's import() tests every branch.
//
// The record is untrusted input on every read (anything on the origin could
// have written localStorage), so termsRecordOf rebuilds it strictly and
// refuses anything doubtful: a refused record means "ask again", never a
// silent acceptance.

import { formatNextChange } from './account.js'

export const STORAGE_KEY = 'varanda-terms'
export const FILE_NAME = 'varanda-terms.json'
export const MAX_MEMBERS = 16

const MEMBER_RE = /^[0-9a-f]{64}$/
const RECORD_KEYS = ['members', 'v', 'version']
const ENTRY_KEYS = ['acceptedAt', 'synced']

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype

const isVersion = (n) => Number.isInteger(n) && n >= 1 && n <= 9999

function sameKeys (obj, keys) {
  const own = Object.keys(obj).sort()
  return own.length === keys.length && own.every((k, i) => k === keys[i])
}

// Canonical ISO: exactly what Date#toISOString would print for that instant.
function isIso (s) {
  if (typeof s !== 'string' || s.length !== 24) return false
  const d = new Date(s)
  return !Number.isNaN(d.getTime()) && d.toISOString() === s
}

export function isMemberKey (s) {
  return typeof s === 'string' && MEMBER_RE.test(s)
}

// value -> a fresh, validated record, or null. Strict and total.
export function termsRecordOf (value) {
  try {
    if (!isObject(value) || !sameKeys(value, RECORD_KEYS)) return null
    if (value.v !== 1 || !isVersion(value.version)) return null
    const members = value.members
    if (!isObject(members)) return null
    const keys = Object.keys(members)
    if (keys.length > MAX_MEMBERS) return null
    const out = {}
    for (const key of keys) {
      const entry = members[key]
      if (!isMemberKey(key) || !isObject(entry) || !sameKeys(entry, ENTRY_KEYS)) return null
      if (!isIso(entry.acceptedAt) || typeof entry.synced !== 'boolean') return null
      out[key] = { acceptedAt: entry.acceptedAt, synced: entry.synced }
    }
    return { v: 1, version: value.version, members: out }
  } catch {
    return null
  }
}

const hasMember = (record, member) =>
  !!record && isObject(record.members) && Object.hasOwn(record.members, member)

// What the entry gate shows. `claim` is null or {at} (an acceptance of
// `version` made on this page load before anyone signed in). The order
// matters:
// - Hosted, nothing is decided until the identity is known, so the passkey
//   ceremony is never interrupted.
// - Hosted and locked at Entrar with no member yet: an existing passkey is
//   about to enter. The gate waits until after Entrar, where the member is
//   known and an acceptance it gave on another device can be found
//   (shouldAskHeld); asking here would ask everyone who already accepted.
//   Nothing about the member flows before Entrar, and once it is known the
//   rows below decide.
// - Hosted, unlocked, no member yet (a first passkey ceremony): the shell
//   learns the new key only after passkey.refresh, while Identidade already
//   talks to the account service, so Criar conta stays gated before
//   anything is sent: only a claim from this page load lets it through.
// - Native/serve before the identity exists: no external data flows yet, so
//   a record at the current version is enough.
// - A known member must be in a record at the current version, or hold the
//   claim to bind.
export function termsDecision ({ record, version, member, claim, hosted, identityKnown, locked } = {}) {
  if (hosted === true && identityKnown === false) return 'loading'
  const known = member !== null && member !== undefined
  const claimed = claim !== null && claim !== undefined
  if (hosted === true && !known) {
    if (locked === true) return 'accepted'
    return claimed ? 'accepted' : 'needed'
  }
  if (record === null || record === undefined) return 'needed'
  if (record.version !== version) return 'updated'
  if (!known) return 'accepted'
  if (hasMember(record, member)) return 'accepted'
  return claimed ? 'bind' : 'account'
}

// A new record with `member` accepted at `acceptedAt`. A missing record or one
// for another version starts over; an existing entry is kept as it is; past
// MAX_MEMBERS the oldest acceptance is dropped.
export function withMember (record, version, member, acceptedAt) {
  return withEntry(record, version, member, { acceptedAt, synced: false })
}

function withEntry (record, version, member, entry) {
  const base = record && record.version === version && isObject(record.members)
    ? record.members
    : {}
  const members = {}
  for (const key of Object.keys(base)) members[key] = { ...base[key] }
  if (member !== null && member !== undefined && !Object.hasOwn(members, member)) {
    members[member] = entry
    // Never the member just added: with the clock behind the stored dates it
    // would be the oldest, and the gate would never open.
    while (Object.keys(members).length > MAX_MEMBERS) {
      let oldest = null
      for (const key of Object.keys(members)) {
        if (key === member) continue
        if (oldest === null || members[key].acceptedAt < members[oldest].acceptedAt) oldest = key
      }
      delete members[oldest]
    }
  }
  return { v: 1, version, members }
}

// The account service answered that `member` accepted `version` at
// `acceptedAt` on another device: recorded as already synced, so the device
// never sends it back. Same rules as withMember; anything doubtful leaves the
// record as it is (the gate then asks).
export function withHeld (record, version, member, acceptedAt) {
  if (!isMemberKey(member) || !isVersion(version) || !isIso(acceptedAt)) return record
  if (record && record.version === version && hasMember(record, member)) return record
  return withEntry(record, version, member, { acceptedAt, synced: true })
}

export function withSynced (record, member) {
  if (!hasMember(record, member)) return record
  return {
    v: 1,
    version: record.version,
    members: { ...record.members, [member]: { ...record.members[member], synced: true } }
  }
}

export function withoutMember (record, member) {
  if (!hasMember(record, member)) return record
  const members = { ...record.members }
  delete members[member]
  return { v: 1, version: record.version, members }
}

// Whether to send this member's acceptance to the account service now. Every
// gate must be open; one attempt per page load (attempted).
export function shouldSyncTerms ({ hosted, termsOk, ready, online, locked, setupDone, recovering, onceSync, member, record, version, attempted } = {}) {
  if (hosted !== true || termsOk !== true || ready !== true || online === false) return false
  if (locked !== false || setupDone !== true || recovering !== false || onceSync !== false) return false
  if (member === null || member === undefined || !record || record.version !== version) return false
  if (!hasMember(record, member) || record.members[member].synced === true) return false
  return attempted === false
}

// The shell's memory of one member#version sync in this page load: undefined
// (never tried) or { count, state }. States: 'busy' (a run in flight),
// 'done', 'transient' (a failure that spent an attempt), 'retry' (armed to
// run again) and 'so-aparelho' (no directory link: sticky until the Ajustes
// re-arm). Events:
//   start         a run begins (after a 'done' the count starts over)
//   ok            the server has the acceptance
//   fail          any other failure
//   nao-vinculado the member has no directory link
//   generation    a lock, unlock or reset dropped the run: armed again and
//                 the attempt is given back
//   online        back online: a transient failure is armed again, up to
//                 TERMS_SYNC_MAX attempts
//   rearm         the link confirmed in Ajustes: 'so-aparelho' is forgotten;
//                 'transient' is armed again under TERMS_SYNC_MAX (its count
//                 is kept)
//   drop          the member was dropped (Recomeçar): forgotten
// 'online' and 'rearm' on a 'busy' entry mark it `again`: the run in flight
// may have started before the network came back or the link was confirmed,
// so if it then fails (or answers 'nao-vinculado') it is armed again instead
// of settling. Unknown events, and settle events on an entry that is not
// 'busy', change nothing (the same object comes back).
export const TERMS_SYNC_MAX = 3

const SETTLE = { ok: 'done', fail: 'transient', 'nao-vinculado': 'so-aparelho' }

export function termsSyncStep (entry, event) {
  const e = isObject(entry) ? entry : undefined
  if (event === 'drop') return undefined
  if (event === 'start') {
    const count = e && e.state !== 'done' && Number.isInteger(e.count) ? e.count : 0
    return { count: count + 1, state: 'busy' }
  }
  if (e === undefined) return entry
  if (Object.hasOwn(SETTLE, event)) {
    if (e.state !== 'busy') return entry
    const state = SETTLE[event]
    if (e.again === true && state !== 'done') return { count: e.count, state: 'retry' }
    return { count: e.count, state }
  }
  if (event === 'generation') {
    return e.state === 'busy' ? { count: Math.max(0, e.count - 1), state: 'retry' } : entry
  }
  if (event === 'online') {
    if (e.state === 'busy') return e.count < TERMS_SYNC_MAX && e.again !== true ? { ...e, again: true } : entry
    return e.state === 'transient' && e.count < TERMS_SYNC_MAX ? { count: e.count, state: 'retry' } : entry
  }
  if (event === 'rearm') {
    if (e.state === 'busy') return e.count < TERMS_SYNC_MAX && e.again !== true ? { ...e, again: true } : entry
    if (e.state === 'so-aparelho') return undefined
    // A transient failure keeps its count: the re-arm must not reset the
    // TERMS_SYNC_MAX attempts per page load.
    if (e.state === 'transient') return e.count < TERMS_SYNC_MAX ? { count: e.count, state: 'retry' } : entry
    return entry
  }
  return entry
}

// Whether that memory blocks a run now (shouldSyncTerms' `attempted`).
// `recordEntry` is the device record's entry for the member ({acceptedAt,
// synced} or null): a 'done' with an entry that is not synced means a fresh
// acceptance was written after the last run (accept or bind after
// Recomeçar), so it does not block.
export function termsSyncAttempted (entry, recordEntry) {
  if (!isObject(entry)) return false
  if (entry.state === 'retry') return false
  if (entry.state === 'done' && isObject(recordEntry) && recordEntry.synced !== true) return false
  return true
}

// The check after Entrar: did this member accept the current version on
// another device? One question per member#version per page load (heldKey),
// and the gate waits at most TERMS_HELD_WAIT_MS for the answer.
export const TERMS_HELD_WAIT_MS = 4000

const HELD_DECISIONS = ['needed', 'updated', 'account']

export function heldKey (member, version) {
  return `${member}#${version}`
}

// A claim means the gate was just answered on this device: nothing to ask.
export function shouldAskHeld ({ hosted, member, claim, decision, online, entry } = {}) {
  if (hosted !== true || !isMemberKey(member) || online === false) return false
  if (claim !== null && claim !== undefined) return false
  if (!HELD_DECISIONS.includes(decision)) return false
  return entry === null || entry === undefined
}

// The memory of one question: { state: 'asking', at } while it is in flight,
// then 'held', 'none' (not accepted there, or an older service), 'failed' or
// 'timeout'. 'wait' holds the gate back only while the question is young;
// otherwise the caller shows what the decision says.
export function heldGate ({ decision, entry, elapsedMs } = {}) {
  if (!HELD_DECISIONS.includes(decision) || !isObject(entry) || entry.state !== 'asking') return 'show'
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < TERMS_HELD_WAIT_MS ? 'wait' : 'show'
}

// Outcomes: 'held', 'none', 'failed', 'timeout'. Only an entry still asking
// moves, so a settled entry is a latch: once the gate may have been shown
// (none, failed, timeout) it never becomes 'held'. A 'held' answer that
// arrives at or after TERMS_HELD_WAIT_MS is a timeout, because heldGate
// already let the gate show; the caller ignores it and records nothing.
export function heldSettle (entry, outcome, elapsedMs) {
  if (!isObject(entry) || entry.state !== 'asking') return entry
  if (outcome === 'held') {
    const inTime = Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < TERMS_HELD_WAIT_MS
    return { state: inTime ? 'held' : 'timeout' }
  }
  if (outcome === 'none' || outcome === 'failed' || outcome === 'timeout') return { state: outcome }
  return entry
}

export function formatAcceptedAt (iso) {
  return formatNextChange(iso)
}
