// Publicar is a sheet over the stack and A Rua stays mounted under a
// Conversa, so a confirmed reply must reach the screens already on screen.
// Listeners only: nothing to wipe, and nothing that can outlive an identity.

import { parseRef } from './thread.js'
import { isAuthorKey } from './nav.js'

function replyTarget (to) {
  if (typeof to === 'string') {
    const ref = parseRef(to)
    if (ref === null) return null
    return { author: ref.author, seq: ref.seq }
  }
  if (to === null || typeof to !== 'object' || Array.isArray(to)) return null
  if (typeof to.author !== 'string' || !Number.isSafeInteger(to.seq) || to.seq < 1) return null
  const author = to.author.toLowerCase()
  if (!isAuthorKey(author)) return null
  return { author, seq: to.seq }
}

// A reply still in flight has no confirmed seq, so it is not an item.
export function ownReplyItem (input = {}) {
  if (input === null || typeof input !== 'object') return null
  const { author, seq, to, text, at, media, gen } = input
  if (typeof author !== 'string') return null
  const key = author.toLowerCase()
  if (!isAuthorKey(key)) return null
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  const replyTo = replyTarget(to)
  if (replyTo === null) return null
  if (typeof text !== 'string') return null
  const keepMedia = Array.isArray(media) && media.length > 0
  if (text === '' && !keepMedia) return null
  const when = typeof at === 'string' && !Number.isNaN(Date.parse(at))
    ? at
    : new Date().toISOString()
  // Listeners compare this with cacheGeneration() and drop a stale or null
  // one, so a late completion after an account wipe recreates nothing.
  const generation = Number.isSafeInteger(gen) && gen >= 0 ? gen : null
  return {
    kind: 'post',
    author: key,
    seq,
    at: when,
    text,
    replyTo,
    ...(keepMedia ? { media } : {}),
    gen: generation
  }
}

const replyListeners = new Set()
const goneListeners = new Set()

function subscribe (listeners, listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// A failing screen must not stop the others or reach the sender.
function callEach (listeners, fn) {
  const list = [...listeners]
  for (const listener of list) {
    try { fn(listener) } catch {}
  }
  return list.length
}

export function onOwnReply (listener) {
  return subscribe(replyListeners, listener)
}

export function announceOwnReply (item, from = null) {
  if (item === null || typeof item !== 'object') return 0
  return callEach(replyListeners, (listener) => listener(item, from))
}

export function onOwnReplyGone (listener) {
  return subscribe(goneListeners, listener)
}

export function announceOwnReplyGone (refs) {
  let set = null
  if (refs instanceof Set) set = refs
  else if (Array.isArray(refs)) set = new Set(refs)
  if (set === null || set.size === 0) return 0
  return callEach(goneListeners, (listener) => listener(set))
}
