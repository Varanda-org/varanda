import { File, Paths } from 'expo-file-system'
import { FILE_NAME, createTestimonialHideStore } from './testimonialHide.js'

const store = createTestimonialHideStore({
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

export const loadTestimonialHidden = () => store.load()
export const hideTestimonial = (id) => store.hide(id)
