// One actions sheet for a whole chat list of Bubble, as PostSheetHost does for
// posts. A bubble used to mount its own ActionsSheet (a Modal each), so a long
// thread kept hundreds of closed sheets. Under this provider a bubble hands
// over its sheet ({ title, actions, header }) and the provider shows it.
// Without a provider (the Vitrine, a lone bubble) Bubble keeps its own.

import { createContext, useContext, useMemo, useReducer } from 'react'
import { ActionsSheet } from './ActionsSheet'
import { CLOSED, chatSheetReducer } from './chatSheetState'

const ChatSheetContext = createContext(null)

export function useChatSheet () {
  return useContext(ChatSheetContext)
}

export function ChatSheetProvider ({ children }) {
  const [state, dispatch] = useReducer(chatSheetReducer, CLOSED)
  // Stable, so the memoized bubbles do not render again when the sheet opens.
  const host = useMemo(() => ({
    show: (owner, sheet) => dispatch({ type: 'show', owner, sheet }),
    refresh: (owner, sheet) => dispatch({ type: 'refresh', owner, sheet }),
    close: () => dispatch({ type: 'close' })
  }), [])
  return (
    <ChatSheetContext.Provider value={host}>
      {children}
      <ActionsSheet open={state.open} onClose={() => host.close()} title={state.sheet.title} actions={state.sheet.actions} header={state.sheet.header} />
    </ChatSheetContext.Provider>
  )
}
