// The in-app Varanda node (iOS and Android): the ONLY module that imports
// react-native-bare-kit. One Worklet owner per JS context, kept on
// globalThis so a Fast Refresh re-evaluation of this module never starts a
// second node over the same data dir. The worklet (worklet/main.js, packed
// to assets/worklet/main.bundle.js by scripts/pack-worklet.sh) runs the node
// session; this side talks to it with the @varanda/rpc client over the
// framed IPC (docs/rpc.md section 3).
//
// recover (worklet lock takeover, packages/core/lib/store.js) is passed on
// every start, because every start is a cold start (the first in this JS
// context) or follows the termination of this context's previous worklet:
// a stop, a failed start and an IPC that ended on its own all terminate it
// first. A lock left by a crash, or by a worklet force-terminated after
// END_TIMEOUT_MS, is therefore taken over, and a live worklet of this
// context never is. The gate (src/gate) starts with recover: false to prove
// that node.close released the lock.
//
// Full JS reload (dev only): the new JS context starts with an empty
// globalThis, so the previous context's worklet is out of reach from here.
// The node's worklet is therefore created under a fixed id (NODE_WORKLET_ID):
// react-native-bare-kit keeps a native registry of worklets by id, and starting
// a new one under an id terminates the previous one, whichever context made
// it. If that termination loses the race with the new worklet's store open,
// the takeover is refused by RocksDB's own per-process lock (verified in
// packages/core/test/worklet-lock.test.js), never by sharing the store.

import { Worklet } from 'react-native-bare-kit'
import { Directory, Paths } from 'expo-file-system'
import { createClient, encodeFrame, createFrameDecoder, MAX_REQUEST, MAX_MESSAGE, EVENTS } from '@varanda/rpc'
import bundle from '../../assets/worklet/main.bundle.js'

const KEY = '__varandaNode'
const NODE_WORKLET_ID = 'app.varanda.node'
const END_TIMEOUT_MS = 10000

function state () {
  if (!globalThis[KEY]) {
    globalThis[KEY] = {
      node: null // the running node: { worklet, client, ended, config }
    }
  }
  return globalThis[KEY]
}

// file:///.../Documents/ -> /.../Documents (a plain path for Bare).
export function uriToPath (uri) {
  let s = String(uri)
  if (s.startsWith('file://')) s = s.slice('file://'.length)
  s = decodeURIComponent(s)
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s
}

export function documentPath () {
  return uriToPath(Paths.document.uri)
}

// The app's member data dir: <documents>/varanda.
export function defaultDataDir () {
  return documentPath() + '/varanda'
}

const UPLOAD_DIR = 'varanda-upload'

// The photo upload staging dir of the web kind, created if missing. The
// worklet reads media.uploadFile paths only from inside it (docs/rpc.md 5.56).
export function uploadDirectory () {
  const dir = new Directory(Paths.cache, UPLOAD_DIR)
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
  return dir
}

export function uploadPath () {
  return uriToPath(Paths.cache.uri) + '/' + UPLOAD_DIR
}

// Starts a worklet with the node session and connects a client. Internal:
// returns { worklet, client, ended } where `ended` resolves once the IPC
// stream ended or closed (the worklet's session closed its store). `id` is
// the worklet registry id (null: not registered).
function launch (args, { onEvent, id = null } = {}) {
  const worklet = new Worklet(id)
  const ipc = worklet.IPC
  let client = null
  let resolveEnded
  const ended = new Promise((resolve) => { resolveEnded = resolve })
  let done = false
  const finish = () => {
    if (done) return
    done = true
    if (client !== null) client.close()
    resolveEnded()
  }

  client = createClient({
    send: (message) => {
      ipc.write(encodeFrame(message, MAX_REQUEST))
    }
  })
  const decoder = createFrameDecoder({
    max: MAX_MESSAGE,
    onMessage: (obj) => client.receive(obj),
    // A protocol error from the node: the stream cannot be trusted any more.
    onError: () => {
      try { ipc.end() } catch {}
      finish()
    }
  })
  ipc.on('data', (chunk) => decoder.push(chunk))
  ipc.on('end', finish)
  ipc.on('close', finish)
  ipc.on('error', finish)
  if (typeof onEvent === 'function') {
    for (const name of EVENTS) client.on(name, (data) => onEvent(name, data))
  }

  worklet.start('/app.bundle', bundle, [JSON.stringify(args)])
  return { worklet, client, ended }
}

