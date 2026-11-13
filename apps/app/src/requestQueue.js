// Leave one RPC slot for sync controls while boot reads wait their turn.
export function createRequestQueue ({ maxInFlight = 7, maxWaiting = 24, bypass = ['sync.start', 'sync.stop', 'sync.status'], maxBackground = 2 } = {}) {
  const immediate = new Set(bypass)
  // Two lanes, each first in first out: hidden-tab warm reads wait in the
  // background lane so what the person is looking at starts first.
  const visibleWaiting = []
  const backgroundWaiting = []
  let inFlight = 0
  let backgroundInFlight = 0

  function sendNow (method, params, send) {
    try {
      return Promise.resolve(send(method, params))
    } catch (err) {
      return Promise.reject(err)
    }
  }

  function drain () {
    while (inFlight < maxInFlight) {
      let entry
      if (visibleWaiting.length > 0) entry = visibleWaiting.shift()
      else if (backgroundWaiting.length > 0 && backgroundInFlight < maxBackground) entry = backgroundWaiting.shift()
      else break
      entry.detach()
      inFlight++
      if (entry.background) backgroundInFlight++
      sendNow(entry.method, entry.params, entry.send).then(
        (result) => {
          entry.resolve(result)
          settled(entry)
        },
        (err) => {
          entry.reject(err)
          settled(entry)
        }
      )
    }
  }

  function settled (entry) {
    inFlight--
    if (entry.background) backgroundInFlight--
    drain()
  }

  function aborted () {
    return Object.assign(new Error('pedido cancelado'), { name: 'AbortError' })
  }

  function run (method, params, send, { signal, priority = 'visible', token } = {}) {
    if (signal && signal.aborted) return Promise.reject(aborted())
    if (immediate.has(method)) return sendNow(method, params, send)
    const background = priority === 'background'
    // A background request also waits while its own lane is full, so the
    // waiting limit counts every request that cannot start now, of either
    // lane: a burst of hidden-tab reads cannot grow the backlog unbounded.
    const waits = inFlight >= maxInFlight ||
      (background && (backgroundInFlight >= maxBackground || visibleWaiting.length > 0 || backgroundWaiting.length > 0))
    if (waits && visibleWaiting.length + backgroundWaiting.length >= maxWaiting) {
      return Promise.reject(Object.assign(new Error('pedidos demais em andamento'), { code: 'USAGE' }))
    }
    return new Promise((resolve, reject) => {
      const entry = { method, params, send, resolve, reject, background, token, detach: () => {} }
      if (signal) {
        const abort = () => {
          const lane = entry.background ? backgroundWaiting : visibleWaiting
          const index = lane.indexOf(entry)
          if (index === -1) return
          lane.splice(index, 1)
          entry.detach()
          reject(aborted())
        }
        entry.detach = () => signal.removeEventListener('abort', abort)
        signal.addEventListener('abort', abort, { once: true })
      }
      ;(background ? backgroundWaiting : visibleWaiting).push(entry)
      drain()
    })
  }

  function clear (reason) {
    for (const entry of [...visibleWaiting.splice(0), ...backgroundWaiting.splice(0)]) {
      entry.detach()
      entry.reject(reason)
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
