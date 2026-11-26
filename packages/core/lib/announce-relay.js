'use strict'

// Paced relay of `announce` messages on one admission connection (issue #67):
// a follower announces the diaries it follows to a verified seeder, and a
// seeder announces the diaries it serves to another verified seeder. The
// receiver drops a peer whose announces exceed its bucket (Seeder
// ANNOUNCE_BURST = 20, ANNOUNCE_RATE = 10/s), so an honest relay stays well
// under it: RELAY_ANNOUNCE_BURST = 5, RELAY_ANNOUNCE_RATE = 4/s, leaving room
// for the sender's own announce and for network jitter (the half-rate margin
// of admission.js SEND_RATE_DIVISOR).
//
// A second limit: the admission channel queues sends behind its own outbound
// bucket, which starts in debt after a large initial inventory, and a backlog
// flushes as fast as that bucket allows (about 50 messages/s). So the relay
// hands the channel a new announce only while nothing of ours is queued there
// (`queued()` === 0); announces never pile up behind an inventory and leave
// in a burst. The transport below the channel can still hold messages back
// and release them together, so at most RELAY_MAX_OUTSTANDING announces are
// unanswered at once: a slot frees when the peer answers the key (`admitted`
// or `rejected`, which every seeder sends for an announce: `settle`), or
// after RELAY_SETTLE_MS without an answer. However long the stall, at most
// that many relayed announces arrive together.
//
// Per connection each key is announced at most once, and at most `max`
// distinct keys are ever announced or retired (skip); after that the relay
// sends nothing more. `next(has)` picks the next eligible candidate
// synchronously, at send time, so the caller re-checks its lists right before
// every announce. Browser-safe: requires only ./admission and ./clock.
const { tokenBucket, MAX_INVENTORY, isHex64, isPlainObject, noop } = require('./admission')
const clock = require('./clock')

const RELAY_ANNOUNCE_BURST = 5
const RELAY_ANNOUNCE_RATE = 4 // per second
// How often a relay waiting on the channel's backlog looks again.
const RELAY_POLL_MS = 250
const RELAY_MAX_OUTSTANDING = 4
const RELAY_SETTLE_MS = 30000

function createAnnounceRelay (opts = {}) {
  const {
    send,
    next,
    queued = () => 0,
    burst = RELAY_ANNOUNCE_BURST,
    rate = RELAY_ANNOUNCE_RATE,
    max = MAX_INVENTORY,
    pollMs = RELAY_POLL_MS,
    maxOutstanding = RELAY_MAX_OUTSTANDING,
    settleMs = RELAY_SETTLE_MS,
    now = clock.now,
    bucket = tokenBucket(burst, rate),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    onerror = noop
  } = opts
  if (typeof send !== 'function' || typeof next !== 'function') throw new TypeError('send and next are required')
  if (!(max >= 0)) throw new TypeError('invalid max')
  if (!(maxOutstanding >= 1)) throw new TypeError('invalid maxOutstanding')

  const seen = new Set() // keys announced or retired on this connection
  const outstanding = new Map() // key -> when its slot frees without an answer
  let timer = null
  let stopped = false
  const has = (key) => seen.has(key)

  function schedule (ms) {
    timer = setTimer(() => {
      timer = null
      kick()
    }, Math.max(1, ms))
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function kick () {
    if (stopped || timer !== null) return
    try {
      while (!stopped && seen.size < max) {
        if (queued() > 0) {
          schedule(pollMs)
          return
        }
        if (outstanding.size > 0) {
          const t = now()
          let soonest = Infinity
          for (const [k, at] of outstanding) {
            if (at <= t) outstanding.delete(k)
            else if (at < soonest) soonest = at
          }
          if (outstanding.size >= maxOutstanding) {
            schedule(soonest - t)
            return
          }
        }
        const c = next(has)
        // A caller that offers nothing, an invalid candidate or a key it
        // already offered ends this pass (no loop on a stale candidate).
        // next() may have retired keys (skip), so the cap is checked again.
        if (c === null || c === undefined || !isHex64(c.key) || !isPlainObject(c.cert) || seen.has(c.key) || seen.size >= max) return
        if (!bucket.take()) {
          schedule(bucket.waitMs())
          return
        }
        seen.add(c.key)
        outstanding.set(c.key, now() + settleMs)
        if (send({ type: 'announce', key: c.key, cert: c.cert }) === false) {
          stop()
          return
        }
      }
    } catch (err) {
      stop()
      onerror(err)
    }
  }

  // Retires a key without announcing it (the peer refused it, or it is no
  // longer eligible); it counts toward `max` like an announced key.
  function skip (key) {
    if (stopped || !isHex64(key) || seen.has(key) || seen.size >= max) return
    seen.add(key)
  }

  // The peer answered an announced key: its slot is free again.
  function settle (key) {
    if (stopped || !outstanding.delete(key)) return
    // A timer may be waiting for this very slot: look again now.
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    kick()
  }

  function stop () {
    stopped = true
    outstanding.clear()
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  return {
    kick,
    skip,
    settle,
    stop,
    has,
    size: () => seen.size,
    stopped: () => stopped
  }
}

module.exports = {
  RELAY_ANNOUNCE_BURST,
  RELAY_ANNOUNCE_RATE,
  RELAY_POLL_MS,
  RELAY_MAX_OUTSTANDING,
  RELAY_SETTLE_MS,
  createAnnounceRelay
}
