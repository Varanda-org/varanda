'use strict'

// A bounded fetch for the worklet: Bare has no globalThis.fetch, and the
// browser node downloads group and DM media through one. Only what those
// callers use: GET or HEAD, https (plain http only to a loopback host), no
// redirects followed, no cookies, credentials, referrer or cache. Written
// against the Node-compatible request API, so bare-http1 / bare-https in the
// worklet and Node's http / https in tests.

const MAX_BUFFERED = 16 * 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

function fetchError (message) {
  return new TypeError(message)
}

function headerBag (raw) {
  return {
    get (name) {
      if (typeof name !== 'string' || raw === null || typeof raw !== 'object') return null
      const key = name.toLowerCase()
      if (!Object.prototype.hasOwnProperty.call(raw, key)) return null
      const v = raw[key]
      if (v === undefined || v === null) return null
      return Array.isArray(v) ? v.join(', ') : String(v)
    }
  }
}

function createBareFetch ({ http, https, timeoutMs = 30000, idleMs = 10000 } = {}) {
  return function fetch (input, options = {}) {
    return new Promise((resolve, reject) => {
      const method = String((options && options.method) || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') return reject(fetchError('method not allowed'))
      let url
      try {
        url = new URL(String(input))
      } catch {
        return reject(fetchError('invalid url'))
      }
      if (url.username !== '' || url.password !== '') return reject(fetchError('credentials not allowed'))
      let mod = null
      if (url.protocol === 'https:') mod = https
      else if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) mod = http
      if (mod === null) return reject(fetchError('url not allowed'))
      if (!mod || typeof mod.request !== 'function') return reject(fetchError('fetch is not available'))

      let settled = false
      let finished = false
      let req = null
      let res = null
      let overall = null
      let idle = null
      // The body reader's state: chunks waiting, one pending read, the end.
      const queue = []
      let waiter = null
      let ended = false
      let failure = null

      const clearTimers = () => {
        if (overall !== null) clearTimeout(overall)
        if (idle !== null) clearTimeout(idle)
        overall = null
        idle = null
      }
      const finish = (err) => {
        if (finished) return
        finished = true
        clearTimers()
        if (err) failure = err
        else ended = true
        if (err) {
          try { if (res !== null) res.destroy() } catch {}
          try { if (req !== null) req.destroy() } catch {}
        }
        if (!settled) {
          settled = true
          reject(err || fetchError('no response'))
        }
        if (waiter !== null) {
          const w = waiter
          waiter = null
          if (err) w.reject(err)
          else w.resolve({ done: true, value: undefined })
        }
      }
      const touch = () => {
        if (finished) return
        if (idle !== null) clearTimeout(idle)
        idle = setTimeout(() => finish(fetchError('idle timeout')), idleMs)
      }
      overall = setTimeout(() => finish(fetchError('timeout')), timeoutMs)
      touch()

      const read = () => {
        if (queue.length > 0) {
          const value = queue.shift()
          if (queue.length === 0 && !finished && res !== null) res.resume()
          return Promise.resolve({ done: false, value })
        }
        if (failure !== null) return Promise.reject(failure)
        if (ended) return Promise.resolve({ done: true, value: undefined })
        if (waiter !== null) return Promise.reject(fetchError('read already pending'))
        return new Promise((resolve, reject) => {
          waiter = { resolve, reject }
          if (res !== null) res.resume()
        })
      }
      const cancel = () => {
        queue.length = 0
        if (!finished) finish(fetchError('cancelled'))
        return Promise.resolve()
      }
      let locked = false
      const body = {
        getReader () {
          if (locked) throw fetchError('body already used')
          locked = true
          return { read, cancel, releaseLock () {} }
        },
        cancel
      }
      const arrayBuffer = async () => {
        const reader = body.getReader()
        const declared = Number(headers.get('content-length'))
        if (Number.isFinite(declared) && declared > MAX_BUFFERED) {
          await cancel()
          throw fetchError('body too large')
        }
        const parts = []
        let n = 0
        for (;;) {
          const step = await reader.read()
          if (step.done) break
          n += step.value.byteLength
          if (n > MAX_BUFFERED) {
            await cancel()
            throw fetchError('body too large')
          }
          parts.push(step.value)
        }
        const out = new Uint8Array(n)
        let at = 0
        for (const p of parts) {
          out.set(p, at)
          at += p.byteLength
        }
        return out.buffer
      }
      let headers = headerBag(null)

      try {
        req = mod.request(url.href, { method, headers: {} }, (response) => {
          res = response
          touch()
          headers = headerBag(response.headers)
          response.on('data', (chunk) => {
            if (finished) return
            touch()
            const value = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            if (waiter !== null) {
              const w = waiter
              waiter = null
              w.resolve({ done: false, value })
            } else {
              queue.push(value)
              response.pause()
            }
          })
          response.on('end', () => finish(null))
          response.on('error', () => finish(fetchError('network error')))
          response.on('close', () => finish(fetchError('connection closed')))
          // Nothing flows until the body is read.
          response.pause()
          if (settled) return
          settled = true
          const status = response.statusCode
          resolve({
            status,
            ok: status >= 200 && status < 300,
            redirected: false,
            url: url.href,
            headers,
            body,
            arrayBuffer
          })
        })
        req.on('error', () => finish(fetchError('network error')))
        req.end()
      } catch {
        finish(fetchError('network error'))
      }
    })
  }
}

module.exports = { createBareFetch, MAX_BUFFERED }
