'use strict'

// Page lifecycle: page-close, page-moved, page-link and page-delegate.
// Signing and the countersigned/issuer-only checks live in lib/page.js;
// this module adds the per-type verifiers and the folds over a diary.
// Folds over a PAGE diary take RAW entries ({ seq, record }), never the
// output of applyDeletes: a `delete` naming a page-close, page-moved,
// page-origin, page-roster or page-link block must not undo it, or whoever
// leaked the page key could reopen a closed page or cancel a move with a
// tombstone. latestDelegate reads a PERSON's diary instead, where the
// ordinary deletion rule applies: it takes raw entries and folds the
// tombstones itself.
// The verify* functions and the folds never throw, whatever the input.

const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { isHex, normalizeHex, validateIssuerCertShape, verifyIssuerCert } = require('./cert')
const { PAGE_KEYS, isPlainObject, validRecordCopy } = require('./records')
const { deletedSeqs } = require('./deletion')
const page = require('./page')

const fail = (reason) => ({ ok: false, reason })

function has (obj, k) {
  return Object.prototype.hasOwnProperty.call(obj, k)
}

// The countersigned check of lib/page.js, restricted to `type`; then the
// actor must be `opts.owner` when given (after revocation, so a revoked
// issuer is reported as such).
function verifyActorRecord (type, record, pageKey, associationHex, opts) {
  try {
    const r = validRecordCopy(record, 1)
    if (r === null || r.type !== type) return fail('malformed')
    const owner = opts !== null && typeof opts === 'object' ? opts.owner : undefined
    if (owner !== undefined && owner !== null && !isHex(owner, 32)) return fail('malformed')
    const res = page.verifyCountersigned(r, pageKey, associationHex, opts)
    if (!res.ok) return res
    if (owner !== undefined && owner !== null && r.actor !== normalizeHex(owner)) return fail('not-owner')
    return { ok: true }
  } catch {
    return fail('malformed')
  }
}

function verifyClose (record, pageKey, associationHex, opts) {
  return verifyActorRecord('page-close', record, pageKey, associationHex, opts)
}

function verifyMoved (record, pageKey, associationHex, opts) {
  return verifyActorRecord('page-moved', record, pageKey, associationHex, opts)
}

function verifyLink (record, pageKey, associationHex, opts) {
  try {
    const r = validRecordCopy(record, 1)
    if (r === null || r.type !== 'page-link' || !isHex(pageKey, 32)) return fail('malformed')
    if (r.page !== normalizeHex(pageKey)) return fail('page-mismatch')
    return page.verifyIssuerOnly(r, associationHex, opts)
  } catch {
    return fail('malformed')
  }
}

// The issuer signs a page-link (a delegate actor shown with its diary's
// profile); the delegation trio comes from the issuer certificate, as
// createUsernameRecord does.
function issuerSignLink (fields, issuerKeyPair, issuerCert) {
  if (!isPlainObject(fields)) throw new TypeError('invalid page-link')
  if (!issuerKeyPair || !isKeyBytes(issuerKeyPair.secretKey, 64) || !isKeyBytes(issuerKeyPair.publicKey, 32)) {
    throw new TypeError('issuer key pair must have a 32-byte public key and a 64-byte secret key')
  }
  if (validateIssuerCertShape(issuerCert) !== null) throw new TypeError('invalid issuer certificate')
  if (b4a.toString(issuerKeyPair.publicKey, 'hex') !== issuerCert.issuer) throw new TypeError('issuer certificate is for another key')
  if (!verifyIssuerCert(issuerCert, issuerCert.association).ok) throw new TypeError('invalid issuer certificate')
  if (has(fields, 'association') && fields.association !== issuerCert.association) throw new TypeError('record names another association')
  const out = {}
  for (const k of PAGE_KEYS['page-link']) if (has(fields, k)) out[k] = fields[k]
  out.type = 'page-link'
  out.association = issuerCert.association
  out.issuer = issuerCert.issuer
  out.issuerDate = issuerCert.date
  out.issuerSignature = issuerCert.signature
  out.signature = '0'.repeat(128)
  if (validRecordCopy(out, 1) === null) throw new TypeError('invalid page-link')
  out.signature = b4a.toString(crypto.sign(page.ownerPayload(out), issuerKeyPair.secretKey), 'hex')
  return out
}

function isKeyBytes (buf, length) {
  return (b4a.isBuffer(buf) || buf instanceof Uint8Array) && buf.byteLength === length
}

