'use strict'

// Ahead of a synchronous read, the certificate and username signatures it
// is about to check are verified with WebCrypto (@varanda/core/lib/verified
// warm), so the read finds them in the memo instead of checking each one in
// JavaScript. Without WebCrypto Ed25519 nothing happens. Never throws and
// changes no answer.

const b4a = require('b4a')
const { warm } = require('@varanda/core/lib/verified')
const { certChain, usernameChain, normalizeHex } = require('@varanda/core/lib/cert')
const { decodeBlock } = require('@varanda/core/lib/records')

function rootOf (associationHex) {
  const hex = normalizeHex(associationHex)
  return hex === null ? null : b4a.from(hex, 'hex')
}

// A diary's raw block 0, as ./sync.js localGate checks it.
async function warmBlock0 (raw, associationHex) {
  try {
    const root = rootOf(associationHex)
    const block0 = root === null || !raw ? null : decodeBlock(raw)
    if (block0 === null || typeof block0 !== 'object') return 0
    return await warm([certChain(block0.cert)], root)
  } catch {
    return 0
  }
}

// [{ key, entries: [{ seq, record }] }]: each log's certificate (block 0)
// and its newest username record naming the log's own key, the one
// core/lib/username.js verifies for it.
async function warmLogs (logs, associationHex) {
  try {
    const root = rootOf(associationHex)
    if (root === null) return 0
    const chains = []
    for (const { key, entries } of logs) {
      if (!Array.isArray(entries) || entries.length === 0) continue
      const first = entries[0]
      if (first && first.seq === 0 && first.record) chains.push(certChain(first.record.cert))
      const member = normalizeHex(key)
      for (let i = entries.length - 1; i >= 0; i--) {
        const record = entries[i] && entries[i].record
        if (record && record.type === 'username' && record.member === member) {
          chains.push(usernameChain(record))
          break
        }
      }
    }
    return await warm(chains, root)
  } catch {
    return 0
  }
}

module.exports = { warmBlock0, warmLogs }
