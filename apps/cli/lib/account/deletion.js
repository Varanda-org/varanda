'use strict'

// Excluir conta, outside the directory: the per-member data the other files
// of the account service keep for a deleted key. The directory's deleted
// rows (./store.js deletedMembers) are the authority: purge(member) runs
// right after a deletion and sweep() runs at every start and then
// periodically, so a store that was unavailable or failed to write at the
// moment of the request is purged later, and so is anything a stale writer's
// union merge brought back. Each step is idempotent.
//
// What goes: terms acceptances (terms.json), the age band (age.json), the
// push subscriptions (push.json), the recovery entries (recovery.json, each
// leaving the store's usual 30-day tombstone with the public key), the
// invites the member issued (invites.json), the surprise-invite marks
// (invite-drops.json) and the encrypted seen blob (seen/<member>, removed
// with the compare-and-swap of ./seen-store.js: a conflict waits for the
// next sweep). What stays is decided elsewhere: the deleted row and
// the burned names in the directory, the reports and decisions in
// moderation.json (issue #38), and the pending block (./moderation-store.js).
//
// Never throws. Logs carry only counts, never a key.

const SWEEP_MS = 3600 * 1000

function usable (s) {
  return s !== null && s !== undefined && (typeof s.available !== 'function' || s.available())
}

// createDeletionSweep({ accounts, terms, ages, pushStore, recovery, invites,
// drops, seen, log }) -> { purge(member), sweep(), start() -> stop }. Every
// store but `accounts` may be null (the feature is off: no file to purge).
function createDeletionSweep ({ accounts, terms = null, ages = null, pushStore = null, recovery = null, invites = null, drops = null, seen = null, log = () => {} }) {
  // [name, store, holds(member), forget(member)] for each store that exists.
  const steps = [
    ['terms', terms, (m) => terms.holds(m), (m) => terms.forget(m)],
    ['idade', ages, (m) => ages.get(m) !== null, (m) => ages.forget(m)],
    ['push', pushStore, (m) => pushStore.devices(m) > 0, (m) => pushStore.removeAll(m)],
    ['recuperacao', recovery, (m) => recovery.list(m).length > 0, (m) => recovery.removeMember(m)],
    ['convites', invites, (m) => invites.holds(m), (m) => invites.forget(m)],
    ['sorteio', drops, (m) => drops.holds(m), (m) => drops.forget(m)],
    ['vistos', seen, (m) => seen.get(m) !== null, forgetSeen]
  ].filter(([, store]) => store !== null && store !== undefined)

  async function forgetSeen (member) {
    const current = seen.get(member)
    if (current === null) return
    const r = await seen.forget(member, current.hash)
    if (r.ok !== true) throw new Error('vistos-conflito')
  }

  // -> the number of stores still holding (or unable to answer for) member.
  async function purgeOne (member) {
    let pending = 0
    for (const [, store, holds, forget] of steps) {
      if (!usable(store)) {
        pending++
        continue
      }
      try {
        if (holds(member)) await forget(member)
      } catch {
        pending++
      }
    }
    return pending
  }

  async function purge (member) {
    const pending = await purgeOne(member)
    if (pending > 0) log({ event: 'exclusao', reason: 'purga-pendente', count: pending })
    return { pending }
  }

  let running = null
  // One sweep at a time; a call during a sweep waits for it.
  function sweep () {
    if (running !== null) return running
    running = (async () => {
      let pending = 0
      let members = []
      try {
        members = accounts.deletedMembers()
      } catch {
        return { members: 0, pending: 1 }
      }
      for (const member of members) pending += await purgeOne(member)
      if (pending > 0) log({ event: 'exclusao', reason: 'purga-pendente', count: pending })
      return { members: members.length, pending }
    })().finally(() => { running = null })
    return running
  }

  // The periodic sweep: -> stop(). The timer never keeps the process alive.
  function start (ms = SWEEP_MS) {
    const timer = setInterval(() => { sweep() }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }

  return { purge, sweep, start }
}

module.exports = {
  SWEEP_MS,
  createDeletionSweep
}
