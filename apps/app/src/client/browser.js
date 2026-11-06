/* global document */

// Web, browser node: the node runs in this page. Its code is not in the app
// bundle (Metro blocks packages/core and packages/web-member): it is the
// separate script /varanda-node.js (packages/web-member/scripts/build.js
// --node, written to public/ by `npm run build:node`), loaded once on
// demand, which defines VarandaWebNode. The node keeps the diary in
// IndexedDB but never its secret key: the member's key is derived from the
// passkey (WebAuthn PRF) on 'entrar' and lives only in the page's memory,
// through the handle's `identity` API (status, unlock, complete, lock,
// signOut, reset; status carries `resumed`), and its `media` API uploads
// photos (media.upload, media.putDm) and opens chat photos (media.read).
// It syncs only through the seeder whose address comes from the
// installation's /varanda.json (the page's own origin) or from Conectar.
//
// The client side is the same @varanda/rpc createClient the other web and
// native clients use, wired in memory: each envelope crosses as JSON text,
// parsed with parseMessage and its limits, on a microtask, exactly as it
// would over the varanda-serve WebSocket. No token: the channel never leaves
// the page (docs/rpc.md section 11, as the in-app IPC).

import { createClient, parseMessage, EVENTS, MAX_MESSAGE, mediaBounds } from '@varanda/rpc'

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

// The node's media facade in the native handle's shape
// (./webnode.native.js), so screens see one API: upload, putDm and
// read(ref) -> { bytes, mime, w, h } (the native handle answers a uri
// instead). Here the bytes never cross RPC: they stay in the page. A method
// the facade lacks is a capability this node does not have.
export function mediaOf (facade) {
  if (facade === null || typeof facade !== 'object') return null
  const has = (k) => typeof facade[k] === 'function'
  const out = {}
  if (has('upload')) out.upload = (args) => facade.upload(args)
  if (has('putDm')) out.putDm = (args) => facade.putDm(args)
  if (has('readDm') || has('readGroup')) {
    out.read = async (ref) => {
      if (ref === null || typeof ref !== 'object') throw new TypeError('mídia inválida')
      const dm = ref.kind === 'dm'
      if (!has(dm ? 'readDm' : 'readGroup')) throw new TypeError('mídia inválida')
      const got = dm
        ? await facade.readDm({ from: ref.from, id: ref.id, index: ref.index })
        : await facade.readGroup({ diary: ref.diary, item: ref.item })
      let w = got.w
      let h = got.h
      if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h)) {
        const b = mediaBounds(got.bytes, got.mime)
        w = b === null ? null : b.width
        h = b === null ? null : b.height
      }
      return { bytes: got.bytes, mime: got.mime, w, h }
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

// config: { association, seederUrl } (src/config.js checkWebForm).
// -> { request(method, params), close(), kind: 'browser', identity, media, follows }
// after session.open; `identity` is the node handle's passkey API and `media`
// its media API, or null when the node script has none (src/node.js);
// `follows` is its legacy-follows API ({ legacy(), confirmLegacy(keys) }) or null.
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
    close,
    identity: node.identity,
    media: mediaOf(node.media),
    follows: node.follows || null
  }
}
