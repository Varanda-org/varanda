// State of the one actions sheet a chat list shares between its bubbles. Pure:
// the provider (ChatSheetHost.js) keeps it in a reducer.

export const CLOSED = Object.freeze({ open: false, owner: null, sheet: { title: undefined, actions: [], header: undefined } })

// Pure. The sheet is kept after a close: it slides out, and a pressed action
// runs once it is gone. Only the bubble that opened it refreshes it.
export function chatSheetReducer (state, event) {
  if (event && event.type === 'show') {
    const sheet = event.sheet && Array.isArray(event.sheet.actions) ? event.sheet : CLOSED.sheet
    return { open: sheet.actions.length > 0, owner: event.owner ?? null, sheet }
  }
  if (event && event.type === 'refresh') {
    if (!state.open || event.owner == null || event.owner !== state.owner || !event.sheet || !Array.isArray(event.sheet.actions)) return state
    return { open: event.sheet.actions.length > 0, owner: state.owner, sheet: event.sheet }
  }
  if (event && event.type === 'close') return state.open ? { ...state, open: false } : state
  return state
}
