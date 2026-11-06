import { File, Paths } from 'expo-file-system'
import { FILE_NAME, createInviteSeenStore } from './inviteDrop.js'

const store = createInviteSeenStore({
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

export const loadInviteSeen = store.load
export const saveInviteSeen = store.save
