/* global document */

// A hidden <input type=file> for one photo, created per pick and removed when
// it ends (the same pattern as src/media/attach.web.js). Resolves the File
// itself or null.

const PHOTO_ACCEPT = 'image/jpeg,image/png'

export function pickPhoto () {
  if (typeof document !== 'object' || document === null) return Promise.resolve(null)
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = PHOTO_ACCEPT
    input.style.display = 'none'
    input.setAttribute('aria-hidden', 'true')
    let settled = false
    const done = (file) => {
      if (settled) return
      settled = true
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', onCancel)
      try { input.remove() } catch {}
      resolve(file)
    }
    const onChange = () => done((input.files && input.files[0]) || null)
    const onCancel = () => done(null)
    input.addEventListener('change', onChange)
    input.addEventListener('cancel', onCancel)
    document.body.appendChild(input)
    input.click()
  })
}
