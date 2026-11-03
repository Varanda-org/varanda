'use strict'

// The validateLivenessToken lives only in this process: it never reaches the
// device, the disk or a log. Losing it on a restart just means a new retry.

const DEFAULT_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX = 4096

// Messages name the argument, never its value: the value may be the token.
function needString (value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(name + ' must be a non-empty string')
  }
}

function needPositiveInt (value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(name + ' must be a positive integer')
  }
}

function createLivenessTokens ({ now = Date.now, ttlMs = DEFAULT_TTL_MS, max = DEFAULT_MAX } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function')
  needPositiveInt(ttlMs, 'ttlMs')
  needPositiveInt(max, 'max')

  const entries = new Map()

  function live (member) {
    const entry = entries.get(member)
    if (!entry) return null
    if (now() - entry.at >= ttlMs) {
      entries.delete(member)
      return null
    }
    return entry
  }

  function put (member, documentId, token) {
    needString(member, 'member')
    needString(documentId, 'documentId')
    needString(token, 'token')
    // Delete first so a replaced entry moves to the end of the insertion order.
    entries.delete(member)
    entries.set(member, { documentId, token, at: now(), uncertain: false })
    while (entries.size > max) {
      entries.delete(entries.keys().next().value)
    }
  }

  function get (member, documentId) {
    needString(member, 'member')
    needString(documentId, 'documentId')
    const entry = live(member)
    if (!entry || entry.documentId !== documentId) return null
    return entry.token
  }

  // With documentId, only an entry for that selfie is touched: the answer
  // to a call about an older selfie must not reach a newer one stored
  // meanwhile.
  function drop (member, documentId) {
    needString(member, 'member')
    if (documentId !== undefined) {
      needString(documentId, 'documentId')
      const entry = entries.get(member)
      if (!entry || entry.documentId !== documentId) return
    }
    entries.delete(member)
  }

  function markUncertain (member, documentId) {
    needString(member, 'member')
    if (documentId !== undefined) needString(documentId, 'documentId')
    const entry = live(member)
    if (!entry) return
    if (documentId !== undefined && entry.documentId !== documentId) return
    entry.uncertain = true
  }

  function isUncertain (member) {
    needString(member, 'member')
    const entry = live(member)
    return entry ? entry.uncertain : false
  }

  // A plain object with no data fields: JSON.stringify or a stray log of the
  // store prints nothing that came from Hodle.
  return Object.freeze({
    put,
    get,
    drop,
    markUncertain,
    isUncertain,
    get size () { return entries.size }
  })
}

module.exports = { createLivenessTokens, DEFAULT_TTL_MS, DEFAULT_MAX }
