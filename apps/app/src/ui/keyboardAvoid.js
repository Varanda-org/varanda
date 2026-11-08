// Whether a KeyboardAvoidingView should pad right now. iOS: always (its
// keyboard events give the right frame). Android draws edge to edge, and its
// keyboardDidHide reports the visible area without the system bars, so the
// view kept about 76 dp of padding after the keyboard closed and the composer
// floated over an empty band: there it pads only while the keyboard is open.

import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

export function useKeyboardAvoidEnabled () {
  const android = Platform.OS === 'android'
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!android) return undefined
    const show = Keyboard.addListener('keyboardDidShow', () => setShown(true))
    const hide = Keyboard.addListener('keyboardDidHide', () => setShown(false))
    return () => { show.remove(); hide.remove() }
  }, [android])
  return !android || shown
}
