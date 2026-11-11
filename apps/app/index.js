// First, so crypto.getRandomValues exists before any other module loads.
import './src/cryptoPolyfill'

import { registerRootComponent } from 'expo'

// Before the root component: a background launch runs the refresh task
// (defined at this module's top level) without ever rendering the app.
import './src/backgroundTask'
import { sweepMediaCache } from './src/media/display'
import { trimKept } from './src/media/keep'
import App from './App'

// Photos cached by the last run (some of authors not followed) go before the
// first render; a no-op on the web.
sweepMediaCache()
// Caps the kept photos (./src/media/keep) later, off the start path.
setTimeout(trimKept, 5000)

// registerRootComponent registers App as 'main' and sets up the environment
// for both Expo Go and native builds.
registerRootComponent(App)
