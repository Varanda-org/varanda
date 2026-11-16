// One actions sheet for a whole list of PostRow. A row used to mount two of
// its own (Republicar/Citar and mais), a Modal each, so a long feed kept
// hundreds of closed sheets. Under this provider a row hands over the actions
// of the sheet it wants and the provider shows them in the single sheet.
// Without a provider (a screen that has not adopted it) PostRow keeps its own.

import { createContext, useContext, useMemo, useReducer } from 'react'
import { ActionsSheet } from './ActionsSheet'
import { CLOSED, sheetReducer } from './postSheetState'

const PostSheetContext = createContext(null)

export function usePostSheet () {
  return useContext(PostSheetContext)
}

export function PostSheetProvider ({ children }) {
  const [state, dispatch] = useReducer(sheetReducer, CLOSED)
  // Stable, so the memoized rows do not render again when the sheet opens.
  const host = useMemo(() => ({
    show: (owner, actions) => dispatch({ type: 'show', owner, actions }),
    refresh: (owner, actions) => dispatch({ type: 'refresh', owner, actions }),
    close: () => dispatch({ type: 'close' })
  }), [])
  return (
    <PostSheetContext.Provider value={host}>
      {children}
      <ActionsSheet open={state.open} onClose={() => host.close()} actions={state.actions} />
    </PostSheetContext.Provider>
  )
}
