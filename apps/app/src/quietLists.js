// The own block and mute lists, kept so a reopen hides the blocked and the
// muted before the node answers. Pure: no React, no react-native, no Node
// built-ins.
//
// Part 1: the codecs of the kinds 'bloqueios' and 'silenciados', registered
// in the DELEGATED table of ./screenSnapshot.js, which checks the binding,
// the actor (never a page), the envelope age and the byte size and wipes
// them with the other kinds. Body (an unknown key fails the parse): { keys }:
// at most BLOCK_MAX or MUTE_MAX lowercase hex64 keys, sorted and unique. An
// empty list is a body of its own: "no blocks" differs from "no copy".
//
// Part 2: the boot hand-off. The snapshot preview reads both copies before
// the providers mount and publishes them here; the providers read them with
// useSyncExternalStore(subscribeQuietLists, bootLists).

import rpc from '@varanda/rpc'
import { exactKeys, isHex64, isPlain } from './snapshotParts.js'

const { BLOCK_MAX, MUTE_MAX } = rpc

export const QUIET_LISTS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
// 500 keys of 64 hex digits, quoted and comma separated, plus an envelope
// with an origin of up to 2048 units.
export const QUIET_LISTS_MAX_BYTES = 40960

const iterable = (v) => v !== null && typeof v === 'object' && typeof v[Symbol.iterator] === 'function'

// -> the sorted unique lowercase hex64 keys of `src`, or null when there are
// more than `max` of them or `src` is not iterable.
function keysOf (src, max) {
  if (!iterable(src)) return null
  const set = new Set()
  for (const raw of src) {
    if (typeof raw !== 'string') continue
    const k = raw.toLowerCase()
    if (!isHex64(k)) continue
    set.add(k)
    if (set.size > max) return null
  }
  return [...set].sort()
}

function codecOf (kind, max) {
  function build (input, { fits } = {}) {
    if (!isPlain(input)) return null
    const keys = keysOf(input.keys, max)
    if (keys === null) return null
    const body = { keys }
    return typeof fits === 'function' && !fits(body) ? null : body
  }

  // Strict: only what build writes.
  function parse (body) {
    if (!isPlain(body) || !exactKeys(body, ['keys'])) return null
    const list = body.keys
    if (!Array.isArray(list) || list.length > max) return null
    let last = ''
    for (const k of list) {
      if (!isHex64(k) || k <= last) return null
      last = k
    }
    return { keys: list.slice() }
  }

  // A block must not empty the list that holds it: the copy stays as it is.
  const withoutAuthors = (body) => body

  return Object.freeze({
    KIND: kind,
    maxBytes: QUIET_LISTS_MAX_BYTES,
    maxAgeMs: QUIET_LISTS_MAX_AGE_MS,
    build,
    parse,
    withoutAuthors
  })
}

export const bloqueiosCodec = codecOf('bloqueios', BLOCK_MAX)
export const silenciadosCodec = codecOf('silenciados', MUTE_MAX)

// ---- the boot hand-off

let boot = null
let mayStore = false
const subscribers = new Set()

function notify () {
  for (const fn of [...subscribers]) {
    try { fn() } catch {}
  }
}

function setOf (src) {
  const set = new Set()
  for (const raw of src) {
    if (typeof raw !== 'string') continue
    const k = raw.toLowerCase()
    if (isHex64(k)) set.add(k)
  }
  return set
}

// Without both lists nothing is published. -> whether it was.
export function publishBootLists ({ owner, origin, association, blocks, mutes, wipe } = {}) {
  if (!iterable(blocks) || !iterable(mutes)) return false
  boot = Object.freeze({ owner, origin, association, blocks: setOf(blocks), mutes: setOf(mutes), wipe })
  notify()
  return true
}

export function bootLists () {
  return boot
}

export function clearBootLists () {
  if (boot === null) return
  boot = null
  notify()
}

export function setQuietListsMayStore (value) {
  const next = value === true
  if (next === mayStore) return
  mayStore = next
  notify()
}

export function mayStoreQuietLists () {
  return mayStore
}

export function subscribeQuietLists (fn) {
  if (typeof fn !== 'function') return () => {}
  subscribers.add(fn)
  return () => { subscribers.delete(fn) }
}
