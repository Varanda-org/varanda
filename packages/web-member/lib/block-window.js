'use strict'

// A bounded, ordered request window over a list of block seqs: up to
// `inflight` requests run at once, but results are handed back strictly in
// `seqs` order, so a reader that walks a diary highest seq first (the
// Espiadinha window, the notices tail) keeps every rule that depends on
// that order (a tombstone read before its target, a hole stopping
// everything below it) while paying about one round trip per `inflight`
// blocks instead of one per block. Pure: no I/O, no timers; the caller's
// `start` does the request and the caller's `canStart` holds the budget.
//
// pipeline({ seqs, inflight, canStart, start, skip, cancel }) -> an async
// iterator of { seq, result } (start(seq) resolved), { seq, error } (it
// rejected or threw) or { seq, skipped: true }, in `seqs` order.
//
// THE BOUND: at most `inflight` requests are outstanding at any time,
// counting both the entries started and not yet consumed and the skipped
// ones whose request has not settled yet. canStart() is asked before EVERY
// start; false starts nothing more for now and dispatch is tried again on
// the next consumption (the next call to next()), so a consumer can change
// what start() sees (a tombstone it just read) before the next seq goes out.
//
// skip(seq) is asked when an entry reaches the head, BEFORE waiting for it:
// true yields it at once as skipped and calls cancel(seq), so a request the
// consumer no longer wants (a block a tombstone just deleted, which a
// seeder will never serve) costs no wait. Its slot is freed only when its
// request settles, which cancel() should make prompt; when every free slot
// is held by such a request, next() waits for one to settle instead of
// ending early. The iteration ends when nothing is outstanding to consume
// and nothing more can start. stop() (also called by `break` / `return` in
// a for await) starts nothing more and drops the started entries: their
// outcomes are already captured, so an abandoned rejection is never
// unhandled.
function pipeline ({ seqs, inflight = 1, canStart = () => true, start, skip = () => false, cancel = noop }) {
  if (typeof start !== 'function') throw new TypeError('start required')
  const list = Array.from(seqs)
  const width = Number.isSafeInteger(inflight) && inflight >= 1 ? inflight : 1
  const queue = [] // started, not consumed: { seq, promise of the entry }
  let next = 0
  let stopped = false
  let abandoned = 0 // skipped entries whose request has not settled
  let wake = null

  function launch (seq) {
    let p
    try {
      p = Promise.resolve(start(seq))
    } catch (error) {
      p = Promise.reject(error)
    }
    return { seq, promise: p.then((result) => ({ seq, result }), (error) => ({ seq, error })) }
  }

  function fill () {
    if (stopped) return
    while (next < list.length && queue.length + abandoned < width && canStart()) {
      queue.push(launch(list[next++]))
    }
  }

  function stop () {
    stopped = true
    // Every entry already carries its own rejection handler (launch); the
    // catch only makes that explicit for whoever reads this later.
    for (const e of queue.splice(0)) e.promise.catch(noop)
    awake()
  }

  function awake () {
    const w = wake
    wake = null
    if (w !== null) w()
  }

  function abandon (entry) {
    abandoned++
    // entry.promise never rejects (launch captured the outcome).
    entry.promise.then(() => {
      abandoned--
      awake()
    })
    try { cancel(entry.seq) } catch {}
  }

  const iterator = {
    async next () {
      fill()
      // Every free slot held by a skipped request still settling: wait for
      // one rather than end the window early.
      while (true) {
        if (stopped || queue.length > 0 || abandoned === 0 || next >= list.length) break
        await new Promise((resolve) => { wake = resolve })
        fill()
      }
      if (stopped || queue.length === 0) {
        stop()
        return { done: true, value: undefined }
      }
      const head = queue.shift()
      if (skip(head.seq)) {
        abandon(head)
        return { done: false, value: { seq: head.seq, skipped: true } }
      }
      const value = await head.promise
      if (stopped) return { done: true, value: undefined }
      return { done: false, value }
    },
    async return () {
      stop()
      return { done: true, value: undefined }
    },
    stop,
    [Symbol.asyncIterator] () {
      return iterator
    }
  }
  return iterator
}

function noop () {}

module.exports = { pipeline }
