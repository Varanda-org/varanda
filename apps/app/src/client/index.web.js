// Web: there is no in-app Bare node (the web build never imports
// react-native-bare-kit or the worklet bundle). The web client runs the
// browser node (./browser.js) or talks to varanda-serve (./web.js); see
// ./connect.web.js.
const unavailable = () => Promise.reject(new Error('nó local indisponível na web'))

export const startNode = unavailable
export const terminateNode = () => Promise.resolve(false)
export const currentClient = () => null
export const startProbe = unavailable
export const defaultDataDir = () => null
export const documentPath = () => null
