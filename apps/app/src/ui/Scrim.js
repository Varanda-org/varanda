// A black scrim at one edge of a photo: a solid part at `alpha` behind the
// text, then a real gradient to clear over `fade` points on the photo side,
// so text reads over a white photo and no band edge shows. The gradient is a
// CSS linear-gradient: react-native-web passes backgroundImage through to the
// page, and react-native 0.83 (new architecture) draws it from
// experimental_backgroundImage on iOS and Android. Platform picks the style
// key only, the drawing is the same everywhere.

import { Platform, StyleSheet, View } from 'react-native'

export const scrimColor = (alpha) => 'rgba(0,0,0,' + alpha + ')'

// The fade, from the solid part out to clear: towards the bottom for a top
// scrim, towards the top for a bottom one.
export function scrimGradient (edge, alpha) {
  return 'linear-gradient(' + (edge === 'top' ? 'to bottom' : 'to top') + ', ' + scrimColor(alpha) + ' 0%, ' + scrimColor(0) + ' 100%)'
}

const imageKey = Platform.OS === 'web' ? 'backgroundImage' : 'experimental_backgroundImage'

// edge 'top': solid from the top, then the fade below it; 'bottom': the
// fade first, then solid to the bottom. The caller sizes the box (style) so
// its solid part ends where the text ends.
export function Scrim ({ edge = 'bottom', alpha, fade, style }) {
  const solid = <View key='solid' style={[styles.solid, { backgroundColor: scrimColor(alpha) }]} />
  const ramp = <View key='fade' style={{ height: fade, [imageKey]: scrimGradient(edge, alpha) }} />
  return (
    <View style={[styles.column, style]} pointerEvents='none' accessible={false}>
      {edge === 'top' ? [solid, ramp] : [ramp, solid]}
    </View>
  )
}

const styles = StyleSheet.create({
  column: { flexDirection: 'column' },
  solid: { flex: 1 }
})
