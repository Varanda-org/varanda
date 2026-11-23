'use strict'

// The crash screen's copied details: the build lines and a built-in error
// name, never the message, stack, cause, props or anything else the thrown
// value carries.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const load = () => import('../src/crashReport.js')

const A = 'a'.repeat(40)
const R = '0123456789abcdef'
const BUILT = '2026-11-05T12:34:56Z'
const SECRET = 'segredo-da-pessoa'

function errorLine (text) {
  const lines = text.split('\n')
  return lines[lines.length - 1]
}

test('crashName keeps only the built-in names', async (t) => {
  const { crashName, CRASH_NAMES } = await load()
  t.alike([...CRASH_NAMES], ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError'])
  t.ok(Object.isFrozen(CRASH_NAMES))
  t.is(crashName(new Error('x')), 'Error')
  t.is(crashName(new TypeError('x')), 'TypeError')
  t.is(crashName(new RangeError('x')), 'RangeError')
  t.is(crashName(new ReferenceError('x')), 'ReferenceError')
  t.is(crashName(new SyntaxError('x')), 'SyntaxError')
  t.is(crashName(new EvalError('x')), 'EvalError')
  t.is(crashName(new URIError('x')), 'URIError')
  t.is(crashName(new AggregateError([], 'x')), 'AggregateError')
})

test('crashName turns any other name into Error', async (t) => {
  const { crashName } = await load()
  class InviteError extends Error {}
  InviteError.prototype.name = 'InviteError'
  t.is(crashName(new InviteError('x')), 'Error', 'a custom class')
  const named = (name) => Object.assign(new Error('x'), { name })
  t.is(crashName(named(SECRET)), 'Error', 'a name carrying text')
  t.is(crashName(named('TypeError\nsegredo')), 'Error', 'a built-in name with more after it')
  t.is(crashName(named(' TypeError')), 'Error')
  t.is(crashName(named('typeerror')), 'Error')
  t.is(crashName(named('')), 'Error')
  t.is(crashName(named(42)), 'Error', 'not a string')
  t.is(crashName({ name: new String('TypeError') }), 'Error', 'a boxed string') // eslint-disable-line no-new-wrappers
  t.is(crashName({ name: { toString: () => 'TypeError' } }), 'Error', 'an object that prints as a name')
  t.is(crashName({ name: 'TypeError' }), 'TypeError', 'a plain object with a built-in name')
})

test('crashName survives throwing getters, proxies and non-objects', async (t) => {
  const { crashName } = await load()
  const getter = Object.defineProperty({}, 'name', { get () { throw new Error(SECRET) } })
  t.is(crashName(getter), 'Error', 'a throwing getter')
  const trap = new Proxy({}, { get () { throw new Error(SECRET) } })
  t.is(crashName(trap), 'Error', 'a throwing proxy')
  const { proxy, revoke } = Proxy.revocable({ name: 'TypeError' }, {})
  revoke()
  t.is(crashName(proxy), 'Error', 'a revoked proxy')
  const fnTrap = new Proxy(function () {}, { get () { throw new Error(SECRET) } })
  t.is(crashName(fnTrap), 'Error', 'a throwing function proxy')
  for (const value of [undefined, null, 0, 1, NaN, true, false, 'TypeError', SECRET, Symbol('TypeError'), 10n]) {
    t.is(crashName(value), 'Error', 'non-object ' + typeof value)
  }
})

test('crashDetails is the build lines and the name, never the message', async (t) => {
  const { crashDetails } = await load()
  const err = new TypeError(SECRET)
  err.cause = new Error(SECRET + '-cause')
  err.componentStack = '\n    in ' + SECRET
  err.props = { text: SECRET }
  const text = crashDetails(err, { kind: 'android', commit: A, builtAt: BUILT, release: R })
  t.is(text, [
    'Varanda',
    'App: Android',
    'Commit: ' + A,
    'Build: ' + BUILT,
    'Servidor: desconhecido',
    'Erro: TypeError'
  ].join('\n'))
  t.absent(text.includes(SECRET), 'no message, cause, componentStack or props')
  t.absent(text.includes('at '), 'no stack frame')
})

test('crashDetails on the web carries the release line', async (t) => {
  const { crashDetails } = await load()
  const text = crashDetails(new Error(SECRET), { kind: 'web', commit: A, builtAt: BUILT, release: R })
  t.ok(text.includes('\nApp: web\n'))
  t.ok(text.includes('\nRelease web: ' + R + '\n'))
  t.is(errorLine(text), 'Erro: Error')
  t.absent(text.includes(SECRET))
})

test('crashDetails validates every build line', async (t) => {
  const { crashDetails } = await load()
  const text = crashDetails(new Error('x'), { kind: SECRET, commit: SECRET, builtAt: SECRET, release: SECRET })
  t.is(text, [
    'Varanda',
    'App: desconhecido',
    'Commit: desconhecido',
    'Build: desconhecido',
    'Servidor: desconhecido',
    'Erro: Error'
  ].join('\n'))
  const odd = crashDetails(new Error('x'), { kind: 'ios', commit: A.toUpperCase(), builtAt: '2026-13-01T00:00:00Z', release: R })
  t.ok(odd.includes('\nApp: iOS\n'))
  t.ok(odd.includes('\nCommit: desconhecido\n'), 'upper-case hex is refused')
  t.ok(odd.includes('\nBuild: desconhecido\n'), 'month 13 is refused')
  t.absent(odd.includes('Release web'), 'no release line off the web')
})

test('crashDetails survives a hostile or missing build', async (t) => {
  const { crashDetails } = await load()
  const unknown = [
    'Varanda',
    'App: desconhecido',
    'Commit: desconhecido',
    'Build: desconhecido',
    'Servidor: desconhecido',
    'Erro: RangeError'
  ].join('\n')
  const err = new RangeError(SECRET)
  t.is(crashDetails(err), unknown, 'no build')
  t.is(crashDetails(err, null), unknown, 'null build')
  t.is(crashDetails(err, 'android'), unknown, 'a string build')
  t.is(crashDetails(err, Object.defineProperty({}, 'kind', { get () { throw new Error(SECRET) } })), unknown, 'a throwing getter')
  t.is(crashDetails(err, new Proxy({}, { get () { throw new Error(SECRET) } })), unknown, 'a throwing proxy')
  t.is(crashDetails(new Proxy({}, { get () { throw new Error(SECRET) } }), null), unknown.replace('RangeError', 'Error'), 'hostile both')
})

test('the crash screen keeps only the details, never the thrown value', (t) => {
  const strip = (src) => src.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (m, str) => str || ' ')
  const src = strip(fs.readFileSync(path.join(__dirname, '../src/ui/CrashBoundary.js'), 'utf8'))
  t.ok(/static getDerivedStateFromError \(error\) \{\s*return \{ details: crashDetails\(error, BUILD\) \}/.test(src), 'only the details string reaches state')
  t.absent(/componentDidCatch \(\s*\w/.test(src), 'componentDidCatch takes no error')
  for (const banned of ['.message', '.stack', 'componentStack', 'console.', 'fetch(', 'Platform.OS ===', 'Platform.OS !==', 'Platform.select']) {
    t.absent(src.includes(banned), 'no ' + banned)
  }
  t.ok(src.includes('copyText(shareNav(), '), 'copies through the shared clipboard path')
  t.ok(src.includes("import { dropPreSplash } from './dropPreSplash'"), 'the platform module drops the pre-splash')
  t.absent(src.includes('document'), 'the shared boundary never touches the browser')
  const web = strip(fs.readFileSync(path.join(__dirname, '../src/ui/dropPreSplash.web.js'), 'utf8'))
  t.ok(/export function dropPreSplash \(\) \{\s*try \{\s*const el = document\.getElementById\('varanda-pre-splash'\)\s*if \(el\) el\.remove\(\)\s*\} catch \{\}\s*\}/.test(web), 'the web pre-splash goes, guarded')
  const native = strip(fs.readFileSync(path.join(__dirname, '../src/ui/dropPreSplash.native.js'), 'utf8'))
  t.ok(/^\s*export function dropPreSplash \(\) \{\}\s*$/.test(native), 'nothing to drop on iOS and Android')
  t.ok(/componentDidMount \(\) \{\s*if \(this\.state\.details !== null\) dropPreSplash\(\)\s*\}/.test(src), 'a crash in the first render drops it on mount')
  t.ok(/componentDidUpdate \(prevProps, prevState\) \{\s*if \(prevState\.details === null && this\.state\.details !== null\) dropPreSplash\(\)\s*\}/.test(src), 'a later crash drops it on update')
  t.ok(src.includes("import { StatusBar } from 'expo-status-bar'") && src.includes("<StatusBar style='dark' />"), 'the fallback draws dark status bar icons over its light paper')
  t.ok(src.includes("import { announce, liveRegion } from './copyNote'"), 'the copy note comes from the platform module')
  t.ok(src.includes('accessibilityLiveRegion={liveRegion}'), 'the live region follows the platform')
  t.ok(/const note = ok \? [^\n]*\n\s*this\.setState\(\{ note \}\)\s*announce\(note\)/.test(src), 'a copy result is announced')
  const noteWeb = strip(fs.readFileSync(path.join(__dirname, '../src/ui/copyNote.web.js'), 'utf8'))
  t.ok(noteWeb.includes("liveRegion = 'polite'") && /export function announce \(\) \{\}/.test(noteWeb), 'the web reads the live region and does not announce')
  const noteNative = strip(fs.readFileSync(path.join(__dirname, '../src/ui/copyNote.native.js'), 'utf8'))
  t.ok(noteNative.includes("liveRegion = 'none'") && noteNative.includes('AccessibilityInfo.announceForAccessibility(text)'), 'iOS and Android announce, with no live region')
  const index = strip(fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'))
  t.ok(index.includes('registerRootComponent(withCrashBoundary(App))'), 'the root is wrapped')
})
