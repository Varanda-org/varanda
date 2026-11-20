import { previewPlan, previewUntil } from './momentReaction.js'

const stores = new WeakMap()

export function createMomentPreviews ({ request, media, urlFromBytes, revokeUrl, now, setTimer, clearTimer }) {
  const entries = new Map()

  function createEntry (author, seq) {
    const entry = { listeners: new Set(), state: null, lookup, retry, close }
    let open = true
    let gone = false
    let failed = false
    let epoch = 0
    let pending = false
    let read = false
    let polling = null
    let expiry = null
    let release = null
    let until = null

    function notify (state) {
      entry.state = state
      for (const listener of entry.listeners) listener(state)
    }

    function cleanup () {
      clearTimer(polling)
      clearTimer(expiry)
      polling = null
      expiry = null
      const free = release
      release = null
      if (free) free()
    }

    function close () {
      open = false
      cleanup()
    }

    // A failure (offline, a busy node, a blob not synced yet) may pass, so the
    // next bubble that mounts asks again, as a bubble of its own did before.
    // A momento past its deadline or answered as not showing stays gone.
    function drop (retryable = false) {
      if (!open || gone) return
      gone = true
      failed = retryable
      epoch++
      cleanup()
      if (entry.state?.kind !== 'gone') notify({ kind: 'gone' })
    }

    function retry () {
      if (!open || !gone || !failed) return
      gone = false
      failed = false
      read = false
      lookup()
    }

    async function loadImage (lookup, size) {
      read = true
      const mine = epoch
      try {
        const got = await media.read({ kind: 'moment', author, seq })
        const forget = () => {
          if (typeof got?.uri !== 'string') return
          const name = got.uri.slice(got.uri.lastIndexOf('/') + 1)
          try { if (typeof media.forgetReadFile === 'function') media.forgetReadFile(name) } catch {}
        }
        let uri = null
        try {
          if (open && !gone && mine === epoch && now() < until && got?.mime === lookup.mime) {
            if (got.bytes instanceof Uint8Array) {
              uri = urlFromBytes(got.bytes, got.mime)
              release = () => revokeUrl(uri)
              forget()
            } else if (typeof got.uri === 'string' && got.uri.startsWith('file://')) {
              uri = got.uri
              release = forget
            }
          }
          if (!uri) forget()
        } catch (err) {
          forget()
          throw err
        } finally {
          if (got?.bytes instanceof Uint8Array) got.bytes.fill(0)
        }
        if (!open || mine !== epoch) return
        if (!uri) drop(true)
        else notify({ kind: 'image', uri, size, handleError: () => { if (mine === epoch) drop(true) } })
      } catch {
        if (open && mine === epoch) drop(true)
      }
    }

    async function lookup () {
      if (!open || gone || pending) return
      pending = true
      const mine = epoch
      try {
        const found = await request('moment.lookup', { author, seq })
        if (!open || gone || mine !== epoch) return
        const plan = previewPlan(found)
        until = previewUntil(found)
        if (plan.kind === 'gone' || until === null || now() >= until) {
          drop()
          return
        }
        clearTimer(expiry)
        expiry = setTimer(() => drop(), until - now())
        const scale = Math.min(1, 72 / Math.max(found.w, found.h))
        const size = { width: found.w * scale, height: found.h * scale }
        if (plan.kind === 'video') notify({ kind: 'video', size })
        else if (!read) loadImage(found, size)
      } catch {
        if (open && mine === epoch) drop(true)
      } finally {
        pending = false
        // A retry asked while this lookup, started before the failure, was out.
        if (open && !gone && mine !== epoch) lookup()
        else if (open && !gone) {
          polling = setTimer(() => {
            polling = null
            lookup()
          }, 15000)
        }
      }
    }

    return entry
  }

  function watch ({ identity, author, seq }, listener) {
    const key = identity + ':' + author + ':' + seq
    let entry = entries.get(key)
    const first = !entry
    if (first) {
      entry = createEntry(author, seq)
      entries.set(key, entry)
    }
    const receive = (state) => listener(state)
    entry.listeners.add(receive)
    if (entry.state) receive(entry.state)
    if (first) entry.lookup()
    else entry.retry()
    return () => {
      if (!entry.listeners.delete(receive)) return
      if (entry.listeners.size === 0) {
        entry.close()
        entries.delete(key)
      }
    }
  }

  return { watch }
}

export function sharedPreviews (request, media, deps) {
  let cached = stores.get(request)
  if (!cached || cached.media !== media) {
    cached = { media, store: createMomentPreviews({ ...deps, request, media }) }
    stores.set(request, cached)
  }
  return cached.store
}
