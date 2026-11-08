import { File, Paths } from 'expo-file-system'
import { FILE_NAME, createAlertsStore } from './feiraAlerts.js'

export const alertsStore = createAlertsStore({
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
