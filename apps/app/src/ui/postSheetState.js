// State of the one actions sheet a list shares between its rows. Pure: the
// provider (PostSheetHost.js) keeps it in a reducer.
//
// `actions` is kept after a close: the sheet slides out, and a row that was
// pressed runs its action only once the sheet is gone, so the sheet must still
// hold what it was opened with. `owner` is the row that opened it: while it is
// up, only that row's renders replace the actions (refresh), so a press never
// runs the closures of an older render.

export const CLOSED = Object.freeze({ open: false, owner: null, actions: [] })

export function sheetReducer (state, event) {
  if (event && event.type === 'show') {
    return { open: Array.isArray(event.actions) && event.actions.length > 0, owner: event.owner ?? null, actions: Array.isArray(event.actions) ? event.actions : [] }
  }
  if (event && event.type === 'refresh') {
    if (!state.open || event.owner == null || event.owner !== state.owner || !Array.isArray(event.actions)) return state
    if (event.actions === state.actions) return state
    return { open: event.actions.length > 0, owner: state.owner, actions: event.actions }
  }
  if (event && event.type === 'close') return state.open ? { open: false, owner: state.owner, actions: state.actions } : state
  return state
}
