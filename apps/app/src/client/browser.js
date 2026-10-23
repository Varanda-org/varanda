/* global document */

// Web, browser node: the node runs in this page. Its code is not in the app
// bundle (Metro blocks packages/core and packages/web-member): it is the
// separate script /varanda-node.js (packages/web-member/scripts/build.js
// --node, written to public/ by `npm run build:node`), loaded once on
// demand, which defines VarandaWebNode. The node keeps the member's key in
// IndexedDB and syncs only through the seeder whose address the person
// typed in Conectar.
//
// The client side is the same @varanda/rpc createClient the other web and
// native clients use, wired in memory: each envelope crosses as JSON text,
// parsed with parseMessage and its limits, on a microtask, exactly as it
// would over the varanda-serve WebSocket. No token: the channel never leaves
// the page (docs/rpc.md section 11, as the in-app IPC).

import { createClient, parseMessage, EVENTS, MAX_MESSAGE } from '@varanda/rpc'

const NODE_SCRIPT = '/varanda-node.js'

let loading = null

function fail (message) {
  const err = new Error(message)
  err.code = 'CLOSED'
  return err
}

function loaded () {
  const api = globalThis.VarandaWebNode
  return api && api.version === 1 && typeof api.start === 'function' ? api : null
}

// -> Promise<VarandaWebNode>; a failed load is retried by the next call.
function loadNode () {
  const api = loaded()
  if (api !== null) return Promise.resolve(api)
  if (loading !== null) return loading
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = NODE_SCRIPT
    script.async = true
    script.onload = () => {
      const ready = loaded()
      if (ready !== null) resolve(ready)
      else reject(fail('o nó do navegador não carregou'))
    }
    script.onerror = () => {
      script.remove()
      reject(fail('não foi possível carregar o nó do navegador'))
    }
    document.head.appendChild(script)
  })
  loading.catch(() => { loading = null })
  return loading
}

// config: { association, seederUrl } (src/config.js checkWebForm).
// -> { request(method, params), close(), kind } after session.open.
// onClose({ code }) is called if the node ends the connection on its own
// (never after close()).
export async function connectBrowserNode (config, { onEvent, onClose } = {}) {
  if (config === null || typeof config !== 'object') throw fail('informe a associação e o endereço do semeador')
  const api = await loadNode()
  const node = await api.start({ association: config.association, seederUrl: config.seederUrl })
  let deliberate = false
  let port = null
  const client = createClient({
    send: (message, text) => queueMicrotask(() => { if (port !== null) port.receive(text) })
  })
  if (typeof onEvent === 'function') {
    for (const name of EVENTS) client.on(name, (data) => onEvent(name, data))
  }
  port = node.connect((text) => queueMicrotask(() => {
    const parsed = parseMessage(text, MAX_MESSAGE)
    if (parsed.ok) client.receive(parsed.value)
  }), {
    onClose: () => {
      client.close()
      if (!deliberate && typeof onClose === 'function') onClose({ code: 'closed' })
    }
  })
  const close = async () => {
    deliberate = true
    client.close()
    port.close()
    await node.close()
  }
  try {
    await client.request('session.open', {})
  } catch (err) {
    await close()
    throw err
  }
  return {
    kind: 'browser',
    request: (method, params = {}) => client.request(method, params),
    close
  }
}
