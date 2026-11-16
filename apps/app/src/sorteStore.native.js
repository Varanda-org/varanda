// iOS/Android: the per-device salt of the Sorte do dia, as a small file in the
// app's document dir. Never throws; without a readable file a fresh salt is
// made and saved.
import { File, Paths } from 'expo-file-system'
import { isSalt, newSalt } from './sorte.js'

export const FILE_NAME = 'varanda-sorte.txt'

export async function loadSalt () {
  try {
    const f = new File(Paths.document, FILE_NAME)
    if (f.exists) {
      const text = String(await f.text()).trim()
      if (isSalt(text)) return text
    }
  } catch {}
  const salt = newSalt()
  try {
    const f = new File(Paths.document, FILE_NAME)
    if (!f.exists) f.create()
    f.write(salt)
  } catch {}
  return salt
}
