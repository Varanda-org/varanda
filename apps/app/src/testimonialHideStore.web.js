import { STORAGE_KEY, createTestimonialHideStore } from './testimonialHide.js'

const store = createTestimonialHideStore({
  read: () => globalThis.localStorage.getItem(STORAGE_KEY),
  write: (raw) => globalThis.localStorage.setItem(STORAGE_KEY, raw)
})

export const loadTestimonialHidden = () => store.load()
export const hideTestimonial = (id) => store.hide(id)
