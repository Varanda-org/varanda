// The config of every Animated.timing inside an endless Animated.loop, kept
// pure so a test can pin it. A running animation counts as an interaction
// unless it says otherwise, and react-native-web's FlatList only grows its
// rendered window once InteractionManager is idle. On the web nothing runs on
// the native driver, so a placeholder pulsing on a mounted but hidden tab (a
// tab that loads on its first visit) kept every list at its first rows until
// that tab was opened.

export function loopTiming (config) {
  return { ...config, isInteraction: false }
}
