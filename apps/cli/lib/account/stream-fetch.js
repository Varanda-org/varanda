'use strict'

const https = require('node:https')
const dns = require('node:dns')
const { publicAddress, guardedLookup, httpsTarget, mediaType } = require('./safe-fetch')

// A streaming GET for the account service, beside ./safe-fetch.js (which
// buffers the whole body and accepts only 200). Audio is relayed as it
// arrives, with a Range, so this one hands back the open response instead.
// The SSRF rules are the same:
//
//   - the first hop passes the caller's `firstTarget`, every redirect passes
//     `nextTarget` (by default https, port 443, a dotted hostname, no IP
//     literal, no credentials), and each one resolves through the guarded
//     lookup in the socket itself, so the address checked is the address
//     dialled;
//   - `firstHeaders` (where an API key rides) go on the first hop only: a
//     redirect may point anywhere the target admits, and the key must not
//     follow it there;
//   - every hop carries User-Agent, Accept and a well formed Range, nothing
//     else: no cookie, credentials, Referer, forwarded address or member
//     identity;
//   - one deadline up to the final response headers; after that the body is
//     bounded by `pipeCapped`, or by `readCapped` and the caller's deadline.
//
// `request`, `lookup` and `allowAddress` are replaced only by tests, to
// reach a loopback fixture. Nothing here reads the environment.

const RANGE_RE = /^bytes=(\d{1,12})-(\d{0,12})$/
const FIXED = new Set(['user-agent', 'accept', 'range', 'host'])
const DEFAULT_CONNECT_MS = 10000

// -> null or { start, end } (end null for an open range).
function parseRange (header) {
  if (typeof header !== 'string') return null
  const m = header.match(RANGE_RE)
  if (m === null) return null
  const start = Number(m[1])
  const end = m[2] === '' ? null : Number(m[2])
  if (end !== null && start > end) return null
  return { start, end }
}

function hopHeaders ({ userAgent, accept, range, extra }) {
  const headers = {}
  for (const key of Object.keys(extra)) {
    if (!FIXED.has(key.toLowerCase())) headers[key] = extra[key]
  }
  headers['User-Agent'] = userAgent
  headers.Accept = accept
  if (parseRange(range) !== null) headers.Range = range
  return headers
}

// -> open(href, { firstHeaders, range, accept, connectMs }) resolving
// { status, headers, type, url, stream, destroy } (`url` the final URL,
// `stream` the response body) or rejecting with a short token. A rejection
// for an error status ('status') also carries the `status` number and, for a
// 416, `contentRange` (the header as sent, or null): the caller tells a
// missing item or a range past the end from an outage by it.
function createStreamFetch ({
  request = https.request,
  lookup = dns.lookup,
  allowAddress = publicAddress,
  firstTarget,
  nextTarget = httpsTarget,
  userAgent,
  maxRedirects = 3
}) {
  if (typeof firstTarget !== 'function') throw new TypeError('firstTarget')
  const socketLookup = guardedLookup(lookup, allowAddress)

  return function open (href, { firstHeaders = {}, range = null, accept, connectMs = DEFAULT_CONNECT_MS } = {}) {
    return new Promise((resolve, reject) => {
      let done = false
      let current = null
      const fail = (token, extra) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (current) current.destroy()
        current = null
        reject(Object.assign(new Error(token), extra))
      }
      const timer = setTimeout(() => fail('prazo'), connectMs)
      const hop = (location, left, first) => {
        const t = first ? firstTarget(location) : nextTarget(location)
        if (!t) return fail('destino')
        let req
        try {
          req = request({
            hostname: t.hostname,
            port: t.port,
            path: t.path,
            method: 'GET',
            agent: false,
            lookup: socketLookup,
            headers: hopHeaders({ userAgent, accept, range, extra: first ? firstHeaders : {} })
          })
        } catch {
          return fail('pedido')
        }
        current = req
        req.on('error', () => fail('rede'))
        req.on('response', (res) => {
          // A late reset on a body nobody reads yet must not crash the process.
          res.on('error', () => {})
          if (done) return res.destroy()
          const status = res.statusCode
          if (status >= 300 && status < 400 && res.headers.location !== undefined) {
            res.resume()
            if (left < 1) return fail('redirecionamentos')
            let next
            try {
              next = new URL(res.headers.location, t.href).href
            } catch {
              return fail('destino')
            }
            current = null
            req.destroy()
            return hop(next, left - 1, false)
          }
          if (status !== 200 && status !== 206) {
            res.resume()
            const extra = { status }
            if (status === 416) {
              const cr = res.headers['content-range']
              extra.contentRange = typeof cr === 'string' ? cr : null
            }
            return fail('status', extra)
          }
          done = true
          clearTimeout(timer)
          resolve({
            status,
            headers: res.headers,
            type: mediaType(res.headers['content-type']),
            url: t.href,
            stream: res,
            destroy () {
              res.destroy()
              req.destroy()
            }
          })
        })
        req.end()
      }
      hop(href, maxRedirects, true)
    })
  }
}

