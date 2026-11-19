// Recent music picks ("Recentes"), kept only on this device, per account.
// Pure ES module: no React, no platform module, no Node built-ins; the
// platform stores (musicRecentsStore.web.js / .native.js) only pass read,
// write and remove. A track keeps the listed genre its text names, never the
// provider's text. The genre counts are computed from the stored list, so
// they age out with the cap, a repeated pick cannot count twice and clearing
// the list erases them too.

import rpc from '@varanda/rpc'
import { musicGenreOf, recentItem } from './music.js'

const { MUSIC_GENRES, isMusicGenre } = rpc

export const STORAGE_KEY = 'varanda-music-recents'
export const FILE_NAME = 'varanda-music-recents.json'
export const MAX_RECENTS = 24
// Accounts this device kept picks for; the least recently used is forgotten.
export const MAX_OWNERS = 4
export const MUSIC_RECENTS_SHOWN = 5
export const MUSIC_GENRE_MIN = 1
// Four full lists of the longest titles take about 70 thousand characters,
// so a file this store wrote is never refused as oversized.
export const MAX_RAW = 262144

const HEX64 = /^[0-9a-f]{64}$/

const isOwner = (v) => typeof v === 'string' && HEX64.test(v)
const sameEntry = (a, b) => a.kind === b.kind && a.id === b.id

function entryOf (kind, json, genre) {
  const fields = recentItem(kind, json)
  if (fields === null) return null
  const entry = { kind, ...fields }
  if (kind === 'track' && isMusicGenre(genre)) entry.genre = genre
  return entry
}

// Untrusted on every read: rebuilt field by field, doubtful entries dropped,
// each owner and each entry kept once, caps applied. Newest first.
export function decodeRecents (raw) {
  const out = []
  if (typeof raw !== 'string' || raw.length > MAX_RAW) return out
  let o
  try { o = JSON.parse(raw) } catch { return out }
  if (!o || typeof o !== 'object' || o.v !== 1 || !Array.isArray(o.owners)) return out
  for (const slot of o.owners) {
    if (out.length >= MAX_OWNERS) break
    if (!slot || typeof slot !== 'object' || !isOwner(slot.owner) || out.some((x) => x.owner === slot.owner)) continue
    if (!Array.isArray(slot.items)) continue
    const items = []
    for (const it of slot.items) {
      if (items.length >= MAX_RECENTS) break
      if (!it || typeof it !== 'object') continue
      const entry = entryOf(it.kind, it, it.genre)
      if (entry !== null && !items.some((x) => sameEntry(x, entry))) items.push(entry)
    }
    out.push({ owner: slot.owner, items })
  }
  return out
}

export function encodeRecents (owners) {
  return JSON.stringify({ v: 1, owners: owners.map(({ owner, items }) => ({ owner, items: items.map((it) => ({ ...it })) })) })
}

const trackGenres = (items) => (Array.isArray(items) ? items : []).filter((it) => it && it.kind === 'track' && isMusicGenre(it.genre))

// Genre to the number of stored tracks of it; playlists never count.
export function musicGenreCounts (items) {
  const counts = new Map()
  for (const it of trackGenres(items)) counts.set(it.genre, (counts.get(it.genre) || 0) + 1)
  return counts
}

// MUSIC_GENRES by count, then by the most recent use, then list order.
export function musicGenreOrder (items) {
  const counts = musicGenreCounts(items)
  const latest = new Map()
  trackGenres(items).forEach((it, i) => { if (!latest.has(it.genre)) latest.set(it.genre, i) })
  const never = Number.MAX_SAFE_INTEGER
  return MUSIC_GENRES
    .map((genre, i) => ({ genre, i, count: counts.get(genre) || 0, at: latest.has(genre) ? latest.get(genre) : never }))
    .sort((a, b) => b.count - a.count || a.at - b.at || a.i - b.i)
    .map(({ genre }) => genre)
}

export function musicTopGenre (items) {
  const top = musicGenreOrder(items)[0]
  return top !== undefined && (musicGenreCounts(items).get(top) || 0) >= MUSIC_GENRE_MIN ? top : null
}

// Synchronous and never throws. Another tab or a second store may write the
// same storage, so every call reads it fresh and applies its change to that
// copy. A read that threw may hide entries still on disk: the call then
// works on the last copy this store saw and never writes over the storage.
// A missing or corrupt file is simply empty.
export function createMusicRecents ({ read, write, remove }) {
  let memory = []

  function fresh () {
    try {
      memory = decodeRecents(read())
      return true
    } catch {
      return false
    }
  }

  function save (owners, readOk) {
    memory = owners
    if (!readOk) return false
    try {
      write(encodeRecents(owners))
      return true
    } catch {
      return false
    }
  }

  return {
    list (owner) {
      if (!isOwner(owner)) return []
      fresh()
      const slot = memory.find((x) => x.owner === owner)
      return slot ? slot.items.map((it) => ({ ...it })) : []
    },
    // A snippet is its track's entry. -> true when storage was updated.
    note (owner, kind, item) {
      const k = kind === 'snippet' ? 'track' : kind
      const entry = isOwner(owner) && item && typeof item === 'object' ? entryOf(k, item, musicGenreOf(item.genre)) : null
      if (entry === null) return false
      const readOk = fresh()
      const slot = memory.find((x) => x.owner === owner)
      const items = [entry, ...(slot ? slot.items.filter((x) => !sameEntry(x, entry)) : [])].slice(0, MAX_RECENTS)
      return save([{ owner, items }, ...memory.filter((x) => x.owner !== owner)].slice(0, MAX_OWNERS), readOk)
    },
    clearOwner (owner) {
      if (!isOwner(owner)) return false
      const readOk = fresh()
      return save(memory.filter((x) => x.owner !== owner), readOk)
    },
    clear () {
      memory = []
      try {
        remove()
        return true
      } catch {
        return false
      }
    }
  }
}
