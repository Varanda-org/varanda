import { File, Paths } from 'expo-file-system'

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
