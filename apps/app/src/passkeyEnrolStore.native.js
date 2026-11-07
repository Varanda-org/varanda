// The passkey enrolment record on the native app (src/passkeyEnrol.js; the
// browser node keeps the same record in its kv): the attestation object of
// the passkey this installation created for its identity, public data only
// (the credential id and the public key, never the PRF output), until the
// account service stored the key. One small JSON file in the app's
// Documents, like the deletion receipt: it dies with the app on reinstall.
import { File, Paths } from 'expo-file-system'
import { enrolRecordOf } from './passkeyEnrol.js'

const FILE_NAME = 'varanda-passkey-enrol.json'

function file () {
  return new File(Paths.document, FILE_NAME)
}

export const passkeyEnrolStore = {
  async load () {
    try {
      const f = file()
      if (!f.exists) return null
      return enrolRecordOf(JSON.parse(f.textSync()))
    } catch {
      return null
    }
  },
  async save (record) {
    const valid = enrolRecordOf(record)
    if (valid === null) return false
    try {
      const f = file()
      if (!f.exists) f.create()
      f.write(JSON.stringify(valid))
      return true
    } catch {
      return false
    }
  },
  async clear () {
    try {
      const f = file()
      if (f.exists) f.delete()
      return true
    } catch {
      return false
    }
  }
}
