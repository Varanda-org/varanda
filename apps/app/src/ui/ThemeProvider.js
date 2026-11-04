// The light/dark palette for the whole tree.
//
// Migrating a file (screens and ui components):
// 1. `const styles = StyleSheet.create({...})` becomes a module-scope
//    `const makeStyles = (colors) => StyleSheet.create({...})`.
// 2. Each component calls `const styles = useStyles(makeStyles)` at its top,
//    unconditionally, and `const { colors } = useTheme()` when its JSX paints
//    a colour (icon colours, placeholderTextColor, inline styles).
// 3. A default parameter that captures colors (`color = colors.ink`) moves
//    into the body after the hooks, before any early return.
// 4. Drop `colors` from the theme / ui import.

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Appearance, useColorScheme } from 'react-native'
import { MODES, light, paletteFor, resolveScheme, withMode } from '../appearance.js'
import { applySchemeToDocument, loadAppearanceRecord, saveAppearanceRecord } from '../appearanceStore'

// Outside a provider (unmigrated code, tests) everything stays light.
export const ThemeContext = createContext({ scheme: 'light', colors: light, mode: 'system', setMode () {} })

export function ThemeProvider ({ children }) {
  // Read synchronously: picking the scheme in an effect would paint one
  // light frame before a stored Escuro.
  const [mode, setModeState] = useState(() => (loadAppearanceRecord() || { mode: 'system' }).mode)
  const system = useColorScheme()
  const scheme = resolveScheme({ mode, system })
  const colors = paletteFor(scheme)

  // Also on the first mount, so a choice stored before a restart reaches the
  // native chrome (iOS page sheets, Android night resources).
  // react-native-web has no setColorScheme.
  useEffect(() => {
    if (typeof Appearance.setColorScheme !== 'function') return
    try {
      Appearance.setColorScheme(mode === 'system' ? 'unspecified' : mode)
    } catch {}
  }, [mode])

  // A layout effect runs before every passive effect of the commit, so the
  // sunset band meta set by the shell (applyBandMeta) wins over this one.
  useLayoutEffect(() => {
    applySchemeToDocument(scheme, { bg: colors.bg, themeColor: colors.bg })
  }, [scheme, colors])

  const value = useMemo(() => ({
    scheme,
    colors,
    mode,
    setMode (next) {
      if (!MODES.includes(next)) return
      setModeState(next)
      saveAppearanceRecord(withMode(next))
    }
  }), [scheme, mode, colors])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme () {
  return useContext(ThemeContext)
}

// On react-native-web StyleSheet.create compiles CSS classes when called, so
// each factory runs at most once per scheme. Keyed by the factory itself: an
// inline lambda is a new key every render and misses the cache.
const cache = new WeakMap()

export function useStyles (makeStyles) {
  const { scheme, colors } = useTheme()
  let entry = cache.get(makeStyles)
  if (entry === undefined) {
    entry = {}
    cache.set(makeStyles, entry)
  }
  if (entry[scheme] === undefined) entry[scheme] = makeStyles(colors)
  return entry[scheme]
}
