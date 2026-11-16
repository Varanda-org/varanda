// What a feed.read item teaches the profiles cache (./names.js). Pure: no
// React, no Node built-ins.
//
// Every FeedItem carries the author's `avatar` from the same newest profile
// its `name` comes from (docs/rpc.md 5.13): a descriptor, or null for a plain
// profile. A node from before that omits the key, which is "unknown", not "no
// photo": the seed then has no avatar key, because the cache changes the
// photo only for a seed with an own `avatar` key (namesCache.applySeed).
// A null name means the node had no profile record for the diary yet (a
// diary still downloading), so a null avatar says nothing either.

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// `avatar: false`: seed the name only. page.feed borrows the head's profile
// when the tail has none, so its avatar may be an older one and must not
// overwrite a photo the cache read from profile.read.
export function feedSeed (item, { avatar = true } = {}) {
  const seed = { name: item.name, username: item.username }
  if (avatar && hasOwn(item, 'avatar') && item.avatar !== undefined && (item.avatar !== null || (typeof item.name === 'string' && item.name !== ''))) seed.avatar = item.avatar
  return seed
}

// learnMany / seedMany entries for a page of items.
export function feedSeeds (items, opts) {
  return items.map((item) => [item.author, feedSeed(item, opts)])
}
