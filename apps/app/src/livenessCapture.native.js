// The phone app has no in-app face check yet: the payments screen keeps the
// hosted verification page there. Kept free of the detector and of the
// credentials module so the native bundle never pulls them.

export function isAvailable () {
  return false
}

export function LivenessCapture () {
  return null
}
