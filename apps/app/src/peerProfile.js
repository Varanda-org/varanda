// The public profile (name, @nome, bio, photo) of someone the member does not
// follow, read from the node. Callers gate on node.hosted: the core node
// refuses diary.peek (docs/rpc.md 5.27). Name, @nome and photo come only from
// the node-verified diary.peek answer, never from the index or a list row.
// The index and the node may also say the diary is gone (PEER_GONE), which
// only takes a kept name away, so a later block or revoked @nome is shown.
// Pure: no React, no globals.

import { blockedPeekParams } from './memberBlocks.js'
import { avatarOf } from './media/avatar.js'

// Only a profile.read that answered "missing" asks for a peek: undefined is
// not answered yet, an object is a person already named.
export function wantsPeek (profile) {
  return profile === null
}

function textOf (v) {
  return typeof v === 'string' && v !== '' ? v : null
}

// Never throws.
export function peerEntryOf (peek, key) {
  try {
    if (!peek || typeof peek !== 'object' || typeof key !== 'string') return null
    if (peek.key !== key.toLowerCase()) return null
    const profile = peek.profile && typeof peek.profile === 'object' ? peek.profile : null
    const name = profile ? textOf(profile.name) : null
    const bio = profile ? textOf(profile.bio) : null
    const username = textOf(peek.username)
    const avatar = profile ? avatarOf(profile.avatar) : null
    if (name === null && username === null && avatar === null) return null
    return { name, username, bio, avatar }
  } catch {
    return null
  }
}

// readPeerEntry's answer when the diary is definitively not visible any more
// (blocked, @nome issuer revoked, unknown): the caller drops a kept peek and
// shows the plain unnamed header. It only ever removes, never names.
export const PEER_GONE = 'gone'

function peekGone (err) {
  return !!err && err.code === 'NOT_FOUND' && err.message === 'diário indisponível'
}

// One member lookup for the index's seq hints, then at most one peek. No
// retry, never throws. -> an entry, PEER_GONE when the index has no such
// author or the node refuses the diary itself, else null (a passing failure
// such as the network, a rate limit, no reachable seeder, a timeout, or an
// answer that names nothing: keep what is shown).
export async function readPeerEntry (key, { fetchMember, peek }) {
  try {
    const m = await fetchMember(key)
    if (m && m.ok === false && m.reason === 'not-found') return PEER_GONE
    if (!m || m.ok !== true) return null
    const params = blockedPeekParams(key.toLowerCase(), m.value)
    if (params === null) return null
    let peeked
    try {
      peeked = await peek(params)
    } catch (err) {
      return peekGone(err) ? PEER_GONE : null
    }
    return peerEntryOf(peeked, key)
  } catch {
    return null
  }
}
