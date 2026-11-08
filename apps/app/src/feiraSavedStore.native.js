// iOS/Android: saved listings live in one JSON file in the app's documents,
// keyed by installation origin inside the file (feiraSaved.js).

import { File, Paths } from 'expo-file-system'
import { FILE_NAME, createSavedStore } from './feiraSaved.js'

const store = createSavedStore({
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

export const listSaved = store.list
export const isSaved = store.has
export const toggleSaved = store.toggle
export const removeSaved = store.remove
export const clearSaved = store.clear
