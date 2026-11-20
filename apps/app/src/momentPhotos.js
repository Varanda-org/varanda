// Momento photos read ahead of the viewer, so the next one shows at once,
// and released as soon as nothing wants them. Pure: no React, no
// react-native, no Node built-ins.

import { VIDEO_MIME } from './media/plan.js'

export const MOMENT_PHOTO_MAX_AGE_MS = 5 * 60 * 1000
export const MOMENT_PHOTO_AHEAD_STALL_MS = 30 * 1000
export const MOMENT_PHOTO_MAX_READS = 2
export const MOMENT_PHOTO_MAX_STALLED = 2
export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']

const OFF = Object.freeze({ phase: 'off' })
// The hold of a read() made without an owner: any want() can end it.
const ANY = Symbol('any owner')

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

export function momentPhotoKey (author, seq) {
  return author + ':' + seq
}

function wipe (bytes) {
  try { if (bytes instanceof Uint8Array) bytes.fill(0) } catch {}
}

const refOk = (ref) => isObject(ref) && typeof ref.author === 'string' && Number.isSafeInteger(ref.seq)

// The store holds one entry per author:seq. An entry lives while an owner's
// want() list names it or while read() holds it. read(ref, owner) holds an
// entry until that owner's next want() whose index 0 is not that key, so an
// owner pins at most the photo it shows; read(ref) without an owner holds it
// until the next want() from any owner that does not name it at all. Either
// way the entry's timers may still end it: the viewer reads the item on
// screen and lists it first in its next want(), so the hold only bridges the
// gap between the two calls. A list whose index 0 is null pins nothing.
//
// Timers: `until` (the momento's expiry) always releases. The max age bounds
// how long a photo stays decrypted, but a shown photo has no signal back from
// the UI, so a photo at index 0 of some owner's list (the item on screen) or
// held by a read() is kept and its max age re-armed. Everything else listed
// (the viewer's previous and next photos, the strip's [null, ref]) ages out
// and is read again on demand. An 'off' cached by fail() shows nothing, so
// its max age always releases it and the bytes may be read again.
//
// Reads: at most MOMENT_PHOTO_MAX_READS media.read calls run at once for
// read-ahead, counting the item on screen and reads whose entry was already
// released (the node keeps working on them), so read-ahead never competes
// with the photo the person is waiting for. read() of the item on screen
// starts at once regardless. A read stops counting when it answers or after
// the stall watchdog, which only marks it stale: no read-ahead starts while
// MOMENT_PHOTO_MAX_STALLED stale reads are waiting, so a seeder that never
// answers gets no new read per step, only the item on screen, and a stale
// answer lets read-ahead go on. The watchdog never drops, repeats or replaces
// a read: it cannot tell a slow read from a hung one, and the transport's
// own deadline (the chunk GET timeout) already ends a hung one. So a slow
// read keeps its entry, a read() of that key joins it instead of starting a
// second download, and its answer is used like any other: shown or kept if
// the entry is still wanted, forgotten or revoked and zeroed if not. Owners
// are served newest want() first, so a stale list does not run ahead of the
// one the person is driving.
//
// subscribe(fn) calls fn(key, result) when an entry settles, from a read
// ({ phase: 'ok', uri, ms } or { phase: 'off' }) or from fail(). It is not
// called on release.
export function createMomentPhotos ({ media, urlFromBytes, revokeUrl, adoptVideoFile, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, maxAgeMs = MOMENT_PHOTO_MAX_AGE_MS, aheadStallMs = MOMENT_PHOTO_AHEAD_STALL_MS } = {}) {
  const entries = new Map()
  const owners = new Map()
  // Keys whose read failed since the last want(): the ahead queue skips them,
  // so a blob that cannot be read is not asked for in a loop.
  const failed = new Set()
  // Every media.read in flight, released entries included, until the node
  // answers or the watchdog stops counting it: a slow read must not stall
  // read-ahead. aheadSlot is the one ahead read among them.
  const inflight = new Set()
  let aheadSlot = null
  // Tokens the watchdog stopped counting whose read has not answered yet: the
  // node is still working on them, so they hold read-ahead back.
  const stale = new Set()
  const listeners = new Set()
  let closed = false

  function notify (key, result) {
    for (const fn of [...listeners]) {
      try { fn(key, result) } catch {}
    }
  }

  const expired = (until) => Number.isFinite(until) && now() >= until

  function makeEntry (key, until) {
    const entry = { key, until, expected: null, holds: new Set(), state: 'pending', result: null, release: null, resolve: null, promise: null, untilTimer: null, ageTimer: null }
    entry.promise = new Promise((resolve) => { entry.resolve = resolve })
    if (Number.isFinite(until)) entry.untilTimer = setTimer(() => drop(entry), Math.max(0, until - now()))
    entries.set(key, entry)
    return entry
  }

  // Releases an entry once. A pending one is answered `answer` (default
  // 'off') now and its result is discarded when it lands (settle sees state
  // 'gone').
  function drop (entry, answer = OFF) {
    if (entry.state === 'gone') return
    const was = entry.state
    entry.state = 'gone'
    clearTimer(entry.untilTimer)
    clearTimer(entry.ageTimer)
    entry.untilTimer = null
    entry.ageTimer = null
    if (entries.get(entry.key) === entry) entries.delete(entry.key)
    const free = entry.release
    entry.release = null
    if (free) { try { free() } catch {} }
    if (was === 'pending') entry.resolve(answer)
  }

  // A shown photo is never revoked under the UI by the max age.
  function shown (entry) {
    if (entry.holds.size > 0) return true
    for (const list of owners.values()) {
      const ref = list[0]
      if (refOk(ref) && momentPhotoKey(ref.author, ref.seq) === entry.key) return true
    }
    return false
  }

  function aged (entry) {
    if (entry.state === 'gone') return
    entry.ageTimer = null
    if (shown(entry)) entry.ageTimer = setTimer(() => aged(entry), maxAgeMs)
    else drop(entry)
  }

  function settle (entry, got) {
    let forgotten = false
    const forget = () => {
      if (forgotten) return
      forgotten = true
      if (!isObject(got) || typeof got.uri !== 'string') return
      const name = got.uri.slice(got.uri.lastIndexOf('/') + 1)
      try { if (typeof media.forgetReadFile === 'function') media.forgetReadFile(name) } catch {}
    }
    let uri = null
    let release = null
    try {
      const expected = isObject(entry.expected) ? entry.expected : {}
      const video = isObject(got) && got.mime === VIDEO_MIME
      const valid = entry.state === 'pending' && !closed && !expired(entry.until) &&
        isObject(got) && got.mime === expected.mime && (video
        ? got.ms === expected.ms && [got.w, got.h, got.ms].every((n) => Number.isSafeInteger(n) && n > 0)
        : IMAGE_MIMES.includes(got.mime))
      if (valid) {
        if (got.bytes instanceof Uint8Array) {
          uri = urlFromBytes(got.bytes, got.mime)
          forget()
        } else if (typeof got.uri === 'string' && got.uri.startsWith('file://')) {
          if (video) {
            uri = adoptVideoFile(got.uri)
            forget()
          } else {
            uri = got.uri
            release = forget
          }
        }
      }
    } catch {
      uri = null
      release = null
    } finally {
      if (isObject(got)) wipe(got.bytes)
    }
    const done = typeof uri === 'string' && uri !== '' ? uri : null
    if (done === null) {
      forget()
      if (entry.state === 'pending') {
        failed.add(entry.key)
        drop(entry)
        notify(entry.key, OFF)
      }
      return
    }
    entry.state = 'ok'
    entry.release = release || (() => revokeUrl(done))
    entry.result = Object.freeze({ phase: 'ok', uri: done, ms: got.ms })
    entry.ageTimer = setTimer(() => aged(entry), maxAgeMs)
    entry.resolve(entry.result)
    notify(entry.key, entry.result)
  }

  // Ends one read's count once: its answer, or the watchdog, whichever comes
  // first. A late answer from a read the watchdog stopped counting finds its
  // token gone and frees nothing that took its place.
  function finish (token) {
    if (!inflight.has(token)) return
    inflight.delete(token)
    clearTimer(token.timer)
    token.timer = null
    if (aheadSlot === token) aheadSlot = null
  }

  // The watchdog of a slow read: it stops counting and turns stale until the
  // node answers, and nothing else. A slow link or a seeder's Retry-After
  // waits can pass the watchdog with a valid answer still on its way, and the
  // transport deadline bounds a hung one, so the entry stays as it is: no
  // duplicate download, and no slow valid answer thrown away.
  function stalled (token) {
    if (!inflight.has(token)) return
    finish(token)
    stale.add(token)
    pump()
  }

  function start (ref, key, ahead) {
    const entry = makeEntry(key, ref.until)
    entry.expected = ref.expected
    const token = { timer: null }
    inflight.add(token)
    if (ahead) aheadSlot = token
    token.timer = setTimer(() => stalled(token), aheadStallMs)
    let reading
    try {
      reading = Promise.resolve(media.read({ kind: 'moment', author: ref.author, seq: ref.seq }))
    } catch (err) {
      reading = Promise.reject(err)
    }
    // A throw in settle must neither leave the caller waiting nor stall the queue.
    reading.then((got) => settle(entry, got), () => settle(entry, null)).catch(() => drop(entry)).then(() => {
      if (stale.delete(token)) {
        pump()
        return
      }
      if (!inflight.has(token)) return
      finish(token)
      pump()
    })
    return entry
  }

  // The first ref of a list is the item on screen; a video is read ahead
  // only as the very next item (or as an owner's only ref), since a deeper
  // one costs a whole file the person may never reach.
  function aheadAllowed (list, i, count) {
    const ref = list[i]
    if (!isObject(ref.expected) || ref.expected.mime !== VIDEO_MIME) return true
    return i === 1 || (i === 0 && count === 1)
  }

  function pump () {
    if (closed || aheadSlot !== null || inflight.size >= MOMENT_PHOTO_MAX_READS || stale.size >= MOMENT_PHOTO_MAX_STALLED) return
    for (const list of [...owners.values()].reverse()) {
      const count = list.filter(refOk).length
      for (let i = 0; i < list.length; i++) {
        const ref = list[i]
        if (!refOk(ref) || !aheadAllowed(list, i, count)) continue
        const key = momentPhotoKey(ref.author, ref.seq)
        if (entries.has(key) || failed.has(key) || expired(ref.until)) continue
        start(ref, key, true)
        return
      }
    }
  }

  function read (ref, owner) {
    if (closed || !refOk(ref)) return Promise.resolve(OFF)
    const key = momentPhotoKey(ref.author, ref.seq)
    let entry = entries.get(key)
    if (!entry) {
      if (expired(ref.until)) return Promise.resolve(OFF)
      entry = start(ref, key, false)
    }
    entry.holds.add(owner === undefined || owner === null ? ANY : owner)
    return entry.promise
  }

  function peek (key) {
    const entry = entries.get(key)
    return entry && (entry.state === 'ok' || entry.state === 'off') ? entry.result : null
  }

  // The bytes passed every check but did not decode: 'off' stays cached so
  // the UI does not read them again in a loop, until want() or a timer
  // releases it.
  function fail (key) {
    if (closed || typeof key !== 'string') return
    const old = entries.get(key)
    const until = old ? old.until : undefined
    const holds = old ? new Set(old.holds) : new Set([ANY])
    if (old) drop(old)
    const entry = makeEntry(key, until)
    entry.holds = holds
    entry.state = 'off'
    entry.result = OFF
    entry.resolve(OFF)
    entry.ageTimer = setTimer(() => drop(entry), maxAgeMs)
    notify(key, OFF)
  }

  function want (owner, refs) {
    if (closed) return
    const list = Array.isArray(refs) ? refs.slice() : []
    // Re-inserted so the pump serves the newest list first.
    owners.delete(owner)
    if (list.length > 0) owners.set(owner, list)
    failed.clear()
    const named = new Set()
    for (const ref of list) if (refOk(ref)) named.add(momentPhotoKey(ref.author, ref.seq))
    const pinned = refOk(list[0]) ? momentPhotoKey(list[0].author, list[0].seq) : null
    const listed = new Set()
    for (const other of owners.values()) {
      for (const ref of other) if (refOk(ref)) listed.add(momentPhotoKey(ref.author, ref.seq))
    }
    for (const entry of [...entries.values()]) {
      if (!named.has(entry.key)) entry.holds.delete(ANY)
      if (entry.key !== pinned) entry.holds.delete(owner)
      if (entry.holds.size === 0 && !listed.has(entry.key)) drop(entry)
    }
    pump()
  }

  function clear () {
    if (closed) return
    closed = true
    owners.clear()
    failed.clear()
    listeners.clear()
    for (const token of inflight) clearTimer(token.timer)
    inflight.clear()
    stale.clear()
    aheadSlot = null
    for (const entry of [...entries.values()]) drop(entry)
  }

  function subscribe (fn) {
    if (closed || typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  return { want, read, peek, fail, clear, subscribe }
}

// One store at a time, for the current node.media and epoch. node.media is
// null while locked and a new object after unlock, so a store kept per media
// object would be orphaned, not cleared, by a lock: any other media
// (null included) or epoch clears the old store at once, so no photo of the
// last session survives. A stale caller (an older epoch of the same media,
// or a media already replaced) gets null and leaves the current store alone.
let current = null
const retired = new WeakSet()

const older = (a, b) => Number.isFinite(a) && Number.isFinite(b) && a < b

export function momentPhotosFor (media, epoch, deps) {
  const valid = media !== null && typeof media === 'object' && typeof media.read === 'function'
  if (valid && retired.has(media)) return null
  if (current !== null) {
    if (valid && current.media === media) {
      if (current.epoch === epoch) return current.store
      if (older(epoch, current.epoch)) return null
    } else {
      retired.add(current.media)
    }
    current.store.clear()
    current = null
  }
  if (!valid) return null
  const store = createMomentPhotos({ ...deps, media })
  current = { media, epoch, store }
  return store
}

// Tests only: clears the current store so cases do not share it.
export function resetMomentPhotosForTests () {
  if (current !== null) {
    retired.add(current.media)
    current.store.clear()
  }
  current = null
}
