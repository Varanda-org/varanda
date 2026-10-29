import { File, Paths } from 'expo-file-system'
import { FILE_NAME, introRecordOf } from './intro.js'

function file () {
  return new File(Paths.document, FILE_NAME)
}

export async function loadIntroRecord () {
  try {
    const f = file()
    if (!f.exists) return null
    return introRecordOf(JSON.parse(await f.text()))
  } catch {
    return null
  }
}

export async function saveIntroRecord (record) {
  try {
    const valid = introRecordOf(record)
    if (valid === null) return false
    const f = file()
    if (!f.exists) f.create()
    f.write(JSON.stringify(valid))
    return true
  } catch {
    return false
  }
}
