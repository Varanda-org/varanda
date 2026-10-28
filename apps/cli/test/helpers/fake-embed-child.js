'use strict'

// A protocol-compatible stand-in for lib/account/ai/embed-child.js, forked by
// embedder.js through its `_childPath` test seam: no model, deterministic
// vectors from ./fake-embed. Behaviours, selected by the init message (the
// embedder's `_childInit` extras) or by the request text:
//   init.report: path   append one JSON line per start: { pid, env (the
//                       keys of process.env), execArgv, argv }
//   init.noReady        never answer the init (the init deadline fires)
//   init.initError      answer { type: 'error', code: 'sem-modelo' }
//   init.sentinel: s    print s to stdout and stderr (and console.*) at start
//   text 'HANG'         never answer
//   text 'CRASH'        exit(1) without answering
//   text 'BADVEC'       answer a 383-component vector
//   text 'NANVEC'       answer DIM nulls (what NaN becomes in JSON)
//   text 'JUNK'         send junk and wrong-id answers, then the real answer
// Exits when the IPC channel disconnects, like the real child.

const fs = require('node:fs')
const { DIM, makeEmbed } = require('./fake-embed')

const embed = makeEmbed()

function send (msg) {
  try {
    if (process.connected) process.send(msg)
  } catch {}
}

process.on('disconnect', () => process.exit(0))

let ready = false
process.on('message', async (msg) => {
  if (!ready) {
    if (!msg || msg.type !== 'init') return
    if (typeof msg.report === 'string') {
      const line = JSON.stringify({ pid: process.pid, env: Object.keys(process.env), execArgv: process.execArgv, argv: process.argv.slice(2), init: msg })
      fs.appendFileSync(msg.report, line + '\n')
    }
    if (typeof msg.sentinel === 'string') {
      process.stdout.write(msg.sentinel + '\n')
      process.stderr.write(msg.sentinel + '\n')
      console.log(msg.sentinel)
      console.error(msg.sentinel)
    }
    if (msg.noReady) return
    if (msg.initError) return send({ type: 'error', code: 'sem-modelo' })
    ready = true
    return send({ type: 'ready' })
  }
  if (!msg || !Number.isSafeInteger(msg.id) || typeof msg.text !== 'string') return
  const { id, text } = msg
  if (text === 'HANG') return
  if (text === 'CRASH') process.exit(1)
  if (text === 'BADVEC') return send({ id, embedding: new Array(DIM - 1).fill(0.05), truncated: false })
  if (text === 'NANVEC') return send({ id, embedding: new Array(DIM).fill(NaN), truncated: false })
  const answer = await embed(text)
  if (text === 'JUNK') {
    send('junk')
    send([1, 2, 3])
    send({ type: 'ready' })
    send({ id: id + 1000, embedding: new Array(DIM).fill(0), truncated: false })
    send({ id: String(id), error: 'falha-ia' })
  }
  send({ id, ...answer })
})
