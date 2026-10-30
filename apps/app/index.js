// First, so crypto.getRandomValues exists before any other module loads.
import './src/cryptoPolyfill'

import { registerRootComponent } from 'expo'

import App from './App'

// registerRootComponent registers App as 'main' and sets up the environment
// for both Expo Go and native builds.
registerRootComponent(App)
