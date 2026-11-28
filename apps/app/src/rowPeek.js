// Names for the Conversas rows of people the node has no profile for (a person
// the member does not follow: profile.read answers "missing"), read the way an
// open conversation reads its header (peerProfile.js): the seeder index for the
// hints, then one node-verified diary.peek. Pure, so the rules load in tests.
//
// Bounded on purpose: only the first PEEK_WINDOW rows of the list ask, a key
// at most once per scope, one at a time. A name that no peek verified is never
// shown. Where the node cannot peek (the core node) or nothing is verified,
// the row keeps "Pessoa".

import { PEER_GONE, wantsPeek } from './peerProfile.js'

export const PEEK_WINDOW = 10
export const PEEK_BATCH = 4

const triedKey = (scope, peer) => scope + ':' + peer.toLowerCase()

// The next peers to ask for: rows near the top, profile.read said "missing"
// or the name is a peek an earlier run saved (`isSaved`: it no longer reads as
// missing, yet this run has not verified it), no verified peek yet, not asked
// in this scope, at most `batch`.
export function planRowPeeks ({ peers, profileOf, isPeeked, isSaved = () => false, tried, scope, window = PEEK_WINDOW, batch = PEEK_BATCH }) {
  const out = []
  for (const peer of (Array.isArray(peers) ? peers : []).slice(0, window)) {
    if (typeof peer !== 'string' || peer === '' || tried.has(triedKey(scope, peer))) continue
    if (isPeeked(peer)) continue
    if (!wantsPeek(profileOf(peer)) && !isSaved(peer)) continue
    out.push(peer)
    if (out.length >= batch) break
  }
  return out
}

// Asks batch after batch until nothing is left to ask or `current()` turns
// false (hidden, offline, another scope, unmounted). The key is marked asked
// before its read, so no render asks it twice; a walk stopped during the read
// un-marks it, so the next walk asks again instead of leaving "Pessoa".
export async function runRowPeeks ({ plan, tried, scope, lookupMany, read, current, learn, forget }) {
  while (current()) {
    const peers = plan()
    if (peers.length === 0) return
    const members = lookupMany ? await lookupMany(peers) : []
    for (const [i, peer] of peers.entries()) {
      if (!current()) return
      tried.add(triedKey(scope, peer))
      const entry = await read(peer, members[i])
      if (!current()) {
        tried.delete(triedKey(scope, peer))
        return
      }
      if (entry === PEER_GONE) forget(peer)
      else if (entry !== null) learn(peer, entry)
    }
  }
}
