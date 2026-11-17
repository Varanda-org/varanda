'use strict'

// Web Push notices: which record in a member's log becomes a push to whom,
// the actor name the notice may carry, and the shape of the event the seeder
// relays to the account service. Pure: no I/O, no clock, never throws.
const { formatRef, parseRef, isHex64, isCanonicalIso } = require('./records')
const { displayText, mentionTokens, MENTION_MAX } = require('@varanda/rpc')

const PUSH_KINDS = ['follow', 'reply', 'quote', 'mention', 'like', 'repost']
// Kinds whose ref names the actor's own post (actor:seq), not the recipient's.
const OWN_REF_KINDS = ['quote', 'mention']
// One push per recipient per post: a post that replies to someone and also
// quotes or mentions them notifies once, as the strongest kind whose target
// the seeder can confirm (the weaker kinds travel as alternates).
const PRIORITY = { reply: 3, quote: 2, mention: 1 }
const PUSH_MAX_AGE_MS = 6 * 3600 * 1000
const MAX_PUSH_NAME = 64
const EVENT_KEYS = ['v', 'kind', 'actor', 'recipient', 'seq', 'ref', 'name']

// Must stay aligned with AT_SIGNS, INVISIBLE and invisible() in
// apps/app/src/who.js: a push must never show a name the app would not.
const AT_SIGNS = [0x40, 0xff20, 0xfe6b]
const INVISIBLE = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160],
  [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff]
]

function invisible (cp) {
  return /\s/.test(String.fromCodePoint(cp)) || INVISIBLE.some(([from, to]) => cp >= from && cp <= to)
}

function isPlainObject (v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function hasExactKeys (o, keys) {
  const own = Object.keys(o)
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k))
}

function isTarget (r) {
  return isPlainObject(r) && isHex64(r.author) && Number.isSafeInteger(r.seq) && r.seq >= 1
}

// A predicate that throws counts against the push: isMember false,
// isBlocked true.
function ask (fn, key, onError) {
  try {
    return typeof fn === 'function' ? fn(key) === true : onError
  } catch {
    return onError
  }
}

// The single target pushCandidate knows: follow, reply, like or repost. A
// quote or mention is never returned here (pushCandidates covers those).
function target (record, author) {
  const type = record.type
  if (type === 'follow') {
    if (record.on !== true || !isHex64(record.key) || record.key === author) return null
    return { kind: 'follow', recipient: record.key, ref: null, targetSeq: null }
  }
  if (type === 'post') {
    const replyTo = record.replyTo
    if (!isTarget(replyTo) || replyTo.author === author) return null
    return { kind: 'reply', recipient: replyTo.author, ref: formatRef(replyTo), targetSeq: replyTo.seq }
  }
  if (type === 'like' || type === 'repost') {
    const to = record.to
    if (record.on !== true || !isTarget(to) || to.author === author) return null
    return { kind: type, recipient: to.author, ref: formatRef(to), targetSeq: to.seq }
  }
  return null
}

// The member keys holding a username, as the caller reports them. Anything
// but an array, or a lookup that throws, counts as nobody.
function holdersOf (holders, token) {
  try {
    if (typeof holders !== 'function') return []
    const list = holders(token)
    if (!Array.isArray(list)) return []
    const keys = []
    for (const key of list) if (isHex64(key)) keys.push(key)
    return keys
  } catch {
    return []
  }
}

// Every recipient a post notifies: the replied-to author, the quoted author
// and the members holding each mentioned name. A quote or mention ref is the
// actor's own post (author:seq): the recipient's post is either the quoted
// one (targetSeq) or absent.
function postTargets (record, author, seq, holders) {
  const hits = []
  const replyTo = record.replyTo
  if (isTarget(replyTo) && replyTo.author !== author) {
    hits.push({ kind: 'reply', recipient: replyTo.author, ref: formatRef(replyTo), targetSeq: replyTo.seq })
  }
  const own = formatRef({ author, seq })
  const quote = record.quote
  if (isTarget(quote) && quote.author !== author) {
    hits.push({ kind: 'quote', recipient: quote.author, ref: own, targetSeq: quote.seq })
  }
  for (const token of mentionTokens(record.text, MENTION_MAX)) {
    for (const key of holdersOf(holders, token)) {
      if (key !== author) hits.push({ kind: 'mention', recipient: key, ref: own, targetSeq: null })
    }
  }
  return hits
}

// record.at is author-supplied, so the age check can only suppress a notice
// (records written while the seeder was offline and synced after a restart),
// never vouch for one: the seeder cursor is what prevents replays.
function tooOld (at, now) {
  return isCanonicalIso(at) && now - Date.parse(at) > PUSH_MAX_AGE_MS
}

function pushCandidate (args) {
  try {
    if (!isPlainObject(args)) return null
    const { author, seq, record, isMember, isBlocked, now } = args
    if (!isHex64(author) || !Number.isSafeInteger(seq) || seq < 1) return null
    if (!Number.isFinite(now) || !isPlainObject(record)) return null
    const hit = target(record, author)
    if (hit === null || tooOld(record.at, now)) return null
    if (!ask(isMember, hit.recipient, false)) return null
    if (ask(isBlocked, author, true) || ask(isBlocked, hit.recipient, true)) return null
    return { kind: hit.kind, actor: author, recipient: hit.recipient, seq, ref: hit.ref }
  } catch {
    return null
  }
}

