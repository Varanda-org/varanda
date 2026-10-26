// In-memory storage for a Hypercore 10 core (random-access-storage line).
// Hypercore 10.38.2 (lib/core.js Core.open) calls the factory once per file
// with a single argument, the file name ('oplog', 'tree', 'bitfield',
// 'data', 'header'), and expects a random-access-storage instance back.
// A random-access-storage instance refuses every operation once closed
// (random-access-storage 3.0.2 index.js:237, 'Closed'), so a reopen of the
// same factory must hand out a fresh instance; it shares the closed one's
// pages and length, which is what makes the second open see the same files
// (random-access-memory's own RAM.reusable() copies them instead).
// pageSize (optional): the RAM page size in bytes, carried over on reopen.
// Without it random-access-memory's default (1 MiB pages) applies, as the
// sync's quarantine core expects; the Espiadinha's memory cores (./peek.js)
// pass 64 KiB so a short-lived core holding a few blocks never pins a
// megabyte per file.
const RAM = require('random-access-memory')

function memoryStorage ({ pageSize } = {}) {
  const files = new Map()
  const options = pageSize === undefined ? {} : { pageSize }
  return function createStorage (name) {
    const existing = files.get(name)
    if (existing && !existing.closed) return existing
    const ram = new RAM(options)
    if (existing) {
      ram.length = existing.length
      ram.pageSize = existing.pageSize
      ram.buffers = existing.buffers
    }
    files.set(name, ram)
    return ram
  }
}

module.exports = { memoryStorage }
