/* global WebSocket, navigator */
// Entry of the browser node bundle (scripts/build.js writes it as
// varanda-node.js; the app's web build serves it next to the page and
// apps/app src/client/browser.js loads it). It defines ONE global:
//
//   VarandaWebNode = { version: 1, start(config) }
//   start({ association, seederUrl }) -> Promise<{ connect(send, { onClose }), close() }>
//
// start() opens the node over IndexedDB (database 'varanda-node', where the
// diary and its key pair live) and returns the lib/node.js handle; nothing
// else of the node (session, storage, cores, keys) is reachable from the
// page. This is not a security boundary: any script of the same origin can
// read IndexedDB (the key at rest is the passkey work, docs/verification.md
// section 8).
//
// One node per browser profile: start() takes the exclusive Web Lock
// 'varanda-node' (ifAvailable) and holds it until close(), so a second tab
// is refused with LOCKED instead of two tabs rewriting the same diary. A
// browser without the Web Locks API runs unguarded.
const { createBrowserNode } = require('../lib/node')
const { idbNodeStorage } = require('../lib/node-storage')

const DB_NAME = 'varanda-node'
const LOCK_NAME = 'varanda-node'

let current = null

function lockedError () {
  const err = new Error('outra aba já usa o Varanda neste navegador')
  err.code = 'LOCKED'
  return err
}

// -> Promise<release()>; rejects LOCKED when another tab holds the lock.
function takeLock () {
  const locks = typeof navigator === 'object' && navigator !== null ? navigator.locks : undefined
  if (!locks || typeof locks.request !== 'function') return Promise.resolve(() => {})
  return new Promise((resolve, reject) => {
    locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (lock === null) {
        reject(lockedError())
        return undefined
      }
      // Held until the returned promise settles, i.e. until release().
      return new Promise((_resolve) => resolve(_resolve))
    }).catch(reject)
  })
}

async function start ({ association, seederUrl } = {}) {
  if (current !== null) await current.close()
  const release = await takeLock()
  let storage = null
  try {
    storage = await idbNodeStorage(DB_NAME)
    const node = createBrowserNode({
      storage,
      association,
      seederUrl,
      createSocket: (url) => new WebSocket(url)
    })
    let closing = null
    const handle = {
      connect: (send, options) => node.connect(send, options),
      close () {
        if (closing !== null) return closing
        closing = node.close().finally(() => {
          release()
          if (current === handle) current = null
        })
        return closing
      }
    }
    current = handle
    return handle
  } catch (err) {
    if (storage !== null) await storage.close().catch(() => {})
    release()
    throw err
  }
}

globalThis.VarandaWebNode = Object.freeze({ version: 1, start })
