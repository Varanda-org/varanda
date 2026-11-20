// Budget against the RPC client's pending cap of 8 (packages/rpc limits.js):
// 5 reads in flight and 6 in all, so a sync control always has a slot of its
// own. On a native hosted connection the media calls also send one request
// each on that client (client/webnode.native.js, media.sharesClient), so
// src/node.js routes them through this queue there: media.read as a visible
// read, and the media writes (upload, putDm, putMoment) in the control lane,
// ahead of reads and never refused for capacity, still inside the total of 6.
// The two slots left outside the queue are a best-effort reserve, not a
// guarantee: they assume the direct connect-time sync.status and one identity
// request at a time. Each identity operation awaits its requests in turn, but
// two status() calls can overlap, and node.close is not counted at all.
export function createRequestQueue ({ maxInFlight = 5, maxWaiting = 24, bypass = ['sync.start', 'sync.stop', 'sync.status'], maxBackground = 2, maxTotal = 6 } = {}) {
  const immediate = new Set(bypass)
  // Three FIFO lanes. Sync controls (and any request run with priority
  // 'control') wait on their own and leave before visible reads; that lane
  // never refuses for capacity. Hidden-tab warm reads wait in the background
  // lane so what the person is looking at starts first.
  const controlWaiting = []
  const visibleWaiting = []
  const backgroundWaiting = []
  // inFlight counts ordinary and background requests. totalInFlight also
  // counts control-lane requests handed to send and not yet settled.
  let inFlight = 0
  let backgroundInFlight = 0
  let totalInFlight = 0

  function sendNow (method, params, send) {
    try {
      return Promise.resolve(send(method, params))
    } catch (err) {
      return Promise.reject(err)
    }
  }

  // Every rejection of an entry that was never handed to send carries
  // queued: true (see notSent).
  function aborted () {
    return Object.assign(new Error('pedido cancelado'), { name: 'AbortError', queued: true })
  }

  function laneOf (entry) {
    if (entry.control) return controlWaiting
    return entry.background ? backgroundWaiting : visibleWaiting
  }

  function watchAbort (entry, signal) {
    if (!signal) return
    const abort = () => {
      const lane = laneOf(entry)
      const index = lane.indexOf(entry)
      if (index === -1) return
      lane.splice(index, 1)
      entry.detach()
      entry.reject(aborted())
    }
    entry.detach = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
  }

  function launch (entry) {
    entry.detach()
    if (entry.gate && !entry.gate()) {
      entry.reject(aborted())
      return
    }
    totalInFlight++
    if (!entry.control) {
      inFlight++
      if (entry.background) backgroundInFlight++
    }
    sendNow(entry.method, entry.params, entry.send).then(
      (result) => {
        entry.resolve(result)
        finished(entry)
      },
      (err) => {
        entry.reject(err)
        finished(entry)
      }
    )
  }

  function finished (entry) {
    totalInFlight--
    if (!entry.control) {
      inFlight--
      if (entry.background) backgroundInFlight--
    }
    drain()
  }

  function drain () {
    // A freed slot serves the control lane before either read lane.
    while (controlWaiting.length > 0 && totalInFlight < maxTotal) {
      launch(controlWaiting.shift())
    }
    while (inFlight < maxInFlight && totalInFlight < maxTotal) {
      let entry
      if (visibleWaiting.length > 0) entry = visibleWaiting.shift()
      else if (backgroundWaiting.length > 0 && backgroundInFlight < maxBackground) entry = backgroundWaiting.shift()
      else break
      launch(entry)
    }
  }

  function run (method, params, send, { signal, gate, priority = 'visible', token } = {}) {
    if ((signal && signal.aborted) || (gate && !gate())) return Promise.reject(aborted())
    if (immediate.has(method) || priority === 'control') {
      return new Promise((resolve, reject) => {
        const entry = { method, params, send, resolve, reject, gate, control: true, detach: () => {} }
        watchAbort(entry, signal)
        controlWaiting.push(entry)
        drain()
      })
    }
    const background = priority === 'background'
    // A background request also waits while its own lane is full, so the
    // waiting limit counts every read that cannot start now, of either lane:
    // a burst of hidden-tab reads cannot grow the backlog unbounded. Queued
    // controls already own the total slots they will take.
    const blockedByTotal = totalInFlight + controlWaiting.length >= maxTotal
    const waits = inFlight >= maxInFlight || blockedByTotal ||
      (background && (backgroundInFlight >= maxBackground || visibleWaiting.length > 0 || backgroundWaiting.length > 0))
    if (waits && visibleWaiting.length + backgroundWaiting.length >= maxWaiting) {
      return Promise.reject(Object.assign(new Error('pedidos demais em andamento'), { code: 'USAGE' }))
    }
    return new Promise((resolve, reject) => {
      const entry = { method, params, send, resolve, reject, gate, background, token, detach: () => {} }
      watchAbort(entry, signal)
      ;(background ? backgroundWaiting : visibleWaiting).push(entry)
      drain()
    })
  }

  // Every waiter gets its own rejection built here, so the caller's reason is
  // never mutated (it may be frozen, or not an object at all). It keeps the
  // reason's message and own fields (code, name) and adds queued: true.
  function dropped (reason) {
    if (reason !== null && typeof reason === 'object') {
      const message = typeof reason.message === 'string' ? reason.message : 'pedido cancelado'
      return Object.assign(new Error(message, { cause: reason }), reason, { queued: true })
    }
    const message = reason === undefined || reason === null ? 'pedido cancelado' : String(reason)
    return Object.assign(new Error(message, { cause: reason }), { queued: true })
  }

  function clear (reason) {
    for (const entry of [...controlWaiting.splice(0), ...visibleWaiting.splice(0), ...backgroundWaiting.splice(0)]) {
      entry.detach()
      entry.reject(dropped(reason))
    }
  }

  // A tab that becomes visible moves its still-waiting read forward; the same
  // request is never sent twice, and one already in flight is left alone.
  function promote (token) {
    if (token === undefined) return false
    const index = backgroundWaiting.findIndex((entry) => entry.token === token)
    if (index === -1) return false
    const [entry] = backgroundWaiting.splice(index, 1)
    entry.background = false
    visibleWaiting.push(entry)
    drain()
    return true
  }

  return { run, clear, promote }
}

// A request dropped by clear() or aborted before it was handed to send never
// reached the node: callers written for a sent request treat it as not sent,
// not as a failed one.
export function notSent (err) {
  return err !== null && typeof err === 'object' && err.queued === true
}