// Each entry read once: shape-valid records by seq (the first entry wins a
// duplicated seq).
function recordsBySeq (entries, types) {
  const bySeq = new Map()
  if (!Array.isArray(entries)) return bySeq
  const n = entries.length
  for (let i = 0; i < n; i++) {
    try {
      const entry = entries[i]
      if (entry === null || typeof entry !== 'object') continue
      const seq = entry.seq
      // Page records and delegates never sit in block 0, and a negative seq
      // would sort first and become terminal.
      if (!Number.isSafeInteger(seq) || seq < 1 || bySeq.has(seq)) continue
      const copy = validRecordCopy(entry.record, seq)
      if (copy === null || !types.includes(copy.type)) continue
      bySeq.set(seq, copy)
    } catch {}
  }
  return bySeq
}

function verifyOpts (options) {
  try {
    if (options === null || typeof options !== 'object') return null
    const { revokedIssuers, owner } = options
    return { revokedIssuers, owner }
  } catch {
    return null
  }
}

function emptyLifecycle () {
  return { closed: null, movedTo: null, links: [] }
}

// The first verified page-close or page-moved, in block order, is terminal:
// it is the only one that counts and every later close, move or link is
// ignored, since a leaked page key can still append records (such as an
// already countersigned statement) after it.
function pageLifecycle (entries, pageKey, associationHex, options = {}) {
  try {
    const opts = verifyOpts(options)
    if (opts === null || !isHex(pageKey, 32)) return emptyLifecycle()
    const bySeq = recordsBySeq(entries, ['page-close', 'page-moved', 'page-link'])
    const seqs = [...bySeq.keys()].sort((a, b) => a - b)
    const out = emptyLifecycle()
    for (const seq of seqs) {
      const r = bySeq.get(seq)
      if (r.type === 'page-close') {
        if (verifyClose(r, pageKey, associationHex, opts).ok) {
          out.closed = { seq, at: r.at }
          break
        }
      } else if (r.type === 'page-moved') {
        if (verifyMoved(r, pageKey, associationHex, opts).ok) {
          out.movedTo = { to: r.to, seq }
          break
        }
      } else if (verifyLink(r, pageKey, associationHex, opts).ok) {
        out.links.push({ actor: r.actor, diary: r.diary, seq })
      }
    }
    return out
  } catch {
    return emptyLifecycle()
  }
}

function cutSeq (lifecycle) {
  try {
    if (!isPlainObject(lifecycle)) return null
    let cut = null
    for (const part of [lifecycle.closed, lifecycle.movedTo]) {
      if (part === null || typeof part !== 'object') continue
      const seq = part.seq
      if (Number.isSafeInteger(seq) && (cut === null || seq < cut)) cut = seq
    }
    return cut
  } catch {
    return null
  }
}

// Drops every block after the terminal close or move.
function cutEntries (entries, lifecycle) {
  if (!Array.isArray(entries)) return []
  const cut = cutSeq(lifecycle)
  if (cut === null) return entries
  const out = []
  const n = entries.length
  for (let i = 0; i < n; i++) {
    try {
      const entry = entries[i]
      if (entry !== null && typeof entry === 'object' && Number.isSafeInteger(entry.seq) && entry.seq <= cut) out.push(entry)
    } catch {}
  }
  return out
}

// The page-origin a moved page's new key carries at seq 3, when it verifies.
function originOf (entries, pageKey, associationHex, options = {}) {
  try {
    const opts = verifyOpts(options)
    if (opts === null) return null
    const origin = recordsBySeq(entries, ['page-origin']).get(3)
    if (origin === undefined) return null
    return page.verifyOrigin(origin, pageKey, associationHex, { revokedIssuers: opts.revokedIssuers }).ok ? origin : null
  } catch {
    return null
  }
}

// The delegate a core member's own diary names last, skipping deleted
// blocks; the diary's Hypercore signature is its only authentication.
function latestDelegate (entries) {
  try {
    const deleted = deletedSeqs(entries)
    let best = null
    for (const [seq, r] of recordsBySeq(entries, ['page-delegate'])) {
      if (deleted.has(seq)) continue
      if (best === null || seq > best.seq) best = { seq, actor: r.actor }
    }
    return best === null ? null : best.actor
  } catch {
    return null
  }
}

module.exports = {
  CLOSE_PREFIX: page.CLOSE_PREFIX,
  CLOSE_ISSUER_PREFIX: page.CLOSE_ISSUER_PREFIX,
  MOVED_PREFIX: page.MOVED_PREFIX,
  MOVED_ISSUER_PREFIX: page.MOVED_ISSUER_PREFIX,
  LINK_PREFIX: page.LINK_PREFIX,
  signClose: page.signClose,
  signMoved: page.signMoved,
  issuerCountersign: page.issuerCountersign,
  issuerSignLink,
  verifyClose,
  verifyMoved,
  verifyLink,
  pageLifecycle,
  cutEntries,
  originOf,
  latestDelegate
}
