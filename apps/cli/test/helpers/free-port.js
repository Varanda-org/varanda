'use strict'

// Kept apart from phone-link.js, which must load without binding a port
// (phone-stub.test.js pins that).
const net = require('node:net')

// A loopback port that was free a moment ago. Use it only when a loopback
// origin is needed; otherwise listen on port 0.
async function freePort () {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

module.exports = { freePort }
