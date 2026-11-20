'use strict'

// The pure rules of a poll (docs/protocol.md, the `poll` key of a post, the
// `choice` record and the group `group-poll` and `group-choice` records): a
// poll is a list of POLL_MIN..POLL_MAX option texts, a pick is the index of
// one of them or null (no vote). Core validates records with them, the node
// validates methods with them and the app builds its editor with them, so
// every side agrees. Zero dependencies, no Node built-ins. The checks never
// throw.

const L = require('./limits')
const { isInvisibleOnly, scan } = require('./profile-extra')

// One option: 1..MAX_POLL_OPTION code points on one line that show
// something (not only whitespace or invisible characters).
function isPollOption (v) {
  if (typeof v !== 'string') return false
  const n = scan(v, false)
  return n >= 1 && n <= L.MAX_POLL_OPTION && !isInvisibleOnly(v)
}

// The characters isInvisibleOnly counts as drawing nothing (profile-extra's
// INVISIBLE_ONLY set, whitespace aside), anywhere in a string.
const INVISIBLE = /[\u200b-\u200d\u2060\u00ad\u115f\u1160\u3164\uffa0\u2800\ufff9-\ufffb]|\udb40[\udc00-\udc7f]/g

// The text two options are compared by: NFKC-normalized when the runtime has
// String.prototype.normalize (fullwidth and composed forms fold), without
// the invisible characters, runs of whitespace as one space, trimmed. So
// 'Sim', ' Sim ', 'Sim' + U+200B and 'S' + U+00AD + 'im' are one option.
function pollKey (v) {
  let s = String(v)
  if (typeof String.prototype.normalize === 'function') {
    try {
      s = s.normalize('NFKC')
    } catch {}
  }
  return s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()
}

// The options of a poll: a dense array of POLL_MIN..POLL_MAX valid options,
// distinct by pollKey (so 'Sim' and ' Sim' + U+200B are one option twice).
function isPoll (v) {
  try {
    if (!Array.isArray(v) || v.length < L.POLL_MIN || v.length > L.POLL_MAX) return false
    const seen = new Set()
    for (let i = 0; i < v.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(v, i) || !isPollOption(v[i])) return false
      const key = pollKey(v[i])
      if (seen.has(key)) return false
      seen.add(key)
    }
    return true
  } catch {
    return false
  }
}

// A pick: null (no vote, or a vote withdrawn) or the index of an option of a
// poll with `count` options (POLL_MAX when the poll is not known, as the
// shape of a record or a method param).
function isPick (v, count = L.POLL_MAX) {
  if (v === null) return true
  const n = Number.isSafeInteger(count) ? Math.min(count, L.POLL_MAX) : L.POLL_MAX
  return Number.isSafeInteger(v) && v >= 0 && v < n
}

module.exports = {
  POLL_MIN: L.POLL_MIN,
  POLL_MAX: L.POLL_MAX,
  MAX_POLL_OPTION: L.MAX_POLL_OPTION,
  isPollOption,
  isPoll,
  isPick,
  pollKey
}
