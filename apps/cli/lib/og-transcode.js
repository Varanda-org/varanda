'use strict'

// Native decoding stays in a child with no inherited secrets. This is crash
// and secret isolation, not an OS sandbox: the child has the same uid.

const path = require('node:path')
const { fork } = require('node:child_process')
const { createHash } = require('node:crypto')
const { mediaBounds, MAX_SHARE_COVER_BYTES, MAX_SHARE_COVER_SIDE } = require('@varanda/rpc')
const { stillImageSize } = require('@varanda/core/lib/still-image')

const MIMES = ['image/avif', 'image/jpeg', 'image/png', 'image/webp']
const MAX_INPUT_BYTES = 8 * 1024 * 1024

function needsTranscode (d) {
  if (!d || !MIMES.includes(d.mime)) return false
  const bytes = d.bytes instanceof Uint8Array ? d.bytes.byteLength : d.bytes
  return d.mime === 'image/avif' || bytes > MAX_SHARE_COVER_BYTES
}

function coverSize (width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null
  const scale = Math.min(1, MAX_SHARE_COVER_SIDE / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

function createOgTranscoder (opts = {}) {
  const childPath = opts.childPath || path.join(__dirname, 'og-transcode-child.js')
  const now = opts.now || Date.now
  const initMs = opts.initMs ?? 4000
  const requestMs = opts.requestMs ?? 4000
  const backoffMs = opts.backoffMs ?? 1000
  const cacheEntries = opts.cacheEntries ?? 64
  const cacheBytes = opts.cacheBytes ?? 16 * 1024 * 1024
  const negativeEntries = opts.negativeEntries ?? 512
  const cache = new Map()
  const negative = new Set()
  const jobs = new Map()
  const queue = []
  const processes = new Map()
  let usedBytes = 0
  let child = null
  let starting = null
  let finishInit = null
  let available = false
  let avif = false
  let hostAvif = false
  let retryAt = -Infinity
  let active = null
  let pending = null
  let nextId = 0
  let closed = false

  function refuse (hash) {
    negative.add(hash)
    while (negative.size > negativeEntries) negative.delete(negative.values().next().value)
  }

  function remember (key, hash, bytes) {
    if (bytes.length > cacheBytes || cacheEntries < 1) return
    cache.set(key, { hash, bytes: Buffer.from(bytes) })
    usedBytes += bytes.length
    while (cache.size > cacheEntries || usedBytes > cacheBytes) {
      const oldest = cache.keys().next().value
      usedBytes -= cache.get(oldest).bytes.length
      cache.delete(oldest)
    }
  }

  function settle (value) {
    if (!pending) return
    const p = pending
    pending = null
    clearTimeout(p.timer)
    p.resolve(value)
  }

  function drop (proc) {
    if (proc !== child) return
    child = null
    available = false
    avif = false
    retryAt = now() + backoffMs
    try { proc.kill('SIGKILL') } catch {}
    if (finishInit) finishInit(false)
    settle(null)
  }

  function spawn () {
    return new Promise((resolve) => {
      let proc
      try {
        proc = fork(childPath, [], {
          env: {},
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          serialization: 'advanced',
          execArgv: ['--max-old-space-size=256']
        })
      } catch {
        retryAt = now() + backoffMs
        resolve(false)
        return
      }
      child = proc
      processes.set(proc, new Promise((resolve) => proc.once('close', () => {
        processes.delete(proc)
        resolve()
      })))
      const timer = setTimeout(() => drop(proc), initMs)
      finishInit = (ok) => {
        clearTimeout(timer)
        finishInit = null
        available = ok
        resolve(ok)
      }
      proc.on('error', () => drop(proc))
      proc.on('exit', () => drop(proc))
      proc.on('disconnect', () => drop(proc))
      proc.on('message', (msg) => {
        if (proc !== child || !msg || typeof msg !== 'object') return
        if (finishInit) {
          if (msg.type !== 'ready' || typeof msg.avif !== 'boolean') return
          avif = msg.avif
          hostAvif ||= avif
          finishInit(true)
          return
        }
        if (!pending || msg.type !== 'result' || msg.id !== pending.id) return
        const bytes = msg.bytes
        const size = bytes instanceof Uint8Array && bytes.length <= MAX_SHARE_COVER_BYTES &&
          bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          ? stillImageSize(bytes, 'image/jpeg')
          : null
        if (!size || size.width !== active.input.width || size.height !== active.input.height) {
          refuse(active.hash)
          settle(null)
        } else {
          settle(Buffer.from(bytes))
        }
      })
    })
  }

  async function ensure () {
    if (closed) return false
    if (available) return true
    if (starting) return starting
    if (now() < retryAt) return false
    starting = spawn()
    try { return await starting } finally { starting = null }
  }

  async function run (job) {
    if (!await ensure() || closed || (job.input.mime === 'image/avif' && !avif)) return null
    const proc = child
    return new Promise((resolve) => {
      const id = ++nextId
      pending = { id, resolve, timer: setTimeout(() => drop(proc), requestMs) }
      try {
        proc.send({ type: 'transcode', id, ...job.input }, (err) => {
          if (err) drop(proc)
        })
      } catch {
        drop(proc)
      }
    })
  }

  function pump () {
    if (active || closed || queue.length === 0) return
    const job = queue.shift()
    active = job
    run(job).catch(() => null).then((bytes) => {
      if (bytes && !closed) remember(job.key, job.hash, bytes)
      jobs.delete(job.key)
      active = null
      job.resolve(bytes)
      pump()
    })
  }

  function transcode (input) {
    try {
      if (closed || !input || !MIMES.includes(input.mime)) return Promise.resolve(null)
      const { bytes, mime, sha256, srcWidth, srcHeight } = input
      if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_INPUT_BYTES) return Promise.resolve(null)
      if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return Promise.resolve(null)
      if (createHash('sha256').update(bytes).digest('hex') !== sha256 || negative.has(sha256)) return Promise.resolve(null)
      const bounds = mediaBounds(bytes, mime)
      if (!bounds || bounds.frames !== 1) {
        refuse(sha256)
        return Promise.resolve(null)
      }
      const size = coverSize(srcWidth, srcHeight)
      if (!size || bounds.width !== srcWidth || bounds.height !== srcHeight ||
        (input.width !== undefined && input.width !== size.width) ||
        (input.height !== undefined && input.height !== size.height)) return Promise.resolve(null)
      const key = sha256 + ':' + size.width + 'x' + size.height
      const hit = cache.get(key)
      if (hit) {
        cache.delete(key)
        cache.set(key, hit)
        return Promise.resolve(Buffer.from(hit.bytes))
      }
      if (jobs.has(key)) return jobs.get(key).then((bytes) => bytes && Buffer.from(bytes))
      if (active && queue.length >= 4) return Promise.resolve(null)
      let finish
      const promise = new Promise((resolve) => { finish = resolve })
      jobs.set(key, promise)
      queue.push({
        key,
        hash: sha256,
        resolve: finish,
        input: { bytes: Buffer.from(bytes), mime, srcWidth, srcHeight, ...size }
      })
      pump()
      return promise.then((bytes) => bytes && Buffer.from(bytes))
    } catch {
      return Promise.resolve(null)
    }
  }

  async function close () {
    closed = true
    if (child) drop(child)
    for (const job of queue.splice(0)) job.resolve(null)
    jobs.clear()
    cache.clear()
    negative.clear()
    usedBytes = 0
    await Promise.all(processes.values())
  }

  return {
    async ready () { return { avif: await ensure() && avif } },
    avif () {
      // Pages only name /capa while a child is up, so a page render is also
      // what brings back a child that died after a good self-test.
      if (!available) ensure().catch(() => {})
      return hostAvif
    },
    canDo (mime) { return !closed && available && MIMES.includes(mime) && (mime !== 'image/avif' || avif) },
    known (hash) { return negative.has(hash) || Array.from(cache.values()).some((entry) => entry.hash === hash) },
    refused (hash) { return negative.has(hash) },
    refuse,
    transcode,
    close
  }
}

module.exports = { createOgTranscoder, needsTranscode, coverSize }
