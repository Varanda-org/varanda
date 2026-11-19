// Web ignores adjustsFontSizeToFit, so a tab narrower than its label drops
// its side padding and takes a smaller font, the same for every tab. The
// floor is for "Depoimentos", the hosted profile's longest fixed label: about
// 104 px at 16/600 plus 8 px on either side, with a little room for wider
// system fonts. A longer label, such as a Curtidas tab with its count, is
// estimated at 9 px a character.
export const TIGHT_TAB_WIDTH = 124
export const LABEL_CHAR_WIDTH = 9
export const TAB_PADDING = 16
export const TIGHT_FONT_SIZE = 13
export const TIGHT_PADDING = 2

export function segmentedFit (width, count, shrinks, longest) {
  if (shrinks === true) return { tight: false }
  const tabs = Number.isInteger(count) && count > 0 ? count : 1
  const each = Number.isFinite(width) && width > 0 ? width / tabs : Infinity
  const chars = Number.isInteger(longest) && longest > 0 ? longest : 0
  const needs = Math.max(TIGHT_TAB_WIDTH, chars * LABEL_CHAR_WIDTH + TAB_PADDING)
  return each < needs
    ? { tight: true, paddingHorizontal: TIGHT_PADDING, fontSize: TIGHT_FONT_SIZE }
    : { tight: false }
}
