'use strict'

// worklet/unhandled.js and its wiring in worklet/main.js: without a listener
// Bare aborts the whole app on a rejection nobody handled. The worklet logs
// it on one line and keeps running, and registers no uncaughtException
// listener (those still abort).
const test = require('brittle')
const fs = require('node:fs')
const path = require('node:path')
const { createRejectionLogger } = require('../worklet/unhandled')

test('an unhandled Error is logged with its stack on one escaped line', (t) => {
  const lines = []
  const onRejection = createRejectionLogger((line) => lines.push(line))
  onRejection(new Error('falhou\n\u001b[31mforjado'))
  t.is(lines.length, 1)
  t.ok(lines[0].startsWith('varanda worklet: unhandled rejection Error: falhou'))
  t.ok(lines[0].includes('workletRejection.test.js'), 'the stack is kept')
  t.absent(['\n', '\r', '\u001b'].some((c) => lines[0].includes(c)), 'no raw newline or escape sequence')
})

test('any rejection reason is logged and the listener never throws', (t) => {
  const lines = []
  const onRejection = createRejectionLogger((line) => lines.push(line))
  const badStack = new Error('m')
  Object.defineProperty(badStack, 'stack', { get () { throw new Error('no') } })
  const reasons = ['texto', undefined, null, 7, Object.create(null), { toString () { throw new Error('x') } }, badStack]
  for (const reason of reasons) t.execution(() => onRejection(reason))
  t.alike(lines.map((l) => l.slice('varanda worklet: unhandled rejection '.length)), [
    'texto', 'undefined', 'null', '7', '(unprintable reason)', '(unprintable reason)', '(unprintable reason)'
  ])
  const throwing = createRejectionLogger(() => { throw new Error('log down') })
  t.execution(() => throwing(new Error('x')), 'a failing log stays inside the listener')
})

test('worklet/main.js registers the rejection listener and no uncaughtException one', async (t) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'worklet', 'main.js'), 'utf8')
  const listeners = []
  const errors = []
  let ended = false
  const Bare = { argv: [], on: (name, fn) => listeners.push([name, fn]) }
  const BareKit = { IPC: { write () {}, end () { ended = true }, on () {} } }
  const stubs = {
    './unhandled': require('../worklet/unhandled'),
    '@varanda/core/lib/session': { createSession () { throw new Error('not reached') } },
    '@varanda/rpc': {},
    '@varanda/core/lib/bare/fs': { constants: {} }
  }
  const req = (name) => {
    if (!(name in stubs)) throw new Error('unexpected require ' + name)
    return stubs[name]
  }
  const console = { error: (...args) => errors.push(args.join(' ')) }
  // eslint-disable-next-line no-new-func
  new Function('require', 'Bare', 'BareKit', 'console', source)(req, Bare, BareKit, console)
  await new Promise((resolve) => setImmediate(resolve))
  t.ok(ended, 'with no start argument the worklet ends its stream')

  t.alike(listeners.map(([name]) => name).filter((n) => /rejection|exception/i.test(n)), ['unhandledRejection'])
  const onRejection = listeners.find(([name]) => name === 'unhandledRejection')[1]
  onRejection(new Error('perdida'))
  t.ok(errors.some((line) => line.startsWith('varanda worklet: unhandled rejection Error: perdida')), 'logged on console.error')
})
