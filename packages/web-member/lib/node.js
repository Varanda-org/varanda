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
// A second connect() replaces the first (its port is closed and its onClose
// called, as when another varanda-serve socket takes over). node.close()
// closes the session (any sync stopped and awaited) and then the storage.
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
    get state () {
      return session.state
    }
  }
}

module.exports = { createBrowserNode }
