// Screen-reader labels for the carousel arrows. Pure, so tests load it alone.
// An arrow says where it leads ("Próxima foto, 4 de 5"), not only which way.
import { counterText } from './carousel.js'

// page is the 0-based page on screen; dir is -1 (previous) or 1 (next). Past
// either end there is no target, so no label.
export function arrowLabel (page, count, dir) {
  if (!Number.isInteger(page) || !Number.isInteger(count) || page < 0 || page >= count) return ''
  const target = page + (dir < 0 ? -1 : 1)
  if (target < 0 || target >= count) return ''
  return (dir < 0 ? 'Foto anterior, ' : 'Próxima foto, ') + counterText(target, count)
}
