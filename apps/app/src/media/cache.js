/* global URL */

// A small LRU of blob: URLs for verified media, pure (no React, no fetch).
// Keys are 'core:start:blocks:sha256'. A key has at most one load in flight
// (callers share its promise), at most `concurrency` loads run at once (the
// rest wait in order), and the least recently used URL is revoked when the
// cache grows past `max`. A failed load is not cached: the next get retries.
// One entry per content key serves both persisting and transient (persist:
// false, authors the device does not follow) loads: both produce the same
// verified bytes and only the network fetch mode differs (the caller's load
// passes persist to fetchMedia). This in-memory LRU is not persistent storage:
// its blob: URLs die with the page and are revoked on eviction.

const noopRevoke = (url) => {
  try { URL.revokeObjectURL(url) } catch {}
}

// Automatic retries of a failed load while its tile is shown: a post's
// blocks can reach the seeder a moment after the post itself, so a 404 or a
// network error is retried after 2 s, 5 s and 15 s, then the tile waits for
// a tap. A mismatch (length, SHA-256) is never retried automatically.
export const RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000])

// The delay before automatic retry number `done` + 1, or null to stop.
export function retryDelay (err, done, delays = RETRY_DELAYS_MS) {
  if (!err || err.retryable !== true) return null
  if (!Number.isInteger(done) || done < 0 || done >= delays.length) return null
  return delays[done]
}

export function mediaKey (d) {
  return d.core + ':' + d.start + ':' + d.blocks + ':' + d.sha256
}

export function createMediaCache ({ max = 64, concurrency = 4, revoke = noopRevoke } = {}) {
  const entries = new Map()
  const inflight = new Map()
  const waiting = []
  let active = 0

  const pump = () => {
    while (active < concurrency && waiting.length > 0) {
      const job = waiting.shift()
      active++
      Promise.resolve()
        .then(job.load)
        .then(job.resolve, job.reject)
        .finally(() => {
          active--
          pump()
        })
    }
  }

  const schedule = (load) => new Promise((resolve, reject) => {
    waiting.push({ load, resolve, reject })
    pump()
  })

  const store = (key, url) => {
    const old = entries.get(key)
    if (old !== undefined) {
      entries.delete(key)
      if (old !== url) revoke(old)
    }
    entries.set(key, url)
    while (entries.size > max) {
      const [oldest, oldUrl] = entries.entries().next().value
      entries.delete(oldest)
      revoke(oldUrl)
    }
  }

  // The cached URL (marked as recently used), or null.
  const peek = (key) => {
    if (!entries.has(key)) return null
    const url = entries.get(key)
    entries.delete(key)
    entries.set(key, url)
    return url
  }

  const get = (key, load) => {
    const hit = peek(key)
    if (hit !== null) return Promise.resolve(hit)
    const running = inflight.get(key)
    if (running) return running
    const p = schedule(load).then((url) => {
      store(key, url)
      return url
    }).finally(() => {
      inflight.delete(key)
    })
    inflight.set(key, p)
    return p
  }

  const clear = () => {
    for (const url of entries.values()) revoke(url)
    entries.clear()
  }

  return {
    get,
    peek,
    clear,
    get size () { return entries.size },
    get active () { return active },
    get waiting () { return waiting.length }
  }
}
