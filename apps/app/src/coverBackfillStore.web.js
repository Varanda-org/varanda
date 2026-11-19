const PREFIX = 'varanda.coverBackfill.'
const failedReads = new Set()

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
  if (failedReads.has(identity)) throw new Error('Registro de capas indisponível.')
  try {
    globalThis.localStorage.setItem(PREFIX + identity, text)
  } catch (err) {
    failedReads.add(identity)
    throw err
  }
}
