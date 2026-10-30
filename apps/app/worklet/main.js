'use strict'
/* global Bare, BareKit */

// The Varanda node inside the app: a Bare worklet (react-native-bare-kit)
// started by src/client/native.js with one JSON argument
//   { kind, dataDir, association, bootstrap, dhtHost, allowPublicDht, recover,
//     diagnostics, seederUrl, cacheDir }
// It runs ONE node session over the worklet IPC, framed as docs/rpc.md
// section 3 (4-byte big-endian length + UTF-8 JSON). kind 'core' (the
// default, also when kind is absent) is @varanda/core/lib/session on the
// manifest diary; kind 'web' is the browser node's session on file storage
// (worklet/web-node.js: seederUrl, cacheDir; bootstrap, dhtHost,
// allowPublicDht and recover do not apply).
// Packed by scripts/pack-worklet.sh (bare-pack --linked); its native addons
// are linked into the app by scripts/link-addons.sh (bare-link).

const { createSession } = require('@varanda/core/lib/session')
const { encodeFrame, createFrameDecoder, createServerDispatcher, MAX_REQUEST, MAX_MESSAGE } = require('@varanda/rpc')
// Same module instance the session's '#fs' resolves to under Bare: read only
// for the diagnostics line below.
const fs = require('@varanda/core/lib/bare/fs')

const { IPC } = BareKit

// The start argument: the last argv entry that parses as a JSON object.
function readArgs () {
  const argv = Array.isArray(Bare.argv) ? Bare.argv : []
  for (let i = argv.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(argv[i])
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {}
  }
  return null
}

let closing = false
let session = null
let dispatcher = null

let closed = false // node.close finished: its response is the last frame

function send (message) {
  if (closing) return
  let frame
  try {
    frame = encodeFrame(message, MAX_MESSAGE)
  } catch {
    return
  }
  IPC.write(frame)
}

// After the node.close response: stops accepting frames and sends nothing
// more. The IPC stream is deliberately NOT ended here: the host terminates
// the worklet right after the response (src/client/native.js).
function finish () {
  closing = true
  if (dispatcher !== null) dispatcher.close()
}

// Closes the session (lock released) and ends the IPC stream once.
function close () {
  if (closing) return
  closing = true
  if (dispatcher !== null) dispatcher.close()
  const done = session === null ? Promise.resolve() : session.detach().then(() => session.close())
  done.catch(() => {}).then(() => {
    try { IPC.end() } catch {}
  })
}

// node.close (docs/rpc.md 5.17, IPC only): the host's explicit shutdown,
// since the bare-kit IPC carries no end-of-stream from React Native. The
// session is detached and closed (any sync stopped, every store closed, the
// data-dir lock released) BEFORE the response; once the response is
// written, finish() stops accepting frames (the stream stays open until the
// host terminates the worklet).
async function nodeClose () {
  await session.detach()
  await session.close()
  closed = true
  return { closed: true }
}

function diagnostics () {
  return 'diag structuredClone=' + typeof structuredClone +
    ' O_NOFOLLOW=' + (Number.isInteger(fs.constants.O_NOFOLLOW) && fs.constants.O_NOFOLLOW > 0 ? 'yes' : 'no') +
    ' O_EXCL=' + (Number.isInteger(fs.constants.O_EXCL) && fs.constants.O_EXCL > 0 ? 'yes' : 'no') +
    ' bare=' + String(Bare.version)
}

function main () {
  const args = readArgs()
  if (args === null) {
    console.error('varanda worklet: start argument missing')
    return close()
  }
  if (args.kind === 'web') return mainWeb(args)
  if (args.kind !== undefined && args.kind !== 'core') {
    console.error('varanda worklet: invalid configuration: kind')
    return close()
  }
  try {
    session = createSession({
      dataDir: args.dataDir,
      association: args.association,
      bootstrap: args.bootstrap === undefined ? null : args.bootstrap,
      dhtHost: args.dhtHost === undefined ? null : args.dhtHost,
      allowPublicDht: args.allowPublicDht === true,
      storeOptions: { lock: 'worklet', recover: args.recover === true, suspend: true },
      onInternalError: (err) => console.error('varanda worklet: internal error', err && err.stack ? err.stack : err)
    })
  } catch (err) {
    // A configuration error: reported on the system log, then the stream
    // ends (the host shows the worklet as stopped).
    console.error('varanda worklet: invalid configuration:', err && err.message)
    return close()
  }

  // The diagnostics line goes out once, right after session.open succeeded.
  let diagSent = args.diagnostics !== true
  const handlers = { ...session.handlers, 'node.close': nodeClose }
  dispatcher = createServerDispatcher({
    handlers,
    token: null,
    send: (message) => {
      send(message)
      // Only node.close answers { closed: true }.
      if (closed && message.ok === true && message.result && message.result.closed === true) return finish()
      if (!diagSent && dispatcher !== null && dispatcher.opened) {
        diagSent = true
        dispatcher.emit('warning', { line: diagnostics() })
      }
    },
    onProtocolError: close
  })
  session.attach(dispatcher.emit)

  const decoder = createFrameDecoder({
    max: MAX_REQUEST,
    onMessage: (obj) => { if (!closing) dispatcher.receive(obj) },
    onError: close
  })
  IPC.on('data', (chunk) => { if (!closing) decoder.push(chunk) })
  IPC.on('end', close)
  IPC.on('error', close)

  Bare.on('suspend', () => { session.suspend().catch(() => {}) })
  Bare.on('resume', () => { session.resume() })
}

// kind 'web': the same framed dispatcher over worklet/web-node.js. The
// web session has no suspend/resume (its lease redials), so the Bare
// suspend/resume events change nothing here.
function mainWeb (args) {
  // WebCrypto (subtle.digest) for web-member's session and member-ops,
  // before any of them loads.
  require('bare-crypto/global')
  const { createWebNode } = require('./web-node')
  try {
    session = createWebNode(args, {
      onInternalError: (err) => console.error('varanda worklet: internal error', err && err.stack ? err.stack : err)
    })
  } catch (err) {
    console.error('varanda worklet: invalid configuration:', err && err.message)
    return close()
  }

  const handlers = { ...session.handlers, 'node.close': nodeClose }
  dispatcher = createServerDispatcher({
    handlers,
    token: null,
    send: (message) => {
      send(message)
      if (closed && message.ok === true && message.result && message.result.closed === true) return finish()
    },
    onProtocolError: close
  })
  session.attach(dispatcher.emit)

  const decoder = createFrameDecoder({
    max: MAX_REQUEST,
    onMessage: (obj) => { if (!closing) dispatcher.receive(obj) },
    onError: close
  })
  IPC.on('data', (chunk) => { if (!closing) decoder.push(chunk) })
  IPC.on('end', close)
  IPC.on('error', close)
}

main()
