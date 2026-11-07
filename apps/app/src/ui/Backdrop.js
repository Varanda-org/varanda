// The dimmed area behind a sheet or a menu: a tap closes it. On the web it is
// a plain view that only takes the tap. react-native-web's Modal focuses its
// first descendant that accepts .focus(), and any button (even tabIndex -1)
// does, so a button backdrop drew a focus ring around the whole screen and
// was a Tab stop. Native keeps the 'fechar' button for screen readers.

import { Platform, Pressable, View } from 'react-native'

export function Backdrop ({ style, onClose }) {
  if (Platform.OS === 'web') {
    return <View style={style} accessible={false} onStartShouldSetResponder={() => true} onResponderRelease={onClose} />
  }
  return <Pressable style={style} accessibilityRole='button' accessibilityLabel='fechar' onPress={onClose} />
}
