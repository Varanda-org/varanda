'use strict'

// The crash signal: the error boundary tells the node provider that the tree
// is gone for good, and the provider closes the connection.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

let fresh = 0
// A new module instance per test: the crashed latch is per process.
const load = () => import('../src/crashSignal.js?t=' + (++fresh))

function withoutComments (src) {
  return src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
}
const read = (rel) => withoutComments(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'))

test('signalCrash runs each listener once', async (t) => {
  const { onCrash, signalCrash } = await load()
  const calls = []
  onCrash(() => calls.push('a'))
  onCrash(() => calls.push('b'))
  t.alike(calls, [], 'nothing before the crash')
  signalCrash()
  t.alike(calls, ['a', 'b'])
})

test('signalCrash is idempotent', async (t) => {
  const { onCrash, signalCrash } = await load()
  let calls = 0
  onCrash(() => { calls++ })
  signalCrash()
  signalCrash()
  t.is(calls, 1, 'a second crash does nothing')
  onCrash(() => { calls++ })
  signalCrash()
  t.is(calls, 1, 'a listener added after the crash is not run by a later call')
})

test('a throwing listener does not stop the others and signalCrash never throws', async (t) => {
  const { onCrash, signalCrash } = await load()
  const calls = []
  onCrash(() => { calls.push('a') })
  onCrash(() => { throw new Error('x') })
  onCrash(() => { calls.push('c') })
  t.execution(() => signalCrash())
  t.alike(calls, ['a', 'c'])
})

test('unsubscribe removes the listener', async (t) => {
  const { onCrash, signalCrash } = await load()
  const calls = []
  const off = onCrash(() => calls.push('a'))
  onCrash(() => calls.push('b'))
  off()
  off()
  signalCrash()
  t.alike(calls, ['b'])
})

test('the same listener registered twice runs once', async (t) => {
  const { onCrash, signalCrash } = await load()
  let calls = 0
  const fn = () => { calls++ }
  onCrash(fn)
  onCrash(fn)
  signalCrash()
  t.is(calls, 1)
})

test('isCrashed is false until the crash and true after it', async (t) => {
  const { isCrashed, signalCrash } = await load()
  t.is(isCrashed(), false)
  signalCrash()
  t.is(isCrashed(), true)
  signalCrash()
  t.is(isCrashed(), true)
})

test('no node starts or survives in connectNow after the crash', (t) => {
  const src = read('src/node.js')
  t.ok(src.includes("import { isCrashed, onCrash } from './crashSignal'"), 'imported')
  const start = src.indexOf('const connectNow = useCallback(async (cfg')
  t.ok(start !== -1, 'connectNow found')
  const body = src.slice(start, src.indexOf('connectNode(', start))
  t.ok(/^\s*const connectNow = useCallback\(async \(cfg, \{ save = false \} = \{\}\) => \{\s*if \(isCrashed\(\)\) return\s/.test(body), 'returns before anything else once crashed')
  t.ok(body.includes('const obsolete = () => !attemptsRef.current.isCurrent(token) || isCrashed()'), 'a connection that finishes after the crash is dropped')
  t.is(src.split('connectNode(').length - 1, 1, 'connectNow is the only place that starts a node')
})

test('crashSignal.js is pure', (t) => {
  const src = read('src/crashSignal.js')
  t.absent(/\bimport\b|\brequire\(/.test(src), 'no imports')
})

test('the boundary signals the crash from componentDidCatch, with no error and no logging', (t) => {
  const src = read('src/ui/CrashBoundary.js')
  t.ok(src.includes("import { signalCrash } from '../crashSignal'"))
  t.ok(/componentDidCatch \(\) \{\s*signalCrash\(\)\s*\}/.test(src), 'componentDidCatch takes nothing and only signals')
  t.is(src.split('signalCrash(').length - 1, 1, 'signalled in one place')
})

test('the node provider closes the connection on a crash, from a passive effect', (t) => {
  const src = read('src/node.js')
  t.ok(src.includes("import { isCrashed, onCrash } from './crashSignal'"), 'imported')
  t.ok(/useEffect\(\(\) => onCrash\(\(\) => \{\s*attemptsRef\.current\.begin\(\)\s*const conn = connRef\.current\s*if \(conn\) Promise\.resolve\(\)\.then\(\(\) => conn\.close\(\)\)\.catch\(\(\) => \{\}\)\s*\}\), \[\]\)/.test(src), 'closes connRef.current, errors swallowed, registered once')
  t.absent(/useLayoutEffect\(\(\) => onCrash/.test(src), 'not a layout effect, whose cleanup runs before componentDidCatch')
  t.ok(/const connRef = useRef\(null\)/.test(src), 'connRef is the live connection ref')
})
