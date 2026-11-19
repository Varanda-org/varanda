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
// invites the member issued (invites.json, and with the Feira on the codes
// charged to the member in feira-invites.json: `invites` is then the
// ./invites-pair.js facade, whose holds and forget cover both files), the
// surprise-invite marks
// (invite-drops.json), the encrypted seen blob (seen/<member>, removed
// with the compare-and-swap of ./seen-store.js: a conflict waits for the
// next sweep) and the passkey public keys with any waiting deletion
// (passkeys.json, leaving a 30-day tombstone), and a request filed by
// Excluir conta sem a passkey (deletion-requests.json). The verified phone number
// (phone.json) is not erased: its live row is ended ('excluida'), which frees
// the number for someone else, but the sealed number stays for the store's
// RETENTION_MS, because a court order about the deleted key may still follow
// that pointer; the phone store's own sweep purges it after, and only the
// moderation rule of ./phone-routes.js burns it. Each sweep first runs the
// deletions whose date came (`scheduled`, ./delete-routes.js runScheduled),
// so they are purged in the same pass. Pages: the member's pending state in
// pages.json (./pages-store.js forgetMember: their admin invites with the
// key share sealed for them, a transfer offer to them, their share in a
// rotation not yet promoted, a core delegate row of or for their key) and
// the invite rosters kept for them (page-invite-rosters.json,
// ./pages-routes.js forgetInvites). The owner's signed roster, the admins
// list and the current key shares stay: only the owner's own Remover
// changes those. AI triage (./ai/worker.js forgetMember when it runs, else
// ./ai/forget.js on the files an earlier run left): the cached reads with
// text and embedding and the marks of the reports about the member, and
// their precedents in exemplars.json. Each pass also runs
// `tick` (./pages-groups.js purgeBlocked: replicas of blocked keys). What
// stays is decided elsewhere: the deleted row and
// the burned names in the directory, the reports and decisions in
// moderation.json (issue #38), and the pending block (./moderation-store.js).
// After MODERATION_RETENTION_MS (6 months, 180 days) the `retention` pass
// (createModerationRetention) runs moderation.forgetDeleted for the key; the
// block itself stays on the list.
//
// Never throws. Logs carry only counts, never a key.

const { isCanonicalIso } = require('@varanda/core/lib/cert')

const SWEEP_MS = 3600 * 1000
const MODERATION_RETENTION_MS = 180 * 24 * 3600 * 1000

function usable (s) {
  return s !== null && s !== undefined && (typeof s.available !== 'function' || s.available())
}

