// The keyboard lift behind every form (KeyboardForm in screens/Perfil.js, for
// sheets and full-screen steps) and both composers (SheetKeyboard in
// screens/Publicar.js). Every form avoids the keyboard: iOS never resizes for
// it, and Android runs edge to edge (targetSdk 36), where adjustResize no
// longer resizes either. KeyboardAvoidingView compares its parent-relative
// frame with the keyboard's screen position, so inside a sheet it pads too
// little by the sheet's own top; the measured top goes back in as
// keyboardVerticalOffset. `measured` turns the measuring on (a caller that
// has not checked a platform leaves it off and keeps offset 0);
// `remeasureOnKeyboard` measures again when the keyboard opens, as an iOS page
// sheet may still be sliding in at the first layout.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard, KeyboardAvoidingView, StyleSheet, View } from 'react-native'
import { useKeyboardAvoidEnabled } from './keyboardAvoid'

const styles = StyleSheet.create({ fill: { flex: 1 } })

export function KeyboardLift ({ children, measured = true, remeasureOnKeyboard = false }) {
  const ref = useRef(null)
  const avoidKeyboard = useKeyboardAvoidEnabled()
  const [top, setTop] = useState(0)
  const measure = useCallback(() => {
    const view = ref.current
    if (!measured || !view || typeof view.measureInWindow !== 'function') return
    view.measureInWindow((x, y) => { if (Number.isFinite(y)) setTop((was) => (was === y ? was : y)) })
  }, [measured])
  useEffect(() => {
    if (!remeasureOnKeyboard) return undefined
    const sub = Keyboard.addListener('keyboardDidShow', measure)
    return () => { if (sub && typeof sub.remove === 'function') sub.remove() }
  }, [remeasureOnKeyboard, measure])
  return (
    <View ref={ref} style={styles.fill} onLayout={measure} collapsable={false}>
      <KeyboardAvoidingView style={styles.fill} behavior='padding' keyboardVerticalOffset={top} enabled={avoidKeyboard}>
        {children}
      </KeyboardAvoidingView>
    </View>
  )
}
