// The browser node: a ./session.js session over a storage, served to ONE
// client at a time through @varanda/rpc's createServerDispatcher, in memory.
// There is no network RPC: the page's UI (apps/app, src/client/browser.js)
// holds the createClient side and the two exchange JSON text exactly as the
// varanda-serve WebSocket does (one text per envelope, parsed with
// parseMessage and its limits), so neither side ever shares an object with
// the other. Like the in-app IPC, the dispatcher has no token (token: null):
// the channel never leaves the page.
//
//   const node = createBrowserNode({ storage, association, seederUrl, createSocket })
//   const port = node.connect((text) => ..., { onClose })  // outgoing envelopes
//   port.receive(text)                                    // one incoming envelope
//   port.close(); await node.close()
//
// The identity key (./session.js host controls, all serialized with the
// RPC handlers; none is reachable over the channel):
//   await node.setKeyPair({ publicKey, secretKey }, { media })  // unlock, in memory only;
//                                // media: this device's media core pair (optional)
//   await node.clearKeyPair()    // lock (both pairs zero-filled)
//   await node.identityStatus()  // { exists, publicKey, legacy, unlocked, synced }
//   await node.reset()           // delete the diary, the media cores and the pending
//                                // follows, and lock; config and follows stay
//   await node.mediaUpload({ bytes, mime, width, height, onProgress }) // -> descriptor
// Uploads are a host control, not an RPC method: one request on the channel
// is capped at 64 KiB (@varanda/rpc MAX_REQUEST) and an image is up to 8 MiB.
// The page hands the bytes straight to the session, which stores them in
// this device's media core and returns the descriptor a post then carries.
// Follows are local-first: follow.add / follow.remove (unlocked only)
// answer at once and the session appends the `follow` records itself
// (./session.js, the drain); the event follows.changed { count } tells the
// page the set changed from the diary (another device's follows folded in
// by the sync). The follows kept from before `follow` records existed are
// published only once the person confirms the list:
//   await node.legacyFollows()             // -> { keys } (unlocked only)
//   await node.confirmLegacyFollows(keys)  // -> { published }; the rest leave the list
//
// Engagement and on-demand reads (docs/rpc.md; no new host control): the
// session also serves like.set / repost.set / post.quote (diary writes on
// the post.reply path, idempotent toggles), engagement.read (the own
// diary's likes / reposts among the given refs; works locked) and
// diary.peek, which reads any admitted diary's requested blocks through
// the RUNNING sync (./session.js, ./sync.js): it never opens a storage
// core, stores nothing, and answers NOT_FOUND 'semeador indisponível' when
// no verified seeder link is reachable within PEEK_TIMEOUT_MS and NOT_FOUND
// 'diário indisponível' for a blocked, ungated or unknown author.
//
// A second connect() replaces the first (its port is closed and its onClose
// called, as when another varanda-serve socket takes over). node.close()
// closes the session (any sync stopped and awaited, the key zero-filled)
// and then the storage.
const { createServerDispatcher, parseMessage, MAX_REQUEST } = require('@varanda/rpc')
const { createBrowserSession } = require('./session')

function noop () {}

function createBrowserNode ({ storage, ...options } = {}) {
  const session = createBrowserSession({ storage, ...options })
  let current = null
  let closing = null

  function connect (send, { onClose = noop } = {}) {
    if (typeof send !== 'function') throw new TypeError('send required')
    if (closing !== null) throw new Error('nó encerrado')
    if (current !== null) current.close()
    let closed = false
    const dispatcher = createServerDispatcher({
      handlers: session.handlers,
      send: (message, text) => send(text),
      token: null,
      // A protocol error ends the connection (docs/rpc.md section 11).
      onProtocolError: () => port.close()
    })
    const port = {
      // One envelope as JSON text; anything that does not parse within the
      // request limit ends the connection, as on the WebSocket.
      receive (text) {
        if (closed) return
        const parsed = parseMessage(text, MAX_REQUEST)
        if (!parsed.ok) {
          port.close()
          return
        }
        dispatcher.receive(parsed.value)
      },
      close () {
        if (closed) return
        closed = true
        dispatcher.close()
        if (current === port) {
          current = null
          session.detach().catch(noop)
        }
        try { onClose() } catch {}
      },
      get closed () {
        return closed
      }
    }
    current = port
    session.attach((event, data) => dispatcher.emit(event, data))
    return port
  }

  function close () {
    if (closing !== null) return closing
    closing = (async () => {
      if (current !== null) current.close()
      await session.close()
      await storage.close()
    })()
    return closing
  }

  return {
    connect,
    close,
    setKeyPair: (keyPair, options) => session.setKeyPair(keyPair, options),
    clearKeyPair: () => session.clearKeyPair(),
    mediaUpload: (args) => session.mediaUpload(args),
    legacyFollows: () => session.legacyFollows(),
    confirmLegacyFollows: (keys) => session.confirmLegacyFollows(keys),
    identityStatus: () => session.identityStatus(),
    reset: () => session.reset(),
    get state () {
      return session.state
    }
  }
}

module.exports = { createBrowserNode }
