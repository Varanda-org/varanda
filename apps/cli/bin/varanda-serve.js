#!/usr/bin/env node

'use strict'

// varanda-serve: one Varanda node on this computer, exposed to a browser UI
// over a loopback WebSocket (keys stay on this machine). See README,
// "Servidor local para a interface web (varanda-serve)".

const { parseServeArgs, HELP } = require('../lib/serve/args')
const { createServeServer, authority } = require('../lib/serve/server')
const { createSession } = require('@varanda/core/lib/session')

function fail (err) {
  const usage = err && err.code === 'USAGE'
  process.stderr.write((usage ? 'uso: ' : 'erro: ') + String(err && err.message) + '\n')
  process.exitCode = usage ? 2 : 1
}

async function main () {
  let config
  try {
    config = parseServeArgs(process.argv.slice(2))
  } catch (err) {
    if (err.code !== 'USAGE') throw err
    process.stderr.write('uso: ' + err.message + '\n' + HELP + '\n')
    process.exitCode = 2
    return
  }
  if (config.help) {
    process.stdout.write(HELP + '\n')
    return
  }

  // Refused before listening: a seeder or association dir, a bad key or bootstrap.
  const session = createSession({
    ...config.session,
    onInternalError (err) {
      process.stderr.write('erro interno: ' + String(err && err.message) + '\n')
    }
  })

  const server = createServeServer({
    session,
    port: config.port,
    origins: config.origins,
    uiRoot: config.uiRoot,
    token: config.token,
    openTimeoutMs: config.openTimeoutMs,
    accountOrigin: config.accountOrigin
  })

  let port
  try {
    port = await server.listen()
  } catch (err) {
    await session.close()
    if (err.code === 'EADDRINUSE') process.stderr.write('erro: porta em uso\n')
    else process.stderr.write('erro: ' + err.message + '\n')
    process.exitCode = 1
    return
  }

  const base = 'http://' + authority('127.0.0.1', port)
  // The token is printed once and never logged; in the URL it is a fragment,
  // which the browser never sends to the server.
  process.stdout.write('varanda-serve em ' + base + '\n' +
    (config.uiRoot !== null ? 'abra ' + base + '/#token=' + config.token : 'token: ' + config.token) + '\n')

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    server.close().then(
      () => { process.exitCode = 0 },
      (err) => fail(err)
    ).finally(() => {
      // Bound shutdown if a socket or timer survives close().
      setTimeout(() => process.exit(process.exitCode), 2000).unref()
    })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch(fail)
