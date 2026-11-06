// The Excluir conta receipt (src/accountDeletion.js receiptOf): the public
// key and the date only, so the app can confirm later that the diary left
// the network. localStorage, read and written only through these.
import { receiptOf } from './accountDeletion.js'

const KEY = 'varanda.exclusao'

function storage () {
  try { return globalThis.localStorage || null } catch { return null }
}

export async function loadDeletionReceipt () {
  try {
    const raw = storage().getItem(KEY)
    if (typeof raw !== 'string') return null
    return receiptOf(JSON.parse(raw))
  } catch {
    return null
  }
}

export async function saveDeletionReceipt (receipt) {
  try {
    const valid = receiptOf(receipt)
    if (valid === null) return false
    storage().setItem(KEY, JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}

export async function clearDeletionReceipt () {
  try {
    storage().removeItem(KEY)
    return true
  } catch {
    return false
  }
}
