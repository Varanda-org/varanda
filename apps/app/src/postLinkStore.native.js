// The pending post is held in this module's memory. It does not survive an
// app restart: native sign-in does not reload a page, and there is no tab
// storage to write.

import { postRef } from './postLink.js'

const TTL_MS = 3600000

let pending = null

function clock (now) {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
}

function canonical (target) {
  const ref = postRef(target)
  if (ref === null) return null
  const colon = ref.indexOf(':')
  return { author: ref.slice(0, colon), seq: Number(ref.slice(colon + 1)) }
}

export function savePostLink (target, now = Date.now()) {
  const parts = canonical(target)
  if (parts === null) return
  pending = { author: parts.author, seq: parts.seq, at: clock(now) }
}

// Peeks: a live record stays put. A value older than one hour is absent.
export function takePostLink (now = Date.now()) {
  if (!pending) return null
  const parts = canonical(pending)
  if (parts === null || clock(now) - pending.at > TTL_MS) {
    pending = null
    return null
  }
  return parts
}

export function clearPostLink () {
  pending = null
}
