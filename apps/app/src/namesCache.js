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
