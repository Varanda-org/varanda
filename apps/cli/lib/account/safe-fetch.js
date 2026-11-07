'use strict'

const https = require('node:https')
const dns = require('node:dns')
const net = require('node:net')

// Outbound fetches of the account service to hosts it does not run (the GIF
// provider of ./gif-routes.js, the pages of ./preview-routes.js), with the
// SSRF rules both share:
//
//   - only https targets the caller's `target` admits (exact hostnames,
//     never an IP literal: a literal would skip the lookup below);
//   - the name resolves only to public addresses, checked in the socket's
//     own lookup, so the address that is checked is the address dialled
//     and nothing resolves the name a second time;
//   - at most `maxRedirects` redirects, each one passing `target` and the
//     lookup again; one deadline for the whole exchange; a byte cap; an
//     optional list of allowed content types;
//   - requests carry a fixed User-Agent and Accept and nothing else: no
//     cookie, credentials, Referer, forwarded address or member identity.
//
// `request`, `lookup` and `allowAddress` are replaced only by tests, through
// the constructor, to reach a loopback fixture. Nothing here reads the
// environment.

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

function isHostname (host) {
  return typeof host === 'string' && host.length <= 253 && HOST_RE.test(host) && net.isIP(host) === 0
}

function v4Public (ip) {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = p
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false
  return true
}

// The 8 hextets of an IPv6 literal (embedded IPv4 folded in), or null.
function v6Hextets (ip) {
  let text = ip.toLowerCase()
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  const tail = text.match(/:(\d+\.\d+\.\d+\.\d+)$/)
  if (tail) {
    const p = tail[1].split('.').map(Number)
    text = text.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  if (fill < 0) return null
  const all = [...head, ...new Array(fill).fill('0'), ...rest].map((h) => parseInt(h, 16))
  if (all.length !== 8 || all.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null
  return all
}

// Refuses loopback, private, link-local, CGNAT, multicast, reserved and
// documentation ranges, IPv6 ULA, link-local and site-local, and every
// IPv6 form that can carry an IPv4 address (IPv4-mapped, IPv4-compatible,
// IPv4-translated, NAT64, 6to4, Teredo): a public host never needs them,
// and each can route to an internal IPv4 address.
function publicAddress (ip) {
  const family = net.isIP(ip)
  if (family === 4) return v4Public(ip)
  if (family !== 6) return false
  const h = v6Hextets(ip)
  if (h === null) return false
  if (h.slice(0, 6).every((n) => n === 0)) return false // ::, ::1 and ::/96
  if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) {
    return v4Public([h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join('.'))
  }
  if (h.slice(0, 4).every((n) => n === 0) && h[4] === 0xffff && h[5] === 0) return false // IPv4-translated ::ffff:0:0:0/96
  if ((h[0] & 0xfe00) === 0xfc00) return false
  if ((h[0] & 0xffc0) === 0xfe80) return false
  if ((h[0] & 0xffc0) === 0xfec0) return false
  if ((h[0] & 0xff00) === 0xff00) return false
  if (h[0] === 0x64 && h[1] === 0xff9b) return false // 64:ff9b::/96 and 64:ff9b:1::/48
  if (h[0] === 0x2001 && h[1] === 0x0db8) return false
  if (h[0] === 0x2002) return false
  if (h[0] === 0x2001 && h[1] === 0) return false
  return true
}

// A net lookup that only ever answers addresses `allowAddress` admits:
// every address of the name must pass, or the socket never opens.
function guardedLookup (baseLookup, allowAddress) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') {
      cb = options
      options = {}
    }
    const opts = typeof options === 'number' ? { family: options } : (options || {})
    baseLookup(hostname, { all: true, family: opts.family || 0 }, (err, addrs) => {
      if (err) return cb(err)
      const list = Array.isArray(addrs) ? addrs : []
      if (list.length === 0 || list.some((a) => !a || !allowAddress(a.address))) {
        const blocked = new Error('endereço recusado')
        blocked.code = 'EBLOCKED'
        return cb(blocked)
      }
      if (opts.all) return cb(null, list)
      cb(null, list[0].address, list[0].family)
    })
  }
}

// The default target: an https URL on port 443 whose host is a dotted
// hostname (no IP literal, no single label that a resolver search list
// could turn into an internal name), with no user or password.
function httpsTarget (href) {
  let url
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null
  const host = url.hostname.toLowerCase()
  if (!isHostname(host) || !host.includes('.')) return null
  return { hostname: host, port: 443, path: url.pathname + url.search, href: url.href }
}

// The media type of a Content-Type header, lower case, or ''.
function mediaType (header) {
  if (typeof header !== 'string') return ''
  return header.split(';')[0].trim().toLowerCase()
}

// -> fetch(href, { cap, accept, types, plain }) resolving { body, type, url }
// (`url` the final URL after redirects) or rejecting with no detail.
// `types` (null: any) lists the media types the response may declare;
// `plain` refuses a response with a Content-Encoding other than identity.
function createSafeFetch ({
  request = https.request,
  lookup = dns.lookup,
  allowAddress = publicAddress,
  target = httpsTarget,
  userAgent,
  deadlineMs,
  maxRedirects = 3
}) {
  const socketLookup = guardedLookup(lookup, allowAddress)

  return function safeFetch (href, { cap, accept, types = null, plain = false }) {
    return new Promise((resolve, reject) => {
      let done = false
      let current = null
      const finish = (err, value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (current) current.destroy()
        if (err) reject(err)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(new Error('prazo')), deadlineMs)
      const hop = (location, left) => {
        const t = target(location)
        if (t === null) return finish(new Error('destino'))
        let req
        try {
          req = request({
            hostname: t.hostname,
            port: t.port,
            path: t.path,
            method: 'GET',
            agent: false,
            lookup: socketLookup,
            headers: { 'User-Agent': userAgent, Accept: accept }
          })
        } catch {
          return finish(new Error('pedido'))
        }
        current = req
        req.on('error', () => finish(new Error('rede')))
        req.on('response', (res) => {
          const status = res.statusCode
          if (status >= 300 && status < 400 && res.headers.location !== undefined) {
            res.resume()
            if (left < 1) return finish(new Error('redirecionamentos'))
            let next
            try {
              next = new URL(res.headers.location, t.href).href
            } catch {
              return finish(new Error('destino'))
            }
            current = null
            req.destroy()
            return hop(next, left - 1)
          }
          if (status !== 200) {
            res.resume()
            return finish(new Error('status'))
          }
          const type = mediaType(res.headers['content-type'])
          if (types !== null && !types.includes(type)) return finish(new Error('tipo'))
          const encoding = res.headers['content-encoding']
          if (plain && encoding !== undefined && String(encoding).trim().toLowerCase() !== 'identity') return finish(new Error('codificacao'))
          const declared = Number(res.headers['content-length'])
          if (Number.isFinite(declared) && declared > cap) return finish(new Error('grande'))
          const chunks = []
          let size = 0
          res.on('data', (chunk) => {
            size += chunk.length
            if (size > cap) return finish(new Error('grande'))
            chunks.push(chunk)
          })
          res.on('error', () => finish(new Error('rede')))
          res.on('aborted', () => finish(new Error('rede')))
          res.on('end', () => {
            current = null
            finish(null, { body: Buffer.concat(chunks), type, url: t.href })
          })
        })
        req.end()
      }
      hop(href, maxRedirects)
    })
  }
}

module.exports = {
  isHostname,
  publicAddress,
  guardedLookup,
  httpsTarget,
  mediaType,
  createSafeFetch
}
