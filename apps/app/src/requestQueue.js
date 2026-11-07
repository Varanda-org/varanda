// Leave one RPC slot for sync controls while boot reads wait their turn.
export function createRequestQueue ({ maxInFlight = 7, maxWaiting = 24, bypass = ['sync.start', 'sync.stop', 'sync.status'] } = {}) {
  const immediate = new Set(bypass)
  const waiting = []
  let inFlight = 0

  function sendNow (method, params, send) {
    try {
      return Promise.resolve(send(method, params))
    } catch (err) {
      return Promise.reject(err)
    }
  }

  function drain () {
    while (inFlight < maxInFlight && waiting.length > 0) {
      const entry = waiting.shift()
      entry.detach()
      inFlight++
      sendNow(entry.method, entry.params, entry.send).then(
        (result) => {
          entry.resolve(result)
          settled()
        },
        (err) => {
          entry.reject(err)
          settled()
        }
      )
    }
  }

  function settled () {
    inFlight--
    drain()
  }

  function aborted () {
    return Object.assign(new Error('pedido cancelado'), { name: 'AbortError' })
  }

  function run (method, params, send, { signal } = {}) {
    if (signal && signal.aborted) return Promise.reject(aborted())
    if (immediate.has(method)) return sendNow(method, params, send)
    if (inFlight >= maxInFlight && waiting.length >= maxWaiting) {
      return Promise.reject(Object.assign(new Error('pedidos demais em andamento'), { code: 'USAGE' }))
    }
    return new Promise((resolve, reject) => {
      const entry = { method, params, send, resolve, reject, detach: () => {} }
      if (signal) {
        const abort = () => {
          const index = waiting.indexOf(entry)
          if (index === -1) return
          waiting.splice(index, 1)
          entry.detach()
          reject(aborted())
        }
        entry.detach = () => signal.removeEventListener('abort', abort)
        signal.addEventListener('abort', abort, { once: true })
      }
      waiting.push(entry)
      drain()
    })
  }

  function clear (reason) {
    for (const entry of waiting.splice(0)) {
      entry.detach()
      entry.reject(reason)
    }
  }

  return { run, clear }
}
