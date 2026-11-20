const PREFIX = 'varanda.momentCleanup.'
const failedReads = new Set()

export async function exclusive (fn) {
  if (typeof globalThis.navigator?.locks?.request !== 'function') return null
  return globalThis.navigator.locks.request('varanda-moment-cleanup', { ifAvailable: true }, (lock) => lock ? fn() : null)
}

export function read (identity) {
  try {
    const text = globalThis.localStorage.getItem(PREFIX + identity)
    failedReads.delete(identity)
    return text
  } catch {
    failedReads.add(identity)
    return null
  }
}

export async function write (identity, text) {
  // An unreadable ledger must never be replaced by a seemingly empty one.
  if (failedReads.has(identity)) throw new Error('Registro de momentos indisponível.')
  try {
    globalThis.localStorage.setItem(PREFIX + identity, text)
  } catch (err) {
    failedReads.add(identity)
    throw err
  }
}
