// iOS/Android: the Feira's state and city (feiraScreen.js
// createLocationStore) live in one small JSON file in the app's documents,
// like the saved listings (feiraSavedStore.native.js).

import { File, Paths } from 'expo-file-system'
import { createLocationStore } from './feiraScreen.js'

const FILE_NAME = 'varanda-feira-location.json'

export const feiraLocation = createLocationStore({
  read: () => {
    const file = new File(Paths.document, FILE_NAME)
    return file.exists ? file.text() : null
  },
  write: (key, raw) => {
    const file = new File(Paths.document, FILE_NAME)
    if (!file.exists) file.create()
    file.write(raw)
  }
})
