'use strict'

// follows.json folded with the `follow` records of the own diary. Another
// device of the same member (the browser node, a second CLI) appends them, so
// the list this node's sync and feed read must follow the diary, not only
// what this node wrote itself (docs/protocol.md, section 2).
//
// A diary with no valid `follow` record leaves follows.json as it is. Otherwise
// a key with a record follows its last record (`followSet`); a key with none
// stays as listed (a follow from before `follow` records existed, which is
// never published here). The own key and entries that are not hex64 are
// dropped, and at most `max` keys are kept, sorted. follows.json is written
// only when the result differs.

const { followSet, followRecordKeys, hasFollowRecords } = require('./media')
const { readFollows, writeFollows } = require('./store')
const { isHex64 } = require('./records')

// -> { follows, changed }
function foldFollowsFile (dataDir, entries, ownHex, max) {
  const current = readFollows(dataDir)
  if (!hasFollowRecords(entries)) return { follows: current, changed: false }
  const decided = followRecordKeys(entries, ownHex)
  const keys = new Set(followSet(entries, ownHex))
  for (const raw of current) {
    if (typeof raw !== 'string' || !isHex64(raw.toLowerCase())) continue
    const key = raw.toLowerCase()
    if (key !== ownHex && !decided.has(key)) keys.add(key)
  }
  const follows = [...keys].sort().slice(0, max)
  const listed = [...new Set(current.filter((k) => typeof k === 'string').map((k) => k.toLowerCase()))].sort()
  if (follows.length === listed.length && follows.every((k, i) => k === listed[i]) && listed.length === current.length) {
    return { follows: current, changed: false }
  }
  writeFollows(dataDir, follows)
  return { follows: readFollows(dataDir), changed: true }
}

module.exports = { foldFollowsFile }
