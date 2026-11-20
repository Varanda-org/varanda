/* global sessionStorage */

// The pending post has to survive the web sign-in reload, which reloads this
// tab, and must die with the tab. sessionStorage does both. localStorage
// would not: it outlives the tab and is shared by every tab on this origin.
// The global is read inside each call and every access is guarded: a private
// window or a thrown getter must not break sign-in.

import { postRef } from './postLink.js'

const KEY = 'varanda.postLink'
const TTL_MS = 3600000

// Set only when tab storage refused the write (no storage, private mode,
// quota). App.js cleans the address right after saving, so without this the
// post would be lost; here it still opens on this page, though not after a
// reload (the invite capture in App.js does the same).
let memory = null

function tabStorage () {
  try { return sessionStorage } catch { return null }
}

function clock (now) {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
}

// The colon ref is the check. Reading it back yields the canonical author
// and seq, so a tampered record cannot pass by looking close.
function canonical (target) {
  const ref = postRef(target)
  if (ref === null) return null
  const colon = ref.indexOf(':')
  return { author: ref.slice(0, colon), seq: Number(ref.slice(colon + 1)) }
}

function decode (raw, now) {
  if (typeof raw !== 'string') return null
  let o
  try { o = JSON.parse(raw) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const parts = canonical(o)
  if (parts === null) return null
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return null
  // Older than one hour is a different visit. Exactly one hour still counts.
  if (clock(now) - o.at > TTL_MS) return null
  return parts
}

export function savePostLink (target, now = Date.now()) {
  const parts = canonical(target)
  if (parts === null) return
  const raw = JSON.stringify({ author: parts.author, seq: parts.seq, at: clock(now) })
  try {
    const store = tabStorage()
    if (!store) {
      memory = raw
      return
    }
    store.setItem(KEY, raw)
    memory = null
  } catch {
    memory = raw
  }
}

// Peeks: a live record stays put. Only an expired or tampered one is dropped,
// and clearPostLink is what removes a destination the app is done with.
export function takePostLink (now = Date.now()) {
  if (memory !== null) {
    const dest = decode(memory, now)
    if (dest === null) memory = null
    return dest
  }
  try {
    const store = tabStorage()
    if (!store) return null
    const raw = store.getItem(KEY)
    const dest = decode(raw, now)
    if (dest === null && raw !== null && raw !== undefined) {
      try { store.removeItem(KEY) } catch {}
    }
    return dest
  } catch {
    return null
  }
}

export function clearPostLink () {
  memory = null
  try {
    const store = tabStorage()
    if (store) store.removeItem(KEY)
  } catch {}
}
