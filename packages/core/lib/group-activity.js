'use strict'

// In memory only. Records, for each group writer core, the latest
// author-declared date of a validated plaintext group-post, with that
// post's seq, so the seeder can count the distinct diaries that wrote in a
// public group lately ("Em alta"). It says where to look and is not a
// signed fact. The seq lets the seeder drop activity that a later writer
// cut voids: the seeder removes the writer and rescans its tail when a cut
// changes.
//
// Pure and total: no I/O, no timers, no imports, and no method ever throws
// (a hostile argument answers false or null). No clock: the caller decides
// which dates are acceptable. A maxWriters that is not a safe integer >= 0
// falls back to the default, so a bad option cannot change the bound.

const DEFAULT_MAX_WRITERS = 4096
const HEX64 = /^[0-9a-f]{64}$/

function isWriter (writer) {
  return typeof writer === 'string' && HEX64.test(writer)
}

function nonNegInt (n) {
  return Number.isSafeInteger(n) && n >= 0
}

// A throwing or non-object options bag is the default cap, not an error.
function writerCap (options) {
  try {
    if (options === null || typeof options !== 'object') return DEFAULT_MAX_WRITERS
    const raw = options.maxWriters
    if (nonNegInt(raw)) return raw
  } catch {}
  return DEFAULT_MAX_WRITERS
}

function createGroupActivity (options = {}) {
  const maxWriters = writerCap(options)
  // writer core key -> { at, seq } of the post kept for that core.
  const byWriter = new Map()

  function observe (writer, atMs, seq) {
    try {
      if (!isWriter(writer) || !nonNegInt(atMs) || !nonNegInt(seq)) return false
      const held = byWriter.get(writer)
      if (held === undefined) {
        // The cap bounds how many writer cores are remembered. An existing
        // writer still moves forward, or a later post of its diary would
        // disappear from the count.
        if (byWriter.size >= maxWriters) return false
        byWriter.set(writer, { at: atMs, seq })
        return true
      }
      // The date is one post. A later date replaces the seq even when that
      // seq is smaller; only a tie keeps the greater seq, the post a later
      // cut would void. Already newer is still accepted: false is a bad
      // argument or a new writer past the cap, not "we kept the record".
      if (atMs > held.at || (atMs === held.at && seq > held.seq)) {
        byWriter.set(writer, { at: atMs, seq })
      }
      return true
    } catch {
      return false
    }
  }

  function lastAt (writer) {
    try {
      if (!isWriter(writer)) return null
      const held = byWriter.get(writer)
      return held === undefined ? null : held.at
    } catch {
      return null
    }
  }

  function entry (writer) {
    try {
      if (!isWriter(writer)) return null
      const held = byWriter.get(writer)
      if (held === undefined) return null
      return { at: held.at, seq: held.seq }
    } catch {
      return null
    }
  }

  function removeWriter (writer) {
    try {
      if (!isWriter(writer)) return false
      return byWriter.delete(writer)
    } catch {
      return false
    }
  }

  function clear () {
    try {
      byWriter.clear()
    } catch {}
  }

  function stats () {
    try {
      return { writers: byWriter.size }
    } catch {
      return { writers: 0 }
    }
  }

  return { observe, lastAt, entry, removeWriter, clear, stats }
}

module.exports = { DEFAULT_MAX_WRITERS, createGroupActivity }
