import { File, Paths } from 'expo-file-system'
import { FILE_NAME, createMomentSeenStore } from './momentSeen.js'

const store = createMomentSeenStore({
  read: () => {
    const file = new File(Paths.document, FILE_NAME)
    return file.exists ? file.text() : null
  },
  write: (raw) => {
    const file = new File(Paths.document, FILE_NAME)
    if (!file.exists) file.create()
    file.write(raw)
  }
})

export const loadMomentSeen = () => store.load()
export const markMomentSeen = (id) => store.mark(id)
export const onMomentSeen = (fn) => store.subscribe(fn)
