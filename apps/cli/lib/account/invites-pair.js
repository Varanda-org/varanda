'use strict'

// One invites facade over two stores (invites-store.js): the members'
// weekly invites (primary, invites.json) and the Feira's short codes
// (feira-invites.json, capOn 'use'). The server keeps talking to one object:
// a code is valid when either store accepts it, and the one that knows it
// marks it used. Codes and their hashes stay inside the stores; nothing here
// logs or keeps one.
//
// reserve(id, untilMs, holder, live) holds a slot of the owner's weekly
// Feira cap for a sign-up whose finish is in flight (check and reserve in
// one synchronous step), so codes redeemed at the same time can never pass
// the cap together. `holder` names the pending row; consume(id) or
// release(holder) frees the hold, it lapses at untilMs, and it counts for
// nothing once live() says the row is gone. A code of the primary store
// needs no hold. The directory link stays the single-use authority for
// each code.
//
// feiraOwner(id) names the inviter (the quota owner) of a valid Feira code,
// else null, so the age routes can hold Feira codes to their own paid
// session ceilings (./age-routes.js). It needs the Feira store's
// inviterOf(id); a Feira code whose owner cannot be named throws, so the
// caller fails closed instead of treating it as an ordinary invite.
// feiraPerWeek is the Feira store's weekly cap, read-only.

const HEX64_RE = /^[0-9a-f]{64}$/

function pairInvites (primary, feira = null) {
  if (feira === null) return primary

  // The primary decides: a broken Feira file only turns Feira codes off
  // (refused at check, never consumed), it never stops ordinary invites.
  function available () {
    return primary.available()
  }

  // The primary's answer when it accepts; otherwise the Feira's, whose
  // refusal is the same opaque token for unknown, used and expired.
  function check (id) {
    if (primary.check(id) === null) return null
    if (!feira.available()) return 'convite-invalido'
    return feira.check(id)
  }

  function feiraOwner (id) {
    if (primary.check(id) === null) return null
    if (!feira.available() || feira.check(id) !== null) return null
    const owner = typeof feira.inviterOf === 'function' ? feira.inviterOf(id) : null
    if (typeof owner !== 'string' || !HEX64_RE.test(owner)) throw new Error('dono do convite da Feira desconhecido')
    return owner
  }

  function reserve (id, untilMs, holder = id, live = null) {
    if (primary.check(id) === null || !feira.available()) return false
    return feira.reserve(id, untilMs, holder, live)
  }

  function release (holder) {
    feira.release(holder)
  }

  // File names of the stores that cannot be read, for the operator's log.
  function brokenFiles () {
    return [primary, feira].filter((s) => !s.available()).map((s) => s.fileName)
  }

  async function consume (id) {
    const res = await primary.consume(id)
    if (res.changed || !feira.available()) return res
    return feira.consume(id)
  }

  // A deletion forgets the member in both files; with the Feira file broken
  // it rejects, so the sweep retries instead of leaving Feira rows behind.
  async function forget (member) {
    const [a, b] = await Promise.all([primary.forget(member), feira.forget(member)])
    return { changed: a.changed || b.changed }
  }

  async function heal () {
    const [a, b] = await Promise.all([primary.heal(), feira.available() ? feira.heal() : false])
    return a || b
  }

  const pair = {
    issue: (member) => primary.issue(member),
    forget,
    // A broken Feira file may still hold the member: say so, so a deletion
    // sweep calls forget, which rejects and keeps the cleanup pending.
    holds: (member) => primary.holds(member) || !feira.available() || feira.holds(member),
    check,
    feiraOwner,
    reserve,
    release,
    brokenFiles,
    consume,
    heal,
    summary: (member) => primary.summary(member),
    count: () => primary.count(),
    fail () {
      primary.fail()
      feira.fail()
    },
    available
  }
  Object.defineProperty(pair, 'perWeek', { value: primary.perWeek, enumerable: true, writable: false })
  Object.defineProperty(pair, 'feiraPerWeek', { value: feira.perWeek ?? null, enumerable: true, writable: false })
  return pair
}

module.exports = { pairInvites }
