import { buildInfo, versionDetails } from './version.js'

// What the crash screen lets the person copy. The thrown value may carry what
// they wrote, a peer's text or session state in its message, stack, cause or
// props, so only its name leaves, and only when it is a built-in error name.
export const CRASH_NAMES = Object.freeze([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'EvalError',
  'URIError',
  'AggregateError'
])

// A getter or a proxy trap may throw, and a name may be any string.
export function crashName (error) {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return 'Error'
    const name = error.name
    return typeof name === 'string' && CRASH_NAMES.includes(name) ? name : 'Error'
  } catch {
    return 'Error'
  }
}

function safeBuild (build) {
  try {
    return buildInfo(build)
  } catch {
    return buildInfo({})
  }
}

// The screen makes no network call, so the server commit is unknown.
export function crashDetails (error, build) {
  return versionDetails({ app: safeBuild(build), server: { status: 'unavailable' } }) + '\nErro: ' + crashName(error)
}
