// react-native-web's isScreenReaderEnabled always resolves true and never reports a change, so the web cannot tell: automatic music there follows the Ajustes switch alone.
export function screenReaderOn () {
  return false
}

export function screenReaderKnown () {
  return true
}
