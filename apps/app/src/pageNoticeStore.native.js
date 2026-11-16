import { Directory, File, Paths } from 'expo-file-system'
import { registerLocalCache } from './localCaches'
import { pageNoticeFlags } from './pageNotice'

export function wipePageNotices () {
  let entries
  try { entries = new Directory(Paths.document).list() } catch { return }
  const names = entries.map((entry) => (entry && typeof entry.name === 'string' ? entry.name : null))
  for (const name of pageNoticeFlags(names)) {
    try {
      const file = new File(Paths.document, name)
      if (file.exists) file.delete()
    } catch {}
  }
}

registerLocalCache({ wipe: wipePageNotices })

export function pageNoticeStore () {
  return {
    getItem (key) {
      const file = new File(Paths.document, key + '.json')
      return file.exists ? file.textSync() : null
    },
    setItem (key, value) {
      const file = new File(Paths.document, key + '.json')
      if (!file.exists) file.create()
      file.write(value)
    }
  }
}
