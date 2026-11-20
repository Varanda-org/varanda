'use strict'

// Route tests can control conversion without loading native code or spawning.
function createFakeOgTranscoder ({ avif = true, probe = async () => ({ avif }), now = Date.now, backoffMs = 1000, negativeEntries = 512, bytes = null, convert, calls = [] } = {}) {
  const known = new Set()
  const negative = new Set()
  let hostAvif = false
  let available = false
  let starting = null
  let retryAt = -Infinity
  let closed = false
  function refuse (hash) {
    negative.add(hash)
    while (negative.size > negativeEntries) negative.delete(negative.values().next().value)
  }
  async function ensure () {
    if (closed) return false
    if (available) return true
    if (starting) return starting
    if (now() < retryAt) return false
    starting = Promise.resolve().then(probe).catch(() => null).then((ready) => {
      available = !closed && !!ready
      avif = available && ready.avif === true
      hostAvif ||= avif
      if (!available) retryAt = now() + backoffMs
      return available
    })
    try { return await starting } finally { starting = null }
  }
  return {
    calls,
    async ready () { return { avif: await ensure() && avif } },
    avif () {
      if (!hostAvif) ensure().catch(() => {})
      return hostAvif
    },
    canDo (mime) {
      return !closed && available && (mime === 'image/avif' ? avif : ['image/jpeg', 'image/png', 'image/webp'].includes(mime))
    },
    known (hash) { return negative.has(hash) || known.has(hash) },
    refused (hash) { return negative.has(hash) },
    refuse,
    async transcode (input) {
      if (closed || negative.has(input.sha256) || !await ensure()) return null
      calls.push(input)
      const result = convert ? await convert(input) : bytes
      if (result) known.add(input.sha256)
      else refuse(input.sha256)
      return result
    },
    async close () { closed = true; known.clear(); negative.clear() }
  }
}

// Header-only JPEGs exercise the parent's shape checks without a decoder.
function jpegHeader (width, height) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9])
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return bytes
}

function runChild ({ report, mode, delay = 0, avif = true, once = false } = {}) {
  const fs = require('node:fs')
  // CoreFoundation adds this at process startup, even with env: {}.
  delete process.env.__CF_USER_TEXT_ENCODING
  const record = (data) => { if (report) fs.appendFileSync(report, JSON.stringify(data) + '\n') }
  record({ type: 'start', pid: process.pid, env: Object.keys(process.env).length, execArgv: process.execArgv })
  process.on('disconnect', () => process.exit(0))
  if (mode === 'init-hang') return
  if (mode === 'init-exit') return process.exit(1)
  process.on('message', (msg) => {
    record({ type: 'message', id: msg.id })
    if (mode === 'hang') return
    if (mode === 'exit') return process.exit(1)
    if (mode === 'disconnect') return process.disconnect()
    let bytes = jpegHeader(msg.width, msg.height)
    if (mode === 'over-cap') bytes = Buffer.concat([bytes, Buffer.alloc(262144)])
    if (mode === 'wrong-size') bytes = jpegHeader(1, 1)
    if (mode === 'wrong-magic') bytes[0] = 0
    if (mode === 'wrong-type') bytes = Array.from(bytes)
    if (mode === 'null') bytes = null
    if (once) mode = null
    setTimeout(() => {
      if (process.connected) process.send({ type: 'result', id: msg.id, bytes }, () => {})
    }, delay)
  })
  process.send({ type: 'ready', avif })
}

module.exports = { createFakeOgTranscoder, jpegHeader, runChild }
