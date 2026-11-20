// iOS/Android: the per-device salt file of an older Sorte do dia is deleted.
// Never throws.
import { File, Paths } from 'expo-file-system'

export const FILE_NAME = 'varanda-sorte.txt'

export function forgetSalt () {
  try {
    const f = new File(Paths.document, FILE_NAME)
    if (f.exists) f.delete()
  } catch {}
}
