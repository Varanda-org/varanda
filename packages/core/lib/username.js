'use strict'

// The @username of a diary (docs/protocol.md section 3, "Username record").
// records.js validates the shape only and must not import cert.js, so the
// signature check lives here.

const { validRecordCopy } = require('./records')
// Called through the module object (not destructured) so tests can count the
// verifications.
const cert = require('./cert')

// Plain-data copy of the diary's latest username record, or null. Never throws.
//
// The candidate is the HIGHEST-seq shape-valid `username` record whose
// `member` is the diary key; only that one record is verified (issuer
// delegation and record signature, for the association). If it does not
// verify the result is null: there is no fallback to an earlier record.
// Only the diary's owner can append to it, and `username.add` verifies a
// record before appending, so a bad newest record can only come from the
// owner's own modified client and only hides the owner's own name. In return
// a followed peer cannot make readers pay one verification per junk record:
// the cost is at most one candidate verification per log per feed build.
// Records naming another member (copied from someone else's diary) are never
// candidates; they are dropped by the shape/member filter at no crypto cost.
//
// `opts.revokedIssuers` (a Set of issuer keys, blocklist.js revokedIssuerSet)
// makes a record from a revoked issuer invalid like any other failing
// record: a newest candidate signed by a revoked issuer yields null.
function latestUsernameRecord (entries, memberHex, associationHex, opts) {
  try {
    const member = cert.normalizeHex(memberHex)
    if (member === null) return null
    let best = null
    let bestSeq = -1
    for (const { seq, record } of entries) {
      if (!Number.isSafeInteger(seq) || seq <= bestSeq) continue
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'username' || copy.member !== member) continue
      best = copy
      bestSeq = seq
    }
    if (best === null) return null
    return cert.verifyUsernameRecord(best, member, associationHex, opts).ok ? best : null
  } catch {
    return null
  }
}

// The username string of that record, or null.
function latestUsername (entries, memberHex, associationHex, opts) {
  const record = latestUsernameRecord(entries, memberHex, associationHex, opts)
  return record === null ? null : record.username
}

// Upper bound on the username records heldUsernames verifies per call.
const MAX_HELD_USERNAMES = 64

// Map username -> issuer hex of every name this diary verifiably held, or an
// empty Map. Never throws.
//
// For the reader's OWN diary and the seeder's bounded window only, not for a
// per-peer feed path: it may cost up to MAX_HELD_USERNAMES verifications.
// A name once held is never given to another member by the account service,
// so every verified historical name still identifies this member, and a
// renamed member keeps receiving mentions of the old name. Unlike
// latestUsernameRecord a bad newest record does not hide an earlier good one,
// but only the MAX_HELD_USERNAMES highest-seq shape-valid own records are
// candidates, so junk records can push old names out of the window and never
// make the caller pay more than that bound. Copied records naming another
// member are dropped by the shape/member filter at no crypto cost, and
// `opts.revokedIssuers` drops only the records of a revoked issuer.
function heldUsernames (entries, memberHex, associationHex, opts) {
  const held = new Map()
  try {
    const member = cert.normalizeHex(memberHex)
    if (member === null) return held
    const bySeq = new Map()
    for (const { seq, record } of entries) {
      if (!Number.isSafeInteger(seq) || bySeq.has(seq)) continue
      const copy = validRecordCopy(record, seq)
      if (copy === null || copy.type !== 'username' || copy.member !== member) continue
      bySeq.set(seq, copy)
    }
    const newest = [...bySeq.keys()].sort((a, b) => b - a).slice(0, MAX_HELD_USERNAMES)
    for (const seq of newest) {
      const record = bySeq.get(seq)
      // Newest first, so a name held twice maps to its newest issuer.
      if (held.has(record.username)) continue
      if (cert.verifyUsernameRecord(record, member, associationHex, opts).ok) held.set(record.username, record.issuer)
    }
    return held
  } catch {
    return new Map()
  }
}

module.exports = {
  MAX_HELD_USERNAMES,
  latestUsernameRecord,
  latestUsername,
  heldUsernames
}