// Asks the worklet to shut down with node.close (docs/rpc.md 5.17: the
// session is detached and closed and the data-dir lock released before the
// response), then terminates the worklet. The bare-kit IPC has no
// end-of-stream from this side (IPC.end() only ends our writable), so the
// request is the only clean path. A worklet that does not answer within
// END_TIMEOUT_MS (hung, or already gone) is terminated anyway: its lock may
// then be left behind, and only then does the next start need recover.
// -> true only when the node.close response arrived.
async function stop (node) {
  let timer
  const timeout = new Promise((resolve) => { timer = setTimeout(resolve, END_TIMEOUT_MS, false) })
  const closed = node.client.closed
    ? Promise.resolve(false)
    : node.client.request('node.close').then((r) => r !== null && typeof r === 'object' && r.closed === true, () => false)
  const clean = await Promise.race([closed, node.ended.then(() => false), timeout])
  clearTimeout(timer)
  node.client.close()
  try { node.worklet.terminate() } catch {}
  return clean
}

// A hosted config (src/config.js nativeHostedConfigOf) starts the web kind:
// the browser node's session on file storage, no DHT and no recover (the
// worklet's file storage lock has no takeover).
function argsOf (config, recover) {
  if (config.kind === 'hosted') {
    uploadDirectory()
    return {
      kind: 'web',
      dataDir: config.dataDir || defaultDataDir(),
      cacheDir: uploadPath(),
      association: config.association,
      seederUrl: config.seederUrl
    }
  }
  return {
    dataDir: config.dataDir || defaultDataDir(),
    association: config.association,
    bootstrap: config.bootstrap === undefined ? null : config.bootstrap,
    dhtHost: config.dhtHost === undefined ? null : config.dhtHost,
    allowPublicDht: config.allowPublicDht === true,
    recover,
    diagnostics: config.diagnostics === true
  }
}

// Starts the node once and opens the RPC session. config: { association,
// bootstrap, dhtHost, allowPublicDht, dataDir?, diagnostics? }; onEvent(name,
// data) receives every node event; recover defaults to true (see the top of
// this file). -> { client, recovered, dataDir }
export async function startNode (config, { onEvent, recover = true } = {}) {
  const s = state()
  if (s.node !== null) throw new Error('nó já iniciado')
  const args = argsOf(config, recover === true)
  const node = launch(args, { onEvent, id: NODE_WORKLET_ID })
  node.config = args
  s.node = node
  node.ended.then(() => {
    if (s.node !== node) return
    // The IPC failed or ended on its own (not a stop): terminate the worklet
    // here, so it can never keep the store while a replacement starts.
    s.node = null
    node.client.close()
    try { node.worklet.terminate() } catch {}
  })
  try {
    await node.client.request('session.open')
  } catch (err) {
    // A failed start (bad config makes the worklet close its side, or the
    // open times out): stop and terminate this worklet so a corrected
    // startNode can run.
    await stop(node)
    if (s.node === node) s.node = null
    throw err
  }
  return { client: node.client, recovered: args.recover === true, dataDir: args.dataDir }
}

// The running node's client, or null.
export function currentClient () {
  const s = state()
  return s.node === null ? null : s.node.client
}

// Stops the running node (node.close, then terminate). -> whether the stop
// was clean (node.close answered: the data-dir lock was released).
export async function terminateNode () {
  const s = state()
  const node = s.node
  if (node === null) return false
  const clean = await stop(node)
  if (s.node === node) s.node = null
  return clean
}

// Gate only (src/gate): a SECOND worklet on a data dir, never with recover,
// to prove the data-dir lock refuses it. Not tracked as the app's node, and
// registered under no id: under NODE_WORKLET_ID it would terminate the node.
export async function startProbe (config) {
  const node = launch(argsOf(config, false))
  try {
    await node.client.request('session.open')
  } catch (err) {
    await stop(node)
    throw err
  }
  return { client: node.client, stop: () => stop(node) }
}
