// The 'Página' badge text from an index hint, a seed or a page.read answer:
// null for a person. Closed and moved pages say so. Pure; only a hint, since
// Membro verifies with page.read.
export function pageBadgeLabel (info) {
  if (!info || typeof info !== 'object' || info.page !== true) return null
  if (info.closed === true) return 'Página · encerrada'
  if (info.moved === true || (info.movedTo !== undefined && info.movedTo !== null)) return 'Página · mudou de chave'
  return 'Página'
}
