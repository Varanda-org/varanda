// Pure entry rules of the profiles cache (./names.js), kept apart so tests
// can load them without React. An entry is { name, username, bio, avatar,
// loaded }; avatar is undefined while unknown (only seeds without an avatar
// were seen), null when the profile has none, else a fresh descriptor copy.

import { avatarOf, sameAvatar } from './media/avatar.js'

const str = (v) => (typeof v === 'string' && v !== '' ? v : null)

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// A seed or learned value: { name?, username?, bio?, avatar? }, or a bare
// name (the older learn(key, name) form).
export function fieldsOf (value) {
  if (value === null || value === undefined) return {}
  if (typeof value === 'string') return { name: value }
  return typeof value === 'object' ? value : {}
}

// undefined and null differ: "not known yet" is not "no photo".
export function sameEntry (a, b) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.name !== b.name || a.username !== b.username || a.bio !== b.bio || a.loaded !== b.loaded) return false
  if ((a.avatar === undefined) !== (b.avatar === undefined)) return false
  return sameAvatar(a.avatar, b.avatar)
}

// Merges a seed into the known entry: a null never overwrites a known
// string, and a seed never marks the entry as loaded (nor touches a known
// bio). Only a seed that carries an own 'avatar' key changes the avatar
// (null clears it). -> the next entry, or null when nothing changed.
export function applySeed (known, value) {
  const f = fieldsOf(value)
  const avatar = hasOwn(f, 'avatar') ? avatarOf(f.avatar) : (known ? known.avatar : undefined)
  const merged = {
    name: str(f.name) ?? (known ? known.name : null),
    username: str(f.username) ?? (known ? known.username : null),
    bio: str(f.bio) ?? (known ? known.bio : null),
    avatar,
    loaded: known ? known.loaded : false
  }
  if (known && sameEntry(merged, known)) return null
  if (!known && merged.name === null && merged.username === null && merged.bio === null && !merged.avatar) return null
  return merged
}

// A profile.read entry: a null removes what a seed said (username included),
// and an omitted avatar (an older node) reads as none.
export function authoritative (p) {
  return { name: str(p.name), username: str(p.username), bio: str(p.bio), avatar: avatarOf(p.avatar), loaded: true }
}

export function viewOf (entry) {
  return { name: entry.name, username: entry.username, bio: entry.bio, avatar: entry.avatar }
}

// What profileOf hands out for an entry (a page diary carries its flags).
function profileView (entry) {
  const view = viewOf(entry)
  return entry.page === true ? { ...view, page: true, closed: entry.closed === true, moved: entry.moved === true } : view
}

function sameView (a, b) {
  if (a.name !== b.name || a.username !== b.username || a.bio !== b.bio) return false
  if (a.page !== b.page || a.closed !== b.closed || a.moved !== b.moved) return false
  if ((a.avatar === undefined) !== (b.avatar === undefined)) return false
  return sameAvatar(a.avatar, b.avatar)
}

// The view of `entry`, reusing `prev` while it says the same thing: memoized
// rows compare props by identity, and a fresh object per lookup would
// re-render every row on any change of the cache (a refetch that only flips
// `loaded` included).
export function stableView (entry, prev) {
  const next = profileView(entry)
  return prev && typeof prev === 'object' && sameView(prev, next) ? prev : next
}

function sameInputs (a, b) {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const k of keys) if (!Object.is(a[k], b[k])) return false
  return true
}

// Per-row props cache of the feed lists (kept here because this module loads
// without React, so the rule is tested in node). `inputs` is a flat object of
// what the row's props are derived from; while every value is identical the
// cached props object comes back, else `build(live)` makes a new one. `live`
// is the row's box, the same object across rebuilds and refreshed with
// `latest` on every call, so callbacks inside the props run the newest
// handlers without the handlers being inputs.
export function cachedRow (cache, key, inputs, latest, build) {
  const hit = cache.get(key)
  const live = hit ? hit.live : {}
  Object.assign(live, latest)
  if (hit && sameInputs(hit.inputs, inputs)) return hit.props
  const props = build(live)
  cache.set(key, { inputs, props, live })
  return props
}

// Drops the rows no longer in the list, so the cache never outgrows it.
export function pruneRows (cache, keys) {
  const keep = new Set(keys)
  for (const key of [...cache.keys()]) if (!keep.has(key)) cache.delete(key)
}

// The counts index flags after one answer of counts pass `pass` (passes
// overlap: the next page's counts do not wait for the previous ones).
// `applied` is the newest pass whose flags were applied: an older pass
// answering late never brings back its `indexing` (an old `indexing: true`
// would hide every count), but its `complete: false` still counts, since its
// page's posts are not the newer page's. Answers of one pass still combine.
// -> { flags, applied }.
export function countsFlags ({ prev, applied, pass, indexing, complete }) {
  if (pass < applied) {
    if (complete !== false || prev.complete === false) return { flags: prev, applied }
    return { flags: { indexing: prev.indexing, complete: false }, applied }
  }
  return { flags: { indexing: indexing === true, complete: prev.complete !== false && complete !== false }, applied: pass }
}
