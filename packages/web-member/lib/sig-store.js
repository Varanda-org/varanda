'use strict'

// Keeps the digests of the signatures this device verified
// (@varanda/core/lib/verified loadDigests) in the node's storage, so a
// returning visit does not check every followed diary's certificate and
// username again in JavaScript.
//
// kv verifiedSigs = { v: 1, digests: hex }: at most verified.MAX_DIGESTS
// 32-byte digests, oldest first. A digest says only that a signature this
// device already checked was valid; it holds no key, name or text. A torn or
// foreign value reads as none. The digests are written a few seconds after
// the last new one and when the node closes; the last node to close in this
// process drops them from memory, so a later node starts from its own
// storage.

const verified = require('@varanda/core/lib/verified')

const KEY = 'verifiedSigs'
const SAVE_DELAY_MS = 3000

let open = 0

function noop () {}

function keepVerified (storage, { delayMs = SAVE_DELAY_MS } = {}) {
  open++
  let timer = null
  let closed = false
  let saving = Promise.resolve()

  // Recording starts now, so the checks made while the stored list loads
  // are kept too; loading adds to the set.
  verified.loadDigests('')
  const loaded = (async () => {
    let data = null
    try {
      data = await storage.readJson(KEY)
    } catch {}
    const ok = data !== null && typeof data === 'object' && data.v === 1 && typeof data.digests === 'string'
    verified.loadDigests(ok ? data.digests : '')
  })()

  function save () {
    timer = null
    // After this node's own list is in: saving earlier would replace it.
    saving = saving.then(() => loaded).then(() => storage.writeJson(KEY, { v: 1, digests: verified.exportDigests() })).catch(noop)
    return saving
  }

  const off = verified.onDigest(() => {
    if (closed || timer !== null) return
    timer = setTimeout(save, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
  })

  async function close () {
    if (closed) return
    closed = true
    off()
    await loaded
    if (timer !== null) {
      clearTimeout(timer)
      await save()
    }
    await saving
    if (--open === 0) verified.clearDigests()
  }

  return { loaded, close }
}

module.exports = { keepVerified, KEY }
