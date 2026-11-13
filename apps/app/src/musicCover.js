// Audius covers for this session. Pure ES module: no React, React Native or
// Node built-ins.
//
// The Audius API Terms allow caching only for the session, so a cover lives
// in memory as a data: URI and never as a file: urlFromBytes in
// src/media/display.native.js would write one in the cache directory, and it
// would outlive the session until the next start's sweep. When the app
// process ends nothing remains, and src/ui/useMusicCover.js empties the cache
// on sign-out, lock and an account change.

const COVER_MIMES = ['image/jpeg', 'image/png', 'image/webp']
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

// The key carries the session's origin and member: one person's covers are
// never answered to another, or from another installation. The large cover
// has its own key, so the two sizes never answer each other.
export function coverKey (kind, id, session) {
  const s = session || {}
  const key = [s.origin ?? '', s.member ?? '', kind, id].join('|')
  return s.large === true ? key + '|480' : key
}

export function coverUri (mime, base64) {
  if (!COVER_MIMES.includes(mime) || typeof base64 !== 'string' || !BASE64_RE.test(base64)) return null
  return 'data:' + mime + ';base64,' + base64
}

const asUri = (v) => (typeof v === 'string' && v.startsWith('data:image/') ? v : null)

// load(kind, id, session) resolves a data URI, or anything else for a
// definite "no cover" (kept as null while its entry lives). A rejection is a
// transient failure (a timeout, a 503): its callers get null, but nothing is
// kept, so a later get asks again. get resolves the URI or null; its optional
// signal says the caller has gone.
export function createCoverCache ({ load, max = 48, parallel = 3 } = {}) {
  // Settled covers only. Insertion order is recency: a hit moves its entry to
  // the end.
  const entries = new Map()
  // Loads queued or running, apart from `entries` so the size trim never
  // drops one and a second get never starts one twice: each load spends one
  // of the member's daily art uses on the service.
  const pending = new Map()
  const queue = []
  let active = 0
  let generation = 0

  function settle (job, value, keep) {
    if (pending.get(job.key) === job) pending.delete(job.key)
    if (job.generation !== generation) return job.resolve(null)
    if (keep) {
      entries.set(job.key, value)
      while (entries.size > max) entries.delete(entries.keys().next().value)
    }
    job.resolve(value)
  }

  function pump () {
    while (active < parallel && queue.length > 0) {
      const job = queue.shift()
      job.started = true
      active++
      Promise.resolve()
        .then(() => load(job.kind, job.id, job.session))
        .then((v) => [asUri(v), true], () => [null, false])
        .then(([value, keep]) => {
          active--
          settle(job, value, keep)
          pump()
        })
    }
  }

  // A load nobody waits for leaves the queue before anything is sent (rows of
  // a page the picker left). One already running ends and is kept as usual,
  // so the service never sees more than `parallel` at once.
  function leave (job) {
    job.waiters--
    if (job.waiters > 0 || job.started || pending.get(job.key) !== job) return
    pending.delete(job.key)
    const at = queue.indexOf(job)
    if (at !== -1) queue.splice(at, 1)
    job.resolve(null)
  }

  function get (kind, id, session, { signal } = {}) {
    if (!session || typeof session !== 'object') return Promise.resolve(null)
    const key = coverKey(kind, id, session)
    if (entries.has(key)) {
      const hit = entries.get(key)
      entries.delete(key)
      entries.set(key, hit)
      return Promise.resolve(hit)
    }
    if (signal && signal.aborted) return Promise.resolve(null)
    let job = pending.get(key)
    if (job !== undefined && job.generation !== generation) adopt(job)
    if (job === undefined) {
      job = { key, kind, id, session, generation, started: false, waiters: 0 }
      job.promise = new Promise((resolve) => { job.resolve = resolve })
      pending.set(key, job)
      queue.push(job)
    }
    // A caller without a signal never leaves, so its load always runs.
    job.waiters++
    if (signal) signal.addEventListener('abort', () => leave(job), { once: true })
    pump()
    return job.promise
  }

  // A load that began before a clear() is already paid for on the service: a
  // get for the same key (same origin and member) after it takes the answer
  // instead of sending a second request. Callers from before the clear still
  // get null.
  function adopt (job) {
    const before = job.resolve
    job.generation = generation
    job.promise = new Promise((resolve) => {
      job.resolve = (value) => { before(null); resolve(value) }
    })
  }

  // Loads already running keep their slot and their place in `pending` until
  // they end (so the service never sees more than `parallel` at once); their
  // answers are dropped unless a later get adopts them.
  function clear () {
    generation++
    entries.clear()
    for (const job of queue.splice(0)) {
      pending.delete(job.key)
      job.resolve(null)
    }
  }

  // A settled cover only, or null: never loads, queues or waits. For a sticker
  // that may show a cover already paid for but must not ask for one.
  function peek (kind, id, session) {
    if (!session || typeof session !== 'object') return null
    const key = coverKey(kind, id, session)
    return entries.has(key) ? entries.get(key) : null
  }

  return { get, peek, clear }
}
