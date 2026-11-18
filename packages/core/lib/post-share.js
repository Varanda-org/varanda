'use strict'

// Fold of a diary's `post-share` records (docs/protocol.md section 2,
// "Public share"): post seq -> the highest share seq seen. A post is public
// while any of its shares is live; a reader that keeps only the highest one
// shows the post only while that one is live, which fails closed and matches
// the rule for diaries whose writer keeps at most one live share per post.
// Pure, never throws.

const POST_SHARES_PER_DIARY = 4096
const POST_COVERS_PER_DIARY = 4096

function isSeq (v) {
  return Number.isSafeInteger(v) && v >= 1
}

// false for bad input as for a full map: the caller cannot show a post it
// could not record, so both fail closed.
function foldHighest (map, postSeq, seq, maxPosts) {
  if (!(map instanceof Map) || !isSeq(postSeq) || !isSeq(seq)) return false
  if (!Number.isSafeInteger(maxPosts) || maxPosts < 0) return false
  const prev = map.get(postSeq)
  if (prev !== undefined) {
    if (seq > prev) map.set(postSeq, seq)
    return true
  }
  if (map.size >= maxPosts) return false
  map.set(postSeq, seq)
  return true
}

function highest (map, postSeq) {
  if (!(map instanceof Map)) return null
  const v = map.get(postSeq)
  return v === undefined ? null : v
}

function foldShare (map, postSeq, shareSeq, { maxPosts = POST_SHARES_PER_DIARY } = {}) {
  return foldHighest(map, postSeq, shareSeq, maxPosts)
}

function newestShare (map, postSeq) {
  return highest(map, postSeq)
}

// `post-cover` records: post seq -> the highest cover seq seen. Only the
// highest one counts, so a reader shows no cover when it is tombstoned even
// if an older cover is still live: the writer's newest choice, or its
// withdrawal, is never undone by an older block. A false return (bad input
// or a full map) means no cover, never that the post is hidden: a cover is
// not consent.
function foldCover (map, postSeq, coverSeq, { maxPosts = POST_COVERS_PER_DIARY } = {}) {
  return foldHighest(map, postSeq, coverSeq, maxPosts)
}

function newestCover (map, postSeq) {
  return highest(map, postSeq)
}

module.exports = {
  POST_SHARES_PER_DIARY,
  POST_COVERS_PER_DIARY,
  foldShare,
  newestShare,
  foldCover,
  newestCover
}
