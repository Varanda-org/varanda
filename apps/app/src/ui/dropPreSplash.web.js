/* global document */
// The web pre-splash (public/index.html) is an opaque overlay that Splash.js
// takes over and removes. A throw in the first render comes before that, so
// the crash screen removes it here, or the overlay would hide the screen.
export function dropPreSplash () {
  try {
    const el = document.getElementById('varanda-pre-splash')
    if (el) el.remove()
  } catch {}
}
