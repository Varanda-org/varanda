// A member held by a browser (or any WebSocket client) on Hypercore 10,
// replicating through a Hypercore 11 seeder's acceptStream: the spike's
// member and seeder link, and the browser node (an RPC session over IndexedDB
// that the app's web build runs, lib/node.js).
const { createMember, APPEND_MODE } = require('./lib/member')
const { DIARY_OPTIONS } = require('./lib/diary-options')
const { memoryStorage } = require('./lib/storage')
const { wsStream, WebSocketStream } = require('./lib/ws-stream')
const { connectSeeder } = require('./lib/seeder-link')
const { createBrowserNode } = require('./lib/node')
const { createBrowserSession } = require('./lib/session')
const { idbNodeStorage, memoryNodeStorage } = require('./lib/node-storage')
const { checkSeederUrl } = require('./lib/seeder-url')

module.exports = {
  createMember,
  APPEND_MODE,
  DIARY_OPTIONS,
  memoryStorage,
  wsStream,
  WebSocketStream,
  connectSeeder,
  createBrowserNode,
  createBrowserSession,
  idbNodeStorage,
  memoryNodeStorage,
  checkSeederUrl
}
