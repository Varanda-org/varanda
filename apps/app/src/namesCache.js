// Pure entry rules of the profiles cache (./names.js), kept apart so tests
// can load them without React. An entry is { name, username, bio, avatar,
// loaded }; avatar is undefined while unknown (only seeds without an avatar
// were seen), null when the profile has none, else a fresh descriptor copy.
// A verified diary.peek is kept as an entry (peekedEntry) that outlives a
// `missing` answer of profile.read (missingEntry) and replaces a seed
// (peekReplaces), until the diary is gone (forgottenEntry). A peek an earlier
// run verified and the device saved (savedPeeks) is a seed that a `missing`
// answer also keeps (missingAnswer) until this run's peek answers.

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

// The entry for a key no seed named but whose page hint says Página
// (`hint`: { page, closed, moved } or null): kept without a name so the page
// flag is there before the name arrives, and a later seed merges into it.
// No hint, or a person hint, makes none (no hint means person).
export function pageOnlyEntry (hint) {
  if (!hint || hint.page !== true) return null
  return { name: null, username: null, bio: null, avatar: undefined, loaded: false, ...hint }
}

// A profile.read entry: a null removes what a seed said (username included),
// and an omitted avatar (an older node) reads as none.
export function authoritative (p) {
  return { name: str(p.name), username: str(p.username), bio: str(p.bio), avatar: avatarOf(p.avatar), loaded: true }
}

// A node-verified diary.peek answer as an entry: built from the value alone
// (never merged with a known entry), null when it names nothing.
export function peekedEntry (value) {
  const f = fieldsOf(value)
  const entry = { name: str(f.name), username: str(f.username), bio: str(f.bio), avatar: avatarOf(f.avatar), loaded: true }
  return entry.name === null && entry.username === null && !entry.avatar ? null : entry
}

// What profile.read's `missing` answer leaves in the cache: the verified peek
// kept for that key, or null (no showable diary).
export function missingEntry (peeked) {
  return peeked ? { ...peeked } : null
}

// The `missing` answer for `key` with both kept names (Maps of lowercase keys
// to peekedEntry values): this run's verified peek first, else a peek saved
// on the device (savedPeeks), which keeps the row named while the peek is
// asked again. A denied author's (`refused`) saved peek is never used.
export function missingAnswer (peeked, saved, key, refused = () => false) {
  return missingEntry(peeked.get(key) ?? (refused(key) ? undefined : saved.get(key)))
}

// The saved peeks of `entries` ([key, { name, username, avatar }] pairs, a
// stored copy of names an earlier run verified) to remember: only for a key
// the cache `known` has no entry for, or only the null a `missing` answer
// left (seeding before or after that answer must agree), and `peeked` (this
// run's verified peeks) does not hold, never for a key `refused` says (a
// denied author), and only when the fields name something.
// -> [lowercase key, peekedEntry] pairs.
export function savedPeeks (known, peeked, entries, refused = () => false) {
  const out = []
  const seen = new Set()
  for (const pair of Array.isArray(entries) ? entries : []) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue
    const key = pair[0].toLowerCase()
    if (seen.has(key) || (known && known.has(key) && known.get(key) !== null) || peeked.has(key) || refused(key)) continue
    seen.add(key)
    const entry = peekedEntry(pair[1])
    if (entry !== null) out.push([key, entry])
  }
  return out
}

// A saved peek as a seed (applySeed): it is not loaded, so profile.read is
// still asked and its answer wins.
export function savedSeed (entry) {
  return { name: entry.name, username: entry.username, avatar: entry.avatar }
}

// Whether a stored copy saved for `owner` belongs to the identity `own` (the
// lowercase own key): neither may be missing.
export function sameOwner (owner, own) {
  return typeof owner === 'string' && typeof own === 'string' && own !== '' && owner.toLowerCase() === own.toLowerCase()
}

// Whether `entry` (a cache entry) is still what the saved peek `saved` made
// of it: its seed, or the `missing` answer that kept it (loaded or marked
// stale since).
function fromSaved (entry, saved) {
  if (!entry) return false
  return [applySeed(null, savedSeed(saved)), missingEntry(saved)].some((e) => sameEntry({ ...entry, loaded: e.loaded }, e))
}

// seedPeeked's rule. Remembers the saved peeks of `entries` (savedPeeks) in
// `saved` (oldest first, at most `max` keys) and says what the cache `known`
// gets: `seeds` ([key, savedSeed] pairs to apply) for an absent key, and in
// `next` (a copy of `known`, or null when nothing else changes) the
// `missing` answer for a key whose entry is that answer's null. A key evicted
// past `max` is never re-checked, so its name must not stay: one evicted in
// this call is not shown, and an older one loses the entry its saved seed
// still makes (the page hint `hintOf(entry)` stays). `held` (profile
// answers) and `peeked` (verified peeks) of this run are never touched.
// -> { seeds, next }.
export function seedSaved ({ known, peeked, held, saved, entries, refused = () => false, max, hintOf = () => null }) {
  const fresh = new Map()
  for (const [key, entry] of savedPeeks(known, peeked, entries, refused)) {
    saved.delete(key)
    saved.set(key, entry)
    fresh.set(key, entry)
  }
  let next = null
  while (saved.size > max) {
    const evicted = saved.keys().next().value
    const entry = saved.get(evicted)
    saved.delete(evicted)
    if (fresh.delete(evicted) || held.has(evicted) || peeked.has(evicted)) continue
    const old = known ? known.get(evicted) : undefined
    if (!fromSaved(old, entry)) continue
    const hint = hintOf(old)
    next = next || new Map(known)
    if (old.loaded === true) {
      const forgotten = forgottenEntry(old, hint)
      if (forgotten !== undefined) next.set(evicted, forgotten)
      continue
    }
    // Not answered yet: the key goes back to unknown, so it is still asked.
    const page = pageOnlyEntry(hint)
    if (page === null) next.delete(evicted)
    else next.set(evicted, page)
  }
  const seeds = []
  for (const [key, entry] of fresh) {
    if (known && known.get(key) === null) {
      next = next || new Map(known)
      next.set(key, missingAnswer(peeked, saved, key, refused))
    } else {
      seeds.push([key, savedSeed(entry)])
    }
  }
  return { seeds, next }
}

