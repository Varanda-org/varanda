/* global __DEV__ */
// First, so crypto.getRandomValues exists before any other module loads.
import './src/cryptoPolyfill'
// Right after it: the js-entry boot mark (inert unless the dev perf flag is on).
import './src/perfEntry'

import { registerRootComponent } from 'expo'

// Before the root component: a background launch runs the refresh task
// (defined at this module's top level) without ever rendering the app.
import './src/backgroundTask'
import { sweepMediaCache } from './src/media/display'
import { trimKept } from './src/media/keep'
import { bootSpan, monotonicNow, perfOn } from './src/perfMarks'
import App from './App'
import { withCrashBoundary } from './src/ui/CrashBoundary'

// Photos cached by the last run (some of authors not followed) go before the
// first render; a no-op on the web.
const sweepStart = perfOn ? monotonicNow() : 0
sweepMediaCache()
if (perfOn) bootSpan('sweep-media-cache', sweepStart, monotonicNow())
// Caps the kept photos (./src/media/keep) later, off the start path.
setTimeout(trimKept, 5000)

if (__DEV__ && process.env.EXPO_PUBLIC_VARANDA_HASH_BENCH === '1') {
  setTimeout(() => require('./src/media/hashBench').runHashBench(), 4000)
}

// registerRootComponent registers App as 'main' and sets up the environment
// for both Expo Go and native builds. The boundary shows the crash screen when
// a render throws, instead of a blank app.
registerRootComponent(withCrashBoundary(App))
