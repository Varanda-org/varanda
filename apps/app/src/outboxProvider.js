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
// stored. Natively (outboxAvailable false) the store is never touched.
//
// Automatic sending is scoped to this page session. The stored queue is not
// authenticated: any script of this origin can write localStorage, also while
// the identity is locked (DevTools on a shared computer, an extension), and an
// item planted there would otherwise be signed and published with the
// member's key at the next sign-in, with no action by the member. So the
// drain only picks items approved in an in-memory map (never persisted:
// anything stored can be planted): the items this page wrote (`add`) and the
// items the person released from Diário (`release`, `retry`). The approval is
// bound to the CONTENT (author, association, kind, target, text), not only to
// the id: a stored item whose content changed after it was approved (the
// same id, another text) waits for the person again. An approval is spent by
// the attempt it allows (one publication per approval), and a queued reply
// shows its target before it is approved. Everything else found in storage
// waits for the person.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { LOG_LIMIT_MAX } from '@varanda/rpc'
import { useNode } from './node'
import {
  claim, classifyFailure, enqueue, itemsOf, markFailed, markQueued, markRetry, markUncertain,
  maxSeq, nextDueAt, nextToSend, reconcile, remove, removeAuthor, retryDelayMs, rpcParams,
  sendingOf, serializeOutbox, wake
} from './outbox'
import { loadOutbox, outboxAvailable, randomId, saveOutbox } from './outboxStore'

const STORAGE_KEY = 'varanda-web-outbox'
const NOT_SAVED = 'não foi possível guardar a publicação neste aparelho'

const noop = () => {}
const FALLBACK = {
  available: false,
  items: [],
  itemsFor: () => [],
  add: () => { throw new Error(NOT_SAVED) },
  retry: noop,
  release: noop,
  isAllowed: () => false,
  discard: noop,
  forgetAuthor: () => true,
  lastSent: { n: 0, kind: null }
}

const OutboxContext = createContext(FALLBACK)
// The drain's access to the provider: { mutate, published, allowedRef, released }.
const DrainContext = createContext(null)

export function useOutbox () {
  return useContext(OutboxContext)
}

// What an approval covers: everything that ends up signed in the diary.
function fingerprintOf (item) {
  return JSON.stringify([item.author, item.association, item.kind, item.to, item.text])
}

// approved: Map id -> fingerprint. True when this exact content was approved.
function approved (allowed, item) {
  return allowed.get(item.id) === fingerprintOf(item)
}

// The items that may be sent automatically (see the top of this file).
function onlyAllowed (items, allowed) {
  return items.filter((item) => approved(allowed, item))
}

function messageOf (err) {
  return err && typeof err.message === 'string' && err.message !== '' ? err.message : 'erro'
}

export function OutboxProvider ({ children }) {
  const [items, setItems] = useState(() => (outboxAvailable ? loadOutbox() : []))
  const [lastSent, setLastSent] = useState({ n: 0, kind: null })
  // The content this page session may send automatically: id -> fingerprint.
  // Only in memory.
  const allowedRef = useRef(new Map())
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

  // Another window of this browser changed the queue.
  useEffect(() => {
    if (!outboxAvailable || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const onStorage = (event) => {
      if (event.key === STORAGE_KEY || event.key === null) show(loadOutbox())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [show])

  const published = useCallback((kind) => {
    setLastSent((prev) => ({ n: prev.n + 1, kind }))
  }, [])

  const itemsFor = useCallback((author, association) => itemsOf(items, author, association), [items])

  const add = useCallback(({ author, association, kind, to, text }) => {
    if (!outboxAvailable) throw new Error(NOT_SAVED)
    const id = randomId()
    // Written by this page: sent automatically. Approved (with the content as
    // enqueued) before the save, so the drain step that the new item triggers
    // already sees it.
    const saved = mutate((fresh) => {
      const next = enqueue(fresh, { author, association, kind, to, text, now: Date.now(), id })
      const item = next.find((i) => i.id === id)
      if (item) allowedRef.current.set(id, fingerprintOf(item))
      return next
    })
    if (!saved) {
      allowedRef.current.delete(id)
      throw new Error(NOT_SAVED)
    }
  }, [mutate])

  // An explicit action of the person on the items as shown in Diário: this
  // exact content may be sent automatically.
  const release = useCallback((shown) => {
    for (const item of shown) allowedRef.current.set(item.id, fingerprintOf(item))
    setReleased((n) => n + 1)
  }, [])
  // A new function on every release: consumers re-render and check again.
  const isAllowed = useCallback((item) => approved(allowedRef.current, item), [released])

  const retry = useCallback((item) => {
    release([item])
    mutate((fresh) => markQueued(fresh, item.id))
  }, [mutate, release])
  const discard = useCallback((id) => {
    allowedRef.current.delete(id)
    mutate((fresh) => remove(fresh, id))
  }, [mutate])
  // true when the author's items are gone from the stored queue.
  const forgetAuthor = useCallback((author) => {
    if (!outboxAvailable) return true
    // Nothing of that author: nothing to write (a storage that cannot be
    // written must not block a reset with an empty queue).
    return mutate((fresh) => {
      const mine = fresh.filter((item) => item.author === author)
      for (const item of mine) allowedRef.current.delete(item.id)
      return mine.length > 0 ? removeAuthor(fresh, author) : fresh
    })
  }, [mutate])

  const value = useMemo(() => ({
    available: outboxAvailable, items, itemsFor, add, retry, release, isAllowed, discard, forgetAuthor, lastSent
  }), [items, itemsFor, add, retry, release, isAllowed, discard, forgetAuthor, lastSent])
  const drain = useMemo(() => ({ mutate, published, allowedRef, released }), [mutate, published, released])

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
// page session (see the top of this file) are picked; reconciliation still
// settles any 'sending' item of the pair (it never resends), and an item it
// puts back to 'queued' is picked only if its id is already allowed.
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
    const allowed = onlyAllowed(stored, drain.allowedRef.current)
    if (sendingOf(stored, author, association) === null && nextToSend(allowed, author, association, now) === null) {
      const due = nextDueAt(allowed, author, association)
      if (due !== null) arm(due - now)
      return () => clearTimeout(timer)
    }

    inflightRef.current = true
    runStep({ author, association, mutate: drain.mutate, published: drain.published, allowedRef: drain.allowedRef, request: requestRef.current, gateRef, blockedUntilRef })
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

async function runStep ({ author, association, mutate, published, allowedRef, request, gateRef, blockedUntilRef }) {
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
    const r = reconcile(fresh, author, association, page, Date.now())
    status = r.status
    sentKind = r.sent ? r.sent.item.kind : null
    return r.items
  })
  if (!reconciled) return block()
  if (status === 'sent') published(sentKind)
  if (page === null) return block()

  // (b) The next due allowed item; (c) claimed and saved before the request.
  // Nothing is sent while any item of the pair is 'sending' (another window
  // may have claimed one this page does not allow).
  if (!stillActive()) return
  let item = null
  const claimed = mutate((fresh) => {
    item = sendingOf(fresh, author, association) !== null
      ? null
      : nextToSend(onlyAllowed(fresh, allowedRef.current), author, association, Date.now())
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
        const r = reconcile(fresh, author, association, again, Date.now())
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
