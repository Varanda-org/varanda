'use strict'

// Relays the seeder's push candidates (Seeder onPush) to the account
// service's loopback POST /push-event. Never retries: a lost relay is a lost
// notice, and the in-app Avisos still show follows. Nothing about an event
// is logged or kept beyond the dedupe keys.
const { validatePushEvent } = require('@varanda/core/lib/push-events')

// Same rule as VARANDA_ACCOUNT_HTTP in cli.js: the bearer token must never
// leave the machine.
const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/

function positiveInt (value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer')
  return value
}

function createPushRelay ({ baseUrl, token, fetch = globalThis.fetch, timeoutMs = 5000, maxPending = 256, dedupeMax = 4096 } = {}) {
  const match = typeof baseUrl === 'string' ? LOOPBACK_RE.exec(baseUrl) : null
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new TypeError('baseUrl must be a loopback http URL')
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw new TypeError('token must be 64 lowercase hex characters')
  if (typeof fetch !== 'function') throw new TypeError('fetch must be a function')
  positiveInt(timeoutMs, 'timeoutMs')
  positiveInt(maxPending, 'maxPending')
  positiveInt(dedupeMax, 'dedupeMax')

  const endpoint = baseUrl.replace(/\/$/, '') + '/push-event'
  const queue = []
  const seen = new Set()
  const counts = { sent: 0, failed: 0, invalid: 0, duplicate: 0, full: 0 }
  let inflight = null
  let draining = false
  let closed = false

  function remember (key) {
    seen.add(key)
    // A Set iterates in insertion order, so the first key is the oldest.
    if (seen.size > dedupeMax) seen.delete(seen.values().next().value)
  }

  async function post (body) {
    const controller = new AbortController()
    const timer = AbortSignal.timeout(timeoutMs)
    const onTimeout = () => controller.abort()
    timer.addEventListener('abort', onTimeout, { once: true })
    inflight = controller
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: controller.signal
      })
      if (res.body && typeof res.body.cancel === 'function') {
        try { await res.body.cancel() } catch {}
      }
      if (res.status >= 200 && res.status < 300) counts.sent++
      else counts.failed++
    } catch {
      counts.failed++
    } finally {
      timer.removeEventListener('abort', onTimeout)
      inflight = null
    }
  }

  async function drain () {
    draining = true
    try {
      // close() empties the queue, which also ends this loop.
      while (queue.length > 0) await post(queue.shift())
    } finally {
      draining = false
    }
  }

  function send (event) {
    if (closed) return false
    if (!validatePushEvent(event)) {
      counts.invalid++
      return false
    }
    const key = event.actor + ':' + event.seq
    if (seen.has(key)) {
      counts.duplicate++
      return false
    }
    if (queue.length >= maxPending) {
      counts.full++
      return false
    }
    remember(key)
    queue.push(JSON.stringify(event))
    if (!draining) drain()
    return true
  }

  function stats () {
    return { ...counts, pending: queue.length, inflight: inflight === null ? 0 : 1 }
  }

  function close () {
    closed = true
    queue.length = 0
    if (inflight !== null) inflight.abort()
  }

  return { send, stats, close }
}

module.exports = { createPushRelay }
