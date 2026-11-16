// Pure width rule for Segmented. adjustsFontSizeToFit does nothing on web, so
// at 320 px or less the labels were cut. Below this width per tab the control
// drops its side padding and uses a smaller font, the same for every tab.
// Where the text already shrinks to fit (`shrinks`), nothing changes.
export const TIGHT_TAB_WIDTH = 112
export const TIGHT_FONT_SIZE = 13
export const TIGHT_PADDING = 2

export function segmentedFit (width, count, shrinks) {
  if (shrinks === true) return { tight: false }
  const tabs = Number.isInteger(count) && count > 0 ? count : 1
  const each = Number.isFinite(width) && width > 0 ? width / tabs : Infinity
  return each < TIGHT_TAB_WIDTH
    ? { tight: true, paddingHorizontal: TIGHT_PADDING, fontSize: TIGHT_FONT_SIZE }
    : { tight: false }
}