// Whether `key` shows a saved peek this run has not verified again.
export function isSavedPeekKey (saved, peeked, key) {
  if (typeof key !== 'string') return false
  const k = key.toLowerCase()
  return saved.has(k) && !peeked.has(k)
}

// The entries a new epoch or generation starts the cache with: the saved
// peeks as seeds, never one of a denied author (`refused`).
export function savedRebuild (saved, refused = () => false) {
  const out = new Map()
  for (const [key, entry] of saved) {
    if (refused(key)) continue
    const seed = applySeed(null, savedSeed(entry))
    if (seed !== null) out.set(key, seed)
  }
  return out
}

// A profile.read answer with no name, bio or photo at all (the profile record
// may sit in a part of the diary the node has not downloaded yet, docs/rpc.md
// 5.21) keeps what a kept verified peek said, name, bio, photo and @nome
// together. Once the answer has any of the profile fields it is the newest
// record and its nulls are real (a removed photo or bio), and a null @nome
// may be a revoked one, so nothing is filled. -> the entry, or the same
// object when there is nothing to fill.
export function fillFromPeek (entry, peeked) {
  if (!peeked || !entry) return entry
  if (entry.name !== null || entry.bio !== null || entry.avatar) return entry
  const fill = {}
  for (const field of ['name', 'bio']) if (peeked[field] !== null) fill[field] = peeked[field]
  if (peeked.avatar) fill.avatar = peeked.avatar
  if (entry.username === null && peeked.username !== null) fill.username = peeked.username
  return Object.keys(fill).length === 0 ? entry : { ...entry, ...fill }
}

// What a profile.read answer (a non-null entry) leaves: the entry to store and
// the peek to keep for the next answer (undefined: dropped). The peek stays
// only while it filled the answer. Without one, a blank answer replaces the
// name and photo the entry showed: it is also what profile.read gives once
// the last profile version was deleted (profile.delete), and nothing in the
// answer tells that apart from a diary still downloading, so keeping the old
// values would bring a deleted profile back.
export function settleProfile (entry, peeked) {
  const filled = fillFromPeek(entry, peeked)
  return { entry: filled, peek: filled === entry ? undefined : peeked }
}

// The profile a Página owner just saved or renamed, as a verified entry: the
// name, bio and photo the service accepted (`base`, the page's known profile,
// null when unknown) and the @nome (`username`, the new one after a rename,
// else the one shown). null when the name is not known.
export function keptProfile (base, username) {
  if (!base || typeof base.name !== 'string' || base.name === '') return null
  return { name: base.name, bio: base.bio, avatar: base.avatar, username: typeof username === 'string' && username !== '' ? username : null }
}

// Whether a verified peek may replace `known`: a profile.read answer wins, a seed does not.
export function peekReplaces (known, had, unsupported) {
  if (had || known === null) return true
  if (known === undefined) return unsupported === true
  return typeof known === 'object' && known.loaded !== true
}

// Whether `key` shows a kept peek: peeked and not since answered with a
// profile by profile.read (`held` wins).
export function isPeekedKey (peeked, held, key) {
  if (typeof key !== 'string') return false
  const k = key.toLowerCase()
  return peeked.has(k) && !held.has(k)
}

// What a forgotten peek (the diary is gone) leaves for a key profile.read
// does not hold: the `missing` answer without a peek, with the page hint
// (`hint`, null or { page, closed, moved }) on an unnamed entry. It only
// takes away. -> the next entry, or undefined when nothing changes (an
// unknown key stays unknown).
export function forgottenEntry (known, hint) {
  if (known === undefined) return undefined
  const next = hint === null ? missingEntry(undefined) : { name: null, username: null, bio: null, avatar: null, loaded: true, ...hint }
  if (next === null) return known === null ? undefined : null
  const same = sameEntry(known, next) && known.page === next.page && known.closed === next.closed && known.moved === next.moved
  return same ? undefined : next
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

// The seeds of `entries` ([key, value] pairs) whose key the cache `known` (a
// Map of lowercase keys) has no entry for: a stored copy (A Rua's snapshot)
// never replaces what this session already learned or read, and the new
// entries it makes are not loaded, so a resolve still reads them.
export function absentSeeds (known, entries) {
  const out = []
  const seen = new Set()
  for (const pair of Array.isArray(entries) ? entries : []) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue
    const key = pair[0].toLowerCase()
    if (seen.has(key) || (known && known.has(key))) continue
    seen.add(key)
    out.push(pair)
  }
  return out
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
