/* global window */

// The outbox ('fila de saída') in the app: OutboxProvider keeps the queue of
// the browser node (./outbox for the rules, ./outboxStore for the storage) and
// useOutboxDrain sends it through the write gate, one item per step, only by
// post.create / post.reply.
//
// The stored queue is the single source of truth: two windows of the same
// browser, a drain step that settles after its effect was cleaned up and a
// reset may all change it, so every change is a read-modify-write of the
// stored queue (never of a captured array) and `items` mirrors what was
// stored. Natively the store is a file in the app's documents
// (outboxStore.native.js) and only the installation's node queues.
//
// Automatic sending is scoped to this page session. The stored queue is not
// authenticated: any script of this origin can write localStorage, also while
// the identity is locked (DevTools on a shared computer, an extension), and an
// item planted there would otherwise be signed and published with the
// member's key at the next sign-in, with no action by the member. So the
// drain only picks items approved in an in-memory map (never persisted:
// anything stored can be planted): the items this page wrote (`add`) and the
// items the person released from Diário (`release`, `retry`). The approval is
// bound to the CONTENT (author, association, kind and the box that seals the
// target and the text), not only to the id: a stored item whose content
// changed after it was approved (the same id, another box) waits for the
// person again. An approval is spent by
// the attempt it allows (one publication per approval), and a queued reply
// shows its target before it is approved. Everything else found in storage
// waits for the person.
//
// The target and the text are stored only sealed (item v2, see ./outbox and
// ./outboxSeal): `add` asks the node to seal them before it saves, and after
// an unlock (and after another window changed the queue) an open pass asks
// the node to open each item of the unlocked identity, keeping { to, text }
// in memory only (`openedRef`, cleared on lock or a change of identity). An
// item that does not open as itself (BAD_BOX) is removed; the drain sends an
// item only with the text the node opened from its box, and the approval
// covers the box. A v1 item from before the seal is sealed by the first pass.
// A pass that met a failure that may pass (INTERNAL) runs again 30 s later.
// The drain sends and reconciles only items opened in this window, and claims
// nothing while any item of the pair is 'sending', opened here or not (another
// window may be sending it). One that does not open here waits for the open
// pass, which removes it if its box does not open; Diário can always delete it.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { LOG_LIMIT_MAX } from '@varanda/rpc'
import { useNode } from './node'
import {
  checkDraft, claim, classifyFailure, enqueue, itemsOf, markFailed, markQueued, markRetry, markUncertain,
  maxSeq, nextDueAt, nextToSend, removeAuthor, retryDelayMs, rpcParams,
  sendingOf, serializeOutbox, validBox, wake, writtenAtOf
} from './outbox'
import {
  approved, discardItem, fingerprintOf, keepsClearText, openPass, openedOf, openedOnly, passAgainLater,
  reconcileOpened, remember, sendable, shownItems
} from './outboxSeal'
import { forgetMigrated, isOutboxKey, seenOf } from './outboxMigrate'
import { loadOutbox, outboxAvailable, randomId, saveOutbox } from './outboxStore'

const NOT_SAVED = 'não foi possível guardar a publicação neste aparelho'

const noop = () => {}
const FALLBACK = {
  available: false,
  items: [],
  itemsFor: () => [],
  add: () => Promise.reject(new Error(NOT_SAVED)),
  retry: noop,
  release: noop,
  isAllowed: () => false,
  discard: noop,
  forgetAuthor: () => true,
  lastSent: { n: 0, kind: null }
}

const OutboxContext = createContext(FALLBACK)
// The drain's access to the provider: { mutate, published, allowedRef,
// openedRef, released, openedVersion }.
const DrainContext = createContext(null)

export function useOutbox () {
  return useContext(OutboxContext)
}

function messageOf (err) {
  return err && typeof err.message === 'string' && err.message !== '' ? err.message : 'erro'
}

