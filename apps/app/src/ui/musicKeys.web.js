const STEPS = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, Home: 'min', End: 'max' }

// Only the keys the strip uses are swallowed, so Tab and the sheet's
// Escape still reach the page.
export function stepKeyProps (onKey) {
  return {
    tabIndex: 0,
    onKeyDown: (event) => {
      const key = event && event.key
      if (!Object.prototype.hasOwnProperty.call(STEPS, key)) return
      event.preventDefault()
      event.stopPropagation()
      onKey(STEPS[key])
    }
  }
}
