// The environment the device name is built from (src/devices.js deviceName),
// on the web: the browser's own user agent and touch points. Only this file
// touches the navigator.

export function deviceEnv () {
  try {
    const nav = globalThis.navigator
    if (nav && typeof nav.userAgent === 'string') return { userAgent: nav.userAgent, maxTouchPoints: nav.maxTouchPoints, constants: {} }
  } catch {}
  return { userAgent: '', constants: {} }
}
