'use strict'

// Fold of a diary's `post-share` records (docs/protocol.md section 2,
// "Public share"): post seq -> the highest share seq seen. A post is public
// while any of its shares is live; a reader that keeps only the highest one
// shows the post only while that one is live, which fails closed and matches
// the rule for diaries whose writer keeps at most one live share per post.
// Pure, never throws.

const POST_SHARES_PER_DIARY = 4096

function isSeq (v) {
  return Number.isSafeInteger(v) && v >= 1
}

// false for bad input as for a full map: the caller cannot show a post it
// could not record, so both fail closed.
function foldShare (map, postSeq, shareSeq, { maxPosts = POST_SHARES_PER_DIARY } = {}) {
  if (!(map instanceof Map) || !isSeq(postSeq) || !isSeq(shareSeq)) return false
  if (!Number.isSafeInteger(maxPosts) || maxPosts < 0) return false
  const prev = map.get(postSeq)
  if (prev !== undefined) {
    if (shareSeq > prev) map.set(postSeq, shareSeq)
    return true
  }
  if (map.size >= maxPosts) return false
  map.set(postSeq, shareSeq)
  return true
}

function newestShare (map, postSeq) {
  if (!(map instanceof Map)) return null
  const v = map.get(postSeq)
  return v === undefined ? null : v
}

module.exports = {
  POST_SHARES_PER_DIARY,
  foldShare,
  newestShare
}
