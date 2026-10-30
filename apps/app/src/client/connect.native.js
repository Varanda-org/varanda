// Native: connectNode wraps the in-app Bare node (./native). A hosted config
// starts the web kind and adds the handle of ./webnode (identity, media,
// follows); any other config is the core kind, as before.

import { startNode, terminateNode, currentClient } from './native'
import { webNodeHandle } from './webnode'

const WATCH_MS = 1000

// -> { request(method, params), close(), kind } once session.open succeeded.
// onClose({ code }) is called once if the node's IPC ends on its own after
// startup (native.js then terminates the worklet and the client is closed);
// it is not called after close(). The client has no close callback, so its
// `closed` flag is watched, and a CLOSED rejection checks it at once.
export async function connectNode (config, { onEvent, onClose } = {}) {
  // A previous node of this JS context (Fast Refresh, a restart): stop it
  // first; startNode refuses a second one.
  if (currentClient() !== null) await terminateNode()
  const { client } = await startNode(config, { onEvent })
  let deliberate = false
  let notified = false
  let timer = null
  const check = () => {
    if (deliberate || notified || !client.closed) return
    notified = true
    clearInterval(timer)
    if (typeof onClose === 'function') onClose({ code: 'closed' })
  }
  timer = setInterval(check, WATCH_MS)
  const request = (method, params = {}) => client.request(method, params).catch((err) => {
    if (err && err.code === 'CLOSED') check()
    throw err
  })
  const conn = {
    kind: 'native',
    request,
    close: async () => {
      deliberate = true
      clearInterval(timer)
      await terminateNode()
    }
  }
  if (config !== null && typeof config === 'object' && config.kind === 'hosted') {
    return { ...conn, ...webNodeHandle(request) }
  }
  return conn
}
