import rpc from '@varanda/rpc'

const { feira, displayText } = rpc

export const PARTIAL_NOTE = 'Ordem e faixa de preço valem para os anúncios já carregados'
export const CATEGORY_ICONS = Object.freeze(Object.fromEntries(feira.CATS.map((id) => [id, 'cat_' + id])))

export function browseListings (rows, { sort = 'recentes', minCents = null, maxCents = null } = {}) {
  const bounded = minCents !== null || maxCents !== null
  const result = rows.filter((row) => !bounded || (
    row.price !== null &&
    (minCents === null || row.price >= minCents) &&
    (maxCents === null || row.price <= maxCents)
  ))
  if (sort !== 'menor' && sort !== 'maior') return result
  return result.sort((a, b) => {
    const aLast = a.price === null || a.kind === 'procura'
    const bLast = b.price === null || b.kind === 'procura'
    if (aLast !== bLast) return aLast ? 1 : -1
    if (a.price === null || b.price === null) return a.price === b.price ? 0 : a.price === null ? 1 : -1
    return sort === 'menor' ? a.price - b.price : b.price - a.price
  })
}

export function gridRows (rows, cols) {
  if (!Number.isInteger(cols) || cols < 1) throw new RangeError('cols must be a positive integer')
  const result = []
  for (let i = 0; i < rows.length; i += cols) result.push(rows.slice(i, i + cols))
  return result
}

export function columnsFor (width, largeText) {
  if (largeText || !Number.isFinite(width) || width < 360) return 1
  if (width < 600) return 2
  if (width < 900) return 3
  return 4
}

export function placeLabel ({ city, uf } = {}) {
  return [city, uf].map((value) => displayText(typeof value === 'string' ? value : '')).filter(Boolean).join(', ')
}
