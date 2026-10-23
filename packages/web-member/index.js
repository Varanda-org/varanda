// Spike: a member held by a browser (or any WebSocket client) on Hypercore 10,
// replicating through a Hypercore 11 seeder's acceptStream.
const { createMember, APPEND_MODE } = require('./lib/member')
const { DIARY_OPTIONS } = require('./lib/diary-options')
const { memoryStorage } = require('./lib/storage')
const { wsStream, WebSocketStream } = require('./lib/ws-stream')
const { connectSeeder } = require('./lib/seeder-link')

module.exports = {
  createMember,
  APPEND_MODE,
  DIARY_OPTIONS,
  memoryStorage,
  wsStream,
  WebSocketStream,
  connectSeeder
}
