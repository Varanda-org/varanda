// iOS/Android: recent music picks live in one JSON file in the app's
// documents, keyed by account inside the file (musicRecents.js). Not wiped
// with the local caches, which a lock also clears: node.js removes the file
// on sign-out and reset only.

import { File, Paths } from 'expo-file-system'
import { FILE_NAME, createMusicRecents } from './musicRecents.js'

const store = createMusicRecents({
  read: () => {
    const file = new File(Paths.document, FILE_NAME)
    return file.exists ? file.textSync() : null
  },
  write: (raw) => {
    const file = new File(Paths.document, FILE_NAME)
    if (!file.exists) file.create()
    file.write(raw)
  },
  remove: () => {
    const file = new File(Paths.document, FILE_NAME)
    if (file.exists) file.delete()
  }
})

export const listMusicRecents = store.list
export const noteMusicRecent = store.note
export const clearMusicRecentsOf = store.clearOwner
export const clearMusicRecents = store.clear
