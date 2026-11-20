export const CLOSE_MAX = 16
const SOCIAL_KINDS = ['follow', 'reply', 'quote', 'mention', 'like', 'repost']
const HEX64 = /^[0-9a-f]{64}$/
const REF = /^([0-9a-f]{64}):[1-9][0-9]{0,14}$/
const TAG = /^varanda-(?:dm|dm-page|group-private|group-[0-9a-f]{64}|follow-[0-9a-f]{64}|(?:reply|quote|mention|like|repost)-[0-9a-f]{64}:[1-9][0-9]{0,14})$/

export function validTag (tag) {
  if (typeof tag !== 'string' || tag.length > 96) return false
  const match = TAG.exec(tag)
  return match !== null && match[0] === tag
}

function exactKeys (payload, keys) {
  return Object.keys(payload).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(payload, key))
}

// Keep payload acceptance aligned with sw.js, including its 15-digit refs.
function validBody (body) {
  if (typeof body !== 'string') return false
  const points = [...body]
  return points.length >= 1 && points.length <= 120 && points.every((point) => {
    const c = point.codePointAt(0)
    return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
      (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) ||
      (c >= 0xd800 && c <= 0xdfff) || c === 0x200e || c === 0x200f || c === 0x061c)
  })
}

// Only the read-close grammar is covered: generic, account and retired wakes
// cannot be cleared by reading an inbox or Avisos.
export function tagOf (payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
    Object.prototype.toString.call(payload) !== '[object Object]' || payload.v !== 1) return null
  const { kind } = payload
  if (kind === 'dm' || kind === 'dm-page' || kind === 'group-private' || kind === 'group') {
    if (!Number.isSafeInteger(payload.g) || payload.g <= 0) return null
    if (kind === 'group') {
      if (!exactKeys(payload, ['v', 'kind', 'group', 'body', 'g']) ||
        typeof payload.group !== 'string' || !HEX64.test(payload.group) ||
        (payload.body !== null && !validBody(payload.body))) return null
      return 'varanda-group-' + payload.group
    }
    return exactKeys(payload, ['v', 'kind', 'g']) ? 'varanda-' + kind : null
  }
  if (!SOCIAL_KINDS.includes(kind) || !exactKeys(payload, ['v', 'kind', 'body', 'actor', 'recipient', 'ref']) ||
    !validBody(payload.body)) return null
  const { actor, recipient, ref } = payload
  if (typeof actor !== 'string' || !HEX64.test(actor) ||
    typeof recipient !== 'string' || !HEX64.test(recipient) || actor === recipient) return null
  if (kind === 'follow') {
    if (ref !== null) return null
  } else {
    const match = typeof ref === 'string' ? REF.exec(ref) : null
    if (match === null || match[1] !== (kind === 'quote' || kind === 'mention' ? actor : recipient)) return null
  }
  return 'varanda-' + kind + '-' + (ref || actor)
}

export async function tagHash (tag) {
  if (typeof tag !== 'string') throw new TypeError('tag must be a string')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(tag))
  const bytes = new Uint8Array(digest).subarray(0, 12)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_')
}

function timeOf (at) {
  const time = typeof at === 'string' ? Date.parse(at) : at
  return Number.isFinite(time) && time > 0 ? time : 0
}

/**
 * Accepts normalized snapshots: dm/pageDm { unread: count, requests: count
 * or boolean, at? }, public groups [{ group: hex64, unread: count, at? }],
 * privateUnread: total unread count, avisos [{ kind, key, seq, post, read, at? }].
 * Avisos key/seq identify the actor's record; post is the target ref for
 * reply/like/repost, because noticeRef opens the reply instead of its target.
 * Only read === true closes a social tag. Omitted state is unknown.
 * at is epoch milliseconds or ISO text; newest first, missing dates last,
 * ties by tag. The undated private total sorts with missing dates.
 */
export function readTags ({ dm, pageDm, groups, privateUnread, avisos } = {}) {
  const candidates = new Map()
  const unread = new Set()
  function add (tag, read, at) {
    if (!validTag(tag)) return
    if (!read) unread.add(tag)
    else candidates.set(tag, Math.max(candidates.get(tag) || 0, timeOf(at)))
  }
  for (const [inbox, tag] of [[dm, 'varanda-dm'], [pageDm, 'varanda-dm-page']]) {
    if (inbox) add(tag, inbox.unread === 0 && (inbox.requests === 0 || inbox.requests === false), inbox.at)
  }
  if (Array.isArray(groups)) {
    for (const row of groups) {
      if (row) add('varanda-group-' + row.group, row.unread === 0, row.at)
    }
  }
  if (privateUnread === 0) add('varanda-group-private', true)
  if (Array.isArray(avisos)) {
    for (const row of avisos) {
      if (!row) continue
      const kind = row.kind === undefined ? 'follow' : row.kind
      const ref = kind === 'follow'
        ? row.key
        : kind === 'quote' || kind === 'mention'
          ? row.key + ':' + row.seq
          : row.post
      add('varanda-' + kind + '-' + ref, row.read === true, row.at)
    }
  }
  return [...candidates].filter(([tag]) => !unread.has(tag))
    .sort(([a, at], [b, bt]) => bt - at || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, CLOSE_MAX).map(([tag]) => tag)
}
