'use strict'

// Media cores and follows, pure helpers (no I/O).
//
// A media core is a Hypercore whose block 0 is the JSON header
// { type: 'media-header', v: 1, diary, at } (exact keys, at most
// MAX_HEADER_BYTES) and whose blocks 1.. are raw item bytes, MEDIA_BLOCK_BYTES
// each (the last block of an item shorter). A diary declares its media cores
// with `media-core` records; a post points into one with media descriptors
// (lib/records.js). Its follows are `follow` records replayed in seq order.
// Every export here never throws, whatever the input (hostile getters
// included); mediaHeader, a builder, throws a TypeError on invalid input as
// the record builders do.

const b4a = require('b4a')
const {
  MAX_MEDIA_CORES,
  isHex64,
  isCanonicalIso,
  nowIso,
  validDescriptor,
  validRecordCopy
} = require('./records')

const MAX_HEADER_BYTES = 16384
const HEADER_KEYS = ['type', 'v', 'diary', 'at']

function isPlainObject (v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (obj, keys) {
  const own = Object.keys(obj)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

// -> null when `d` is a valid media descriptor, else 'media-invalid'.
function validateDescriptor (d) {
  return validDescriptor(d) ? null : 'media-invalid'
}

// -> null when `h` is a valid media header, else a short reason.
function validateMediaHeader (h) {
  try {
    if (!isPlainObject(h) || !hasExactKeys(h, HEADER_KEYS)) return 'malformed'
    const { type, v, diary, at } = h
    if (type !== 'media-header' || v !== 1 || !isHex64(diary)) return 'malformed'
    if (!isCanonicalIso(at)) return 'date-invalid'
    if (b4a.byteLength(JSON.stringify({ type, v, diary, at })) > MAX_HEADER_BYTES) return 'too-large'
    return null
  } catch {
    return 'malformed'
  }
}

function mediaHeader ({ diary, at = nowIso() } = {}) {
  const header = { type: 'media-header', v: 1, diary, at }
  const reason = validateMediaHeader(header)
  if (reason) throw new TypeError(reason)
  return header
}

// Each entry read once ({ seq, record }), the record checked on a copy; only
// valid records at seq >= 1 are kept, in input order.
function validEntries (entries, type) {
  const out = []
  if (!Array.isArray(entries)) return out
  for (let i = 0; i < entries.length; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const seq = entry.seq
      if (!Number.isSafeInteger(seq) || seq < 1) continue
      const copy = validRecordCopy(entry.record, seq)
      if (copy !== null && copy.type === type) out.push({ seq, record: copy })
    } catch {}
  }
  return out
}

// The latest `n` declared media cores of a diary, newest first: [{ key, seq }]
// deduplicated by key (newest seq kept). The diary's own key is never a media
// core.
function latestMediaCores (entries, diaryHex, n = MAX_MEDIA_CORES) {
  try {
    if (!Number.isSafeInteger(n) || n < 0) return []
    const best = new Map()
    for (const { seq, record } of validEntries(entries, 'media-core')) {
      if (record.key === diaryHex) continue
      const prev = best.get(record.key)
      if (prev === undefined || seq > prev) best.set(record.key, seq)
    }
    return [...best].map(([key, seq]) => ({ key, seq })).sort((a, b) => b.seq - a.seq).slice(0, n)
  } catch {
    return []
  }
}

// The followed keys, sorted: `follow` records replayed in seq order, the last
// one per key wins; the own key is ignored.
function followSet (entries, ownHex) {
  try {
    const state = new Map()
    const list = validEntries(entries, 'follow').sort((a, b) => a.seq - b.seq)
    for (const { record } of list) {
      if (record.key === ownHex) continue
      state.set(record.key, record.on)
    }
    return [...state].filter(([, on]) => on).map(([key]) => key).sort()
  } catch {
    return []
  }
}

function hasFollowRecords (entries) {
  try {
    return validEntries(entries, 'follow').length > 0
  } catch {
    return false
  }
}

// True when a valid descriptor points into one of the own media cores
// (`ownCores`: an array or a Set of hex keys).
function isOwnMediaCore (descriptor, ownCores) {
  try {
    if (!isPlainObject(descriptor)) return false
    const copy = {}
    for (const k of Object.keys(descriptor)) copy[k] = descriptor[k]
    if (!validDescriptor(copy)) return false
    if (ownCores instanceof Set) return ownCores.has(copy.core)
    return Array.isArray(ownCores) && ownCores.includes(copy.core)
  } catch {
    return false
  }
}

module.exports = {
  MAX_HEADER_BYTES,
  validateDescriptor,
  validateMediaHeader,
  mediaHeader,
  latestMediaCores,
  followSet,
  hasFollowRecords,
  isOwnMediaCore
}
