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

module.exports = {
  latestUsernameRecord,
  latestUsername
}
