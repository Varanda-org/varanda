'use strict'

// Block 0 of a group root the node does not hold, read on demand over a
// short-lived seeder link of its own (docs/rpc.md 5.37): the pending
// group.join with a hint (standalone: true or a community) checks the hint
// against the root's header before writing anything, since the hint comes
// from the seeder's unauthenticated index (/index/group).
// The link is ./dm-link.js dial: a fresh WebSocket, a fresh ephemeral Noise
// key, an EMPTY inventory and no announce, the seeder's hello verified
// (role 'seeder', seederCertForKey) before any core is replicated, a frame
// guard and one deadline. The root's key IS the group key, so Hypercore
// verifies the block against G's signature: the seeder can withhold it or
// serve an older fork-0 history, never forge it. Nothing is stored: the core
// lives in memory and is closed, with the link, before this returns.

const Hypercore = require('hypercore')
const b4a = require('b4a')
const { dial } = require('./dm-link')
const { memoryStorage } = require('./storage')
const { PEEK_CORE_PAGE_SIZE, PEEK_MAX_FRAME } = require('./peek')

const HEX64 = /^[0-9a-f]{64}$/
const ROOT_UNREAD = 'bloco 0 do grupo indisponível'
const ROOT_PEEK_TIMEOUT_MS = 15000

function noop () {}

// -> the raw block 0 of root `key` (lowercase hex64), verified by Hypercore
// against the key. Throws Error(ROOT_UNREAD) when the seeder cannot be
// asked, does not answer within timeoutMs (one deadline for the link and
// the read) or serves a forked core.
async function peekGroupRoot ({ seederUrl, createSocket, association, key, timeoutMs = ROOT_PEEK_TIMEOUT_MS, log = noop }) {
  if (typeof key !== 'string' || !HEX64.test(key)) throw new Error(ROOT_UNREAD)
  const deadline = Date.now() + timeoutMs
  // Hypercore treats a timeout of 0 as none: never less than 1 ms.
  const left = () => Math.max(1, deadline - Date.now())
  let link
  try {
    link = await dial({ seederUrl, createSocket, association, log, connectTimeoutMs: left(), deadlineMs: left(), maxFrame: PEEK_MAX_FRAME, attach: noop })
  } catch {
    throw new Error(ROOT_UNREAD)
  }
  const q = new Hypercore(memoryStorage({ pageSize: PEEK_CORE_PAGE_SIZE }), b4a.from(key, 'hex'), { valueEncoding: 'binary' })
  try {
    await q.ready()
    q.replicate(link.noise)
    let raw = null
    try {
      raw = await q.get(0, { raw: true, timeout: left() })
    } catch {}
    if (raw === null || q.fork !== 0) throw new Error(ROOT_UNREAD)
    return raw
  } finally {
    link.noise.destroy()
    await q.close().catch(noop)
  }
}

module.exports = { peekGroupRoot, ROOT_UNREAD, ROOT_PEEK_TIMEOUT_MS }