// The whole body as one Buffer, or a rejection once it passes `cap` bytes,
// errors or closes early. It has no deadline of its own: a body that trickles
// stays open until the caller destroys the stream, so every caller owns one
// (as audius-routes' providerJson does).
function readCapped (stream, cap) {
  return new Promise((resolve, reject) => {
    let done = false
    let size = 0
    const chunks = []
    const finish = (err, value) => {
      if (done) return
      done = true
      if (err) {
        stream.destroy()
        reject(err)
      } else {
        resolve(value)
      }
    }
    stream.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > cap) return finish(new Error('grande'))
      chunks.push(chunk)
    })
    stream.on('end', () => finish(null, Buffer.concat(chunks)))
    stream.on('error', () => finish(new Error('rede')))
    stream.on('aborted', () => finish(new Error('rede')))
    stream.on('close', () => finish(new Error('rede')))
    // A stream torn down before these listeners existed emits nothing more,
    // and the promise would never settle, holding the caller's slot.
    if (stream.destroyed || stream.errored) finish(new Error('rede'))
  })
}

// Relays `stream` into `res` with backpressure, after discarding the first
// `skip` bytes, and stops when `cap` bytes have passed, when no byte moved
// for `stallMs`, after `totalMs`, or when either side closes or errors.
// `size` is the body length `res` declared in Content-Length, or null.
//
// At the upstream's end, or at a cap equal to `size`, the body is complete
// and `res` is ended, unless `size` is set and the bytes sent differ from it:
// an upstream that ends short of the declared length is a cut too ('upstream'),
// since Node does not enforce Content-Length and an ended short body would
// leave a keep-alive socket where the next response reads as its rest. An
// upstream that errors, aborts or closes before its end is an 'upstream' cut
// as well, and any other cap is a 'cap' cut. In every cut what was written is
// flushed and `res` is destroyed without end(), so a chunked body lacks its
// terminating chunk and a sized one is short, and the client never takes a
// cut for a whole body. The upstream is destroyed as soon as the outcome is
// decided, but `res` stays guarded until it has flushed: the total deadline stays armed
// and a flush deadline of `stallMs` starts, so a client that stops reading
// cannot hold the socket past them.
//
// `onDone(reason, bytes, skipped)` runs exactly once, after `res` finished,
// closed or was destroyed, so a caller's slot covers the socket's whole life.
// `bytes` is what reached `res`, `skipped` what was discarded of `skip`.
// reason is 'end', 'cap', 'stall' (no progress, or the flush deadline),
// 'total', 'upstream' or 'client'.
function pipeCapped (stream, res, { skip = 0, cap, size = null, stallMs, totalMs, onDone = () => {} }) {
  // 'relay' while bytes move, 'flush' once the outcome is decided and only
  // the client side is left, 'stop' while tearing down (destroy may emit
  // synchronously), 'done' after onDone.
  let phase = 'relay'
  let decided = null
  let skipped = 0
  let bytes = 0
  // Writes not yet handed to the socket; a short end waits for them.
  let unflushed = 0
  let stallTimer = null
  const totalTimer = setTimeout(() => stop('total'), totalMs)

  const armStall = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stop('stall'), stallMs)
  }

  // Every socket is torn down or finished before onDone runs, so a throwing
  // callback cannot leave one open.
  function report (reason) {
    if (phase === 'done') return
    phase = 'done'
    clearTimeout(stallTimer)
    clearTimeout(totalTimer)
    onDone(reason, bytes, skipped)
  }

  function stop (reason) {
    if (phase === 'stop' || phase === 'done') return
    phase = 'stop'
    stream.destroy()
    res.destroy()
    report(reason)
  }

  function decide (reason) {
    phase = 'flush'
    decided = reason
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => stop('stall'), stallMs)
    stream.destroy()
  }

  // A write callback runs once that write and every earlier one left.
  const flushed = () => {
    unflushed--
    if (unflushed === 0 && phase === 'flush' && decided === 'upstream') stop('upstream')
  }

  const onDrain = () => {
    if (phase !== 'relay') return
    armStall()
    stream.resume()
  }

  stream.on('data', (chunk) => {
    if (phase !== 'relay') return
    if (skipped < skip) {
      const drop = Math.min(skip - skipped, chunk.length)
      skipped += drop
      chunk = chunk.subarray(drop)
      armStall()
      if (chunk.length === 0) return
    }
    const room = cap - bytes
    if (chunk.length >= room) {
      const tail = room > 0 ? chunk.subarray(0, room) : null
      if (tail !== null) bytes += room
      decide('cap')
      if (cap === size) {
        if (tail !== null) res.end(tail)
        else res.end()
        return
      }
      // A write callback runs once that write and every earlier one left.
      const cut = () => {
        if (phase === 'flush') stop('cap')
      }
      if (tail !== null) res.write(tail, cut)
      else cut()
      return
    }
    bytes += chunk.length
    armStall()
    unflushed++
    if (!res.write(chunk, flushed)) {
      stream.pause()
      res.once('drain', onDrain)
    }
  })
  // A cut by the upstream: what was already written still reaches the
  // client, then `res` is destroyed unended.
  const upstreamCut = () => {
    decide('upstream')
    if (unflushed === 0) stop('upstream')
  }
  stream.on('end', () => {
    if (phase !== 'relay') return
    if (size === null || bytes === size) {
      decide('end')
      res.end()
      return
    }
    upstreamCut()
  })
  const upstreamGone = () => {
    if (phase === 'relay') upstreamCut()
  }
  stream.on('error', upstreamGone)
  stream.on('aborted', upstreamGone)
  stream.on('close', upstreamGone)
  res.on('finish', () => {
    if (phase === 'flush') report(decided)
  })
  const clientGone = () => {
    if (phase === 'relay') return stop('client')
    if (phase === 'flush') stop(decided)
  }
  res.on('error', clientGone)
  res.on('close', clientGone)
  armStall()
}

module.exports = {
  createStreamFetch,
  parseRange,
  readCapped,
  pipeCapped
}
