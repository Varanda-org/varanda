'use strict'

// follows.json folded with the `follow` records of the own diary. Another
// device of the same member (the browser node, a second CLI) appends them, so
// the list this node's sync and feed read must follow the diary, not only
// what this node wrote itself (docs/protocol.md, section 2).
//
// A diary with no valid `follow` record leaves follows.json as it is, and so
// does a diary read with a hole (`entries` shorter than `length`, the signed
// length): records past the hole are unseen, so a local `off` there would be
// undone by an older `on` before it. Otherwise a key with a record follows its
// last record (`followSet`); a key with none stays as listed (a follow from
// before `follow` records existed, which is never published here). The own key
// and entries that are not hex64 are dropped. At most `max` keys are kept,
// sorted, the ones with a record first, so an old follow never pushes one out.
// follows.json is written only when the result differs.

const { followSet, followRecordKeys, hasFollowRecords } = require('./media')
const { readFollows, writeFollows } = require('./store')
const { isHex64 } = require('./records')

// `length` is the diary's signed length -> { follows, changed }
function foldFollowsFile (dataDir, entries, ownHex, max, length) {
  const current = readFollows(dataDir)
  if (entries.length < length || !hasFollowRecords(entries)) return { follows: current, changed: false }
  const decided = followRecordKeys(entries, ownHex)
  const recorded = [...new Set(followSet(entries, ownHex))].sort()
  const old = new Set()
  for (const raw of current) {
    if (typeof raw !== 'string' || !isHex64(raw.toLowerCase())) continue
    const key = raw.toLowerCase()
    if (key !== ownHex && !decided.has(key)) old.add(key)
  }
  const follows = [...recorded, ...[...old].sort()].slice(0, max).sort()
  const listed = [...new Set(current.filter((k) => typeof k === 'string').map((k) => k.toLowerCase()))].sort()
  if (follows.length === listed.length && follows.every((k, i) => k === listed[i]) && listed.length === current.length) {
    return { follows: current, changed: false }
  }
  writeFollows(dataDir, follows)
  return { follows: readFollows(dataDir), changed: true }
}

module.exports = { foldFollowsFile }
