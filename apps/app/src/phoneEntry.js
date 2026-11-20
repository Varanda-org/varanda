// The phone code field of the Telefone screen: the six cells drawn over the
// one input, and when an edit may check the code by itself. Pure: imports
// nothing, so Node's import() tests every branch.

export const CODE_LENGTH = 6

// One entry per cell: the digit typed there, or '' for an empty cell. Only
// digits are drawn, so a value that is not a string draws empty cells.
export function cellsOf (code, n = CODE_LENGTH) {
  const size = Number.isInteger(n) && n > 0 ? n : CODE_LENGTH
  const digits = typeof code === 'string' ? code.replace(/[^0-9]/g, '').slice(0, size) : ''
  const cells = []
  for (let i = 0; i < size; i++) cells.push(i < digits.length ? digits[i] : '')
  return cells
}

// A check is a state-changing request: an edit sends at most one per
// completed code. `last` is the code checked most recently (by an edit or by
// Confirmar), so after an error or an unknown outcome the same digits never go
// again on their own; only a different code, or Confirmar, sends. Anything but
// locked === false holds it, so a missing flag never sends.
export function shouldAutoSubmit ({ code, last, locked } = {}) {
  if (locked !== false) return false
  if (typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return false
  return code !== last
}
