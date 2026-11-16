// iOS and Android size a multiline field themselves when it has no fixed
// height (minHeight and maxHeight only): only the web measures
// (fieldMeasure.web.js). A fixed height never grows on iOS, which reports
// onContentSizeChange only when the frame changes.
export const GROWS_ITSELF = true

export function measureField () {
  return null
}
