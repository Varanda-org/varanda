// The Excluir conta receipt on the native app (see deletionReceiptStore.web.js):
// a small file in the app's documents, the public key and the date only.
import { File, Paths } from 'expo-file-system'
import { receiptOf } from './accountDeletion.js'

const FILE_NAME = 'exclusao.json'

function file () {
  return new File(Paths.document, FILE_NAME)
}

export async function loadDeletionReceipt () {
  try {
    const f = file()
    if (!f.exists) return null
    return receiptOf(JSON.parse(await f.text()))
  } catch {
    return null
  }
}

export async function saveDeletionReceipt (receipt) {
  try {
    const valid = receiptOf(receipt)
    if (valid === null) return false
    const f = file()
    if (!f.exists) f.create()
    f.write(JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}

export async function clearDeletionReceipt () {
  try {
    const f = file()
    if (f.exists) f.delete()
    return true
  } catch {
    return false
  }
}
