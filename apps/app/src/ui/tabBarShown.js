import { createContext } from 'react'

// Whether the tab bar is on screen (a pushed screen hides it). The default is
// true, the early and safe side, when no provider is present.
export const TabBarShown = createContext(true)
