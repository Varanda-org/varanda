import { createContext, useContext } from 'react'
import { Animated } from 'react-native'

// Outside a provider nothing moves: the value stays 0 (shown).
const DEFAULT = { progress: new Animated.Value(0), hidden: false, show () {} }

export const ChromeMotion = createContext(DEFAULT)

export function useChromeMotion () {
  return useContext(ChromeMotion)
}
