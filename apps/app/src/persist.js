// Asks the browser not to evict this origin's storage (navigator.storage).
// -> true when granted. Never rejects.
export async function askPersist (storage) {
  if (storage === null || storage === undefined || typeof storage.persist !== 'function') return false
  try {
    return (await storage.persist()) === true
  } catch {
    return false
  }
}