// Every push one record yields, at most one per recipient, each recipient a
// member and neither side blocked. Each result is the recipient's strongest
// hit (reply over quote over mention) and carries the weaker distinct kinds
// in priority order as `alternates` ({ kind, ref, targetSeq }): the seeder
// confirms a target post before it emits, so a reply to a missing post can
// fall back to a quote or a mention, as the in-app notice does. Sorted by
// priority, then recipient, so the result does not depend on lookup order.
// args.holders(token) returns the member keys holding a username.
function pushCandidates (args) {
  try {
    if (!isPlainObject(args)) return []
    const { author, seq, record, isMember, isBlocked, now, holders } = args
    if (!isHex64(author) || !Number.isSafeInteger(seq) || seq < 1) return []
    if (!Number.isFinite(now) || !isPlainObject(record)) return []
    if (tooOld(record.at, now)) return []
    let hits
    if (record.type === 'post') {
      hits = postTargets(record, author, seq, holders)
    } else {
      const hit = target(record, author)
      hits = hit === null ? [] : [hit]
    }
    if (hits.length === 0 || ask(isBlocked, author, true)) return []
    const byRecipient = new Map()
    for (const hit of hits) {
      const list = byRecipient.get(hit.recipient)
      if (list === undefined) byRecipient.set(hit.recipient, [hit])
      else if (!list.some((h) => h.kind === hit.kind)) list.push(hit)
    }
    const out = []
    for (const [recipient, list] of byRecipient) {
      if (!ask(isMember, recipient, false) || ask(isBlocked, recipient, true)) continue
      list.sort((a, b) => (PRIORITY[b.kind] || 0) - (PRIORITY[a.kind] || 0))
      const [top, ...rest] = list
      const alternates = rest.map((h) => ({ kind: h.kind, ref: h.ref, targetSeq: h.targetSeq }))
      out.push({ kind: top.kind, actor: author, recipient, seq, ref: top.ref, targetSeq: top.targetSeq, alternates })
    }
    out.sort((a, b) => (PRIORITY[b.kind] || 0) - (PRIORITY[a.kind] || 0) || (a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0))
    return out
  } catch {
    return []
  }
}

function stripLeading (chars) {
  let i = 0
  while (i < chars.length) {
    const cp = chars[i].codePointAt(0)
    if (!AT_SIGNS.includes(cp) && !invisible(cp)) break
    i++
  }
  return chars.slice(i)
}

// The actor's display name for the notice text, rendered as the app's
// displayName would, or null when there is nothing visible to show. The
// strip runs before displayText too: a direction mark is both invisible and
// display-unsafe, and once displayText turned it into U+FFFD the strip would
// stop there and show a name the app hides.
function pushName (value) {
  try {
    if (typeof value !== 'string' || value === '') return null
    const shown = displayText(stripLeading(Array.from(value)).join(''))
    // Checked after the clip: the visible part may lie past the 64th code point.
    const name = Array.from(stripLeading(Array.from(shown)).join('').trim()).slice(0, MAX_PUSH_NAME)
    if (!name.some((ch) => ch !== '\ufffd' && !invisible(ch.codePointAt(0)))) return null
    return name.join('')
  } catch {
    return null
  }
}

// displayText replaces every display-unsafe code point (lone surrogates
// included), so a name it would change is not safe to show as is.
function validName (name) {
  if (name === null) return true
  if (typeof name !== 'string') return false
  const length = Array.from(name).length
  return length >= 1 && length <= MAX_PUSH_NAME && displayText(name) === name
}

function validatePushEvent (obj) {
  try {
    if (!isPlainObject(obj) || !hasExactKeys(obj, EVENT_KEYS)) return false
    const { v, kind, actor, recipient, seq, ref, name } = obj
    if (v !== 1 || !PUSH_KINDS.includes(kind)) return false
    if (!isHex64(actor) || !isHex64(recipient) || actor === recipient) return false
    if (!Number.isSafeInteger(seq) || seq < 1) return false
    if (kind === 'follow') {
      if (ref !== null) return false
    } else {
      const parsed = parseRef(ref)
      if (parsed === null || parsed.seq < 1 || formatRef(parsed) !== ref) return false
      if (OWN_REF_KINDS.includes(kind)) {
        // The actor's own post: a quote or mention never points into the
        // recipient's log, so the push cannot name a post of theirs.
        if (parsed.author !== actor || parsed.seq !== seq) return false
      } else if (parsed.author !== recipient) {
        return false
      }
    }
    return validName(name)
  } catch {
    return false
  }
}

module.exports = {
  PUSH_KINDS,
  PUSH_MAX_AGE_MS,
  pushCandidate,
  pushCandidates,
  pushName,
  validatePushEvent
}