export function OutboxProvider ({ children }) {
  const node = useNode()
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  const pkStatus = node.passkey ? node.passkey.status : null
  const unlockedKey = pkStatus && pkStatus.unlocked === true && typeof pkStatus.publicKey === 'string'
    ? pkStatus.publicKey.toLowerCase()
    : null
  const generation = node.passkey ? node.passkey.generation : 0
  const [items, setItems] = useState(() => (outboxAvailable ? loadOutbox() : []))
  const [lastSent, setLastSent] = useState({ n: 0, kind: null })
  // The content this page session may send automatically: id -> fingerprint.
  // Only in memory.
  const allowedRef = useRef(new Map())
  // Opened { to, text } per id (see ./outboxSeal). Only in memory; a new Map
  // per identity, so a pass still running for the previous one fills a map
  // nobody reads.
  const openedRef = useRef(new Map())
  // Bumped when the cache changes: Diário and the drain re-run.
  const [openedVersion, setOpenedVersion] = useState(0)
  // { key, generation } of the unlocked identity the cache belongs to.
  const identityRef = useRef(null)
  const passRef = useRef({ running: false, again: false, timer: null })
  // Bumped when the person releases ids: the drain and Diário re-run.
  const [released, setReleased] = useState(0)
  // The serialized form of `items`: a re-read that changed nothing keeps the
  // same array (no render, no drain re-run).
  const shownRef = useRef(serializeOutbox(items))

  const show = useCallback((next) => {
    const text = serializeOutbox(next)
    if (text === shownRef.current) return
    shownRef.current = text
    setItems(next)
  }, [])

  // Read-modify-write of the stored queue. `op` may throw (nothing is
  // saved). Returns true when the result was saved; when it was not, the
  // stored queue is shown as it is.
  const mutate = useCallback((op) => {
    if (!outboxAvailable) return false
    const fresh = loadOutbox()
    const next = op(fresh)
    // Unchanged (e.g. nothing to reconcile, or an unknown id): nothing to write.
    if (next === fresh) {
      show(fresh)
      return true
    }
    if (!saveOutbox(next)) {
      show(fresh)
      return false
    }
    show(next)
    return true
  }, [show])

  // One open pass at a time; a request during one runs another after it. A
  // pass stopped (locked, or the node not reachable yet) or one that met a
  // failure that may pass tries again later while the same identity stays
  // unlocked.
  const runPassRef = useRef(null)
  runPassRef.current = () => {
    const identity = identityRef.current
    const pass = passRef.current
    if (!outboxAvailable || identity === null || typeof requestRef.current !== 'function') return
    if (pass.running) {
      pass.again = true
      return
    }
    clearTimeout(pass.timer)
    pass.running = true
    const current = () => identityRef.current === identity
    openPass({
      items: loadOutbox(),
      author: identity.key,
      opened: openedRef.current,
      call: (method, params) => requestRef.current(method, params),
      mutate,
      current
    })
      .catch(() => 'stopped')
      .then((result) => {
        pass.running = false
        if (current()) setOpenedVersion((n) => n + 1)
        if (pass.again) {
          pass.again = false
          runPassRef.current()
        } else if (passAgainLater(result) && current()) {
          pass.timer = setTimeout(() => runPassRef.current(), retryDelayMs(1))
        }
      })
  }

  // Unlock, lock or another identity: the cache starts over.
  useEffect(() => {
    identityRef.current = unlockedKey === null ? null : { key: unlockedKey, generation }
    openedRef.current = new Map()
    clearTimeout(passRef.current.timer)
    setOpenedVersion((n) => n + 1)
    runPassRef.current()
  }, [unlockedKey, generation])

  useEffect(() => () => clearTimeout(passRef.current.timer), [])

  // Another window of this browser changed the queue, or an older build in
  // another tab wrote its own key: loadOutbox applies the value of that write
  // (event.newValue, the key itself may be gone already) and merges what the
  // key holds now (./outboxMigrate).
  useEffect(() => {
    if (!outboxAvailable || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const onStorage = (event) => {
      if (isOutboxKey(event.key)) {
        show(loadOutbox(seenOf(event)))
        runPassRef.current()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [show])

  const published = useCallback((kind) => {
    setLastSent((prev) => ({ n: prev.n + 1, kind }))
  }, [])

  // The pair's items for Diário: open ones with their text (`opened: true`),
  // the rest with `to` and `text` null.
  const itemsFor = useCallback((author, association) => shownItems(itemsOf(items, author, association), openedRef.current), [items, openedVersion])

  // Seals, then saves. Throws (nothing queued) when the draft is invalid, the
  // queue is full, the node does not seal it or the save fails. A lock or a
  // switch while the node seals: the sealed item is saved, its clear text is
  // not kept (the next open pass opens it for its identity).
  const add = useCallback(async ({ author, association, kind, to, text }) => {
    if (!outboxAvailable) throw new Error(NOT_SAVED)
    const target = to === undefined ? null : to
    checkDraft({ author, association, kind, to: target, text })
    const identity = identityRef.current
    const id = randomId()
    const now = Date.now()
    let box = null
    try {
      const answer = await requestRef.current('outbox.seal', { id, author, association, kind, to: target, text, writtenAt: writtenAtOf(now) })
      box = answer !== null && typeof answer === 'object' ? answer.box : null
    } catch {
      throw new Error(NOT_SAVED)
    }
    if (!validBox(box)) throw new Error(NOT_SAVED)
    // Written by this page: sent automatically. Approved and open before the
    // save, so the drain step that the new item triggers already sees it.
    const keep = keepsClearText(identity, identityRef.current, author)
    const saved = mutate((fresh) => {
      const next = enqueue(fresh, { author, association, kind, to: target, text, box, now, id })
      const item = next.find((i) => i.id === id)
      if (item) {
        allowedRef.current.set(id, fingerprintOf(item))
        if (keep) remember(openedRef.current, item, { to: target, text })
      }
      return next
    })
    if (!saved) {
      allowedRef.current.delete(id)
      openedRef.current.delete(id)
      throw new Error(NOT_SAVED)
    }
    setOpenedVersion((n) => n + 1)
  }, [mutate])

  // An explicit action of the person on the items as shown in Diário: this
  // exact content may be sent automatically. An item not open (its text not
  // shown) is not approved. An item merged from an older build keeps its mark
  // until this build claims it, so an old-tab claim that arrives first still
  // makes it 'uncertain' instead of sent twice (./outboxMigrate).
  const release = useCallback((shown) => {
    for (const item of shown) {
      const fingerprint = fingerprintOf(item)
      if (fingerprint !== null && openedOf(openedRef.current, item) !== null) allowedRef.current.set(item.id, fingerprint)
    }
    setReleased((n) => n + 1)
  }, [])
  // A new function on every release: consumers re-render and check again.
  const isAllowed = useCallback((item) => approved(allowedRef.current, item), [released])

  const retry = useCallback((item) => {
    release([item])
    mutate((fresh) => markQueued(fresh, item.id))
  }, [mutate, release])
  // An item not open in this window goes whatever its state (./outboxSeal
  // discardItem); an open 'sending' one stays until reconciled.
  const discard = useCallback((id) => {
    allowedRef.current.delete(id)
    if (mutate((fresh) => discardItem(forgetMigrated(fresh, id), id, openedRef.current))) openedRef.current.delete(id)
  }, [mutate])
  // true when the author's items are gone from the stored queue.
  const forgetAuthor = useCallback((author) => {
    if (!outboxAvailable) return true
    // Nothing of that author: nothing to write (a storage that cannot be
    // written must not block a reset with an empty queue).
    return mutate((fresh) => {
      const mine = fresh.filter((item) => item.author === author)
      for (const item of mine) {
        allowedRef.current.delete(item.id)
        openedRef.current.delete(item.id)
      }
      return mine.length > 0 ? removeAuthor(fresh, author) : fresh
    })
  }, [mutate])

  const value = useMemo(() => ({
    available: outboxAvailable, items, itemsFor, add, retry, release, isAllowed, discard, forgetAuthor, lastSent
  }), [items, itemsFor, add, retry, release, isAllowed, discard, forgetAuthor, lastSent])
  const drain = useMemo(() => ({ mutate, published, allowedRef, openedRef, released, openedVersion }), [mutate, published, released, openedVersion])

  return (
    <OutboxContext.Provider value={value}>
      <DrainContext.Provider value={drain}>{children}</DrainContext.Provider>
    </OutboxContext.Provider>
  )
}

// Sends the queue of (author, association) while `enabled`. One step:
// re-read the own diary (log.read), reconcile an item left 'sending', claim
// the next due item (saved BEFORE the request) and send it through the write
// gate. An uncertain send or an 'unknown' reconciliation is never resent
// automatically: the person decides from Diário. Only items allowed in this
// page session and open (see the top of this file) are picked;
// reconciliation still settles any 'sending' item of the pair once it is
// open (it never resends), and an item it puts back to 'queued' is picked
// only if its id is already allowed. An item this window cannot open (yet)
// is never reconciled here and never sent, but while it is 'sending' it holds
// the pair: nothing else is claimed (one send at a time per pair, across
// windows).
export function useOutboxDrain ({ enabled, author, association }) {
  const node = useNode()
  const outbox = useContext(OutboxContext)
  const drain = useContext(DrainContext)
  const items = outbox.items
  const online = node.online
  const stopped = node.sync.stopped

  const inflightRef = useRef(false)
  const [tick, setTick] = useState(0)
  // No step before this time (a claim or a reconciliation could not be saved,
  // or the diary could not be read).
  const blockedUntilRef = useRef(0)
  const onlineRef = useRef(online)
  const handledRunRef = useRef(stopped ? stopped.runId : null)
  const wakeRef = useRef(false)
  const requestRef = useRef(node.request)
  requestRef.current = node.request
  // What the step checks before it claims or sends (the effect's cleanup
  // must not abort a step that is already settling).
  const active = !!(enabled && author && association && outbox.available && drain !== null)
  const gateRef = useRef({ active, author, association })
  gateRef.current = { active, author, association }

  useEffect(() => {
    // The network or the seeder is back: retry now instead of waiting out
    // the backoff.
    const wasOnline = onlineRef.current
    onlineRef.current = online
    if (wasOnline === false && online === true) wakeRef.current = true
    if (stopped && stopped.runId !== handledRunRef.current) {
      handledRunRef.current = stopped.runId
      if (stopped.result && stopped.result.seederConfirmed === true) wakeRef.current = true
    }
    if (drain === null || !outbox.available || !author || !association) return
    if (wakeRef.current) {
      wakeRef.current = false
      blockedUntilRef.current = 0
      drain.mutate((fresh) => wake(fresh, author, association, Date.now()))
    }
    if (!active || inflightRef.current) return

    let timer = null
    const arm = (delay) => { timer = setTimeout(() => setTick((t) => t + 1), Math.max(0, delay)) }
    const now = Date.now()
    if (blockedUntilRef.current > now) {
      arm(blockedUntilRef.current - now)
      return () => clearTimeout(timer)
    }
    const stored = loadOutbox()
    const sending = sendingOf(openedOnly(stored, drain.openedRef.current), author, association)
    // Held by a 'sending' item not open here: nothing to reconcile nor claim
    // until it opens (openedVersion) or goes (items).
    const held = sending === null && sendingOf(stored, author, association) !== null
    const allowed = sendable(stored, drain.allowedRef.current, drain.openedRef.current)
    if (sending === null && (held || nextToSend(allowed, author, association, now) === null)) {
      const due = held ? null : nextDueAt(allowed, author, association)
      if (due !== null) arm(due - now)
      return () => clearTimeout(timer)
    }

    inflightRef.current = true
    runStep({ author, association, mutate: drain.mutate, published: drain.published, allowedRef: drain.allowedRef, openedRef: drain.openedRef, request: requestRef.current, gateRef, blockedUntilRef })
      .catch(() => { blockedUntilRef.current = Date.now() + retryDelayMs(1) })
      .finally(() => {
        inflightRef.current = false
        setTick((t) => t + 1)
      })
    return () => clearTimeout(timer)
  }, [enabled, author, association, items, online, stopped, tick, active, drain, outbox.available])
}

async function readLog (request) {
  try {
    return await request('log.read', { limit: LOG_LIMIT_MAX })
  } catch {
    return null
  }
}

async function runStep ({ author, association, mutate, published, allowedRef, openedRef, request, gateRef, blockedUntilRef }) {
  const block = () => { blockedUntilRef.current = Date.now() + retryDelayMs(1) }
  const stillActive = () => {
    const gate = gateRef.current
    return gate.active && gate.author === author && gate.association === association
  }

  // (a) The own diary, and the item a reload or a lost answer left 'sending'.
  const page = await readLog(request)
  let status = 'none'
  let sentKind = null
  const reconciled = mutate((fresh) => {
    const r = reconcileOpened(fresh, openedRef.current, author, association, page, Date.now())
    status = r.status
    sentKind = r.sent ? r.sent.item.kind : null
    return r.items
  })
  if (!reconciled) return block()
  if (status === 'sent') published(sentKind)
  if (page === null) return block()

  // (b) The next due allowed item; (c) claimed and saved before the request.
  // Nothing is sent while any item of the pair is 'sending', open here or not
  // (another window may have claimed one this page does not allow).
  if (!stillActive()) return
  let item = null
  const claimed = mutate((fresh) => {
    item = sendingOf(fresh, author, association) !== null
      ? null
      : nextToSend(sendable(fresh, allowedRef.current, openedRef.current), author, association, Date.now())
    if (item === null) return fresh
    return claim(fresh, item.id, { now: Date.now(), floorSeq: maxSeq(page) })
  })
  if (item === null) return
  if (!claimed) return block()

  const id = item.id
  // An approval is spent by the attempt it allows: an item that comes back
  // to the queue later (restored by a script, or reconciled after a reload)
  // waits for the person again. Only a retryable failure, which wrote
  // nothing, keeps the same approval for this exact content.
  const fingerprint = fingerprintOf(item)
  allowedRef.current.delete(id)
  try {
    await request(item.kind === 'reply' ? 'post.reply' : 'post.create', rpcParams(item))
  } catch (err) {
    const kind = classifyFailure(err)
    if (kind === 'retry') {
      if (mutate((fresh) => markRetry(fresh, id, { error: messageOf(err), now: Date.now() }))) allowedRef.current.set(id, fingerprint)
      else block()
      return
    }
    if (kind === 'uncertain') {
      const again = await readLog(request)
      let found = false
      const saved = mutate((fresh) => {
        const r = reconcileOpened(fresh, openedRef.current, author, association, again, Date.now())
        if (r.status === 'sent' && r.sent.item.id === id) {
          found = true
          return r.items
        }
        return markUncertain(fresh, id)
      })
      if (!saved) return block()
      if (found) published(item.kind)
      return
    }
    if (!mutate((fresh) => markFailed(fresh, id, messageOf(err)))) block()
    return
  }
  // Published: the item leaves the queue. Should that not be saved, the next
  // step reconciles it as sent.
  if (mutate((fresh) => fresh.filter((other) => other.id !== id))) published(item.kind)
  else block()
}
