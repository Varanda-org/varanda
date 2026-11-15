'use strict'

// One keyboard lift for every form and both composers (src/ui/KeyboardLift.js),
// where Perfil's KeyboardForm and Publicar's SheetKeyboard each carried a copy.
const test = require('brittle')
const fs = require('fs')
const path = require('path')

const read = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')

test('KeyboardForm and SheetKeyboard are thin wrappers over the shared lift', (t) => {
  const lift = read('ui/KeyboardLift.js')
  const perfil = read('screens/Perfil.js')
  const publicar = read('screens/Publicar.js')
  t.is(lift.split('<KeyboardAvoidingView').length - 1, 1, 'the only padding view of the two')
  t.ok(lift.includes('view.measureInWindow(') && lift.includes("Keyboard.addListener('keyboardDidShow', measure)"), 'measure and remeasure live in the lift')
  for (const src of [perfil, publicar]) {
    t.absent(src.includes('<KeyboardAvoidingView') || src.includes('useKeyboardAvoidEnabled'), 'no copy of the block left')
    t.ok(src.includes("import { KeyboardLift } from '../ui/KeyboardLift'"))
  }
  t.ok(perfil.includes("return <KeyboardLift measured={inWindow || Platform.OS === 'android'}>{children}</KeyboardLift>"), 'forms keep the Android-only rule and inWindow')
  t.ok(publicar.includes('if (IOS_SCROLL_INSETS) return <View style={styles.flex}>{children}</View>') && publicar.includes('return <KeyboardLift remeasureOnKeyboard>{children}</KeyboardLift>'), 'composers keep the iOS inset path and the remeasure')
})
