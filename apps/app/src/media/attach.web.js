/* global document */

// Web: lets the person choose photos and GIFs from their own files. A hidden
// <input type=file> is created on demand for each pick and removed when the
// pick ends (change or cancel); no global listener is ever kept. Resolves
// with the chosen File objects ([] when cancelled). If the browser fires
// neither event, the next pick removes the stale input first.

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif'

let current = null

function drop (input) {
  try { input.remove() } catch {}
  if (current === input) current = null
}

export function pickImages () {
  if (current) drop(current)
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = ACCEPT
    input.multiple = true
    input.style.display = 'none'
    input.setAttribute('aria-hidden', 'true')
    let settled = false
    const done = (files) => {
      if (settled) return
      settled = true
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', onCancel)
      drop(input)
      resolve(files)
    }
    const onChange = () => done(Array.from(input.files || []))
    const onCancel = () => done([])
    input.addEventListener('change', onChange)
    input.addEventListener('cancel', onCancel)
    current = input
    // Some engines open the picker only for an input in the document.
    document.body.appendChild(input)
    input.click()
  })
}