// createDeletionSweep({ accounts, terms, ages, pushStore, recovery, invites,
// drops, seen, passkeys, deletionRequests, phones, pages, pageInvites, triage,
// scheduled, tick, retention, log }) -> { purge(member), sweep(), start() -> stop }. Every
// store but `accounts` may be null (the feature is off: no file to purge).
// `pages` is an openPagesStore, `pageInvites` { holds(m), forget(m) } and
// `triage` { holdsMember(m), forgetMember(m) }. `scheduled` and `tick` are
// async functions that never throw. `retention` (createModerationRetention)
// runs after the per-member purge of every sweep.
function createDeletionSweep ({ accounts, terms = null, ages = null, pushStore = null, pushCapsStore = null, recovery = null, invites = null, drops = null, seen = null, passkeys = null, deletionRequests = null, phones = null, pages = null, pageInvites = null, triage = null, scheduled = null, tick = null, retention = null, log = () => {} }) {
  // [name, store, holds(member), forget(member)] for each store that exists.
  const steps = [
    ['terms', terms, (m) => terms.holds(m), (m) => terms.forget(m)],
    ['idade', ages, (m) => ages.get(m) !== null, (m) => ages.forget(m)],
    ['push', pushStore, (m) => pushStore.devices(m) > 0, (m) => pushStore.removeAll(m)],
    ['push-caps', pushCapsStore, (m) => pushCapsStore.holds(m), (m) => pushCapsStore.removeAll(m)],
    ['recuperacao', recovery, (m) => recovery.list(m).length > 0, (m) => recovery.removeMember(m)],
    ['convites', invites, (m) => invites.holds(m), (m) => invites.forget(m)],
    ['sorteio', drops, (m) => drops.holds(m), (m) => drops.forget(m)],
    ['vistos', seen, (m) => seen.get(m) !== null, forgetSeen],
    ['passkeys', passkeys, (m) => passkeys.holds(m), (m) => passkeys.forget(m)],
    ['pedidos-exclusao', deletionRequests, (m) => deletionRequests.holds(m), (m) => deletionRequests.forget(m)],
    ['telefone', phones, (m) => phones.live(m) !== null, (m) => phones.end(m, 'excluida')],
    ['paginas', pages, (m) => pages.holdsMember(m), (m) => pages.forgetMember(m)],
    ['convites-pagina', pageInvites, (m) => pageInvites.holds(m), (m) => pageInvites.forget(m)],
    ['triagem', triage, (m) => triage.holdsMember(m), (m) => triage.forgetMember(m)]
  ].filter(([, store]) => store !== null && store !== undefined)

  async function forgetSeen (member) {
    const current = seen.get(member)
    if (current === null) return
    const r = await seen.forget(member, current.hash)
    if (r.ok !== true) throw new Error('vistos-conflito')
  }

  // Once per file: a corrupt or unreadable file is never read as empty, so
  // the purge stays pending until the operator fixes or moves it. Names the
  // file only, never its contents or a member.
  const warned = new Set()
  function warnBroken (name, store) {
    let files = typeof store.brokenFiles === 'function' ? store.brokenFiles() : []
    if (files.length === 0 && !usable(store)) files = [name]
    for (const file of files) {
      if (warned.has(file)) continue
      warned.add(file)
      log({ event: 'exclusao', reason: 'arquivo-invalido', file, aviso: 'arquivo ' + file + ' ilegível ou corrompido: a purga de exclusões fica pendente até o operador corrigir ou mover o arquivo' })
    }
  }

  // -> the number of stores still holding (or unable to answer for) member.
  async function purgeOne (member) {
    let pending = 0
    for (const [name, store, holds, forget] of steps) {
      if (!usable(store)) {
        warnBroken(name, store)
        pending++
        continue
      }
      try {
        if (holds(member)) await forget(member)
      } catch {
        warnBroken(name, store)
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
      for (const fn of [scheduled, tick]) {
        if (fn === null) continue
        try {
          await fn()
        } catch {}
      }
      let pending = 0
      let members = []
      try {
        members = accounts.deletedMembers()
      } catch {
        return { members: 0, pending: 1 }
      }
      for (const member of members) pending += await purgeOne(member)
      if (retention !== null) {
        try {
          await retention()
        } catch {}
      }
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

// The moderation data of keys deleted at least MODERATION_RETENTION_MS ago
// (moderation-store.js forgetDeleted, every due key in one call): -> an
// async function for createDeletionSweep's `retention`, or null without a
// desk. `beforeForget` (the phone sweep) runs before the purge, so a block
// acked late burns the number while its report still names the key. The
// purge is pinned to the store revision read right before it: any write in
// between (an ack, a decision) makes the store answer `stale`, and the pass
// sweeps again and retries once, then leaves it to the next pass
// (`moderacao-adiada`). A throwing beforeForget skips the pass
// (`moderacao-telefone-pendente`); a directory or desk that throws is
// logged as `moderacao-pendente`; anexo files whose unlink keeps failing
// (still listed after the pass) as `moderacao-anexo-pendente`, so a
// persistent failure is not silent. An absent or non-canonical deletion
// date is never due. Logs counts only.
function createModerationRetention ({ accounts, moderation = null, beforeForget = null, now = Date.now, log = () => {} }) {
  if (moderation === null || moderation === undefined) return null
  return async function retain () {
    let due = null
    let r = null
    try {
      const cut = now() - MODERATION_RETENTION_MS
      due = accounts.deletedMembers().filter((m) => {
        const date = accounts.deletedAt(m)
        if (!isCanonicalIso(date)) return false
        const at = Date.parse(date)
        return Number.isFinite(at) && at <= cut
      })
      if (due.length === 0) return
      if (!moderation.holdsDeleted(due)) return
      for (let attempt = 0; attempt < 2; attempt++) {
        const revision = moderation.revision()
        if (beforeForget !== null) {
          try {
            await beforeForget()
          } catch {
            log({ event: 'exclusao', reason: 'moderacao-telefone-pendente' })
            return
          }
        }
        r = await moderation.forgetDeleted(due, { revision })
        if (!r.stale) break
      }
    } catch {
      if (due === null) log({ event: 'exclusao', reason: 'moderacao-pendente' })
      else log({ event: 'exclusao', reason: 'moderacao-pendente', count: due.length })
      return
    }
    if (r.stale) {
      log({ event: 'exclusao', reason: 'moderacao-adiada' })
      return
    }
    if (r.reports + r.stripped + r.records + r.appeals + r.events + r.files > 0) {
      log({ event: 'exclusao', reason: 'moderacao-expurgada', members: due.length, reports: r.reports, stripped: r.stripped, records: r.records, kept: r.kept, deferred: r.deferred })
    }
    if (r.filesLeft > 0) log({ event: 'exclusao', reason: 'moderacao-anexo-pendente', count: r.filesLeft })
  }
}

module.exports = {
  SWEEP_MS,
  MODERATION_RETENTION_MS,
  createDeletionSweep,
  createModerationRetention
}
