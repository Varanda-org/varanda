// Whether the shell may act on a held launch intent (a push tap) now. Pure:
// imports nothing, so Node tests load it directly. Not due means the intent
// stays held for a later render.
//
// Ajustes is a sheet, so atTabs is false while it is open: a convite must
// still refresh an open Convites, or a lock before closing drops it. Not
// while the phone gate holds the member, though: the sheet is then only the
// explainer's Excluir conta, and a convite would replace it.
export function launchDue ({ kind, atTabs, sheetOpen, phoneClear, deleteFromAviso } = {}) {
  if (atTabs === true) return true
  return kind === 'convite' && sheetOpen === true && phoneClear === true && deleteFromAviso !== true
}
