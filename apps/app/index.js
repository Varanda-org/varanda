// First, so crypto.getRandomValues exists before any other module loads.
import './src/cryptoPolyfill'

import { registerRootComponent } from 'expo'

import { sweepMediaCache } from './src/media/display'
import App from './App'

// Photos cached by the last run (some of authors not followed) go before the
// first render; a no-op on the web.
sweepMediaCache()

// registerRootComponent registers App as 'main' and sets up the environment
// for both Expo Go and native builds.
registerRootComponent(App)
