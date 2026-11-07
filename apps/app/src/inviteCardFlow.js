// The signup invite card on arrival: resolve the stored card record into what
// the screen may show, and the two taps it may offer (Seguir, Mandar um oi).
// Pure ES module: no React, no globals, no storage; request, accountStatus,
// guard and the clock are passed in, so Node's import() tests every branch.
//
// Every call resolves from scratch and nothing is cached or stored: the card
// record comes from tab storage, which anything on the origin can write
// (profileLink.js), so it is untrusted on every read. The card proves who
// WROTE the greeting for this code, not who issued the code: the member is
// only ever shown and offered the two taps, never treated as the issuer.

import rpc from '@varanda/rpc'
import { usernameMatches } from './account.js'

const { parseInviteCardUrl } = rpc

const CARD_MARK = '#c1.'
// A captured card is shown for one day after the link was opened.
export const CARD_RECORD_TTL_MS = 24 * 60 * 60 * 1000

const isRecord = (r) => r !== null && typeof r === 'object' && !Array.isArray(r) &&
  typeof r.code === 'string' && typeof r.body === 'string' && Number.isSafeInteger(r.at)

// Stable across reads of the same record, different for a replaced one. Never
// the signature alone: Ed25519 signatures from the browser sodium are
// malleable, so they are no identity key.
export function cardRecordId (record) {
  return isRecord(record) ? record.code + '.' + record.body + '.' + record.at : null
}

function result (fields) {
  return Object.freeze({
    signature: 'bad',
    membership: null,
    expired: false,
    card: null,
    member: null,
    username: null,
    recordId: null,
    ...fields
  })
}

function isUsageError (err) {
  return !!err && typeof err === 'object' && err.code === 'USAGE'
}

// { record, heldCode, request, accountStatus, nodeReady, now } -> a frozen
// { signature: 'wait'|'bad'|'ok', membership: 'linked'|'unlinked'|'unknown'|null,
//   expired, card, member, username, recordId }.
// 'wait': the node is not ready, or verify failed for a reason other than
// USAGE (locked, timeout): the caller resolves again later. membership
// 'unknown' (accountStatus threw, offline) never authorizes anything.
export async function resolveInviteCard ({ record, heldCode, request, accountStatus, nodeReady, now } = {}) {
  const recordId = cardRecordId(record)
  if (nodeReady !== true) return result({ signature: 'wait', recordId })
  if (recordId === null) return result({})
  // A card never shows for a code the app no longer holds.
  if (typeof heldCode !== 'string' || heldCode !== record.code) return result({ recordId })
  const card = parseInviteCardUrl('varanda:///convite/' + record.code + CARD_MARK + record.body)
  if (card === null || card.code !== record.code) return result({ recordId })
  const t = Number.isFinite(now) ? now : Date.now()
  const expired = t > record.at + CARD_RECORD_TTL_MS || Math.floor(t / 1000) > card.expires
  // Expiry is terminal: an expired card is never verified again and never
  // costs an account lookup (nor tells the service its key was opened).
  if (expired) return result({ recordId, expired: true })

  let verdict
  try {
    verdict = await request('inviteCard.verify', {
      code: card.code,
      design: card.design,
      name: card.name,
      message: card.message,
      expires: card.expires,
      member: card.member,
      signature: card.signature
    })
  } catch (err) {
    // USAGE: an old node without the method, or a refused shape.
    if (isUsageError(err)) return result({ recordId, expired })
    return result({ signature: 'wait', recordId })
  }
  if (!verdict || typeof verdict !== 'object' || verdict.ok !== true) {
    // A genuine card more than a day past its expires: still not 'ok'.
    const late = !!verdict && typeof verdict === 'object' && verdict.reason === 'expired'
    return result({ recordId, expired: expired || late })
  }

  const member = card.member
  let membership = 'unknown'
  let username = null
  try {
    const status = await accountStatus(member)
    membership = status && status.linked === true ? 'linked' : 'unlinked'
    if (membership === 'linked' && typeof status.username === 'string' &&
      usernameMatches(status.usernameRecord, member, status.username)) {
      username = status.username
    }
  } catch {
    membership = 'unknown'
  }
  return result({ signature: 'ok', membership, expired, card: Object.freeze({ ...card }), member, username, recordId })
}

export function canAttribute (r) {
  return !!r && r.signature === 'ok' && r.membership === 'linked' && r.expired === false &&
    typeof r.member === 'string'
}

function failure (err) {
  return err && err.uncertain === true ? 'uncertain' : 'failed'
}

// { request, result, member, text, guard } -> { follow, oi }. Nothing is
// called by construction; each tap writes at most once and never retries on
// its own (an 'uncertain' answer is the UNCERTAIN wording of ui/index.js for
// the caller, who decides whether the person taps again). guard() answers
// true only while the identity generation and the record id captured at
// render time are current; it is asked before EACH write. text is the fixed
// ARRIVAL_DM (inviteCardCopy.js), never the card message.
export function arrivalActions ({ request, result, member, text, guard } = {}) {
  const allowed = () => canAttribute(result) && result.member === member &&
    typeof guard === 'function' && guard() === true

  // -> 'done' | 'uncertain' | 'failed' | 'stale'
  async function follow () {
    if (!allowed()) return 'stale'
    try {
      await request('follow.add', { key: member })
      return 'done'
    } catch (err) {
      return failure(err)
    }
  }

  // -> 'sent' | 'nodm' | 'uncertain' | 'failed' | 'stale'
  async function oi () {
    if (!allowed() || typeof text !== 'string' || text === '') return 'stale'
    let found
    try {
      found = await request('dm.lookup', { member })
    } catch {
      return 'failed'
    }
    if (!found || typeof found.box !== 'string') return 'nodm'
    if (!allowed()) return 'stale'
    try {
      await request('dm.send', { to: member, text })
      return 'sent'
    } catch (err) {
      return failure(err)
    }
  }

  return Object.freeze({ follow, oi })
}
